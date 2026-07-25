'use strict';

// ============================================================
//  ForgeBot — Session Manager (whatsapp-web.js edition)
//  File: src/sessions/sessionManager.js
//
//  RAM-safe boot: Chrome only starts for clients who already have
//  a saved session in Supabase OR when the client opens the
//  dashboard (on-demand via qr-stream route).
//  This means 0 Chrome instances at startup for new installs —
//  no more OOM crashes on Railway.
// ============================================================

var path         = require('path');
var fs           = require('fs');
var { Client, MessageMedia, RemoteAuth } = require('whatsapp-web.js');
var db           = require('../db/supabase');

// ── State ─────────────────────────────────────────────────────
// sessions: clientId → { client, sock, status: 'init'|'ready' }
var sessions = new Map();
// qrCache: clientId → latest QR string (so late SSE joiners get it)
var qrCache  = new Map();
// cbMap: clientId → [{ onQR?, onConnected?, onDisconnected? }]
var cbMap    = new Map();

// ── Supabase RemoteAuth store ─────────────────────────────────
class SupabaseStore {
  async sessionExists({ session }) {
    try { return await db.wwebjsSessionExists(session); }
    catch (e) { return false; }
  }
  async save({ session }) {
    var zipPath = path.join('/tmp', 'wwebjs-auth', session + '.zip');
    if (!fs.existsSync(zipPath)) return;
    var base64 = fs.readFileSync(zipPath).toString('base64');
    await db.saveWwebjsSession(session, base64);
  }
  async extract({ session, path: destPath }) {
    var base64 = await db.loadWwebjsSession(session);
    if (!base64) return;
    fs.mkdirSync(destPath, { recursive: true });
    fs.writeFileSync(
      path.join(destPath, session + '.zip'),
      Buffer.from(base64, 'base64')
    );
  }
  async delete({ session }) {
    await db.deleteWwebjsSession(session);
  }
}

// ── JID conversion ────────────────────────────────────────────
function toWwebjs(jid) {
  if (!jid) return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '@c.us')
            .replace(/@lid$/, '@c.us');
}

function toBaileys(jid) {
  if (!jid) return jid;
  return jid.replace(/@c\.us$/, '@s.whatsapp.net');
}

// ── Baileys-compatible sock wrapper ───────────────────────────
function makeSock(client) {
  return {
    sendMessage: async function(jid, content) {
      var to = toWwebjs(jid);
      if (content.text) {
        return await client.sendMessage(to, content.text);
      }
      if (content.image && content.image.url) {
        var media = await MessageMedia.fromUrl(content.image.url, { unsafeMime: true });
        return await client.sendMessage(to, media, { caption: content.caption || '' });
      }
      if (content.image && Buffer.isBuffer(content.image)) {
        var media = new MessageMedia('image/jpeg', content.image.toString('base64'));
        return await client.sendMessage(to, media, { caption: content.caption || '' });
      }
      if (content.audio && Buffer.isBuffer(content.audio)) {
        var media = new MessageMedia(
          content.mimetype || 'audio/ogg; codecs=opus',
          content.audio.toString('base64')
        );
        return await client.sendMessage(to, media, { sendAudioAsVoice: !!content.ptt });
      }
      if (content.document && Buffer.isBuffer(content.document)) {
        var media = new MessageMedia(
          content.mimetype || 'application/octet-stream',
          content.document.toString('base64'),
          content.fileName || 'file'
        );
        return await client.sendMessage(to, media);
      }
      var fallback = content.caption || '';
      if (fallback) return await client.sendMessage(to, fallback);
    },

    sendPresenceUpdate: async function(status, jid) {
      try {
        var chat = await client.getChatById(toWwebjs(jid));
        if (status === 'composing') await chat.sendStateTyping();
        else await chat.clearState();
      } catch (e) {}
    },

    profilePictureUrl: async function(jid) {
      try { return await client.getProfilePicUrl(toWwebjs(jid)); }
      catch (e) { return null; }
    }
  };
}

// ── Convert wwebjs message → Baileys-style for replyEngine ───
function buildMsg(msg, clientId) {
  return {
    key: {
      remoteJid: toBaileys(msg.from),
      fromMe:    msg.fromMe,
      id:        msg.id._serialized
    },
    message:          { conversation: msg.body || '' },
    messageTimestamp: Math.floor(msg.timestamp),
    pushName:         (msg._data && msg._data.notifyName) || '',
    clientId:         clientId
  };
}

// ── Fire registered callbacks ─────────────────────────────────
function fireCallbacks(clientId, event, data) {
  var cbs = cbMap.get(clientId) || [];
  cbs.forEach(function(cb) {
    try {
      if      (event === 'qr'           && cb.onQR)           cb.onQR(data);
      else if (event === 'connected'    && cb.onConnected)    cb.onConnected();
      else if (event === 'disconnected' && cb.onDisconnected) cb.onDisconnected();
    } catch(e) {}
  });
}

