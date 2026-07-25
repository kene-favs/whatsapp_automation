// ============================================================
//  ForgeBot — sessionManager.js  (Supabase Auth Edition)
//  File location: src/sessions/sessionManager.js
//
//  ROOT CAUSE FIXED:
//  - Old version used useMultiFileAuthState → ephemeral Railway filesystem
//  - Every Railway restart wiped auth files → bot needed QR scan again
//  - This version stores Baileys auth in Supabase (whatsapp_sessions table)
//  - One QR scan. Session survives restarts forever.
//
//  REQUIRES: migration.sql run in Supabase first (adds auth_creds, auth_keys)
// ============================================================

// ── Crypto polyfill — MUST be first line ──
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const pino      = require('pino');
const { createClient } = require('@supabase/supabase-js');
const replyEngine = require('../bot/replyEngine');

const sessions  = {};       // clientId → { sock, connected }
const starting  = new Set();
const retryInfo = {};
const latestQR  = {};

const logger = pino({ level: 'silent' });

// ── Supabase lazy init ────────────────────────────────────────
var _sb = null;
function getSB() {
  if (!_sb) {
    _sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _sb;
}

// ── Buffer-aware JSON helpers ─────────────────────────────────
// Baileys stores auth data as Node Buffers. We encode as base64 for DB storage.
function toJSON(obj) {
  try {
    return JSON.stringify(obj, function(key, val) {
      if (val == null) return val;
      if (Buffer.isBuffer(val)) return { __buf: val.toString('base64') };
      if (typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data)) {
        return { __buf: Buffer.from(val.data).toString('base64') };
      }
      if (val instanceof Uint8Array) return { __buf: Buffer.from(val).toString('base64') };
      return val;
    });
  } catch (e) {
    console.error('[SessionManager] toJSON error:', e.message);
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
    console.error('[SessionManager] fromJSON error:', e.message);
    return null;
  }
}

// ── Supabase-backed Baileys auth state ────────────────────────
async function useSupabaseAuthState(clientId) {
  var sb = getSB();
  var _baileys      = require('@whiskeysockets/baileys');
  var initAuthCreds = _baileys.initAuthCreds || (_baileys.default && _baileys.default.initAuthCreds);
  if (!initAuthCreds) initAuthCreds = function() { return {}; };

  // Load from DB
  var row = null;
  try {
    var { data } = await sb
      .from('whatsapp_sessions')
      .select('auth_creds, auth_keys')
      .eq('client_id', clientId)
      .maybeSingle();
    row = data;
  } catch (e) {
    console.warn('[SessionManager] Could not load Supabase auth for', clientId + ':', e.message);
  }

  // Restore or initialise creds
  var creds = null;
  if (row && row.auth_creds) {
    creds = fromJSON(row.auth_creds);
  }
  if (!creds || typeof creds !== 'object') {
    creds = initAuthCreds();
    console.log('[SessionManager] No saved creds for', clientId, '— fresh session (QR required)');
  } else {
    console.log('[SessionManager] Restored saved creds for', clientId, '— attempting silent reconnect');
  }

  // Restore or initialise key store
  var keysStore = {};
  if (row && row.auth_keys) {
    var parsed = fromJSON(row.auth_keys);
    if (parsed && typeof parsed === 'object') keysStore = parsed;
  }

  // Persist both creds and keys to Supabase
  async function persist() {
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
      console.error('[SessionManager] Auth persist failed for', clientId + ':', e.message);
    }
  }

  var keys = {
    get: async function(type, ids) {
      var store  = keysStore[type] || {};
      var result = {};
      for (var i = 0; i < ids.length; i++) {
        var id = ids[i];
        if (store[id] != null) result[id] = store[id];
      }
      return result;
    },
    set: async function(data) {
      var changed = false;
      Object.keys(data).forEach(function(type) {
        if (!keysStore[type]) keysStore[type] = {};
        Object.keys(data[type]).forEach(function(id) {
          var val = data[type][id];
          if (val != null) { keysStore[type][id] = val; changed = true; }
          else { delete keysStore[type][id]; changed = true; }
        });
      });
      if (changed) await persist();
    }
  };

  return { state: { creds: creds, keys: keys }, saveCreds: persist };
}

