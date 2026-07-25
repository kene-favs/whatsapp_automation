// ============================================================
//  ForgeBot — Session Manager (whatsapp-web.js edition)
//  File location: src/sessions/sessionManager.js
//
//  WHY this version exists:
//    Baileys v6 receives messages from WhatsApp @lid JIDs but
//    cannot reply to them — WhatsApp silently drops messages
//    sent TO @lid from linked devices.  whatsapp-web.js uses a
//    real Chrome browser running WhatsApp Web, which has the
//    full contact cache and always sends to @s.whatsapp.net.
//    This fixes the "Fallback sent OK but no reply in DM" bug.
//
//  Session persistence:
//    RemoteAuth stores a ZIP of the Chrome session in Supabase
//    (whatsapp_sessions.session_data TEXT column).
//    Railway restarts do NOT require re-scanning the QR code.
//
//  API compatibility:
//    getSession(clientId) returns a Baileys-style "sock" wrapper,
//    so replyEngine.js, statusScheduler.js, and clientRoutes.js
//    need NO changes to their sendMessage / sendPresenceUpdate calls.
//
//  BEFORE DEPLOYING — run this SQL in Supabase once:
//    ALTER TABLE whatsapp_sessions
//      ADD COLUMN IF NOT EXISTS session_data TEXT;
// ============================================================

'use strict';

const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const fs   = require('fs');
const path = require('path');
const { createClient: createSBClient } = require('@supabase/supabase-js');
const replyEngine = require('../bot/replyEngine');

// ── Supabase RemoteAuth store ─────────────────────────────────
// Stores/retrieves the wwebjs session ZIP in whatsapp_sessions table.
class SupabaseStore {
  constructor() { this._sb = null; }

  _supabase() {
    if (!this._sb) {
      this._sb = createSBClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY
      );
    }
    return this._sb;
  }

  // Returns true only if a wwebjs session zip exists (not just old Baileys rows)
  async sessionExists({ session }) {
    const { data } = await this._supabase()
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', session)
      .not('session_data', 'is', null)
      .maybeSingle();
    return !!data;
  }

  // wwebjs calls this after it creates the zip at dataPath/session.zip
  async save({ session }) {
    var zipPath = path.join('/tmp', 'wwebjs-auth', session + '.zip');
    if (!fs.existsSync(zipPath)) {
      console.warn('[SessionManager] save() called but zip not found:', zipPath);
      return;
    }
    var base64 = fs.readFileSync(zipPath).toString('base64');
    var { error } = await this._supabase()
      .from('whatsapp_sessions')
      .upsert({
        client_id:    session,
        session_data: base64,
        updated_at:   new Date().toISOString()
      }, { onConflict: 'client_id' });
    if (error) console.error('[SessionManager] save() Supabase error:', error.message);
    else console.log('[SessionManager] Session saved to Supabase for', session);
  }

  // wwebjs calls this on startup; we write the zip so wwebjs can unzip it
  async extract({ session, path: destPath }) {
    var { data, error } = await this._supabase()
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('client_id', session)
      .not('session_data', 'is', null)
      .maybeSingle();
    if (error || !data) return;
    fs.mkdirSync(destPath, { recursive: true });
    var zipPath = path.join(destPath, session + '.zip');
    fs.writeFileSync(zipPath, Buffer.from(data.session_data, 'base64'));
    console.log('[SessionManager] Session extracted from Supabase for', session);
  }

  async delete({ session }) {
    await this._supabase()
      .from('whatsapp_sessions')
      .update({ session_data: null })
      .eq('client_id', session);
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
// replyEngine calls:
//   sock.sendMessage(jid, { text }) / { image: {url}, caption } / { audio, ptt } / { document }
//   sock.sendPresenceUpdate('composing' | 'paused', jid)
// statusScheduler calls:
//   sock.sendMessage('status@broadcast', { text }) / { image: {url}, caption }
// We translate all of these to the wwebjs Client API.

function makeSock(client) {
  return {
    // ── sendMessage ───────────────────────────────────────────
    sendMessage: async function(jid, content) {
      var to = toWwebjs(jid); // 447xxx@c.us or status@broadcast

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
      var fallback = content.text || content.caption || '';
      if (fallback) return await client.sendMessage(to, fallback);
    },

    // ── sendPresenceUpdate ────────────────────────────────────
    // Shows / hides the typing indicator in the customer's chat.
    sendPresenceUpdate: async function(status, jid) {
      try {
        var chat = await client.getChatById(toWwebjs(jid));
        if (status === 'composing') await chat.sendStateTyping();
        else await chat.clearState();
      } catch (e) {
        // Non-critical — silently ignore
      }
    },

    // ── profilePictureUrl ─────────────────────────────────────
    profilePictureUrl: async function(jid) {
      try { return await client.getProfilePicUrl(toWwebjs(jid)); }
      catch (e) { return null; }
    }
  };
}

// ── Build a Baileys-style msg from a wwebjs Message ──────────
// replyEngine expects:
//   msg.key.remoteJid    — sender JID (@s.whatsapp.net format)
//   msg.key.fromMe
//   msg.message.conversation | extendedTextMessage.text
//   msg.message.imageMessage.caption
//   msg.message.audioMessage.ptt
//   msg.pushName
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
    // Keep original wwebjs msg in case voiceHandler or others need it
    _wwebjsMsg:       msg
  };
}

