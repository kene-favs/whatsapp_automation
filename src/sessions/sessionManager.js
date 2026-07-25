// ============================================================
//  ForgeBot — sessionManager.js  (FINAL)
//  File location: src/sessions/sessionManager.js
//
//  @lid fix strategy (two-pronged):
//  1. contacts.upsert fires with the sender's phone JID at the SAME
//     time as messages.upsert. Even without a lid field we capture
//     the phone JID and correlate it to the @lid message by time.
//  2. makeInMemoryStore + getMessage callback prevents WhatsApp's
//     retry-request from failing silently, which was the main reason
//     "Fallback sent OK" never appeared in the recipient's DM.
// ============================================================

// ── Crypto polyfill — MUST be first ──
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

var baileysLib = require('@whiskeysockets/baileys');
// Support both default export patterns
var makeWASocket              = (baileysLib.default && baileysLib.default.makeWASocket)
                                  || baileysLib.makeWASocket
                                  || baileysLib.default
                                  || baileysLib;
var DisconnectReason          = baileysLib.DisconnectReason;
var fetchLatestBaileysVersion = baileysLib.fetchLatestBaileysVersion;
var makeInMemoryStore         = baileysLib.makeInMemoryStore;  // may be undefined

var { Boom }         = require('@hapi/boom');
var pino             = require('pino');
var { createClient } = require('@supabase/supabase-js');
var replyEngine      = require('../bot/replyEngine');

var sessions    = {};   // clientId → { sock, connected }
var starting    = new Set();
var retryInfo   = {};
var latestQR    = {};
var contactMaps = {};   // clientId → Map<lidJid, phoneJid>   (persists across messages)
var stores      = {};   // clientId → makeInMemoryStore instance

// Per-client queue of recently-seen phone JIDs from contacts.upsert
// (used to correlate with @lid messages when lid field is absent)
var recentPhones = {}; // clientId → Array<{ jid, ts }>

var silentLogger = pino({ level: 'silent' });

// ── Supabase ──────────────────────────────────────────────────
var _sb = null;
function getSB() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}

// ── Buffer-safe JSON ──────────────────────────────────────────
function toJSON(obj) {
  try {
    return JSON.stringify(obj, function(key, val) {
      if (val == null) return val;
      if (Buffer.isBuffer(val)) return { __buf: val.toString('base64') };
      if (typeof val === 'object' && val.type === 'Buffer' && Array.isArray(val.data))
        return { __buf: Buffer.from(val.data).toString('base64') };
      if (val instanceof Uint8Array) return { __buf: Buffer.from(val).toString('base64') };
      return val;
    });
  } catch (e) { return null; }
}

function fromJSON(raw) {
  if (!raw) return null;
  try {
    var str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return JSON.parse(str, function(key, val) {
      if (val && typeof val === 'object' && typeof val.__buf === 'string')
        return Buffer.from(val.__buf, 'base64');
      return val;
    });
  } catch (e) { return null; }
}

// ── Supabase auth state ───────────────────────────────────────
async function useSupabaseAuthState(clientId) {
  var sb = getSB();
  var initAuthCreds = baileysLib.initAuthCreds ||
    (baileysLib.default && baileysLib.default.initAuthCreds) ||
    function() { return {}; };

  var row = null;
  try {
    var { data } = await sb
      .from('whatsapp_sessions')
      .select('auth_creds, auth_keys')
      .eq('client_id', clientId)
      .maybeSingle();
    row = data;
  } catch (e) {
    console.warn('[SessionManager] Cannot load auth:', e.message);
  }

  var creds = (row && row.auth_creds) ? fromJSON(row.auth_creds) : null;
  if (!creds || typeof creds !== 'object') {
    creds = initAuthCreds();
    console.log('[SessionManager] No saved creds for', clientId, '— QR required');
  } else {
    console.log('[SessionManager] Restored saved creds for', clientId);
  }

  var keysStore = {};
  if (row && row.auth_keys) {
    var parsed = fromJSON(row.auth_keys);
    if (parsed && typeof parsed === 'object') keysStore = parsed;
  }

  async function persist() {
    try {
      var cj = toJSON(creds);
      var kj = toJSON(keysStore);
      if (!cj) return;
      await sb.from('whatsapp_sessions').upsert({
        client_id:  clientId,
        auth_creds: cj,
        auth_keys:  kj || '{}',
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch (e) {
      console.error('[SessionManager] Persist error:', e.message);
    }
  }

  var keys = {
    get: async function(type, ids) {
      var store  = keysStore[type] || {};
      var result = {};
      ids.forEach(function(id) {
        if (store[id] != null) result[id] = store[id];
      });
      return result;
    },
    set: async function(data) {
      var changed = false;
      Object.keys(data).forEach(function(type) {
        if (!keysStore[type]) keysStore[type] = {};
        Object.keys(data[type]).forEach(function(id) {
          var val = data[type][id];
          if (val != null) { keysStore[type][id] = val; changed = true; }
          else             { delete keysStore[type][id]; changed = true; }
        });
      });
      if (changed) await persist();
    }
  };

  return { state: { creds, keys }, saveCreds: persist };
}

async function clearSupabaseAuth(clientId) {
  try {
    await getSB().from('whatsapp_sessions')
      .update({ auth_creds: null, auth_keys: null, updated_at: new Date().toISOString() })
      .eq('client_id', clientId);
    console.log('[SessionManager] Cleared auth for', clientId);
  } catch (e) {}
}

async function setConnected(clientId, val) {
  try {
    await getSB().from('clients').update({ whatsapp_connected: !!val }).eq('id', clientId);
  } catch (e) {}
}

function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  (global.qrListeners.get(clientId) || []).forEach(function(fn) {
    try { fn(event, data); } catch (e) {}
  });
}

function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000);
  return delay;
}