// ── Clear Supabase auth (forces new QR on next start) ────────
async function clearSupabaseAuth(clientId) {
  try {
    await getSB().from('whatsapp_sessions')
      .update({ auth_creds: null, auth_keys: null, updated_at: new Date().toISOString() })
      .eq('client_id', clientId);
    console.log('[SessionManager] Cleared auth for', clientId);
  } catch (e) {
    console.error('[SessionManager] Failed to clear auth for', clientId + ':', e.message);
  }
}

// ── Update whatsapp_connected in clients table ────────────────
async function setConnected(clientId, val) {
  try {
    await getSB().from('clients')
      .update({ whatsapp_connected: !!val })
      .eq('id', clientId);
  } catch (e) { /* non-critical */ }
}

// ── Broadcast to all SSE listeners ───────────────────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

// ── Exponential backoff delay ─────────────────────────────────
function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info  = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000); // cap at 60s
  return delay;
}

// ── Main: start or reuse session ─────────────────────────────
async function startSession(clientId) {
  // Already connected
  if (sessions[clientId] && sessions[clientId].connected) return;
  // Socket exists but still connecting (not yet open)
  if (sessions[clientId] && sessions[clientId].sock) return;
  // Mutex — already in startup phase
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

    // Use Supabase auth state (survives Railway restarts)
    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version }          = await fetchLatestBaileysVersion();

    var sock = makeWASocket({
      version,
      logger,
      auth:                          state,
      printQRInTerminal:             false,
      browser:                       ['ForgeBot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs:              30000
    });

    // Mark as starting (not yet connected)
    sessions[clientId] = { sock: sock, connected: false };
    starting.delete(clientId); // release mutex — socket is created

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async function(update) {
      var connection     = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr             = update.qr;

      // New QR
      if (qr) {
        latestQR[clientId] = qr;
        console.log('[SessionManager] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr: qr });
      }

      // Connected
      if (connection === 'open') {
        console.log('[SessionManager] ✅ Connected:', clientId);
        if (sessions[clientId]) sessions[clientId].connected = true;
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 };
        broadcast(clientId, 'connected', { status: 'connected' });
        setConnected(clientId, true); // update DB
      }

      // Disconnected
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
        setConnected(clientId, false); // update DB

        if (loggedOut) {
          // WhatsApp logged out this device — clear saved auth
          clearSupabaseAuth(clientId);
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

        // Every 3rd consecutive failure → clear saved auth (force fresh QR)
        if (info.count > 0 && info.count % 3 === 0) {
          clearSupabaseAuth(clientId);
        }

        var delay = getNextDelay(clientId);
        console.log('[SessionManager] Retry #' + retryInfo[clientId].count + ' for', clientId, 'in', delay + 'ms');
        broadcast(clientId, 'reconnecting', { delay: delay, attempt: retryInfo[clientId].count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });

    // ── Incoming messages ─────────────────────────────────────
    sock.ev.on('messages.upsert', async function(payload) {
      var messages = payload.messages || [];
      var type     = payload.type;
      if (type !== 'notify') return;

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        // Skip empty / protocol messages
        if (!msg.message) continue;
        // Skip messages sent by the bot itself
        if (msg.key.fromMe) continue;
        // Skip status broadcasts
        if (msg.key.remoteJid === 'status@broadcast') continue;

        console.log('[SessionManager] 📩 Message for', clientId, 'from', msg.key.remoteJid);

        try {
          await replyEngine.handleMessage(sock, msg, clientId);
        } catch (e) {
          console.error('[SessionManager] ReplyEngine error:', e.message);
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
}

// ── Clear session + auth ──────────────────────────────────────
async function clearSession(clientId) {
  await stopSession(clientId);
  await clearSupabaseAuth(clientId);
}

// ── Get active socket (only when fully connected) ─────────────
function getSession(clientId) {
  var s = sessions[clientId];
  return (s && s.sock && s.connected) ? s.sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

// ── Boot all clients on server start ─────────────────────────
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

// ── SSE listener management ───────────────────────────────────
function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn);
  global.qrListeners.set(clientId, all);
  // Send cached QR immediately to late-joining connections
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
