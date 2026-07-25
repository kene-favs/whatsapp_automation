// ============================================================
//  ForgeBot — Session Manager (whatsapp-web.js edition)
//  File location: src/sessions/sessionManager.js
// ============================================================

'use strict';

const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const fs   = require('fs');
const path = require('path');
// Use the existing Supabase module — no second client needed
const db = require('../db/supabase');
const replyEngine = require('../bot/replyEngine');

// ── RemoteAuth store backed by Supabase ───────────────────────
// Uses the db helper functions so we don't need a second Supabase client.
class SupabaseStore {
  async sessionExists({ session }) {
    try { return await db.wwebjsSessionExists(session); }
    catch (e) { console.error('[SessionManager] sessionExists error:', e.message); return false; }
  }

  async save({ session }) {
    try {
      var zipPath = path.join('/tmp', 'wwebjs-auth', session + '.zip');
      if (!fs.existsSync(zipPath)) {
        console.warn('[SessionManager] save() zip not found:', zipPath);
        return;
      }
      var base64 = fs.readFileSync(zipPath).toString('base64');
      await db.saveWwebjsSession(session, base64);
      console.log('[SessionManager] Session saved to Supabase for', session);
    } catch (e) {
      console.error('[SessionManager] save() error:', e.message);
    }
  }

  async extract({ session, path: destPath }) {
    try {
      var base64 = await db.loadWwebjsSession(session);
      if (!base64) return;
      fs.mkdirSync(destPath, { recursive: true });
      fs.writeFileSync(path.join(destPath, session + '.zip'), Buffer.from(base64, 'base64'));
      console.log('[SessionManager] Session extracted from Supabase for', session);
    } catch (e) {
      console.error('[SessionManager] extract() error:', e.message);
    }
  }

  async delete({ session }) {
    try { await db.deleteWwebjsSession(session); }
    catch (e) { console.error('[SessionManager] delete() error:', e.message); }
  }
}

const store = new SupabaseStore();

// ── Session registry ──────────────────────────────────────────
var sessions = {}; // clientId → { client, sock, connected }
var starting = new Set();

// ── JID helpers ───────────────────────────────────────────────
// wwebjs uses @c.us; replyEngine / clientRoutes use @s.whatsapp.net
function toWwebjs(jid) {
  if (!jid || jid === 'status@broadcast') return jid;
  return jid.replace(/@s\.whatsapp\.net$/, '@c.us');
}
function toBaileys(jid) {
  if (!jid || jid === 'status@broadcast') return jid;
  return jid.replace(/@c\.us$/, '@s.whatsapp.net');
}

// ── Baileys-compatible sock wrapper ───────────────────────────
// replyEngine / statusScheduler call:
//   sock.sendMessage(jid, { text }) / { image: {url}, caption } / { audio, ptt } / { document }
//   sock.sendPresenceUpdate('composing' | 'paused', jid)
// We translate these to the wwebjs Client API.

function makeSock(client) {
  return {
    sendMessage: async function(jid, content) {
      var to = toWwebjs(jid);

      // Text
      if (content.text) {
        return await client.sendMessage(to, content.text);
      }

      // Image with URL
      if (content.image && content.image.url) {
        var media = await MessageMedia.fromUrl(content.image.url, { unsafeMime: true });
        return await client.sendMessage(to, media, { caption: content.caption || '' });
      }

      // Image from Buffer
      if (content.image && Buffer.isBuffer(content.image)) {
        var media = new MessageMedia('image/jpeg', content.image.toString('base64'));
        return await client.sendMessage(to, media, { caption: content.caption || '' });
      }

      // Audio / voice note
      if (content.audio && Buffer.isBuffer(content.audio)) {
        var mime  = content.mimetype || 'audio/ogg; codecs=opus';
        var media = new MessageMedia(mime, content.audio.toString('base64'));
        return await client.sendMessage(to, media, { sendAudioAsVoice: !!content.ptt });
      }

      // Document / file
      if (content.document && Buffer.isBuffer(content.document)) {
        var mime  = content.mimetype || 'application/octet-stream';
        var fname = content.fileName || 'file';
        var media = new MessageMedia(mime, content.document.toString('base64'), fname);
        return await client.sendMessage(to, media);
      }

      // Fallback: send as plain text
      var fallback = content.caption || '';
      if (fallback) return await client.sendMessage(to, fallback);
    },

    sendPresenceUpdate: async function(status, jid) {
      try {
        var chat = await client.getChatById(toWwebjs(jid));
        if (status === 'composing') await chat.sendStateTyping();
        else await chat.clearState();
      } catch (e) {
        // Non-critical — ignore silently
      }
    },

    profilePictureUrl: async function(jid) {
      try { return await client.getProfilePicUrl(toWwebjs(jid)); }
      catch (e) { return null; }
    }
  };
}

