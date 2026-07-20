// ============================================================
//  ForgeBot — Client API Routes v3
//  src/api/clientRoutes.js
//
//  BUILT ON TOP OF v2 — all original routes preserved exactly.
//  v3 additions (at bottom of file):
//   - GET  /client/session-status
//   - GET  /client/settings (combined client + bot_setup)
//   - POST /client/settings
//   - GET  /client/setup
//   - POST /client/setup (5-step wizard)
//   - GET  /client/listings/:id  (single listing)
//   - PUT  /client/listings/:id  (alias for PATCH)
//   - GET  /client/orders
//   - PUT  /client/orders/:id
//   - GET  /client/analytics
//   - GET  /client/broadcast-logs
//   - POST /client/broadcast  (audience presets)
//   - GET/POST/PATCH/DELETE /client/bot-tasks
//   - GET/PUT /client/post-schedule
//   - POST /client/push/subscribe  (under /client/)
//   - POST /client/push/test       (under /client/)
//   - POST /client/listings/:id/media — now supports multer file upload
//   - POST /client/listings — keywords now optional
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');
const bcrypt   = require('bcryptjs');
const axios    = require('axios');

const db             = require('../db/supabase');
const sessionManager = require('../sessions/sessionManager');

// ── VAPID push (loaded lazily so it doesn't crash if web-push missing) ──
let webpush = null;
try {
  webpush = require('web-push');
  webpush.setVapidDetails(
    'mailto:support@forgebot.ng',
    process.env.VAPID_PUBLIC_KEY  || 'BBN1ci_BmHj26FTeNf_lnzqVGAhM2_X1RBlDz0lYlVOh3ULn5aKO9iNnhHBdyuDBGQXCvkjAN03yNrwhd6S0JNs',
    process.env.VAPID_PRIVATE_KEY || 'V1HPNYUQboY3DGGgRn92A4WSzZfWmtFLQewEeYvKiDo'
  );
} catch(e) { console.warn('[ClientRoutes] web-push not installed — push notifications disabled'); }

// ── Lazy Supabase init ────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// ── Multer: memory storage for file uploads ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max
});

