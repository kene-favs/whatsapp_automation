// ============================================================
//  ForgeBot — Session Manager
//  File location: src/sessions/sessionManager.js
//
//  v3 fixes:
//   - Replaced useMultiFileAuthState (Railway ephemeral filesystem)
//     with useSupabaseAuthState (persists to whatsapp_sessions table)
//     → Session survives Railway redeploys, no QR scan needed each time
//   - Updates clients.whatsapp_connected on connect/disconnect
//     → index.js bootAllSessions() can auto-reconnect on startup
//   - All existing exports preserved
// ============================================================

// ── Crypto polyfill — MUST be first line before any imports ──
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} = require('@whiskeysockets/baileys');

const { createClient } = require('@supabase/supabase-js');
const { Boom }         = require('@hapi/boom');
const pino             = require('pino');
const replyEngine      = require('../bot/replyEngine');

const sessions = {};   // clientId → { sock }
const starting  = new Set();
const retryInfo = {};
const latestQR  = {};

const logger = pino({ level: 'silent' });

// ── Lazy Supabase init ────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// ── Broadcast to all SSE listeners ───────────────────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

// ── Retry delay: exponential backoff capped at 60s ───────────
function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info  = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000);
  return delay;
}

// ── Supabase Auth State ───────────────────────────────────────
// Replaces useMultiFileAuthState — persists Baileys auth to DB
// so Railway deploys don't wipe credentials.

