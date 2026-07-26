// ============================================================
//  ForgeBot — sessionManager.js  (whatsapp-web.js edition)
//  File location: src/sessions/sessionManager.js
//  FIX: added message_create event — 'message' alone doesn't fire
//       in all wwebjs/Railway environments
// ============================================================
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const db           = require('../db/supabase');
const replyEngine  = require('../bot/replyEngine');

// ── JID helpers ───────────────────────────────────────────────
function toWwebjs(jid) {
  if (!jid) return jid;
  return jid.replace('@s.whatsapp.net', '@c.us').replace('@lid', '@c.us');
}
function toBaileys(jid) {
  if (!jid) return jid;
  return jid.replace('@c.us', '@s.whatsapp.net');
}

// ── In-memory state ───────────────────────────────────────────
const sessions  = new Map();
const qrCache   = new Map();
const cbMap     = new Map();

// ── Supabase session store ────────────────────────────────────
class SupabaseStore {
  constructor(clientId) { this.clientId = clientId; }

  async sessionExists({ session }) {
    try {
      var sb = db.getSupabase();
      var result = await sb.from('whatsapp_sessions')
        .select('client_id')
        .eq('client_id', this.clientId)
        .not('session_data', 'is', null)
        .maybeSingle();
      return !!(result.data);
    } catch (e) {
      console.error('[Store] sessionExists error:', e.message);
      return false;
    }
  }

  async save({ session }) {
    try {
      // wwebjs writes ZIP to .wwebjs_auth/session-<name>.zip
      // Try multiple possible paths
      var candidates = [
        path.join(process.cwd(), '.wwebjs_auth', 'session-' + session + '.zip'),
        path.join('/tmp', 'session-' + session + '.zip'),
        path.join(process.cwd(), 'session-' + session + '.zip'),
      ];

      var zipPath = null;
      for (var i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
          zipPath = candidates[i];
          break;
        }
      }

      if (!zipPath) {
        // Also try searching in .wwebjs_auth directory for any matching zip
        var authDir = path.join(process.cwd(), '.wwebjs_auth');
        if (fs.existsSync(authDir)) {
          var files = fs.readdirSync(authDir);
          var match = files.find(function(f) { return f.includes(session) && f.endsWith('.zip'); });
          if (match) zipPath = path.join(authDir, match);
        }
      }

      if (!zipPath) {
        console.warn('[Store] Session ZIP not found for', session, '— skipping save');
        return;
      }

      var data = fs.readFileSync(zipPath).toString('base64');
      var sb = db.getSupabase();
      await sb.from('whatsapp_sessions').upsert({
        client_id:    this.clientId,
        session_data: data,
        updated_at:   new Date().toISOString()
      }, { onConflict: 'client_id' });
      console.log('[Store] Session saved for', this.clientId);
    } catch (e) {
      console.error('[Store] save error:', e.message);
    }
  }

  async extract({ session, path: extractPath }) {
    try {
      var sb = db.getSupabase();
      var result = await sb.from('whatsapp_sessions')
        .select('session_data')
        .eq('client_id', this.clientId)
        .maybeSingle();

      if (!result.data || !result.data.session_data) {
        throw new Error('No session data in DB');
      }

      var zipData = Buffer.from(result.data.session_data, 'base64');
      var zipPath = extractPath + '.zip';
      var parentDir = path.dirname(extractPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      fs.writeFileSync(zipPath, zipData);
      console.log('[Store] Session extracted for', this.clientId);
    } catch (e) {
      console.error('[Store] extract error:', e.message);
      throw e;
    }
  }

  async delete({ session }) {
    try {
      var sb = db.getSupabase();
      await sb.from('whatsapp_sessions')
        .update({ session_data: null })
        .eq('client_id', this.clientId);
      console.log('[Store] Session deleted for', this.clientId);
    } catch (e) {
      console.error('[Store] delete error:', e.message);
    }
  }
}

// ── Convert wwebjs msg → Baileys-style msg ────────────────────
function buildMsg(msg) {
  var msgObj = {};
  if (msg.body) msgObj.conversation = msg.body;
  if (msg.type === 'ptt')   msgObj.audioMessage = { ptt: true };
  else if (msg.type === 'audio') msgObj.audioMessage = {};
  if (msg.type === 'image') msgObj.imageMessage = { caption: msg.body || '' };

  return {
    key: {
      remoteJid: toBaileys(msg.from || ''),
      fromMe:    !!msg.fromMe,
      id:        (msg.id && msg.id._serialized) ? msg.id._serialized : String(Date.now())
    },
    message:          msgObj,
    pushName:         (msg._data && msg._data.notifyName) ? msg._data.notifyName : '',
    messageTimestamp: msg.timestamp || Math.floor(Date.now() / 1000),
    _wwebjsMsg:       msg
  };
}