// ── @lid → phone resolution ───────────────────────────────────
function normalizeJid(jid) {
  if (!jid) return jid;
  if (!jid.includes('@')) return jid + '@s.whatsapp.net';
  return jid;
}

// Called from contacts.upsert / contacts.update
// Stores mappings when BOTH id (phone) and lid are present.
// Also queues phone JIDs for time-window correlation.
function processContactList(clientId, contacts) {
  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
  var map = contactMaps[clientId];
  if (!recentPhones[clientId]) recentPhones[clientId] = [];

  var now = Date.now();

  (contacts || []).forEach(function(c) {
    var phoneJid = c.id  ? normalizeJid(c.id)  : null;
    var lidJid   = c.lid ? (c.lid.includes('@') ? c.lid : c.lid + '@lid') : null;

    // Case 1: both phone and lid present — direct mapping
    if (phoneJid && lidJid && phoneJid.endsWith('@s.whatsapp.net')) {
      map.set(lidJid, phoneJid);
      console.log('[SessionManager] Mapped:', lidJid, '→', phoneJid);
    }

    // Case 2: only phone JID present — queue it for correlation
    if (phoneJid && !lidJid && phoneJid.endsWith('@s.whatsapp.net')) {
      recentPhones[clientId].push({ jid: phoneJid, ts: now });
      // Only keep entries from last 10 seconds
      recentPhones[clientId] = recentPhones[clientId].filter(function(e) {
        return (now - e.ts) < 10000;
      });
    }
  });
}

// Resolve @lid to phone JID for sending
function resolveJid(clientId, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;

  // 1. Direct contactMap lookup (populated from contacts.upsert with lid field)
  var map = contactMaps[clientId];
  if (map && map.get(jid)) {
    var r = map.get(jid);
    console.log('[SessionManager] ✅ Resolved via map:', jid, '→', r);
    return r;
  }

  // 2. makeInMemoryStore contact lookup
  var store = stores[clientId];
  if (store && store.contacts) {
    var sc = store.contacts[jid];
    if (sc && sc.id && sc.id.endsWith('@s.whatsapp.net')) {
      console.log('[SessionManager] ✅ Resolved via store:', jid, '→', sc.id);
      if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
      contactMaps[clientId].set(jid, sc.id);
      return sc.id;
    }
  }

  // 3. Time-window correlation: use the most-recent phone JID from contacts.upsert
  // (contacts.upsert fires for new contacts at same time as messages.upsert)
  var recent = recentPhones[clientId] || [];
  var now    = Date.now();
  var fresh  = recent.filter(function(e) { return (now - e.ts) < 5000; });
  if (fresh.length === 1) {
    // Exactly one new phone JID arrived in the last 5 seconds — must be the sender
    var phoneJid = fresh[0].jid;
    console.log('[SessionManager] ✅ Resolved via time-correlation:', jid, '→', phoneJid);
    if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
    contactMaps[clientId].set(jid, phoneJid);
    recentPhones[clientId] = [];
    return phoneJid;
  }

  // 4. Fallback — send to @lid (may not deliver, but we've tried everything)
  console.log('[SessionManager] ⚠️  Could not resolve @lid:', jid, '— sending as-is');
  return jid;
}