// ── startSession ──────────────────────────────────────────────
async function startSession(clientId, callbacks) {
  callbacks = callbacks || {};

  // Already connected — fire onConnected immediately and return
  if (sessions[clientId] && sessions[clientId].connected) {
    if (callbacks.onConnected) callbacks.onConnected();
    return function() {};
  }

  // Already starting — skip duplicate boot
  if (starting.has(clientId)) return function() {};
  starting.add(clientId);

  var dataPath = path.join('/tmp', 'wwebjs-auth');
  fs.mkdirSync(dataPath, { recursive: true });

  var client = new Client({
    authStrategy: new RemoteAuth({
      clientId:             clientId,
      store:                store,
      dataPath:             dataPath,
      backupSyncIntervalMs: 300000  // auto-backup every 5 minutes
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

  // Register BEFORE client.initialize() so we don't miss events
  sessions[clientId] = { client: client, sock: sock, connected: false };
  starting.delete(clientId);

  // ── QR code ───────────────────────────────────────────────
  client.on('qr', function(qr) {
    console.log('[SessionManager] QR ready for client', clientId);
    if (callbacks.onQR) callbacks.onQR(qr);
  });

  // ── Connected ─────────────────────────────────────────────
  client.on('ready', function() {
    console.log('[SessionManager] ✅ Connected:', clientId);
    sessions[clientId].connected = true;
    if (callbacks.onConnected) callbacks.onConnected();
  });

  // ── Auth failure ──────────────────────────────────────────
  client.on('auth_failure', function(msg) {
    console.error('[SessionManager] Auth failed for', clientId, '—', msg);
    if (sessions[clientId]) sessions[clientId].connected = false;
    if (callbacks.onDisconnected) callbacks.onDisconnected();
  });

  // ── Disconnected ──────────────────────────────────────────
  client.on('disconnected', function(reason) {
    console.log('[SessionManager] Disconnected:', clientId, '| reason:', reason);
    if (sessions[clientId]) sessions[clientId].connected = false;
    if (callbacks.onDisconnected) callbacks.onDisconnected();
    delete sessions[clientId];

    // Auto-reconnect unless the user deliberately logged out
    if (reason !== 'LOGOUT') {
      console.log('[SessionManager] Reconnecting', clientId, 'in 10s...');
      setTimeout(function() { startSession(clientId, {}); }, 10000);
    }
  });

  // ── Incoming messages ─────────────────────────────────────
  client.on('message', async function(msg) {
    // Ignore own messages and status broadcasts
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

  // Kick off Chrome + WhatsApp Web
  client.initialize().catch(function(err) {
    console.error('[SessionManager] initialize() error for', clientId, ':', err.message);
    delete sessions[clientId];
  });

  return function() {}; // cleanup noop (SSE stream close)
}

// ── stopSession ───────────────────────────────────────────────
async function stopSession(clientId) {
  if (sessions[clientId] && sessions[clientId].client) {
    try { await sessions[clientId].client.destroy(); } catch (e) {}
    delete sessions[clientId];
  }
}

// ── clearSession — logout + wipe saved session in Supabase ───
async function clearSession(clientId) {
  if (sessions[clientId] && sessions[clientId].client) {
    try { await sessions[clientId].client.logout(); } catch (e) {}
    delete sessions[clientId];
  }
  await store.delete({ session: clientId });
  console.log('[SessionManager] Session cleared for', clientId);
}

// ── getSession — returns the sock wrapper (or null) ──────────
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

// Legacy shim — some files import registerQRListener / unregisterQRListener
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
