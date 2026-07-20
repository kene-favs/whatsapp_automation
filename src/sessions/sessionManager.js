// ============================================================
//  ForgeBot — sessionManager.js
//  File location: src/sessions/sessionManager.js
//
//  Fixes vs original:
//   - Crypto polyfill (CRITICAL for Railway Node 18)
//   - global.qrListeners broadcast — SSE always gets QR even after retry
//   - latestQR cache — late-joining SSE connections get QR immediately
//   - Mutex (starting Set) — prevents double-session race condition
//   - Exponential backoff 5s→10s→20s→40s→60s cap
//   - Clears auth files every 3rd consecutive failure
//   - Sends fatal event after 10 retries
//   - All existing exports preserved + clearSession added
//   + statusPoster wired in (start on open, stop on close/logout/stop)
// ============================================================

// ── Crypto polyfill — MUST be first line before any imports ──
if (typeof crypto === 'undefined') {
  global.crypto = require('crypto').webcrypto;
}

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs   = require('fs');
const pino = require('pino');
const replyEngine = require('../bot/replyEngine');
const { startStatusPoster, stopStatusPoster } = require('../bot/statusPoster'); // ← ADDED

const sessions = {};  // clientId → { sock }
const starting  = new Set(); // mutex — prevents double-startSession
const retryInfo = {}; // clientId → { count, delay }
const latestQR  = {}; // clientId → last QR string (for late-joining SSE)

const logger = pino({ level: 'silent' });

// ── Broadcast to all SSE listeners for a client ──────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  var all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

// ── Retry delay with exponential backoff ─────────────────────
function getNextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  var info  = retryInfo[clientId];
  info.count++;
  var delay = info.delay;
  info.delay = Math.min(info.delay * 2, 60000); // cap at 60s
  return delay;
}

// ── Clear saved auth files (force fresh QR) ──────────────────
function clearAuthFiles(clientId) {
  try {
    var authDir = path.join(__dirname, '../../sessions', clientId);
    if (fs.existsSync(authDir)) {
      fs.readdirSync(authDir).forEach(function(f) {
        try { fs.unlinkSync(path.join(authDir, f)); } catch (e) {}
      });
      console.log('[SessionManager] Cleared auth files for', clientId);
    }
  } catch (e) {
    console.error('[SessionManager] Failed to clear auth for', clientId, e.message);
  }
}

// ── Main: start or reuse session ─────────────────────────────
async function startSession(clientId) {
  // Already connected — nothing to do
  if (sessions[clientId] && sessions[clientId].sock) {
    return;
  }

  // Mutex — prevent double-start
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

    var authDir = path.join(__dirname, '../../sessions', clientId);
    var { state, saveCreds } = await useMultiFileAuthState(authDir);
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

      // ── New QR received ──────────────────────────────────
      if (qr) {
        latestQR[clientId] = qr; // cache for late-joining SSE
        console.log('[SessionManager] QR ready for', clientId);
        broadcast(clientId, 'qr', { qr: qr });
      }

      // ── Connection opened ────────────────────────────────
      if (connection === 'open') {
        console.log('[SessionManager] Connected:', clientId);
        delete latestQR[clientId];
        retryInfo[clientId] = { count: 0, delay: 5000 }; // reset backoff
        broadcast(clientId, 'connected', { status: 'connected' });
        startStatusPoster(clientId, sock); // ← ADDED: kick off status poster
      }

      // ── Connection closed ────────────────────────────────
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
        stopStatusPoster(clientId); // ← ADDED: stop status poster on disconnect

        if (loggedOut) {
          // Logged out — clear files and notify SSE
          clearAuthFiles(clientId);
          broadcast(clientId, 'fatal', { reason: 'logged_out' });
          delete retryInfo[clientId];
          return;
        }

        var info = retryInfo[clientId] || { count: 0, delay: 5000 };
        retryInfo[clientId] = info;

        // After 10 retries send fatal
        if (info.count >= 10) {
          console.log('[SessionManager] Max retries reached for', clientId);
          broadcast(clientId, 'fatal', { reason: 'max_retries' });
          delete retryInfo[clientId];
          return;
        }

        // Clear auth files every 3rd failure (forces fresh QR)
        if (info.count > 0 && info.count % 3 === 0) {
          clearAuthFiles(clientId);
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
        catch (e) { console.error('[SessionManager] ReplyEngine error:', e.message); }
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
  stopStatusPoster(clientId); // ← ADDED: stop status poster before closing socket
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

// ── Clear auth + stop ─────────────────────────────────────────
async function clearSession(clientId) {
  await stopSession(clientId);
  clearAuthFiles(clientId);
}

// ── Get active socket ─────────────────────────────────────────
function getSession(clientId) {
  return (sessions[clientId] && sessions[clientId].sock) ? sessions[clientId].sock : null;
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

// ── Register SSE listener (called from qr-stream route) ──────
// Returns the cached QR if one exists (so late-joining connections get it)
function registerQRListener(clientId, fn) {
  if (!global.qrListeners) global.qrListeners = new Map();
  var all = global.qrListeners.get(clientId) || [];
  all.push(fn);
  global.qrListeners.set(clientId, all);
  // Send cached QR immediately if available
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