// ── Build a Baileys-style msg from a wwebjs Message ──────────
function buildMsg(msg) {
  var jid     = toBaileys(msg.from || '');
  var content = {};

  switch (msg.type) {
    case 'chat':
      content.conversation = msg.body || '';
      break;
    case 'image':
      content.imageMessage = { caption: msg.body || '' };
      break;
    case 'ptt':
      content.audioMessage = { ptt: true };
      break;
    case 'audio':
      content.audioMessage = { ptt: false };
      break;
    default:
      content.conversation = msg.body || '';
  }

  return {
    key: {
      remoteJid: jid,
      fromMe:    msg.fromMe,
      id:        (msg.id && (msg.id._serialized || msg.id.id)) || ''
    },
    message:          content,
    pushName:         msg.notifyName || '',
    messageTimestamp: Math.floor(Date.now() / 1000),
    _wwebjsMsg:       msg  // keep original in case voiceHandler needs it
  };
}

// ── startSession ──────────────────────────────────────────────
async function startSession(clientId, callbacks) {
  callbacks = callbacks || {};

  if (sessions[clientId] && sessions[clientId].connected) {
    if (callbacks.onConnected) callbacks.onConnected();
    return function() {};
  }

  if (starting.has(clientId)) return function() {};
  starting.add(clientId);

  var dataPath = '/tmp/wwebjs-auth';
  fs.mkdirSync(dataPath, { recursive: true });

  var client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             clientId,
      store:                store,
      dataPath:             dataPath,
      backupSyncIntervalMs: 300000  // backup every 5 minutes
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    }
  });

  var sock = makeSock(client);
  sessions[clientId] = { client: client, sock: sock, connected: false };
  starting.delete(clientId);

  client.on('qr', function(qr) {
    console.log('[SessionManager] QR ready for client', clientId);
    if (callbacks.onQR) callbacks.onQR(qr);
  });

  client.on('ready', function() {
    console.log('[SessionManager] ✅ Connected:', clientId);
    sessions[clientId].connected = true;
    if (callbacks.onConnected) callbacks.onConnected();
  });

  client.on('auth_failure', function(msg) {
    console.error('[SessionManager] Auth failed for', clientId, '—', msg);
    if (sessions[clientId]) sessions[clientId].connected = false;
    if (callbacks.onDisconnected) callbacks.onDisconnected();
  });

  client.on('disconnected', function(reason) {
    console.log('[SessionManager] Disconnected:', clientId, '| reason:', reason);
    if (sessions[clientId]) sessions[clientId].connected = false;
    if (callbacks.onDisconnected) callbacks.onDisconnected();
    delete sessions[clientId];

    if (reason !== 'LOGOUT') {
      console.log('[SessionManager] Reconnecting', clientId, 'in 10s...');
      setTimeout(function() { startSession(clientId, {}); }, 10000);
    }
  });

  client.on('message', async function(msg) {
    if (msg.fromMe) return;
    if (msg.from === 'status@broadcast') return;

    try {
      var baileysMsg = buildMsg(msg);
      console.log('[SessionManager] 📩 Message for', clientId, 'from', baileysMsg.key.remoteJid);
      await replyEngine.handleMessage(sock, baileysMsg, clientId);
    } catch (err) {
      console.error('[SessionManager] handleMessage error for', clientId, ':', err.message);
    }
  });

  client.initialize().catch(function(err) {
    console.error('[SessionManager] initialize() error for', clientId, ':', err.message);
    delete sessions[clientId];
  });

  return function() {};
}

// ── stopSession ───────────────────────────────────────────────
async function stopSession(clientId) {
  if (sessions[clientId] && sessions[clientId].client) {
    try { await sessions[clientId].client.destroy(); } catch (e) {}
    delete sessions[clientId];
  }
}

// ── clearSession — logout + wipe saved session ────────────────
async function clearSession(clientId) {
  if (sessions[clientId] && sessions[clientId].client) {
    try { await sessions[clientId].client.logout(); } catch (e) {}
    delete sessions[clientId];
  }
  await store.delete({ session: clientId });
  console.log('[SessionManager] Session cleared for', clientId);
}

// ── getSession — returns the sock wrapper or null ─────────────
function getSession(clientId) {
  var s = sessions[clientId];
  if (!s || !s.connected) return null;
  return s.sock;
}

function getAllSessions() {
  return Object.keys(sessions);
}

// ── bootAllSessions — called once at server startup ───────────
async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Booting', activeClients.length, 'session(s)...');
  for (var i = 0; i < activeClients.length; i++) {
    var c = activeClients[i];
    try {
      await startSession(c.id, {});
      console.log('[SessionManager] Started session for', c.business_name || c.id);
    } catch (err) {
      console.error('[SessionManager] Failed to start session for', c.id, ':', err.message);
    }
  }
}

// Legacy shims
function registerQRListener() {}
function unregisterQRListener() {}

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
