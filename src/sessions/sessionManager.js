// ============================================================
//  ForgeBot — sessionManager.js  (FINAL v6 — pushName + lid resolution)
//  File location: src/sessions/sessionManager.js
//
//  @lid resolution strategy (four-layer):
//  1. Direct contactMap  (contacts.upsert gave us id+lid together)
//  2. Store lid scan     (iterate store.contacts, compare .lid field)
//  3. pushName match     (message.pushName == store contact name → phone JID)
//  4. Time-window        (contacts.upsert fired within 5 s of the message)
//  Fallback: send to @lid as-is.
// ============================================================

if (typeof crypto === 'undefined') global.crypto = require('crypto').webcrypto;

var baileysLib               = require('@whiskeysockets/baileys');
var makeWASocket              = baileysLib.makeWASocket || baileysLib.default || baileysLib;
var DisconnectReason          = baileysLib.DisconnectReason;
var fetchLatestBaileysVersion = baileysLib.fetchLatestBaileysVersion;
var makeInMemoryStore         = baileysLib.makeInMemoryStore;

var { Boom }         = require('@hapi/boom');
var pino             = require('pino');
var { createClient } = require('@supabase/supabase-js');
var replyEngine      = require('../bot/replyEngine');

var sessions    = {};
var starting    = new Set();
var retryInfo   = {};
var latestQR    = {};
var contactMaps = {};   // clientId → Map<lidJid, phoneJid>
var stores      = {};   // clientId → makeInMemoryStore
var recentPhones = {};  // clientId → [{jid, ts}]

var silentLogger = pino({ level: 'silent' });

// ── Supabase ──────────────────────────────────────────────────
var _sb = null;
function getSB() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}

// ── JSON helpers (Buffer-safe) ────────────────────────────────
function toJSON(obj) {
  try {
    return JSON.stringify(obj, function(k, v) {
      if (v == null) return v;
      if (Buffer.isBuffer(v)) return { __buf: v.toString('base64') };
      if (typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data))
        return { __buf: Buffer.from(v.data).toString('base64') };
      if (v instanceof Uint8Array) return { __buf: Buffer.from(v).toString('base64') };
      return v;
    });
  } catch (e) { return null; }
}
function fromJSON(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), function(k, v) {
      if (v && typeof v === 'object' && typeof v.__buf === 'string')
        return Buffer.from(v.__buf, 'base64');
      return v;
    });
  } catch (e) { return null; }
}

