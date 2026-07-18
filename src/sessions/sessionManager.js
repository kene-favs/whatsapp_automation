const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const pino = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions = {}; // clientId → { sock, cleanup }
const logger = pino({ level: 'silent' });

// ── Helper: push an event to all SSE listeners waiting for this client's QR ──
function notifyQRListeners(clientId, payload) {
  const listeners = global.qrListeners?.get(clientId) || [];
  listeners.forEach(fn => { try { fn(payload); } catch (_) {} });
}

async function startSession(clientId, callbacks = {}) {
  // If already running, just return existing
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

    if (qr) {
      // Fire existing admin callback
      if (callbacks.onQR) callbacks.onQR(qr);
      // Fire SSE stream for onboard.html
      notifyQRListeners(clientId, { type: 'qr', qr });
    }

    if (connection === 'open') {
      console.log(`[ForgeBot] Client ${clientId} connected`);
      if (callbacks.onConnected) callbacks.onConnected();
      // Tell onboard.html the scan succeeded → show "Set Up My Bot" button
      notifyQRListeners(clientId, { type: 'connected' });
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : 0;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[ForgeBot] Client ${clientId} disconnected (code ${code}), reconnect=${shouldReconnect}`);

      if (callbacks.onDisconnected) callbacks.onDisconnected();
      // Tell onboard.html if still open
      notifyQRListeners(clientId, { type: 'disconnected' });
      delete sessions[clientId];

      if (shouldReconnect) {
        setTimeout(() => startSession(clientId, {}), 5000);
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

  // Cleanup function (closes SSE stream without killing session)
  return () => {};
}

async function stopSession(clientId) {
  if (sessions[clientId]?.sock) {
    await sessions[clientId].sock.logout();
    delete sessions[clientId];
  }
}

function getSession(clientId) {
  return sessions[clientId]?.sock || null;
}

function getAllSessions() {
  return Object.keys(sessions);
}

// Boot all active client sessions on server start
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

module.exports = { startSession, stopSession, getSession, getAllSessions, bootAllSessions };