// ── Main: start session ───────────────────────────────────────
async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].connected) return;
  if (sessions[clientId] && sessions[clientId].sock) return;
  if (starting.has(clientId)) return;
  starting.add(clientId);

  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();

  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    console.log('[SessionManager] Starting session for', clientId,
      '(attempt #' + (retryInfo[clientId].count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting', attempt: retryInfo[clientId].count + 1 });

    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version }          = await fetchLatestBaileysVersion();

    // Build in-memory store for getMessage callback (required for message retransmission)
    var store = null;
    if (makeInMemoryStore) {
      try {
        store = makeInMemoryStore({ logger: silentLogger });
        stores[clientId] = store;
      } catch (e) {}
    }

    var sock = makeWASocket({
      version,
      logger:                        silentLogger,
      auth:                          state,
      printQRInTerminal:             false,
      browser:                       ['ForgeBot', 'Chrome', '122.0.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs:              60000,
      // getMessage is REQUIRED for WhatsApp retry-request handling.
      // Without it, "sent OK" messages get silently dropped when WhatsApp
      // can't route them on the first attempt.
      getMessage: async function(key) {
        if (store) {
          try {
            var storedMsg = await store.loadMessage(key.remoteJid, key.id);
            if (storedMsg && storedMsg.message) return storedMsg.message;
          } catch (e) {}
        }
        // Return a stub so Baileys can still form the retry response
        return { conversation: '' };
      }
    });

    // Bind store BEFORE registering other listeners
    if (store) store.bind(sock.ev);

    sessions[clientId] = { sock, connected: false };
    starting.delete(clientId);

    sock.ev.on('creds.update', saveCreds);

    // ── Contact events → build @lid map ──────────────────────
    sock.ev.on('contacts.upsert', function(contacts) {
      processContactList(clientId, contacts);
    });

    sock.ev.on('contacts.update', function(updates) {
      processContactList(clientId, updates);
    });

    // ── Connection lifecycle ──────────────────────────────────
    sock.ev.on('connection.update', async function(update) {
      var connection     = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr             = update.qr;

      if (qr) {
        latestQR[clientId] = qr;
        console.log('[SessionManager] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr });
      }

      if (connection === 'open') {
        console.log('[SessionManager] ✅ Connected:', clientId);
        if (sessions[clientId]) sessions[clientId].connected = true;
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 };
        broadcast(clientId, 'connected', { status: 'connected' });
        setConnected(clientId, true);
      }

      if (connection === 'close') {
        var code = 0;
        try {
          if (lastDisconnect && lastDisconnect.error instanceof Boom)
            code = lastDisconnect.error.output.statusCode;
        } catch (e) {}

        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);

        delete sessions[clientId];
        delete stores[clientId];
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
          broadcast(clientId, 'fatal', { reason: 'max_retries' });
          delete retryInfo[clientId];
          return;
        }

        if (info.count > 0 && info.count % 3 === 0) clearSupabaseAuth(clientId);

        var delay = getNextDelay(clientId);
        console.log('[SessionManager] Retry #' + retryInfo[clientId].count + ' in', delay + 'ms');
        broadcast(clientId, 'reconnecting', { delay, attempt: retryInfo[clientId].count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });

    // ── Incoming messages ─────────────────────────────────────
    sock.ev.on('messages.upsert', async function(payload) {
      if (payload.type !== 'notify') return;
      var messages = payload.messages || [];

      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        var originalJid = msg.key.remoteJid;
        var resolvedJid = resolveJid(clientId, originalJid);

        console.log('[SessionManager] 📩 Message for', clientId,
          'from', originalJid,
          resolvedJid !== originalJid ? '→ resolved to ' + resolvedJid : '');

        // Rewrite key so replyEngine sends to the resolved JID
        if (resolvedJid !== originalJid) {
          msg = Object.assign({}, msg, {
            key: Object.assign({}, msg.key, { remoteJid: resolvedJid })
          });
        }

        try {
          await replyEngine.handleMessage(sock, msg, clientId);
        } catch (e) {
          console.error('[SessionManager] ReplyEngine error:', e.message);
        }
      }
    });

  } catch (err) {
    console.error('[SessionManager] startSession error:', err.message);
    starting.delete(clientId);
    delete sessions[clientId];
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    var delay = getNextDelay(clientId);
    setTimeout(function() { startSession(clientId); }, delay);
  }
}

// ── Public API ────────────────────────────────────────────────
async function stopSession(clientId) {
  try {
    if (sessions[clientId] && sessions[clientId].sock)
      await sessions[clientId].sock.logout();
  } catch (e) {}
  delete sessions[clientId];
  delete stores[clientId];
  starting.delete(clientId);
  delete retryInfo[clientId];
  delete latestQR[clientId];
}

async function clearSession(clientId) {
  await stopSession(clientId);
  await clearSupabaseAuth(clientId);
}

function getSession(clientId) {
  var s = sessions[clientId];
  return (s && s.sock && s.connected) ? s.sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting', activeClients.length, 'session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var client = activeClients[i];
    try {
      await startSession(client.id);
    } catch (err) {
      console.error('[SessionManager] Failed to start session for', client.id + ':', err.message);
    }
  }
}

function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn);
  global.qrListeners.set(clientId, all);
  if (latestQR[clientId]) { try { fn('qr', { qr: latestQR[clientId] }); } catch (e) {} }
}

function unregisterQRListener(clientId, fn) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  global.qrListeners.set(clientId, all.filter(function(f) { return f !== fn; }));
}

module.exports = {
  startSession, stopSession, clearSession,
  getSession, getAllSessions, bootAllSessions,
  registerQRListener, unregisterQRListener
};