// ── JWT auth middleware ───────────────────────────────────────
function auth(req, res, next) {
  try {
    var header = req.headers.authorization || '';
    var token  = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Partner expiry check (runs on every authed request) ───────
async function checkPartnerExpiry(clientId) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', clientId)
      .single();

    if (result.error || !result.data) return;
    var c = result.data;

    if (c.is_partner && c.partner_expires_at && c.subscription_active) {
      if (new Date(c.partner_expires_at) < new Date()) {
        await sb.from('clients')
          .update({ subscription_active: false })
          .eq('id', clientId);
        await sb.from('partner_log').insert({
          client_id: clientId,
          action: 'expired',
          note: 'Auto-expired on API request check'
        });
      }
    }
  } catch (e) {
    console.error('[ClientAPI] Partner check error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — before router.use('/client', auth …)
// ══════════════════════════════════════════════════════════════

async function activateClient(clientId) {
  var sb = _supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  await sb.from('clients').update({ status: 'active', trial_notified: false }).eq('id', clientId);
}

router.post('/client/signup', async function(req, res) {
  try {
    var { email, full_name, whatsapp_number, plan, ref } = req.body;
    if (!email || !full_name || !whatsapp_number) return res.status(400).json({ error: 'email, full_name, and whatsapp_number are required' });
    var sb   = getSupabase();
    var hash = await bcrypt.hash('forgebot2025', 10);
    var insert = await sb.from('clients').insert({
      email: email, full_name: full_name, whatsapp_number: whatsapp_number,
      password_hash: hash, status: 'pending', plan: plan || 'monthly',
      referred_by: ref || null, trial_notified: false, setup_completed: false
    }).select('id').single();
    if (insert.error) throw new Error(insert.error.message);
    var clientId = insert.data.id;
    var amount = (plan === 'yearly') ? 24000 : 2500;
    var appUrl = process.env.APP_URL || 'https://forgebot.up.railway.app';
    var flwRes;
    try {
      flwRes = await axios.post('https://api.flutterwave.com/v3/payments', {
        tx_ref: 'FB-' + clientId + '-' + Date.now(), amount: amount, currency: 'NGN',
        redirect_url: appUrl + '/api/client/pay/callback',
        customer: { email: email, name: full_name, phonenumber: whatsapp_number },
        meta: { client_id: clientId },
        customizations: { title: 'ForgeBot Subscription', logo: appUrl + '/icons/icon-192.png' }
      }, { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    } catch (e) {
      await sb.from('clients').delete().eq('id', clientId);
      return res.status(502).json({ error: 'Payment gateway unavailable. Please try again.' });
    }
    if (!flwRes.data || flwRes.data.status !== 'success') {
      await sb.from('clients').delete().eq('id', clientId);
      return res.status(502).json({ error: 'Could not create payment link. Please try again.' });
    }
    res.json({ payment_url: flwRes.data.data.link });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/login', async function(req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    var sb = getSupabase();
    var result = await sb.from('clients').select('*').eq('email', email).single();
    if (result.error || !result.data) return res.status(401).json({ error: 'Invalid credentials' });
    var client = result.data;
    if (client.status !== 'active') return res.status(403).json({ error: 'Account not yet active. Complete payment first.' });
    var match = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    var token = jwt.sign({ id: client.id, clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, client: { id: client.id, full_name: client.full_name, email: client.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/qr-stream — PUBLIC (EventSource cannot send auth headers)
router.get('/client/qr-stream', async function(req, res) {
  var token = req.query.token;
  var clientId;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    clientId = decoded.clientId || decoded.id;
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
  }

  var heartbeat = setInterval(function() {
    try { res.write(':heartbeat\n\n'); } catch (e) {}
  }, 20000);

  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  req.on('close', function() {
    clearInterval(heartbeat);
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });

  try {
    await sessionManager.startSession(clientId);
  } catch (e) {
    sendEvent('error', { message: 'Failed to start WhatsApp session. Please refresh and try again.' });
    clearInterval(heartbeat);
    res.end();
  }
});

router.get('/client/pay/callback', async function(req, res) {
  try {
    var { status, tx_ref, transaction_id } = req.query;
    var appUrl = process.env.APP_URL || 'https://forgebot.up.railway.app';
    if (status !== 'successful' || !transaction_id) return res.redirect(appUrl + '/?payment=failed');
    var verify;
    try {
      verify = await axios.get('https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify', {
        headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY }
      });
    } catch (e) { return res.redirect(appUrl + '/?payment=failed'); }
    var txData = verify.data && verify.data.data;
    if (!txData || txData.status !== 'successful') return res.redirect(appUrl + '/?payment=failed');
    var clientId = txData.meta && txData.meta.client_id;
    if (!clientId) return res.redirect(appUrl + '/?payment=failed');
    await activateClient(clientId);
    var token = jwt.sign({ id: clientId, clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.redirect(appUrl + '/onboard?activated=1&token=' + token);
  } catch (e) { return res.redirect((process.env.APP_URL || 'https://forgebot.up.railway.app') + '/?payment=error'); }
});

router.post('/client/pay/webhook', async function(req, res) {
  try {
    var hash = req.headers['verif-hash'];
    if (!hash || hash !== process.env.FLW_HASH) return res.status(401).json({ error: 'Unauthorized' });
    var { event, data } = req.body;
    if (event === 'charge.completed' && data && data.status === 'successful') {
      var clientId = data.meta && data.meta.client_id;
      if (clientId) await activateClient(clientId);
    }
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/push/vapid-key', function(req, res) { res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }); });
router.post('/push/subscribe', async function(req, res) {
  try {
    var { subscription, clientId: cid } = req.body;
    if (!subscription || !cid) return res.status(400).json({ error: 'subscription and clientId required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({ client_id: cid, subscription: JSON.stringify(subscription), updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/push/test', function(req, res) { res.json({ ok: true }); });

// ── Apply auth + partner check to all client routes ───────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  EXISTING ROUTES (preserved exactly from v2)
// ══════════════════════════════════════════════════════════════

router.get('/client/me', async function(req, res) {
  try {
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var sock   = sessionManager.getSession(req.clientId);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/flows', async function(req, res) {
  try {
    var flows = await db.getFlows(req.clientId, false);
    res.json(flows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    var flow = await db.addFlow(req.clientId, 'Custom', keywords, response_type || 'text', response, media_url || null, 0);
    res.json(flow);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/flows/:id', async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
    var post = await db.addStatusPost(req.clientId, caption, mediaUrl, scheduledTime, scheduledDays);
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/broadcasts', async function(req, res) {
  try {
    var { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    var sb     = getSupabase();
    var result = await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200);
    var jids   = (result.data || []).map(function(c) { return c.jid; });
    var sent = 0;
    for (var i = 0; i < jids.length; i++) {
      try { await sock.sendMessage(jids[i], { text: message }); sent++; await new Promise(function(r) { setTimeout(r, 1200); }); } catch (e) {}
    }
    await db.logBroadcast(req.clientId, message, sent);
    res.json({ sent: sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/settings', async function(req, res) {
  try {
    var allowed = ['notification_number', 'business_name', 'bank_name', 'account_number', 'account_name', 'business_hours'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var updated = await db.updateClient(req.clientId, update);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message: fallback_message });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/listings
router.get('/client/listings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('service_listings').select('*, listing_media(id, url, media_type, caption, sort_order)').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/listings — v3: keywords now optional
router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id: req.clientId, name: name, description: description || null,
      price: price || null, price_label: price_label || null, location: location || null,
      category: category || null, keywords: keywords || '', available: true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/client/listings/:id
router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','available'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/listings/:id
router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/listings/:id/media
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/listings/:id/media — v3: accepts file upload OR JSON url
router.post('/client/listings/:id/media', upload.single('file'), async function(req, res) {
  try {
    var sb = getSupabase();
    var listingId = req.params.id;
    var url, media_type, caption, filename, sort_order;

    if (req.file) {
      // File uploaded directly — push to Supabase Storage
      var ext    = req.file.originalname.split('.').pop().toLowerCase();
      var mtype  = req.file.mimetype;
      media_type = mtype.startsWith('image') ? 'image' : (mtype === 'application/pdf' ? 'pdf' : (mtype.startsWith('video') ? 'video' : 'other'));
      caption    = req.body.caption || null;
      sort_order = parseInt(req.body.sort_order) || 0;
      filename   = req.clientId + '/' + listingId + '/' + Date.now() + '.' + ext;

      var uploadResult = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, { contentType: mtype, upsert: false });
      if (uploadResult.error) throw new Error('Storage upload failed: ' + uploadResult.error.message);
      var publicData = sb.storage.from('forgebot-listings').getPublicUrl(filename);
      url = publicData.data.publicUrl;
    } else {
      // JSON body with URL
      url        = req.body.url;
      media_type = req.body.media_type || 'image';
      caption    = req.body.caption    || null;
      filename   = req.body.filename   || null;
      sort_order = parseInt(req.body.sort_order) || 0;
      if (!url) return res.status(400).json({ error: 'file or url required' });
    }

    var result = await sb.from('listing_media').insert({
      listing_id: listingId, client_id: req.clientId,
      url: url, media_type: media_type, caption: caption,
      filename: filename, sort_order: sort_order
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/media/:id
router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data: media } = await sb.from('listing_media').select('filename').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (media && media.filename) { try { await sb.storage.from('forgebot-listings').remove([media.filename]); } catch(e) {} }
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/upload (kept for legacy dashboard upload calls)
router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    var sb       = getSupabase();
    var ext      = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var result   = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (result.error) throw new Error(result.error.message);
    var urlResult = sb.storage.from('forgebot-listings').getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/faq', async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb = getSupabase();
    var result = await sb.from('business_faq').insert({ client_id: req.clientId, question: question, answer: answer, keywords: keywords || null, sort_order: sort_order || 0 }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    var update = {};
    if (question   !== undefined) update.question   = question;
    if (answer     !== undefined) update.answer     = answer;
    if (keywords   !== undefined) update.keywords   = keywords;
    if (sort_order !== undefined) update.sort_order = sort_order;
    var sb = getSupabase();
    var result = await sb.from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/partner-status', async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c = result.data;
    var now = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
    var expired   = expiresAt ? expiresAt < now : false;
    res.json({ is_partner: c.is_partner || false, expires_at: c.partner_expires_at || null, days_left: daysLeft, expired: expired, still_active: c.subscription_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation: occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase(); var clientId = req.clientId;
    var { occupation, occupation_data, availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel, service_areas, studio_location,
      home_service, advance_booking, deposit_required, session_duration, who_do_you_serve,
      free_consult, return_policy, delivers_to, delivery_fee_local, delivery_time_local,
      minimum_order, bulk_orders } = req.body;
    if (occupation) await sb.from('clients').update({ occupation: occupation, occupation_data: occupation_data || {} }).eq('id', clientId);
    var setupData = { client_id: clientId, availability_days: availability_days||null, payment_methods: payment_methods||null,
      current_promo: current_promo||null, instagram: instagram||null, facebook: facebook||null, tiktok: tiktok||null,
      whatsapp_channel: whatsapp_channel||null, service_areas: service_areas||null, studio_location: studio_location||null,
      home_service: home_service||null, advance_booking: advance_booking||null, deposit_required: deposit_required||null,
      session_duration: session_duration||null, who_do_you_serve: who_do_you_serve||null, free_consult: free_consult||null,
      return_policy: return_policy||null, delivers_to: delivers_to||null, delivery_fee_local: delivery_fee_local||null,
      delivery_time_local: delivery_time_local||null, minimum_order: minimum_order||null, bulk_orders: bulk_orders||null,
      updated_at: new Date().toISOString() };
    Object.keys(setupData).forEach(function(k) { if (setupData[k] === undefined) delete setupData[k]; });
    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES — v3 additions
// ══════════════════════════════════════════════════════════════

// ── Session status ────────────────────────────────────────────
router.get('/client/session-status', async function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock });
  } catch (e) { res.json({ connected: false }); }
});

// ── Single listing ────────────────────────────────────────────
router.get('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('service_listings').select('*, listing_media(id, url, media_type, caption, sort_order)').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (result.error) return res.status(404).json({ error: 'Not found' });
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT alias for PATCH on listings ──────────────────────────
router.put('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','available'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb = getSupabase();
    var result = await sb.from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings GET (combined) ───────────────────────────────────
router.get('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();
    var [clientRes, setupRes] = await Promise.all([
      sb.from('clients').select('id,full_name,email,business_name,whatsapp_number,notification_number,bank_name,account_number,account_name,business_hours,fallback_message,welcome_message,occupation,location_address').eq('id', req.clientId).single(),
      sb.from('bot_setup').select('*').eq('client_id', req.clientId).single()
    ]);
    res.json({ client: clientRes.data || {}, setup: setupRes.data || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings POST (combined) ──────────────────────────────────
router.post('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();
    var clientFields = ['business_name','fallback_message','welcome_message','notification_number','bank_name','account_number','account_name','business_hours'];
    var clientUpdate = {};
    clientFields.forEach(function(k) { if (req.body[k] !== undefined) clientUpdate[k] = req.body[k]; });
    if (Object.keys(clientUpdate).length) await sb.from('clients').update(clientUpdate).eq('id', req.clientId);
    var setupFields = ['payment_methods','current_promo','instagram','facebook','tiktok','whatsapp_channel','service_areas','delivery_areas','delivery_fee','return_policy'];
    var setupData = { client_id: req.clientId, updated_at: new Date().toISOString() };
    setupFields.forEach(function(k) { if (req.body[k] !== undefined) setupData[k] = req.body[k]; });
    await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Setup wizard GET/POST ─────────────────────────────────────
router.get('/client/setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data } = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var setupData = Object.assign({ client_id: req.clientId, updated_at: new Date().toISOString() }, req.body);
    await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    await sb.from('clients').update({ setup_completed: true }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────────
router.get('/client/orders', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data } = await sb.from('orders').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/orders/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var { status, notes } = req.body;
    var { data, error } = await sb.from('orders').update({ status: status, notes: notes, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────
router.get('/client/analytics', async function(req, res) {
  try {
    var sb = getSupabase();
    var month = req.query.month || new Date().toISOString().slice(0, 7);
    var start = month + '-01T00:00:00.000Z';
    var end   = new Date(month + '-01'); end.setMonth(end.getMonth() + 1); var endStr = end.toISOString();
    var [custRes, orderRes] = await Promise.all([
      sb.from('customers').select('id', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', endStr),
      sb.from('orders').select('id,total', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', endStr)
    ]);
    var revenue = (orderRes.data || []).reduce(function(s, o) { return s + (parseFloat(o.total) || 0); }, 0);
    res.json({ newCustomers: custRes.count || 0, orders: orderRes.count || 0, revenue: revenue });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcast logs + audience broadcast ──────────────────────
router.get('/client/broadcast-logs', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data } = await sb.from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(50);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/broadcast', async function(req, res) {
  try {
    var sb = getSupabase();
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    var { message, audience, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var recipients = [];
    if (audience === 'custom' && phones) {
      var phoneList = (Array.isArray(phones) ? phones : phones.split(/[\n,]+/)).map(function(p) { return p.toString().replace(/\D/g, ''); }).filter(function(p) { return p.length >= 7; });
      recipients = phoneList.map(function(p) { if (!p.startsWith('234')) p = '234' + p.replace(/^0/, ''); return p + '@s.whatsapp.net'; });
    } else {
      var query = sb.from('customers').select('jid').eq('client_id', req.clientId);
      if (audience === 'inactive_7d')  { var d7  = new Date(); d7.setDate(d7.getDate()-7);   query = query.lt('last_contact', d7.toISOString()); }
      if (audience === 'inactive_14d') { var d14 = new Date(); d14.setDate(d14.getDate()-14); query = query.lt('last_contact', d14.toISOString()); }
      var { data: customers } = await query;
      recipients = (customers || []).map(function(c) { return c.jid; });
    }
    if (!recipients.length) return res.status(400).json({ error: 'No recipients found' });
    var sent = 0, failed = 0;
    for (var i = 0; i < recipients.length; i++) {
      try { await sock.sendMessage(recipients[i], { text: message }); sent++; await new Promise(function(r) { setTimeout(r, 1500); }); } catch(e) { failed++; }
    }
    await db.logBroadcast(req.clientId, message, sent);
    res.json({ success: true, sent: sent, failed: failed, total: recipients.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Tasks ─────────────────────────────────────────────────
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data } = await sb.from('bot_tasks').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/bot-tasks', async function(req, res) {
  try {
    var sb = getSupabase();
    var { title, message, audience, schedule_time, repeat, active } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    var { data, error } = await sb.from('bot_tasks').insert({ client_id: req.clientId, title: title, message: message, audience: audience || 'all_customers', schedule_time: schedule_time || null, repeat: repeat || 'none', active: active !== false }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data, error } = await sb.from('bot_tasks').update(Object.assign({}, req.body, { updated_at: new Date().toISOString() })).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Post schedule ─────────────────────────────────────────────
router.get('/client/post-schedule', async function(req, res) {
  try {
    var sb = getSupabase();
    var { data } = await sb.from('post_schedules').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).catch(function() { return { data: [] }; });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/post-schedule', async function(req, res) {
  try {
    var sb = getSupabase();
    var { schedules } = req.body;
    if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
    await sb.from('post_schedules').delete().eq('client_id', req.clientId).catch(function(){});
    if (schedules.length) {
      var rows = schedules.map(function(s) { return Object.assign({ client_id: req.clientId }, s); });
      await sb.from('post_schedules').insert(rows);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push notifications (under /client/) ──────────────────────
router.get('/client/push/vapid-public-key', function(req, res) {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || 'BBN1ci_BmHj26FTeNf_lnzqVGAhM2_X1RBlDz0lYlVOh3ULn5aKO9iNnhHBdyuDBGQXCvkjAN03yNrwhd6S0JNs' });
});

router.post('/client/push/subscribe', async function(req, res) {
  try {
    var sb = getSupabase();
    var sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
    await sb.from('push_subscriptions').upsert({ client_id: req.clientId, endpoint: sub.endpoint, subscription: JSON.stringify(sub), updated_at: new Date().toISOString() }, { onConflict: 'client_id,endpoint' }).catch(function() {
      return sb.from('push_subscriptions').upsert({ client_id: req.clientId, subscription: JSON.stringify(sub), updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/push/test', async function(req, res) {
  try {
    if (!webpush) return res.status(503).json({ error: 'web-push module not installed on server' });
    var sb = getSupabase();
    var { data: subs } = await sb.from('push_subscriptions').select('subscription').eq('client_id', req.clientId);
    if (!subs || !subs.length) return res.status(400).json({ error: 'No push subscription found. Open the dashboard in your browser first.' });
    var payload = JSON.stringify({ title: 'ForgeBot', body: 'Push notifications working! ✅', icon: '/icons/icon-192.png' });
    var sent = 0;
    for (var i = 0; i < subs.length; i++) {
      try {
        var subObj = typeof subs[i].subscription === 'string' ? JSON.parse(subs[i].subscription) : subs[i].subscription;
        await webpush.sendNotification(subObj, payload); sent++;
      } catch(e) { if (e.statusCode === 410) await sb.from('push_subscriptions').delete().eq('client_id', req.clientId); }
    }
    res.json({ ok: true, sent: sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
