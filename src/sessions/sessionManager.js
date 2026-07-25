'use strict';

// ============================================================
//  ForgeBot — Session Manager (whatsapp-web.js edition)
//  Replaces: src/sessions/sessionManager.js
//
//  Key changes from Baileys:
//   - Uses wwebjs + Puppeteer/Chrome (fixes @lid JID replies)
//   - RemoteAuth stores session ZIP in Supabase (survives Railway restarts)
//   - startSession(clientId, opts) accepts onQR/onConnected/onDisconnected
//   - Baileys-compatible sock wrapper so replyEngine needs zero changes
//   - global.getSock set so clientRoutes qr-stream check works
// ============================================================

var path           = require('path');
var fs             = require('fs');
var { Client, MessageMedia, RemoteAuth } = require('whatsapp-web.js');
var db             = require('../db/supabase');

// ── State ─────────────────────────────────────────────────────
// sessions: clientId → { client, sock, status: 'init'|'ready' }
var sessions  = new Map();
// qrCache: clientId → latest QR string (so late SSE joiners get QR immediately)
var qrCache   = new Map();
// cbMap: clientId → array of { onQR?, onConnected?, onDisconnected? }
var cbMap     = new Map();

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
  // @s.whatsapp.net → @c.us  |  @lid → strip and convert best-effort
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

// ── Convert wwebjs msg → Baileys-style for replyEngine ───────
function buildMsg(msg, clientId) {
  var from = toBaileys(msg.from);
  var msgContent = {};

  if (msg.hasMedia) {
    // Let replyEngine know there's media — but text body is the main trigger
    msgContent = { conversation: msg.body || '', hasMedia: true };
  } else {
    msgContent = { conversation: msg.body || '' };
  }

  return {
    key: {
      remoteJid: from,
      fromMe:    msg.fromMe,
      id:        msg.id._serialized
    },
    message:          msgContent,
    messageTimestamp: Math.floor(msg.timestamp),
    pushName:         (msg._data && msg._data.notifyName) || '',
    clientId:         clientId
  };
}

// ── Fire registered callbacks for a client ────────────────────
function fireCallbacks(clientId, event, data) {
  var cbs = cbMap.get(clientId) || [];
  cbs.forEach(function(cb) {
    try {
      if (event === 'qr'           && cb.onQR)           cb.onQR(data);
      else if (event === 'connected'    && cb.onConnected)    cb.onConnected();
      else if (event === 'disconnected' && cb.onDisconnected) cb.onDisconnected();
    } catch(e) {}
  });
}

// ── Create and wire up a wwebjs Client ────────────────────────
function createWwebjsClient(clientId) {
  var store  = new SupabaseStore();
  var client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             clientId,
      store:                store,
      backupSyncIntervalMs: 300000   // save session every 5 min
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

  // QR ready — cache it and fire callbacks
  client.on('qr', function(qr) {
    console.log('[SessionManager] QR generated for client ' + clientId);
    qrCache.set(clientId, qr);
    fireCallbacks(clientId, 'qr', qr);
  });

  // Authenticated but not yet ready
  client.on('authenticated', function() {
    console.log('[SessionManager] Authenticated: ' + clientId);
  });

  // WhatsApp Web fully ready — swap from init to ready state
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
    cbMap.delete(clientId);   // SSE connections already notified
  });

  // Incoming message → replyEngine
  client.on('message', async function(msg) {
    if (msg.fromMe) return;
    try {
      var entry = sessions.get(clientId);
      if (!entry || !entry.sock) return;
      var replyEngine = require('../bot/replyEngine');
      var fakeMsg     = buildMsg(msg, clientId);
      await replyEngine.handleMessage(entry.sock, fakeMsg, clientId);
    } catch(e) {
      console.error('[SessionManager] Message handler error for ' + clientId + ':', e.message);
    }
  });

  // Disconnected — clean up and auto-reconnect (unless logged out)
  client.on('disconnected', function(reason) {
    console.log('[SessionManager] Disconnected: ' + clientId + ' — reason:', reason);
    fireCallbacks(clientId, 'disconnected');
    sessions.delete(clientId);
    qrCache.delete(clientId);
    if (reason !== 'LOGOUT') {
      console.log('[SessionManager] Scheduling reconnect for ' + clientId);
      setTimeout(function() {
        startSession(clientId).catch(function(e) {
          console.error('[SessionManager] Reconnect error for ' + clientId + ':', e.message);
        });
      }, 8000);
    }
  });

  client.on('auth_failure', function(msg) {
    console.error('[SessionManager] Auth failure for ' + clientId + ':', msg);
    sessions.delete(clientId);
  });

  return client;
}

// ── Public: start (or attach callbacks to) a session ─────────
//
//  opts = { onQR(qr), onConnected(), onDisconnected() }
//
//  - Already ready:       fires onConnected immediately, returns
//  - Already initializing: registers callbacks, fires cached QR if exists, returns
//  - No session:          creates client + starts Chrome (async, returns quickly)
//
function startSession(clientId, opts) {
  // Register callbacks first so we don't miss events
  if (opts) {
    var cbs = cbMap.get(clientId) || [];
    cbs.push(opts);
    cbMap.set(clientId, cbs);
  }

  var existing = sessions.get(clientId);

  if (existing && existing.status === 'ready') {
    // Already connected — notify immediately
    if (opts && opts.onConnected) {
      try { opts.onConnected(); } catch(e) {}
    }
    return Promise.resolve(existing.sock);
  }

  if (existing && existing.status === 'init') {
    // Chrome is already starting — send cached QR if we have one
    var cachedQR = qrCache.get(clientId);
    if (cachedQR && opts && opts.onQR) {
      try { opts.onQR(cachedQR); } catch(e) {}
    }
    return Promise.resolve();
  }

  // No session at all — start one
  var client = createWwebjsClient(clientId);
  sessions.set(clientId, { client: client, sock: null, status: 'init' });

  // Initialize Chrome in the background — don't await here
  client.initialize().catch(function(e) {
    console.error('[SessionManager] initialize() failed for ' + clientId + ':', e.message);
    sessions.delete(clientId);
  });

  return Promise.resolve();
}

// ── Public: stop a session ────────────────────────────────────
async function stopSession(clientId) {
  var entry = sessions.get(clientId);
  if (!entry) return;
  try { await entry.client.destroy(); } catch(e) {}
  sessions.delete(clientId);
  qrCache.delete(clientId);
  cbMap.delete(clientId);
}

// ── Public: stop + wipe persisted session from Supabase ───────
async function clearSession(clientId) {
  await stopSession(clientId);
  try { await db.deleteWwebjsSession(clientId); } catch(e) {}
}

// ── Public: get sock if connected (null if init or absent) ────
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

// ── Public: boot all active clients at startup ────────────────
async function bootAllSessions() {
  try {
    var clients = await db.getActiveClients();
    console.log('[SessionManager] Booting ' + clients.length + ' session(s)');
    for (var i = 0; i < clients.length; i++) {
      var clientId = clients[i].id;
      console.log('[SessionManager] Starting session for ' + clientId);
      startSession(clientId);
      // Stagger Chrome launches to avoid RAM spikes
      if (i < clients.length - 1) {
        await new Promise(function(r) { setTimeout(r, 5000); });
      }
    }
  } catch(e) {
    console.error('[SessionManager] bootAllSessions error:', e.message);
  }
}

// ── Legacy shims (kept so nothing breaks) ─────────────────────
function registerQRListener()   {}
function unregisterQRListener() {}

// ── Make getSession available globally for clientRoutes ───────
//    The /api/client/qr-stream route checks: global.getSock && global.getSock(clientId)
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
