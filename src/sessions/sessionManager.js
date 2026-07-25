// ============================================================
//  ForgeBot — sessionManager.js  (Supabase Auth + @lid fix)
//  File location: src/sessions/sessionManager.js
//
//  ROOT CAUSE OF "sent OK but no DM received":
//  Baileys receives messages from @lid JIDs (WhatsApp Linked Identity).
//  Replying to @lid silently succeeds at the API level but WhatsApp
//  never delivers the message — @lid is a receive-only identifier.
//  You must send to the @s.whatsapp.net (phone-based) JID.
//
//  FIX: Listen to contacts.upsert to build @lid→phone mapping.
//       Resolve @lid → @s.whatsapp.net before passing to replyEngine.
// ============================================================

// ── Crypto polyfill — MUST be first ──
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom }  = require('@hapi/boom');
const pino      = require('pino');
const { createClient } = require('@supabase/supabase-js');
const replyEngine = require('../bot/replyEngine');

const sessions    = {};    // clientId → { sock, connected }
const starting    = new Set();
const retryInfo   = {};
const latestQR    = {};
const contactMaps = {};    // clientId → Map<@lid, @s.whatsapp.net>

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
  } catch (e) { return null; }
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
  } catch (e) { return null; }
}

// ── Supabase-backed Baileys auth state ────────────────────────
async function useSupabaseAuthState(clientId) {
  var sb = getSB();
  var _baileys      = require('@whiskeysockets/baileys');
  var initAuthCreds = _baileys.initAuthCreds || (_baileys.default && _baileys.default.initAuthCreds);
  if (!initAuthCreds) initAuthCreds = function() { return {}; };

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

  var creds = null;
  if (row && row.auth_creds) creds = fromJSON(row.auth_creds);
  if (!creds || typeof creds !== 'object') {
    creds = initAuthCreds();
    console.log('[SessionManager] No saved creds for', clientId, '— QR required');
  } else {
    console.log('[SessionManager] Restored saved creds for', clientId, '— attempting silent reconnect');
  }

  var keysStore = {};
  if (row && row.auth_keys) {
    var parsed = fromJSON(row.auth_keys);
    if (parsed && typeof parsed === 'object') keysStore = parsed;
  }

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
        if (store[ids[i]] != null) result[ids[i]] = store[ids[i]];
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
    await getSB().from('clients')
      .update({ whatsapp_connected: !!val })
      .eq('id', clientId);
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

// ── @lid → @s.whatsapp.net resolution ────────────────────────
function normalizeJid(jid) {
  if (!jid) return jid;
  if (!jid.includes('@')) return jid + '@s.whatsapp.net';
  return jid;
}

function updateContactMap(clientId, contacts) {
  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
  var map = contactMaps[clientId];
  var added = 0;
  contacts.forEach(function(c) {
    // c.id = @s.whatsapp.net JID, c.lid = @lid JID
    if (c.id && c.lid) {
      var phoneJid = normalizeJid(c.id);
      var lidJid   = c.lid.includes('@') ? c.lid : c.lid + '@lid';
      if (!phoneJid.endsWith('@s.whatsapp.net')) return; // skip non-phone JIDs
      map.set(lidJid, phoneJid);
      added++;
    }
  });
  if (added > 0) console.log('[SessionManager] Contact map updated for', clientId, '— total mapped:', map.size);
}

function resolveJid(clientId, jid) {
  if (!jid || !jid.endsWith('@lid')) return jid;
  var map = contactMaps[clientId];
  if (!map) return jid;
  var resolved = map.get(jid);
  if (resolved) {
    console.log('[SessionManager] Resolved @lid → phone:', jid, '→', resolved);
    return resolved;
  }
  // @lid not in map yet — will send to @lid (may not deliver)
  console.log('[SessionManager] ⚠️  @lid not mapped yet, sending as-is:', jid);
  return jid;
}

// ── Main: start or reuse session ─────────────────────────────
async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].connected) return;
  if (sessions[clientId] && sessions[clientId].sock) return;
  if (starting.has(clientId)) {
    console.log('[SessionManager] Already starting for', clientId);
    return;
  }
  starting.add(clientId);

  // Initialise contact map for this client
  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();

  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    var retry = retryInfo[clientId];
    console.log('[SessionManager] Starting session for', clientId, '(attempt #' + (retry.count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting', attempt: retry.count + 1 });

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

    sessions[clientId] = { sock: sock, connected: false };
    starting.delete(clientId);

    sock.ev.on('creds.update', saveCreds);

    // ── Build @lid→phone map from contact sync ────────────────
    // Fires during initial WhatsApp sync and when new contacts message
    sock.ev.on('contacts.upsert', function(contacts) {
      updateContactMap(clientId, contacts);
    });

    sock.ev.on('contacts.update', function(updates) {
      updateContactMap(clientId, updates);
    });

    sock.ev.on('connection.update', async function(update) {
      var connection     = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr             = update.qr;

      if (qr) {
        latestQR[clientId] = qr;
        console.log('[SessionManager] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr: qr });
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
          if (lastDisconnect && lastDisconnect.error instanceof Boom) {
            code = lastDisconnect.error.output.statusCode;
          }
        } catch (e) {}

        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);

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
          broadcast(clientId, 'fatal', { reason: 'max_retries' });
          delete retryInfo[clientId];
          return;
        }

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
        if (!msg.message) continue;
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        var originalJid = msg.key.remoteJid;

        // ── KEY FIX: resolve @lid → @s.whatsapp.net ──────────
        // @lid is WhatsApp's internal Linked Identity. Sending to @lid
        // succeeds at the API level but is silently dropped by WhatsApp.
        // We must use the phone-based @s.whatsapp.net JID for sending.
        var resolvedJid = resolveJid(clientId, originalJid);

        // Rewrite remoteJid in the message so replyEngine sends to the correct JID
        if (resolvedJid !== originalJid) {
          msg = Object.assign({}, msg, {
            key: Object.assign({}, msg.key, { remoteJid: resolvedJid })
          });
        }

        console.log('[SessionManager] 📩 Message for', clientId, 'from', originalJid,
          resolvedJid !== originalJid ? '(resolved to ' + resolvedJid + ')' : '');

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
