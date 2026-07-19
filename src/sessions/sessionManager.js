const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs   = require('fs');
const pino = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions = {}; // clientId → { sock }
const logger = pino({ level: 'silent' });

// ── Wipe session auth files so next connect gets a fresh QR ──────────────────
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

async function startSession(clientId, callbacks = {}) {
  // If already running, just return
  if (sessions[clientId]?.sock) {
    return () => {};
  }

  const authDir = path.join(__dirname, '../../sessions', clientId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['ForgeBot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false
  });

  sessions[clientId] = { sock };

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && callbacks.onQR) {
      callbacks.onQR(qr);
    }

    if (connection === 'open') {
      console.log(`[ForgeBot] Client ${clientId} connected`);
      if (callbacks.onConnected) callbacks.onConnected();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;

      // Codes that mean credentials are stale/invalid — must wipe and start fresh
      const staleCodes = [
        DisconnectReason.loggedOut,           // 401 — user logged out
        DisconnectReason.connectionReplaced,  // 440 — another device took over
        515,                                  // bad session / restart required
      ];
      const isStale = staleCodes.includes(code);

      console.log(`[ForgeBot] Client ${clientId} disconnected (code ${code}), stale=${isStale}`);

      if (callbacks.onDisconnected) callbacks.onDisconnected(isStale);
      delete sessions[clientId];

      if (isStale) {
        // Wipe stale creds then restart — will generate a fresh QR
        clearSessionFiles(clientId);
        setTimeout(() => startSession(clientId, callbacks), 2000);
      } else {
        // Network drop / normal close — reconnect with same creds
        // NOTE: pass callbacks so QR/connected events still reach the client
        setTimeout(() => startSession(clientId, callbacks), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      await replyEngine.handleMessage(sock, msg, clientId);
    }
  });

  return () => {};
}

async function stopSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { await sessions[clientId].sock.logout(); } catch (e) {}
    delete sessions[clientId];
  }
}

// Force-clear session (stop + wipe files) — used by admin or on demand
async function clearSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { sessions[clientId].sock.end(undefined, { reconnect: false }); } catch (e) {}
    delete sessions[clientId];
  }
  clearSessionFiles(clientId);
}

function getSession(clientId) {
  return sessions[clientId]?.sock || null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

async function bootAllSessions(activeClients) {
  console.log(`[ForgeBot] Booting ${activeClients.length} client session(s)...`);
  for (const client of activeClients) {
    try {
      await startSession(client.id, {});
      console.log(`[ForgeBot] Started session for ${client.business_name}`);
    } catch (err) {
      console.error(`[ForgeBot] Failed to start session for ${client.id}:`, err.message);
    }
  }
}

module.exports = { startSession, stopSession, clearSession, getSession, getAllSessions, bootAllSessions };