// ── Supabase auth state ───────────────────────────────────────
async function useSupabaseAuthState(clientId) {
  var sb = getSB();
  var initAuthCreds = baileysLib.initAuthCreds || function() { return {}; };

  var row = null;
  try {
    var { data } = await sb
      .from('whatsapp_sessions')
      .select('auth_creds, auth_keys')
      .eq('client_id', clientId)
      .maybeSingle();
    row = data;
  } catch (e) { console.warn('[SessionManager] Cannot load auth:', e.message); }

  var creds = (row && row.auth_creds) ? fromJSON(row.auth_creds) : null;
  if (!creds || typeof creds !== 'object') {
    creds = initAuthCreds();
    console.log('[SessionManager] No saved creds for', clientId, '— QR required');
  } else {
    console.log('[SessionManager] Restored saved creds for', clientId);
  }

  var keysStore = {};
  if (row && row.auth_keys) {
    var p = fromJSON(row.auth_keys);
    if (p && typeof p === 'object') keysStore = p;
  }

  async function persist() {
    try {
      var cj = toJSON(creds); if (!cj) return;
      await sb.from('whatsapp_sessions').upsert({
        client_id: clientId, auth_creds: cj,
        auth_keys: toJSON(keysStore) || '{}',
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch (e) { console.error('[SessionManager] Persist error:', e.message); }
  }

  var keys = {
    get: async function(type, ids) {
      var s = keysStore[type] || {}, r = {};
      ids.forEach(function(id) { if (s[id] != null) r[id] = s[id]; });
      return r;
    },
    set: async function(data) {
      var changed = false;
      Object.keys(data).forEach(function(type) {
        if (!keysStore[type]) keysStore[type] = {};
        Object.keys(data[type]).forEach(function(id) {
          var v = data[type][id];
          if (v != null) { keysStore[type][id] = v; changed = true; }
          else { delete keysStore[type][id]; changed = true; }
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
  } catch (e) {}
}
async function setConnected(clientId, val) {
  try { await getSB().from('clients').update({ whatsapp_connected: !!val }).eq('id', clientId); } catch (e) {}
}
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  (global.qrListeners.get(clientId) || []).forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}
function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info = retryInfo[clientId]; info.count++;
  var d = info.delay; info.delay = Math.min(info.delay * 2, 60000); return d;
}

// ── Contact map builders ──────────────────────────────────────
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.includes('@') ? jid : jid + '@s.whatsapp.net';
}

function processContactList(clientId, contacts) {
  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
  if (!recentPhones[clientId]) recentPhones[clientId] = [];
  var map = contactMaps[clientId];
  var now = Date.now();
  var withLid = 0, withPhone = 0;

  (contacts || []).forEach(function(c) {
    var phone = c.id  ? normalizeJid(c.id)  : null;
    var lid   = c.lid ? (c.lid.includes('@') ? c.lid : c.lid + '@lid') : null;

    if (phone && lid && phone.endsWith('@s.whatsapp.net')) {
      map.set(lid, phone);
      withLid++;
    }
    if (phone && !lid && phone.endsWith('@s.whatsapp.net')) {
      recentPhones[clientId].push({ jid: phone, ts: now });
      withPhone++;
    }
  });

  // Keep recentPhones fresh
  recentPhones[clientId] = recentPhones[clientId].filter(function(e) { return (now - e.ts) < 10000; });

  if (withLid > 0) console.log('[SessionManager] Built', withLid, 'lid→phone mappings');
  console.log('[SessionManager] contacts sync:', (contacts||[]).length, 'total,', withLid, 'with lid,', withPhone, 'phone-only');
}

// ── @lid → phone JID resolution (four strategies) ────────────
function resolveJid(clientId, jid, pushName) {
  if (!jid || !jid.endsWith('@lid')) return jid;

  // Strategy 1: direct lid map (populated from contacts.upsert id+lid pairs)
  var map = contactMaps[clientId];
  if (map && map.get(jid)) {
    var r1 = map.get(jid);
    console.log('[SessionManager] ✅ S1 contactMap:', jid, '→', r1);
    return r1;
  }

  var store = stores[clientId];
  var allContacts = store && store.contacts ? Object.values(store.contacts) : [];

  // Strategy 2: scan all store.contacts for a contact whose .lid field matches
  for (var i = 0; i < allContacts.length; i++) {
    var c = allContacts[i];
    if (!c.lid || !c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
    var clid = c.lid.includes('@') ? c.lid : c.lid + '@lid';
    if (clid === jid) {
      console.log('[SessionManager] ✅ S2 store.lid scan:', jid, '→', c.id);
      if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
      contactMaps[clientId].set(jid, c.id);
      return c.id;
    }
  }

  // Strategy 3: pushName match — works for saved contacts
  // Message.pushName == contact display name → find their phone JID
  if (pushName) {
    var nameMatches = allContacts.filter(function(c) {
      return c.id && c.id.endsWith('@s.whatsapp.net') &&
        (c.name === pushName || c.notify === pushName || c.verifiedName === pushName);
    });
    if (nameMatches.length === 1) {
      var r3 = nameMatches[0].id;
      console.log('[SessionManager] ✅ S3 pushName "' + pushName + '":', jid, '→', r3);
      if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
      contactMaps[clientId].set(jid, r3);
      return r3;
    }
    if (nameMatches.length > 1) {
      // Ambiguous — pick the one whose name is an EXACT match over notify match
      var exact = nameMatches.filter(function(c) { return c.name === pushName; });
      if (exact.length === 1) {
        var r3b = exact[0].id;
        console.log('[SessionManager] ✅ S3 pushName exact "' + pushName + '":', jid, '→', r3b);
        if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
        contactMaps[clientId].set(jid, r3b);
        return r3b;
      }
      console.log('[SessionManager] ⚠️  S3 pushName "' + pushName + '" ambiguous (' + nameMatches.length + ' matches)');
    }
  }

  // Strategy 4: time-window correlation
  var now2 = Date.now();
  var fresh = (recentPhones[clientId] || []).filter(function(e) { return (now2 - e.ts) < 5000; });
  if (fresh.length === 1) {
    var r4 = fresh[0].jid;
    console.log('[SessionManager] ✅ S4 time-correlation:', jid, '→', r4);
    if (!contactMaps[clientId]) contactMaps[clientId] = new Map();
    contactMaps[clientId].set(jid, r4);
    recentPhones[clientId] = [];
    return r4;
  }

  console.log('[SessionManager] ⚠️  @lid unresolved:', jid, '| store contacts:', allContacts.length,
    '| pushName:', pushName || '(none)');
  return jid;
}

// ── Start session ─────────────────────────────────────────────
async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].connected) return;
  if (sessions[clientId] && sessions[clientId].sock) return;
  if (starting.has(clientId)) return;
  starting.add(clientId);

  if (!contactMaps[clientId]) contactMaps[clientId] = new Map();

  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    console.log('[SessionManager] Starting session for', clientId, '(attempt #' + (retryInfo[clientId].count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting' });

    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version }          = await fetchLatestBaileysVersion();

    var store = null;
    if (makeInMemoryStore) {
      try { store = makeInMemoryStore({ logger: silentLogger }); stores[clientId] = store; }
      catch (e) { console.warn('[SessionManager] makeInMemoryStore unavailable:', e.message); }
    }

    var sock = makeWASocket({
      version,
      logger:                        silentLogger,
      auth:                          state,
      printQRInTerminal:             false,
      browser:                       ['ForgeBot', 'Chrome', '122.0.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs:              60000,
      getMessage: async function(key) {
        if (store) {
          try {
            var m = await store.loadMessage(key.remoteJid, key.id);
            if (m && m.message) return m.message;
          } catch (e) {}
        }
        return { conversation: '' };
      }
    });

    if (store) store.bind(sock.ev);

    sessions[clientId] = { sock, connected: false };
    starting.delete(clientId);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.upsert', function(contacts) {
      processContactList(clientId, contacts);
    });
    sock.ev.on('contacts.update', function(updates) {
      processContactList(clientId, updates);
    });

    sock.ev.on('connection.update', async function(update) {
      var { connection, lastDisconnect, qr } = update;

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
        try { if (lastDisconnect && lastDisconnect.error instanceof Boom) code = lastDisconnect.error.output.statusCode; } catch (e) {}
        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code);

        delete sessions[clientId]; delete stores[clientId];
        starting.delete(clientId);
        setConnected(clientId, false);

        if (loggedOut) {
          clearSupabaseAuth(clientId);
          broadcast(clientId, 'fatal', { reason: 'logged_out' });
          delete retryInfo[clientId]; return;
        }

        var info = retryInfo[clientId] || { count: 0, delay: 5000 };
        retryInfo[clientId] = info;
        if (info.count >= 10) { broadcast(clientId, 'fatal', { reason: 'max_retries' }); delete retryInfo[clientId]; return; }
        if (info.count > 0 && info.count % 3 === 0) clearSupabaseAuth(clientId);

        var delay = getNextDelay(clientId);
        console.log('[SessionManager] Retry #' + retryInfo[clientId].count + ' in', delay + 'ms');
        broadcast(clientId, 'reconnecting', { delay, attempt: retryInfo[clientId].count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });

    sock.ev.on('messages.upsert', async function(payload) {
      if (payload.type !== 'notify') return;
      for (var i = 0; i < payload.messages.length; i++) {
        var msg = payload.messages[i];
        if (!msg.message || msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        var originalJid = msg.key.remoteJid;
        var pushName    = msg.pushName || null;

        // Resolve @lid → phone JID (4 strategies)
        var resolvedJid = resolveJid(clientId, originalJid, pushName);

        console.log('[SessionManager] 📩 Message for', clientId, 'from', originalJid,
          resolvedJid !== originalJid ? '→ ' + resolvedJid : '(unresolved)');

        if (resolvedJid !== originalJid) {
          msg = Object.assign({}, msg, { key: Object.assign({}, msg.key, { remoteJid: resolvedJid }) });
        }

        try { await replyEngine.handleMessage(sock, msg, clientId); }
        catch (e) { console.error('[SessionManager] ReplyEngine error:', e.message); }
      }
    });

  } catch (err) {
    console.error('[SessionManager] startSession error:', err.message);
    starting.delete(clientId); delete sessions[clientId];
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    var delay = getNextDelay(clientId);
    setTimeout(function() { startSession(clientId); }, delay);
  }
}

async function stopSession(clientId) {
  try { if (sessions[clientId] && sessions[clientId].sock) await sessions[clientId].sock.logout(); } catch (e) {}
  delete sessions[clientId]; delete stores[clientId];
  starting.delete(clientId); delete retryInfo[clientId]; delete latestQR[clientId];
}
async function clearSession(clientId) { await stopSession(clientId); await clearSupabaseAuth(clientId); }
function getSession(clientId) { var s = sessions[clientId]; return (s && s.sock && s.connected) ? s.sock : null; }
function getAllSessions() { return Object.keys(sessions); }

async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting', activeClients.length, 'session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    try { await startSession(activeClients[i].id); }
    catch (e) { console.error('[SessionManager] Boot failed for', activeClients[i].id + ':', e.message); }
  }
}

function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn); global.qrListeners.set(clientId, all);
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