// ── Baileys-compatible sock wrapper ───────────────────────────
function makeSock(client) {
  return {
    sendMessage: async function(jid, content) {
      var wwjid = toWwebjs(jid);
      try {
        if (content.text) {
          return await client.sendMessage(wwjid, content.text);
        }
        if (content.image) {
          var imgUrl = (typeof content.image === 'string') ? content.image : content.image.url;
          if (imgUrl) {
            try {
              var imgMedia = await MessageMedia.fromUrl(imgUrl, { unsafeMime: true });
              return await client.sendMessage(wwjid, imgMedia, { caption: content.caption || '' });
            } catch (imgErr) {
              console.error('[Sock] Image failed, sending caption:', imgErr.message);
              if (content.caption) await client.sendMessage(wwjid, content.caption);
            }
          }
          return;
        }
        if (content.document) {
          var docUrl = (typeof content.document === 'string') ? content.document : content.document.url;
          if (docUrl) {
            try {
              var docMedia = await MessageMedia.fromUrl(docUrl, { unsafeMime: true });
              return await client.sendMessage(wwjid, docMedia, { caption: content.caption || content.fileName || '' });
            } catch (docErr) {
              console.error('[Sock] Doc failed:', docErr.message);
            }
          }
          return;
        }
        console.warn('[Sock] Unknown content type:', JSON.stringify(Object.keys(content)));
      } catch (e) {
        console.error('[Sock] sendMessage error to ' + wwjid + ':', e.message);
      }
    },

    sendPresenceUpdate: async function(state, jid) {
      // Safe no-op — typing indicator, never crashes the bot
      try {
        var wwjid = toWwebjs(jid);
        var chat  = await client.getChatById(wwjid);
        if (state === 'composing') await chat.sendStateTyping();
        else await chat.clearState();
      } catch (e) { /* cosmetic, ignore */ }
    }
  };
}

