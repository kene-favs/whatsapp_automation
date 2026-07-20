// ============================================================
//  ForgeBot — sessionManager.js  v4
//  src/sessions/sessionManager.js
//
//  KEY FIX: WhatsApp auth state now saved to Supabase DB
//  instead of local filesystem. Railway wipes local files on
//  every deploy — Supabase persists across restarts.
//
//  SQL required (run once in Supabase):
//  CREATE TABLE IF NOT EXISTS whatsapp_sessions (
//    client_id text PRIMARY KEY,
//    auth_creds jsonb,
//    auth_keys  jsonb,
//    updated_at timestamptz DEFAULT now()
//  );
//
//  All existing exports preserved.
// ============================================================

if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const { createClient } = require('@supabase/supabase-js');
const pino      = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions  = {};
const starting  = new Set();
const retryInfo = {};
const latestQR  = {};
const logger    = pino({ level: 'silent' });

// ── Lazy Supabase ─────────────────────────────────────────────
let _sb = null;
function getSB() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}

// ══════════════════════════════════════════════════════════════
//  SUPABASE AUTH STATE — replaces useMultiFileAuthState
//  Saves creds + keys to whatsapp_sessions table so they
//  survive Railway restarts and redeploys.
// ══════════════════════════════════════════════════════════════
async function useSupabaseAuthState(clientId) {
  var sb = getSB();

  // Load existing state
  var row = null;
  try {
    var res = await sb.from('whatsapp_sessions').select('auth_creds,auth_keys').eq('client_id', clientId).single();
    row = res.data;
  } catch(e) {}

  // Deserialise creds (they may contain Buffers stored as base64 JSON)
  var creds;
  try {
    creds = row && row.auth_creds
      ? JSON.parse(JSON.stringify(row.auth_creds), BufferJSON.reviver)
      : initAuthCreds();
  } catch(e) {
    creds = initAuthCreds();
  }

  // Deserialise keys
  var keysRaw = {};
  try {
    if (row && row.auth_keys) keysRaw = row.auth_keys;
  } catch(e) {}

  // Persist helper — called after any change
  async function persist() {
    try {
      var serialCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
      await sb.from('whatsapp_sessions').upsert({
        client_id:  clientId,
        auth_creds: serialCreds,
        auth_keys:  keysRaw,
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch(e) { console.error('[SessionManager] Auth persist error:', e.message); }
  }

  var state = {
    creds: creds,
    keys: {
      get: async function(type, ids) {
        var data = {};
        ids.forEach(function(id) {
          var val = keysRaw[type + ':' + id];
          if (val !== undefined && val !== null) {
            try { data[id] = JSON.parse(JSON.stringify(val), BufferJSON.reviver); } catch(e) { data[id] = val; }
          }
        });
        return data;
      },
      set: async function(data) {
        Object.keys(data).forEach(function(type) {
          var typeData = data[type] || {};
          Object.keys(typeData).forEach(function(id) {
            if (typeData[id] !== null && typeData[id] !== undefined) {
              try { keysRaw[type + ':' + id] = JSON.parse(JSON.stringify(typeData[id], BufferJSON.replacer)); }
              catch(e) { keysRaw[type + ':' + id] = typeData[id]; }
            } else {
              delete keysRaw[type + ':' + id];
            }
          });
        });
        await persist();
      }
    }
  };

  var saveCreds = async function() {
    await persist();
  };

  return { state, saveCreds };
}

// ── Clear session from Supabase ───────────────────────────────
async function clearAuthFromDB(clientId) {
  try {
    var sb = getSB();
    await sb.from('whatsapp_sessions').delete().eq('client_id', clientId);
    console.log('[SessionManager] Cleared auth for', clientId);
  } catch(e) { console.error('[SessionManager] Failed to clear auth:', e.message); }
}

// ── SSE broadcast ─────────────────────────────────────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch(e) {} });
}

// ── Exponential backoff ───────────────────────────────────────
function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info  = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000);
  return delay;
}

// ══════════════════════════════════════════════════════════════
//  START SESSION
// ══════════════════════════════════════════════════════════════
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

    // ── Load auth from Supabase ──────────────────────────────
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

    sessions[clientId] = { sock };
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', function(update) {
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
        broadcast(clientId, 'connected', { status: 'connected' });

        // Start status poster
        try {
          var sp = require('../bot/statusPoster');
          sp.startStatusPoster(clientId, sock);
        } catch(e) { console.error('[SessionManager] StatusPoster start error:', e.message); }
      }

      if (connection === 'close') {
        var code = 0;
        try {
          if (lastDisconnect && lastDisconnect.error instanceof Boom) {
            code = lastDisconnect.error.output.statusCode;
          }
        } catch(e) {}

        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);

        delete sessions[clientId];
        starting.delete(clientId);

        try { var sp = require('../bot/statusPoster'); sp.stopStatusPoster(clientId); } catch(e) {}

        if (loggedOut) {
          clearAuthFromDB(clientId);
          broadcast(clientId, 'fatal', { reason: 'logged_out' });
          delete retryInfo[clientId];
          return;
        }

        var info = retryInfo[clientId] || { count: 0, delay: 5000 };
        retryInfo[clientId] = info;

        if (info.count >= 10) {
          console.log('[SessionManager] Max retries reached for', clientId);
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
        try { await replyEngine.handleMessage(sock, msg, clientId); }
        catch(e) { console.error('[SessionManager] ReplyEngine error:', e.message); }
      }
    });

  } catch(err) {
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
  } catch(e) {}
  delete sessions[clientId];
  starting.delete(clientId);
  delete retryInfo[clientId];
  delete latestQR[clientId];
}

async function clearSession(clientId) {
  await stopSession(clientId);
  await clearAuthFromDB(clientId);
}

function getSession(clientId) {
  return (sessions[clientId] && sessions[clientId].sock) ? sessions[clientId].sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting ' + activeClients.length + ' session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var client = activeClients[i];
    try {
      await startSession(client.id);
      console.log('[SessionManager] Started session for', client.business_name || client.id);
    } catch(err) {
      console.error('[SessionManager] Failed to start session for', client.id + ':', err.message);
    }
  }
}

function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn);
  global.qrListeners.set(clientId, all);
  if (latestQR[clientId]) {
    try { fn('qr', { qr: latestQR[clientId] }); } catch(e) {}
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
