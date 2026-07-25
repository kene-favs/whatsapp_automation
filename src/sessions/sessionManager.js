// ============================================================
//  ForgeBot — sessionManager.js
//  File location: src/sessions/sessionManager.js
//
//  FIXES (Jul 2026):
//
//  FIX A — "Timed Out" errors on sock.sendMessage():
//    sessions[clientId] was set immediately after makeWASocket(),
//    BEFORE Baileys authenticates. getSession() returned a half-open
//    socket → every sendMessage() timed out after the session dropped.
//    Now: sessions[clientId] is marked connected:false on creation.
//    getSession() returns null until the 'open' event sets connected:true.
//    The connecting socket is still tracked to prevent double-starts.
//
//  FIX B — Session dies on every Railway restart:
//    useMultiFileAuthState wrote auth to sessions/{id}/ on the
//    container filesystem. Railway wipes that on every deploy.
//    Bot lost its WhatsApp pairing → new QR required every time.
//    Now: auth stored in whatsapp_sessions Supabase table.
//    Bot silently reconnects after restarts without a new QR scan.
//    Custom Buffer serialization used — does NOT depend on Baileys'
//    BufferJSON export (which may be undefined in some Baileys builds).
//
//  FIX C — keys.get/set not async, null deletions ignored:
//    Baileys key store methods must return Promises.
//    keys.set with null values should DELETE the key (Signal protocol).
// ============================================================

// Crypto polyfill — must be first
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }         = require('@hapi/boom');
const pino             = require('pino');
const { createClient } = require('@supabase/supabase-js');
const replyEngine      = require('../bot/replyEngine');

// sessions: clientId → { sock, connected }
//   connected:false = socket created but not yet authenticated
//   connected:true  = socket live and ready for sendMessage()
const sessions  = {};
const starting  = new Set();
const retryInfo = {};
const latestQR  = {};

const logger = pino({ level: 'silent' });

// ── Supabase client (lazy) ────────────────────────────────────
var _sb = null;
function getSB() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}

// ── Buffer-aware serialization (FIX C: no BufferJSON dependency) ──
// Baileys stores many objects as Node Buffers. We encode as base64.
function toJSON(obj) {
  try {
    return JSON.stringify(obj, function(key, val) {
      if (val == null) return val;
      if (Buffer.isBuffer(val)) return { __buf: val.toString('base64') };
      if (val instanceof Uint8Array) return { __buf: Buffer.from(val).toString('base64') };
      if (val && val.type === 'Buffer' && Array.isArray(val.data)) {
        return { __buf: Buffer.from(val.data).toString('base64') };
      }
      return val;
    });
  } catch (e) {
    console.error('[SM] toJSON error:', e.message);
    return null;
  }
}

function fromJSON(raw) {
  if (!raw) return null;
  try {
    var str = (typeof raw === 'string') ? raw : JSON.stringify(raw);
    return JSON.parse(str, function(key, val) {
      if (val && typeof val === 'object' && typeof val.__buf === 'string') {
        return Buffer.from(val.__buf, 'base64');
      }
      return val;
    });
  } catch (e) {
    console.error('[SM] fromJSON error:', e.message);
    return null;
  }
}