// ── Create wwebjs client ──────────────────────────────────────
function createWwebjsClient(clientId) {
  var store = new SupabaseStore(clientId);

  var client = new Client({
    authStrategy: new RemoteAuth({
      store:               store,
      clientId:            clientId,
      backupSyncIntervalMs: 300000
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--metrics-recording-only',
        '--no-first-run',
        '--mute-audio',
        '--hide-scrollbars',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-client-side-phishing-detection',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-component-update',
        '--js-flags=--max-old-space-size=256'
      ]
    }
  });

  client.on('qr', function(qr) {
    console.log('[SessionManager] QR generated for client ' + clientId);
    qrCache.set(clientId, qr);
    var cbs = cbMap.get(clientId) || [];
    cbs.forEach(function(cb) { if (cb.onQR) { try { cb.onQR(qr); } catch(e) {} } });
  });

  client.on('authenticated', function() {
    console.log('[SessionManager] Authenticated: ' + clientId);
  });

  client.on('ready', function() {
    console.log('[SessionManager] Ready: ' + clientId);
    qrCache.delete(clientId);

    var sock = makeSock(client);
    sessions.set(clientId, { client: client, sock: sock, status: 'ready' });

    try {
      var sb = db.getSupabase();
      sb.from('clients').update({ whatsapp_connected: true }).eq('id', clientId).then(function() {}).catch(function() {});
    } catch (e) {}

    var cbs = cbMap.get(clientId) || [];
    cbs.forEach(function(cb) { if (cb.onConnected) { try { cb.onConnected(); } catch(e) {} } });
    cbMap.delete(clientId);

    global.getSock = getSession;

    console.log('[SessionManager] Message listeners registered for ' + clientId);
  });

  client.on('disconnected', function(reason) {
    console.log('[SessionManager] Disconnected: ' + clientId + ' reason: ' + reason);
    sessions.delete(clientId);
    qrCache.delete(clientId);

    try {
      var sb = db.getSupabase();
      sb.from('clients').update({ whatsapp_connected: false }).eq('id', clientId).then(function() {}).catch(function() {});
    } catch (e) {}

    var cbs = cbMap.get(clientId) || [];
    cbs.forEach(function(cb) { if (cb.onDisconnected) { try { cb.onDisconnected(); } catch(e) {} } });

    if (global.qrListeners) {
      var listeners = global.qrListeners.get(clientId) || [];
      listeners.forEach(function(fn) { try { fn('disconnected', { status: 'disconnected' }); } catch(e) {} });
    }
  });

  // ── THE MESSAGE HANDLER ───────────────────────────────────────
  // BOTH events registered — 'message' alone does not fire in some
  // wwebjs + Railway environments. 'message_create' with fromMe guard
  // is the reliable fallback.
  var handled = new Set(); // dedupe if both events fire for same msg

  async function handleIncoming(msg) {
    try {
      if (msg.fromMe) return;
      if (!msg.from) return;
      if (msg.from === 'status@broadcast') return;
      if (msg.from.includes('@g.us')) return;

      // Dedupe — both 'message' and 'message_create' might fire
      var msgId = (msg.id && msg.id._serialized) ? msg.id._serialized : null;
      if (msgId) {
        if (handled.has(msgId)) return;
        handled.add(msgId);
        // Clean up after 60s to avoid unbounded growth
        setTimeout(function() { handled.delete(msgId); }, 60000);
      }

      console.log('[SessionManager] Message from ' + msg.from + ' for client ' + clientId + ': "' + (msg.body || '[media]').slice(0, 60) + '"');

      var entry = sessions.get(clientId);
      if (!entry || !entry.sock) {
        console.warn('[SessionManager] No sock for client ' + clientId);
        return;
      }

      var builtMsg = buildMsg(msg);
      await replyEngine.handleMessage(entry.sock, builtMsg, clientId);

    } catch (e) {
      console.error('[SessionManager] Message handler error for ' + clientId + ':', e.message);
    }
  }

  client.on('message', handleIncoming);
  client.on('message_create', handleIncoming);

  client.on('auth_failure', function(msg) {
    console.error('[SessionManager] Auth failure for ' + clientId + ':', msg);
    sessions.delete(clientId);
  });

  return client;
}

// ── startSession ──────────────────────────────────────────────
function startSession(clientId, opts) {
  if (opts) {
    var cbs = cbMap.get(clientId) || [];
    cbs.push(opts);
    cbMap.set(clientId, cbs);
  }

  var existing = sessions.get(clientId);

  if (existing && existing.status === 'ready') {
    if (opts && opts.onConnected) { try { opts.onConnected(); } catch(e) {} }
    return Promise.resolve(existing.sock);
  }

  if (existing && existing.status === 'init') {
    var cached = qrCache.get(clientId);
    if (cached && opts && opts.onQR) { try { opts.onQR(cached); } catch(e) {} }
    return Promise.resolve();
  }

  console.log('[SessionManager] Starting Chrome for client ' + clientId);
  var client = createWwebjsClient(clientId);
  sessions.set(clientId, { client: client, sock: null, status: 'init' });

  client.initialize().catch(function(e) {
    console.error('[SessionManager] initialize() failed for ' + clientId + ':', e.message);
    sessions.delete(clientId);
  });

  return Promise.resolve();
}

// ── bootAllSessions ───────────────────────────────────────────
async function bootAllSessions(activeClients) {
  console.log('[SessionManager] Checking ' + activeClients.length + ' client(s) for saved sessions...');

  for (var i = 0; i < activeClients.length; i++) {
    var c     = activeClients[i];
    var store = new SupabaseStore(c.id);
    try {
      var exists = await store.sessionExists({ session: c.id });
      if (exists) {
        console.log('[SessionManager] Restoring session for ' + c.id);
        startSession(c.id, null);
        await new Promise(function(r) { setTimeout(r, 5000); });
      } else {
        console.log('[SessionManager] No saved session for ' + c.id);
      }
    } catch (e) {
      console.error('[SessionManager] Boot check failed for ' + c.id + ':', e.message);
    }
  }
}

// ── getSession ────────────────────────────────────────────────
function getSession(clientId) {
  var entry = sessions.get(clientId);
  return (entry && entry.status === 'ready' && entry.sock) ? entry.sock : null;
}

global.getSock = getSession;

module.exports = {
  startSession,
  bootAllSessions,
  getSession,
  getAllSessions: function() { return Array.from(sessions.keys()); }
};
