// Polyfill Web Crypto API for Node.js < 19 (required by Baileys)
// MUST be at the very top, before any require()
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const pino = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions  = {};        // clientId → { sock, latestQR }
const starting  = new Set(); // mutex: clientIds currently being initialised
const retryInfo = {};        // clientId → { count, delay }
const logger    = pino({ level: 'silent' });

// ── Helpers ────────────────────────────────────────────────────

function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) {
    try { fn(event, data); } catch (e) {}
  });
}

function resetRetry(clientId) {
  retryInfo[clientId] = { count: 0, delay: 5000 };
}

function nextRetry(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info = retryInfo[clientId];
  info.count += 1;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000); // cap at 60s
  return { count: info.count, delay: delay };
}

// Remove cached session files so a fresh QR is generated
function clearSessionFiles(clientId) {
  var fs  = require('fs');
  var dir = path.join(__dirname, '../../sessions', clientId);
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(function(f) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    });
  }
}

// ── Core ───────────────────────────────────────────────────────

async function startSession(clientId) {
  // Mutex: don't start the same client twice simultaneously
  if (starting.has(clientId)) {
    console.log('[ForgeBot] startSession(' + clientId + ') already starting — skip');
    return;
  }

  // Already connected — just resend the cached QR if one exists
  if (sessions[clientId] && sessions[clientId].sock) {
    if (sessions[clientId].latestQR) {
      broadcast(clientId, 'qr', { qr: sessions[clientId].latestQR });
    }
    return;
  }

  starting.add(clientId);
  console.log('[ForgeBot] startSession(' + clientId + ')');

  try {
    var authDir = path.join(__dirname, '../../sessions', clientId);
    var authState = await useMultiFileAuthState(authDir);
    var state     = authState.state;
    var saveCreds = authState.saveCreds;
    var version   = (await fetchLatestBaileysVersion()).version;

    var sock = makeWASocket({
      version: version,
      logger:  logger,
      auth:    state,
      printQRInTerminal: false,
      browser: ['ForgeBot', 'Chrome', '1.0.0'],
      generateHighQualityLinkPreview: false
    });

    sessions[clientId] = { sock: sock, latestQR: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', function(update) {
      var connection    = update.connection;
      var lastDisconnect = update.lastDisconnect;
      var qr            = update.qr;

      if (qr) {
        sessions[clientId].latestQR = qr;
        broadcast(clientId, 'qr', { qr: qr });
      }

      if (connection === 'open') {
        console.log('[ForgeBot] Client ' + clientId + ' connected');
        resetRetry(clientId);
        broadcast(clientId, 'connected', { clientId: clientId });
      }

      if (connection === 'close') {
        var err  = lastDisconnect ? lastDisconnect.error : null;
        var code = (err instanceof Boom) ? err.output.statusCode : 0;
        var errMsg = err ? (err.message || String(err)) : 'none';

        var loggedOut = code === DisconnectReason.loggedOut;
        console.log('[ForgeBot] Client ' + clientId + ' disconnected | code=' + code + ' | reason=' + errMsg);

        delete sessions[clientId];

        if (loggedOut) {
          console.log('[ForgeBot] Client ' + clientId + ' logged out — no reconnect');
          broadcast(clientId, 'disconnected', { reason: 'logged_out' });
          return;
        }

        var retry = nextRetry(clientId);

        if (retry.count >= 10) {
          console.error('[ForgeBot] Client ' + clientId + ' — gave up after 10 retries');
          broadcast(clientId, 'fatal', { reason: 'too_many_retries' });
          return;
        }

        // Every 3rd failure clear session files so WhatsApp issues a new QR
        if (retry.count % 3 === 0) {
          console.log('[ForgeBot] Clearing session files for ' + clientId + ' (attempt ' + retry.count + ')');
          clearSessionFiles(clientId);
        }

        console.log('[ForgeBot] error: ' + errMsg + ' | retry #' + retry.count + ' in ' + (retry.delay / 1000) + 's');
        broadcast(clientId, 'reconnecting', { retryIn: retry.delay, attempt: retry.count });
        setTimeout(function() { startSession(clientId); }, retry.delay);
      }
    });

    sock.ev.on('messages.upsert', async function(arg) {
      var messages = arg.messages;
      var type     = arg.type;
      if (type !== 'notify') return;
      for (var i = 0; i < messages.length; i++) {
        var msg = messages[i];
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        await replyEngine.handleMessage(sock, msg, clientId);
      }
    });

  } catch (err) {
    console.error('[ForgeBot] startSession error for ' + clientId + ':', err.message);
    var retry = nextRetry(clientId);
    broadcast(clientId, 'reconnecting', { retryIn: retry.delay, attempt: retry.count });
    setTimeout(function() { startSession(clientId); }, retry.delay);
  } finally {
    starting.delete(clientId);
  }
}

async function stopSession(clientId) {
  if (sessions[clientId] && sessions[clientId].sock) {
    try { await sessions[clientId].sock.logout(); } catch (e) {}
    delete sessions[clientId];
  }
}

function clearSession(clientId) {
  delete sessions[clientId];
  clearSessionFiles(clientId);
}

function getSession(clientId) {
  return sessions[clientId] ? sessions[clientId].sock : null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  if (!activeClients || !activeClients.length) {
    console.log('[ForgeBot] No previously connected clients to restore');
    return;
  }
  console.log('[ForgeBot] Booting ' + activeClients.length + ' client session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var client = activeClients[i];
    try {
      await startSession(client.id);
      console.log('[ForgeBot] Restored session for ' + client.business_name);
    } catch (err) {
      console.error('[ForgeBot] Failed to restore session for ' + client.id + ':', err.message);
    }
  }
}

module.exports = { startSession, stopSession, clearSession, getSession, getAllSessions, bootAllSessions };
