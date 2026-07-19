const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path    = require('path');
const fs      = require('fs');
const pino    = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions        = {}; // clientId → { sock, latestQR }
const disconnectCount = {}; // clientId → consecutive disconnect count
const logger = pino({ level: 'silent' });

// ── Wipe session auth files so next connect generates a fresh QR ──────────────
function clearSessionFiles(clientId) {
  const authDir = path.join(__dirname, '../../sessions', clientId);
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log('[ForgeBot] Cleared session files for', clientId);
    }
  } catch (e) {
    console.error('[ForgeBot] clearSessionFiles error:', e.message);
  }
}

// ── Broadcast an SSE event to all waiting QR-page clients ────────────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  const all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

async function startSession(clientId) {
  // Already running — nothing to do; SSE clients use global.qrListeners
  if (sessions[clientId]?.sock) {
    // If there's a cached QR (Baileys already generated one), send it immediately
    if (sessions[clientId].latestQR) {
      broadcast(clientId, 'qr', { qr: sessions[clientId].latestQR });
    }
    return;
  }

  const authDir = path.join(__dirname, '../../sessions', clientId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  // fetchLatestBaileysVersion makes a network call — fall back if it fails
  let version = [2, 3000, 1015901307];
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
  } catch (e) {
    console.warn('[ForgeBot] fetchLatestBaileysVersion failed, using fallback version');
  }

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['ForgeBot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false
  });

  sessions[clientId] = { sock, latestQR: null };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessions[clientId].latestQR = qr; // cache so late-joining SSE clients get it
      broadcast(clientId, 'qr', { qr: qr });
    }

    if (connection === 'open') {
      console.log('[ForgeBot] Client', clientId, 'connected');
      disconnectCount[clientId] = 0;
      sessions[clientId].latestQR = null;
      broadcast(clientId, 'connected', { status: 'connected' });
      if (global.qrListeners) global.qrListeners.delete(clientId);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;

      // Codes that mean creds are stale / invalid
      const staleCodes = [
        DisconnectReason.loggedOut,           // 401
        DisconnectReason.connectionReplaced,  // 440
        515,                                  // bad session
      ];
      const isStale = staleCodes.includes(code);

      // Also treat as stale after 3 consecutive failures (handles code 0 loops)
      disconnectCount[clientId] = (disconnectCount[clientId] || 0) + 1;
      const forceClear = disconnectCount[clientId] >= 3;

      console.log('[ForgeBot] Client', clientId, 'disconnected (code', code + '), stale=' + isStale + ', count=' + disconnectCount[clientId]);

      delete sessions[clientId];

      if (isStale || forceClear) {
        if (forceClear) console.log('[ForgeBot] Force-clearing session after', disconnectCount[clientId], 'failures');
        disconnectCount[clientId] = 0;
        clearSessionFiles(clientId);
        // Broadcast a 'reconnecting' hint so the UI keeps the spinner (not an error)
        broadcast(clientId, 'reconnecting', { status: 'reconnecting' });
        setTimeout(function() { startSession(clientId); }, 2000);
      } else {
        broadcast(clientId, 'disconnected', { status: 'disconnected' });
        setTimeout(function() { startSession(clientId); }, 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async function({ messages, type }) {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      await replyEngine.handleMessage(sock, msg, clientId);
    }
  });
}

async function stopSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { await sessions[clientId].sock.logout(); } catch (e) {}
    delete sessions[clientId];
  }
}

// Force-clear a session (stop + wipe files) — forces new QR on next connect
async function clearSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { sessions[clientId].sock.end(undefined, { reconnect: false }); } catch (e) {}
    delete sessions[clientId];
  }
  disconnectCount[clientId] = 0;
  clearSessionFiles(clientId);
}

function getSession(clientId) {
  return sessions[clientId]?.sock || null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  console.log('[ForgeBot] Booting', activeClients.length, 'client session(s)...');
  for (const client of activeClients) {
    try {
      await startSession(client.id);
      console.log('[ForgeBot] Started session for', client.business_name || client.id);
    } catch (err) {
      console.error('[ForgeBot] Failed to start session for', client.id + ':', err.message);
    }
  }
}

module.exports = { startSession, stopSession, clearSession, getSession, getAllSessions, bootAllSessions };