async function useSupabaseAuthState(clientId) {
  var sb = getSupabase();

  // Load existing session from DB
  var result = await sb
    .from('whatsapp_sessions')
    .select('auth_creds, auth_keys')
    .eq('client_id', clientId)
    .single();

  var creds;
  var keysStore = {};

  if (result.data && result.data.auth_creds) {
    try {
      // Supabase returns JSONB as a plain object; use BufferJSON.reviver
      // to convert { type:'Buffer', data:[...] } back into real Buffers
      creds = JSON.parse(JSON.stringify(result.data.auth_creds), BufferJSON.reviver);
    } catch (e) {
      console.error('[SessionManager] Failed to parse creds for', clientId, '— fresh start');
      creds = initAuthCreds();
    }
    try {
      keysStore = JSON.parse(JSON.stringify(result.data.auth_keys || {}), BufferJSON.reviver);
    } catch (e) {
      keysStore = {};
    }
    console.log('[SessionManager] Loaded Supabase auth for', clientId);
  } else {
    creds     = initAuthCreds();
    keysStore = {};
    console.log('[SessionManager] No saved auth for', clientId, '— will show QR');
  }

  // Persist current creds + keys to Supabase
  async function saveToDb() {
    try {
      var credsJson = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      var keysJson  = JSON.parse(JSON.stringify(keysStore, BufferJSON.replacer));
      await sb.from('whatsapp_sessions').upsert({
        client_id:  clientId,
        auth_creds: credsJson,
        auth_keys:  keysJson,
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch (e) {
      console.error('[SessionManager] saveToDb error for', clientId + ':', e.message);
    }
  }

  var state = {
    creds: creds,
    keys: {
      get: function(type, ids) {
        var data = {};
        ids.forEach(function(id) {
          var val = keysStore[type] && keysStore[type][id];
          if (val !== undefined) data[id] = val;
        });
        return data;
      },
      set: async function(data) {
        for (var cat in data) {
          keysStore[cat] = keysStore[cat] || {};
          for (var id in data[cat]) {
            var val = data[cat][id];
            if (val != null) {
              keysStore[cat][id] = val;
            } else {
              delete keysStore[cat][id];
            }
          }
        }
        await saveToDb();
      }
    }
  };

  var saveCreds = async function() {
    await saveToDb();
  };

  return { state: state, saveCreds: saveCreds };
}

// ── Clear Supabase auth (force fresh QR) ─────────────────────
async function clearSupabaseAuth(clientId) {
  try {
    var sb = getSupabase();
    await sb.from('whatsapp_sessions').delete().eq('client_id', clientId);
    console.log('[SessionManager] Cleared Supabase auth for', clientId);
  } catch (e) {
    console.error('[SessionManager] clearSupabaseAuth error:', e.message);
  }
}

// ── Update whatsapp_connected in clients table ────────────────
async function setConnected(clientId, connected) {
  try {
    var sb = getSupabase();
    await sb.from('clients')
      .update({ whatsapp_connected: connected })
      .eq('id', clientId);
  } catch (e) {
    // Non-critical
  }
}

// ── Main: start or reuse session ─────────────────────────────
async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].sock) return;

  if (starting.has(clientId)) {
    console.log('[SessionManager] Already starting for', clientId);
    return;
  }
  starting.add(clientId);

  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    var retry = retryInfo[clientId];

    console.log('[SessionManager] Starting session for', clientId, '(attempt #' + (retry.count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting', attempt: retry.count + 1 });

    // ── Load auth from Supabase (not filesystem) ──────────────
    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version }          = await fetchLatestBaileysVersion();

    var sock = makeWASocket({
      version,
      logger,
      auth:   state,
      printQRInTerminal: false,
      browser: ['ForgeBot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30000
    });

    sessions[clientId] = { sock: sock };

    // Persist creds on every update
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async function(update) {
      var connection     = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr            = update.qr;

      if (qr) {
        latestQR[clientId] = qr;
        console.log('[SessionManager] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr: qr });
      }

      if (connection === 'open') {
        console.log('[SessionManager] Connected:', clientId);
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 };
        // Mark as connected in DB so bootAllSessions can restore on restart
        await setConnected(clientId, true);
        broadcast(clientId, 'connected', { status: 'connected' });
      }

      if (connection === 'close') {
        var code = 0;
        try {
          if (lastDisconnect && lastDisconnect.error instanceof Boom) {
            code = lastDisconnect.error.output.statusCode;
          }
        } catch (e) {}

        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);

        delete sessions[clientId];
        starting.delete(clientId);

        if (loggedOut) {
          // User logged out — clear saved auth and mark disconnected
          await clearSupabaseAuth(clientId);
          await setConnected(clientId, false);
          broadcast(clientId, 'fatal', { reason: 'logged_out' });
          delete retryInfo[clientId];
          return;
        }

        // Temporary disconnect — keep whatsapp_connected = true since we will retry
        var info = retryInfo[clientId] || { count: 0, delay: 5000 };
        retryInfo[clientId] = info;

        if (info.count >= 10) {
          console.log('[SessionManager] Max retries reached for', clientId);
          await setConnected(clientId, false);
          broadcast(clientId, 'fatal', { reason: 'max_retries' });
          delete retryInfo[clientId];
          return;
        }

        var delay = getNextDelay(clientId);
        console.log('[SessionManager] Retry #' + retryInfo[clientId].count + ' for', clientId, 'in', delay + 'ms');
        broadcast(clientId, 'reconnecting', { delay: delay, attempt: retryInfo[clientId].count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });

    sock.ev.on('messages.upsert', async function(payload) {
      var messages = payload.messages;
      var type     = payload.type;
      if (type !== 'notify') return;
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        try {
          await replyEngine.handleMessage(sock, msg, clientId);
        } catch (e) {
          console.error('[SessionManager] ReplyEngine error for', clientId + ':', e.message);
        }
      }
    });

  } catch (err) {
    console.error('[SessionManager] startSession error for', clientId + ':', err.message);
    starting.delete(clientId);
    delete sessions[clientId];

    var info  = retryInfo[clientId] || { count: 0, delay: 5000 };
    retryInfo[clientId] = info;
    var delay = getNextDelay(clientId);
    broadcast(clientId, 'reconnecting', { delay: delay, attempt: retryInfo[clientId].count });
    setTimeout(function() { startSession(clientId); }, delay);
  } finally {
    starting.delete(clientId);
  }
}

// ── Stop session ──────────────────────────────────────────────
async function stopSession(clientId) {
  try {
    if (sessions[clientId] && sessions[clientId].sock) {
      await sessions[clientId].sock.logout();
    }
  } catch (e) {}
  delete sessions[clientId];
  starting.delete(clientId);
  delete retryInfo[clientId];
  delete latestQR[clientId];
  await setConnected(clientId, false);
}

// ── Clear auth + stop (forces QR scan next time) ─────────────
async function clearSession(clientId) {
  await stopSession(clientId);
  await clearSupabaseAuth(clientId);
}

// ── Get active socket ─────────────────────────────────────────
function getSession(clientId) {
  return (sessions[clientId] && sessions[clientId].sock) ? sessions[clientId].sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

// ── Boot all previously-connected clients on startup ─────────
async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting ' + activeClients.length + ' session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var client = activeClients[i];
    try {
      await startSession(client.id);
      console.log('[SessionManager] Started session for', client.business_name || client.id);
    } catch (err) {
      console.error('[SessionManager] Failed to start session for', client.id + ':', err.message);
    }
  }
}

// ── Register SSE listener ─────────────────────────────────────
function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn);
  global.qrListeners.set(clientId, all);
  if (latestQR[clientId]) {
    try { fn('qr', { qr: latestQR[clientId] }); } catch (e) {}
  }
}

function unregisterQRListener(clientId, fn) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  global.qrListeners.set(clientId, all.filter(function(f) { return f !== fn; }));
}

module.exports = {
  startSession,
  stopSession,
  clearSession,
  getSession,
  getAllSessions,
  bootAllSessions,
  registerQRListener,
  unregisterQRListener
};
