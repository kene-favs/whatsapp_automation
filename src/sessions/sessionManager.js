const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path    = require('path');
const fs      = require('fs');
const pino    = require('pino');
const replyEngine = require('../bot/replyEngine');

const sessions  = {};       // clientId → { sock, latestQR }
const starting  = new Set(); // mutex: clientIds currently being initialised
const retryInfo = {};       // clientId → { count, delay }
const logger    = pino({ level: 'silent' });

// ── Wipe session auth files ───────────────────────────────────────────────────
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

// ── Broadcast SSE event to all waiting QR-page clients ───────────────────────
function broadcast(clientId, event, data) {
  if (!global.qrListeners) return;
  const all = global.qrListeners.get(clientId) || [];
  all.forEach(function(fn) { try { fn(event, data); } catch (e) {} });
}

// ── Exponential backoff helper ────────────────────────────────────────────────
function nextDelay(clientId) {
  if (!retryInfo[clientId]) retryInfo[clientId] = { count: 0, delay: 5000 };
  retryInfo[clientId].count += 1;
  const d = retryInfo[clientId].delay;
  retryInfo[clientId].delay = Math.min(d * 2, 60000); // 5s → 10s → 20s → 40s → 60s cap
  return d;
}

function resetRetry(clientId) {
  retryInfo[clientId] = { count: 0, delay: 5000 };
}

// ── Start (or wake up) a WhatsApp session ────────────────────────────────────
async function startSession(clientId) {
  // MUTEX: prevent double-starts for the same client
  if (starting.has(clientId)) {
    console.log('[ForgeBot] startSession already in progress for', clientId, '— skipping');
    return;
  }

  // Already running — send cached QR to any waiting SSE clients
  if (sessions[clientId]?.sock) {
    if (sessions[clientId].latestQR) {
      broadcast(clientId, 'qr', { qr: sessions[clientId].latestQR });
    }
    return;
  }

  starting.add(clientId);
  console.log('[ForgeBot] Starting session for', clientId);

  try {
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
      browser: ['Ubuntu', 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 20000,
      defaultQueryTimeoutMs: 20000
    });

    sessions[clientId] = { sock, latestQR: null };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (sessions[clientId]) sessions[clientId].latestQR = qr;
        broadcast(clientId, 'qr', { qr: qr });
      }

      if (connection === 'open') {
        console.log('[ForgeBot] Client', clientId, 'connected ✓');
        resetRetry(clientId);
        if (sessions[clientId]) sessions[clientId].latestQR = null;
        broadcast(clientId, 'connected', { status: 'connected' });
        if (global.qrListeners) global.qrListeners.delete(clientId);
      }

      if (connection === 'close') {
        const err     = lastDisconnect?.error;
        const code    = err instanceof Boom ? err.output?.statusCode : 0;
        const errMsg  = err ? (err.message || String(err)) : 'none';
        const staleCodes = [DisconnectReason.loggedOut, DisconnectReason.connectionReplaced, 515];
        const isStale = staleCodes.includes(code);
        const delay   = nextDelay(clientId);
        const count   = retryInfo[clientId].count;

        console.log('[ForgeBot] Client', clientId, 'disconnected — code:', code, '| error:', errMsg, '| retry #' + count + ' in', delay/1000 + 's');

        delete sessions[clientId];

        if (isStale || count % 3 === 0) {
          // Clear stale/corrupt files every 3rd failure
          clearSessionFiles(clientId);
        }

        if (count >= 10) {
          // Too many failures — stop retrying, tell the client to refresh the page
          console.log('[ForgeBot] Giving up on', clientId, 'after', count, 'failures. User must refresh.');
          broadcast(clientId, 'fatal', { message: 'Connection could not be established. Please refresh the page to try again.' });
          resetRetry(clientId); // reset so manual refresh works
          return;
        }

        broadcast(clientId, 'reconnecting', { retryIn: delay, attempt: count });
        setTimeout(function() { startSession(clientId); }, delay);
      }
    });

    sock.ev.on('messages.upsert', async function({ messages, type }) {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;
        try { await replyEngine.handleMessage(sock, msg, clientId); } catch (e) {
          console.error('[ForgeBot] replyEngine error for', clientId, ':', e.message);
        }
      }
    });

  } catch (err) {
    console.error('[ForgeBot] startSession threw for', clientId, ':', err.message);
    delete sessions[clientId];
    const delay = nextDelay(clientId);
    broadcast(clientId, 'reconnecting', { retryIn: delay });
    setTimeout(function() { startSession(clientId); }, delay);
  } finally {
    starting.delete(clientId);
  }
}

async function stopSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { await sessions[clientId].sock.logout(); } catch (e) {}
    delete sessions[clientId];
  }
  resetRetry(clientId);
}

async function clearSession(clientId) {
  if (sessions[clientId]?.sock) {
    try { sessions[clientId].sock.end(undefined, { reconnect: false }); } catch (e) {}
    delete sessions[clientId];
  }
  resetRetry(clientId);
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