// ── Supabase auth state (replaces useMultiFileAuthState) ──────
// FIX B: stores Baileys auth in DB so Railway restarts don't kill sessions.
async function useSupabaseAuthState(clientId) {
  var sb = getSB();

  // Pull initAuthCreds from Baileys (handles different export styles)
  var baileysMod    = require('@whiskeysockets/baileys');
  var initAuthCreds = baileysMod.initAuthCreds || (baileysMod.default && baileysMod.default.initAuthCreds);
  if (!initAuthCreds) initAuthCreds = function() { return {}; };

  // Load saved state
  var row = null;
  try {
    var { data } = await sb
      .from('whatsapp_sessions')
      .select('auth_creds, auth_keys')
      .eq('client_id', clientId)
      .maybeSingle();
    row = data;
  } catch (e) {
    console.warn('[SM] Could not load auth for', clientId + ':', e.message);
  }

  var creds = (row && row.auth_creds) ? fromJSON(row.auth_creds) : null;
  if (!creds || typeof creds !== 'object') {
    creds = initAuthCreds();
    console.log('[SM] No saved creds for', clientId, '— QR required');
  } else {
    console.log('[SM] Restored saved creds for', clientId, '— attempting silent reconnect');
  }

  var keysStore = (row && row.auth_keys) ? fromJSON(row.auth_keys) : {};
  if (!keysStore || typeof keysStore !== 'object') keysStore = {};

  async function persistToDB() {
    try {
      var credsJSON = toJSON(creds);
      var keysJSON  = toJSON(keysStore);
      if (!credsJSON) return;
      await sb.from('whatsapp_sessions').upsert({
        client_id:  clientId,
        auth_creds: credsJSON,
        auth_keys:  keysJSON || '{}',
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch (e) {
      console.error('[SM] Persist error for', clientId + ':', e.message);
    }
  }

  // FIX C: async key store with proper null-deletion handling
  var state = {
    creds: creds,
    keys: {
      get: async function(type, ids) {
        var store = keysStore[type] || {};
        var out   = {};
        for (var i = 0; i < ids.length; i++) {
          var id = ids[i];
          if (store[id] != null) out[id] = store[id];
        }
        return out;
      },
      set: async function(data) {
        var changed = false;
        for (var type in data) {
          if (!keysStore[type]) keysStore[type] = {};
          var entries = data[type];
          for (var id in entries) {
            var val = entries[id];
            if (val != null) {
              keysStore[type][id] = val;
            } else {
              // null = Signal protocol delete
              delete keysStore[type][id];
            }
            changed = true;
          }
        }
        if (changed) await persistToDB();
      }
    }
  };

  return { state: state, saveCreds: persistToDB };
}

// ── Clear Supabase auth (forces new QR next boot) ────────────
async function clearSupabaseAuth(clientId) {
  try {
    await getSB().from('whatsapp_sessions')
      .update({ auth_creds: null, auth_keys: null })
      .eq('client_id', clientId);
    console.log('[SM] Cleared Supabase auth for', clientId);
  } catch (e) {
    console.error('[SM] Failed to clear Supabase auth for', clientId + ':', e.message);
  }
}

// ── Update connected flag in DB ───────────────────────────────
async function setConnected(clientId, val) {
  try {
    await getSB().from('clients').update({ whatsapp_connected: val }).eq('id', clientId);
  } catch (e) {}
}

function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info  = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000);
  return delay;
}

// ── Main: start or reuse session ─────────────────────────────
async function startSession(clientId) {
  // FIX A: return if fully connected
  if (sessions[clientId] && sessions[clientId].connected) return;

  // FIX A: return if currently connecting (connected:false = in progress)
  if (sessions[clientId] && sessions[clientId].connected === false) {
    console.log('[SM] Already connecting for', clientId);
    return;
  }

  if (starting.has(clientId)) {
    console.log('[SM] Already starting for', clientId);
    return;
  }
  starting.add(clientId);

  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    var retry = retryInfo[clientId];

    console.log('[SM] Starting session for', clientId, '(attempt #' + (retry.count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting', attempt: retry.count + 1 });

    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version }          = await fetchLatestBaileysVersion();

    var sock = makeWASocket({
      version:                        version,
      logger:                         logger,
      auth:                           state,
      printQRInTerminal:              false,
      browser:                        ['ForgeBot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs:               30000
    });

    // FIX A: mark as connecting (NOT yet usable for sendMessage)
    sessions[clientId] = { sock: sock, connected: false };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', function(update) {
      var connection     = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr            = update.qr;

      if (qr) {
        latestQR[clientId] = qr;
        console.log('[SM] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr: qr });
      }

      if (connection === 'open') {
        // FIX A: NOW the socket is ready — mark connected
        if (sessions[clientId]) sessions[clientId].connected = true;
        starting.delete(clientId);
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 };
        setConnected(clientId, true);
        console.log('[SM] Connected:', clientId);
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
        console.log('[SM] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);

        delete sessions[clientId];
        starting.delete(clientId);
        setConnected(clientId, false);

        if (loggedOut) {
          clearSupabaseAuth(clientId);
          broadcast(clientId, 'fatal', { reason: 'logged_out' });
          delete retryInfo[clientId];
          return;
        }

        var info = retryInfo[clientId] || { count: 0, delay: 5000 };
        retryInfo[clientId] = info;

        if (info.count >= 10) {
          console.log('[SM] Max retries reached for', clientId);
          broadcast(clientId, 'fatal', { reason: 'max_retries' });
          delete retryInfo[clientId];
          return;
        }

        if (info.count > 0 && info.count % 3 === 0) {
          clearSupabaseAuth(clientId);
        }

        var delay = getNextDelay(clientId);
        console.log('[SM] Retry #' + retryInfo[clientId].count + ' for', clientId, 'in', delay + 'ms');
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
        catch (e) { console.error('[SM] ReplyEngine error:', e.message); }
      }
    });

  } catch (err) {
    console.error('[SM] startSession error for', clientId + ':', err.message);
    starting.delete(clientId);
    delete sessions[clientId];
    var info  = retryInfo[clientId] || { count: 0, delay: 5000 };
    retryInfo[clientId] = info;
    var delay = getNextDelay(clientId);
    broadcast(clientId, 'reconnecting', { delay: delay, attempt: retryInfo[clientId].count });
    setTimeout(function() { startSession(clientId); }, delay);
  } finally {
    // Safety net — 'open'/'close' handlers also call this
    starting.delete(clientId);
  }
}

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

async function clearSession(clientId) {
  await stopSession(clientId);
  await clearSupabaseAuth(clientId);
}

// FIX A: only return socket when it's ACTUALLY connected (open event fired)
function getSession(clientId) {
  var s = sessions[clientId];
  return (s && s.sock && s.connected) ? s.sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  console.log('[SM] Booting ' + activeClients.length + ' session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var client = activeClients[i];
    try {
      await startSession(client.id);
      console.log('[SM] Started session for', client.business_name || client.id);
    } catch (err) {
      console.error('[SM] Failed to boot session for', client.id + ':', err.message);
    }
  }
}

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