// ── Create and wire up a wwebjs Client ────────────────────────
function createWwebjsClient(clientId) {
  var client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             clientId,
      store:                new SupabaseStore(),
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    }
  });

  client.on('qr', function(qr) {
    console.log('[SessionManager] QR generated for client ' + clientId);
    qrCache.set(clientId, qr);
    fireCallbacks(clientId, 'qr', qr);
  });

  client.on('authenticated', function() {
    console.log('[SessionManager] Authenticated: ' + clientId);
  });

  client.on('ready', function() {
    console.log('[SessionManager] Ready: ' + clientId);
    qrCache.delete(clientId);
    var sock  = makeSock(client);
    var entry = sessions.get(clientId);
    if (entry) {
      entry.sock   = sock;
      entry.status = 'ready';
    } else {
      sessions.set(clientId, { client: client, sock: sock, status: 'ready' });
    }
    fireCallbacks(clientId, 'connected');
    cbMap.delete(clientId);
  });

  client.on('message', async function(msg) {
    if (msg.fromMe) return;
    try {
      var entry = sessions.get(clientId);
      if (!entry || !entry.sock) return;
      var replyEngine = require('../bot/replyEngine');
      await replyEngine.handleMessage(entry.sock, buildMsg(msg, clientId), clientId);
    } catch(e) {
      console.error('[SessionManager] Message handler error for ' + clientId + ':', e.message);
    }
  });

  client.on('disconnected', function(reason) {
    console.log('[SessionManager] Disconnected: ' + clientId + ' — ' + reason);
    fireCallbacks(clientId, 'disconnected');
    sessions.delete(clientId);
    qrCache.delete(clientId);
    if (reason !== 'LOGOUT') {
      console.log('[SessionManager] Will reconnect ' + clientId + ' in 10s');
      setTimeout(function() {
        startSession(clientId).catch(function(e) {
          console.error('[SessionManager] Reconnect error for ' + clientId + ':', e.message);
        });
      }, 10000);
    }
  });

  client.on('auth_failure', function(msg) {
    console.error('[SessionManager] Auth failure for ' + clientId + ':', msg);
    sessions.delete(clientId);
  });

  return client;
}

// ── Public: start (or attach to) a session ───────────────────
//
//  opts = { onQR(qr), onConnected(), onDisconnected() }
//
//  Behaviour:
//   - Already ready  → calls onConnected immediately, returns
//   - Already initing→ registers callbacks, sends cached QR if any
//   - No session     → starts Chrome in background, returns immediately
//
function startSession(clientId, opts) {
  // Register callbacks before anything else so we never miss an event
  if (opts) {
    var cbs = cbMap.get(clientId) || [];
    cbs.push(opts);
    cbMap.set(clientId, cbs);
  }

  var existing = sessions.get(clientId);

  if (existing && existing.status === 'ready') {
    if (opts && opts.onConnected) {
      try { opts.onConnected(); } catch(e) {}
    }
    return Promise.resolve(existing.sock);
  }

  if (existing && existing.status === 'init') {
    // Chrome is starting — send cached QR if available so dashboard isn't blank
    var cachedQR = qrCache.get(clientId);
    if (cachedQR && opts && opts.onQR) {
      try { opts.onQR(cachedQR); } catch(e) {}
    }
    return Promise.resolve();
  }

  // No session — start Chrome
  var client = createWwebjsClient(clientId);
  sessions.set(clientId, { client: client, sock: null, status: 'init' });

  client.initialize().catch(function(e) {
    console.error('[SessionManager] initialize() failed for ' + clientId + ':', e.message);
    sessions.delete(clientId);
  });

  return Promise.resolve();
}

// ── Public: stop session ──────────────────────────────────────
async function stopSession(clientId) {
  var entry = sessions.get(clientId);
  if (!entry) return;
  try { await entry.client.destroy(); } catch(e) {}
  sessions.delete(clientId);
  qrCache.delete(clientId);
  cbMap.delete(clientId);
}

// ── Public: stop + delete persisted session from Supabase ─────
async function clearSession(clientId) {
  await stopSession(clientId);
  try { await db.deleteWwebjsSession(clientId); } catch(e) {}
}

// ── Public: get sock if connected ────────────────────────────
function getSession(clientId) {
  var entry = sessions.get(clientId);
  if (!entry || entry.status !== 'ready') return null;
  return entry.sock;
}

// ── Public: all connected socks ───────────────────────────────
function getAllSessions() {
  var result = {};
  sessions.forEach(function(entry, clientId) {
    if (entry.status === 'ready') result[clientId] = entry.sock;
  });
  return result;
}

// ── Public: boot at startup — ONLY restore existing sessions ──
//
//  Clients WITHOUT a saved Supabase session are NOT started here.
//  Chrome will start on-demand when the client opens the dashboard.
//  This prevents 3×Chrome from eating all RAM on Railway at boot.
//
async function bootAllSessions() {
  try {
    var clients = await db.getActiveClients();
    console.log('[SessionManager] ' + clients.length + ' active client(s). Checking for saved sessions...');
    var booted = 0;
    for (var i = 0; i < clients.length; i++) {
      var clientId = clients[i].id;
      var hasSaved = false;
      try { hasSaved = await db.wwebjsSessionExists(clientId); } catch(e) {}
      if (hasSaved) {
        console.log('[SessionManager] Restoring saved session for ' + clientId);
        startSession(clientId);
        booted++;
        // Stagger Chrome launches
        if (booted > 0 && i < clients.length - 1) {
          await new Promise(function(r) { setTimeout(r, 15000); });
        }
      } else {
        console.log('[SessionManager] No saved session for ' + clientId + ' — will start on dashboard open');
      }
    }
    if (booted === 0) {
      console.log('[SessionManager] No saved sessions found. Open the dashboard to scan QR and connect.');
    }
  } catch(e) {
    console.error('[SessionManager] bootAllSessions error:', e.message);
  }
}

// ── Legacy shims ──────────────────────────────────────────────
function registerQRListener()   {}
function unregisterQRListener() {}

// ── Make getSession available globally for clientRoutes ───────
global.getSock = getSession;

// ── Exports ───────────────────────────────────────────────────
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
