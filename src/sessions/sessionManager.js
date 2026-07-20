// ============================================================
//  ForgeBot — Session Manager  v3
//  File location: src/sessions/sessionManager.js
//
//  KEY FIX: saves Baileys auth to Supabase (whatsapp_sessions table)
//  instead of Railway's ephemeral filesystem, so WhatsApp stays
//  connected across every Railway redeploy.
//  Also updates clients.whatsapp_connected on connect/disconnect
//  so bootAllSessions() can auto-restore on startup.
// ============================================================

if (typeof crypto === 'undefined') { global.crypto = require('crypto').webcrypto; }

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const { Boom }         = require('@hapi/boom');
const pino             = require('pino');
const replyEngine      = require('../bot/replyEngine');

const sessions = {};
const starting  = new Set();
const retryInfo = {};
const latestQR  = {};
const logger    = pino({ level: 'silent' });

let _sb = null;
function getSB() {
  if (!_sb) _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _sb;
}

function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  (global.qrListeners.get(clientId) || []).forEach(function(fn) { try { fn(event, data); } catch(e){} });
}

function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info = retryInfo[clientId]; info.count++;
  var d = info.delay; info.delay = Math.min(info.delay * 2, 60000); return d;
}

async function setConnected(clientId, val) {
  try { await getSB().from('clients').update({ whatsapp_connected: val }).eq('id', clientId); } catch(e){}
}

async function useSupabaseAuthState(clientId) {
  var sb = getSB();
  var row = await sb.from('whatsapp_sessions').select('auth_creds,auth_keys').eq('client_id', clientId).single();
  var creds, keys = {};
  if (row.data && row.data.auth_creds) {
    try { creds = JSON.parse(JSON.stringify(row.data.auth_creds), BufferJSON.reviver); } catch(e) { creds = initAuthCreds(); }
    try { keys  = JSON.parse(JSON.stringify(row.data.auth_keys || {}), BufferJSON.reviver); } catch(e) { keys = {}; }
    console.log('[SessionManager] Loaded Supabase auth for', clientId);
  } else {
    creds = initAuthCreds(); console.log('[SessionManager] No saved auth for', clientId, '— QR needed');
  }
  async function save() {
    try {
      await sb.from('whatsapp_sessions').upsert({
        client_id: clientId,
        auth_creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
        auth_keys:  JSON.parse(JSON.stringify(keys,  BufferJSON.replacer)),
        updated_at: new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch(e) { console.error('[SessionManager] save error:', e.message); }
  }
  var state = {
    creds: creds,
    keys: {
      get: function(type, ids) {
        var d = {}; ids.forEach(function(id) { if (keys[type] && keys[type][id] != null) d[id] = keys[type][id]; }); return d;
      },
      set: async function(data) {
        for (var cat in data) { keys[cat] = keys[cat] || {}; for (var id in data[cat]) { if (data[cat][id] != null) keys[cat][id] = data[cat][id]; else delete keys[cat][id]; } }
        await save();
      }
    }
  };
  return { state: state, saveCreds: save };
}

async function clearSupabaseAuth(clientId) {
  try { await getSB().from('whatsapp_sessions').delete().eq('client_id', clientId); } catch(e){}
}

async function startSession(clientId) {
  if (sessions[clientId] && sessions[clientId].sock) return;
  if (starting.has(clientId)) return;
  starting.add(clientId);
  try {
    if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
    console.log('[SessionManager] Starting for', clientId, '(attempt #' + (retryInfo[clientId].count + 1) + ')');
    broadcast(clientId, 'status', { status: 'connecting' });
    var { state, saveCreds } = await useSupabaseAuthState(clientId);
    var { version } = await fetchLatestBaileysVersion();
    var sock = makeWASocket({ version, logger, auth: state, printQRInTerminal: false, browser: ['ForgeBot','Chrome','1.0.0'], connectTimeoutMs: 30000 });
    sessions[clientId] = { sock: sock };
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async function(update) {
      var { connection, lastDisconnect, qr } = update;
      if (qr) { latestQR[clientId] = qr; broadcast(clientId, 'qr', { qr: qr }); }
      if (connection === 'open') {
        console.log('[SessionManager] Connected:', clientId);
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 };
        await setConnected(clientId, true);
        broadcast(clientId, 'connected', { status: 'connected' });
      }
      if (connection === 'close') {
        var code = 0;
        try { if (lastDisconnect && lastDisconnect.error instanceof Boom) code = lastDisconnect.error.output.statusCode; } catch(e){}
        var loggedOut = (code === DisconnectReason.loggedOut);
        console.log('[SessionManager] Disconnected:', clientId, '| code:', code, '| loggedOut:', loggedOut);
        delete sessions[clientId]; starting.delete(clientId);
        if (loggedOut) { await clearSupabaseAuth(clientId); await setConnected(clientId, false); broadcast(clientId, 'fatal', { reason: 'logged_out' }); delete retryInfo[clientId]; return; }
        var info = retryInfo[clientId] || { count: 0, delay: 5000 }; retryInfo[clientId] = info;
        if (info.count >= 10) { await setConnected(clientId, false); broadcast(clientId, 'fatal', { reason: 'max_retries' }); delete retryInfo[clientId]; return; }
        var delay = getNextDelay(clientId);
        broadcast(clientId, 'reconnecting', { delay: delay, attempt: retryInfo[clientId].count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });
    sock.ev.on('messages.upsert', async function(payload) {
      if (payload.type !== 'notify') return;
      for (var i = 0; i < payload.messages.length; i++) {
        var msg = payload.messages[i];
        if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') continue;
        try { await replyEngine.handleMessage(sock, msg, clientId); } catch(e) { console.error('[SessionManager] ReplyEngine error:', e.message); }
      }
    });
  } catch(err) {
    console.error('[SessionManager] startSession error:', err.message);
    starting.delete(clientId); delete sessions[clientId];
    var info = retryInfo[clientId] || { count: 0, delay: 5000 }; retryInfo[clientId] = info;
    var delay = getNextDelay(clientId);
    setTimeout(function() { startSession(clientId); }, delay);
  } finally { starting.delete(clientId); }
}

async function stopSession(clientId) {
  try { if (sessions[clientId] && sessions[clientId].sock) await sessions[clientId].sock.logout(); } catch(e){}
  delete sessions[clientId]; starting.delete(clientId); delete retryInfo[clientId]; delete latestQR[clientId];
  await setConnected(clientId, false);
}

async function clearSession(clientId) { await stopSession(clientId); await clearSupabaseAuth(clientId); }

function getSession(clientId) { return (sessions[clientId] && sessions[clientId].sock) ? sessions[clientId].sock : null; }
function getAllSessions() { return Object.keys(sessions); }

async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting', activeClients.length, 'session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    try { await startSession(activeClients[i].id); } catch(e) { console.error('[SessionManager] Boot failed for', activeClients[i].id, ':', e.message); }
  }
}

function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || []; all.push(fn); global.qrListeners.set(clientId, all);
  if (latestQR[clientId]) { try { fn('qr', { qr: latestQR[clientId] }); } catch(e){} }
}

function unregisterQRListener(clientId, fn) {
  if (!global.qrListeners) return;
  global.qrListeners.set(clientId, (global.qrListeners.get(clientId) || []).filter(function(f) { return f !== fn; }));
}

module.exports = { startSession, stopSession, clearSession, getSession, getAllSessions, bootAllSessions, registerQRListener, unregisterQRListener };
