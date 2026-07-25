// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  Changes vs v2:
//   - GET /client/session-status  — real Connected/Disconnected badge
//   - GET /client/settings        — returns nested bot_setup for dashboard
//   - PUT /client/settings        — now includes welcome_message + fallback_message
//   - PUT /client/bot-setup       — accepts BOTH old (delivers_to) + new (delivery_areas) names
//   - POST /client/status-posts   — accepts dashboard fields (media_url, post_time) + legacy
//                                    saves BOTH scheduled_time AND post_time columns
//   - GET/PUT /client/orders      — orders management
//   - GET /client/analytics       — monthly analytics
//   - GET /client/broadcast-logs  — broadcast history
//   - POST /client/broadcast      — send to specific phone numbers
//   - GET/POST/PATCH/DELETE /client/bot-tasks
//   - POST /client/push/subscribe (authed)
//   All existing routes preserved exactly
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
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
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

// ── Partner expiry check ──────────────────────────────────────
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
        await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
        await sb.from('partner_log').insert({
          client_id: clientId, action: 'expired', note: 'Auto-expired on API request check'
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
    var amount   = (plan === 'yearly') ? 24000 : 2500;
    var appUrl   = process.env.APP_URL || 'https://forgebot.up.railway.app';
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
    var sb     = getSupabase();
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

// Public push subscribe (no auth — called before login)
router.post('/push/subscribe', async function(req, res) {
  try {
    var { subscription, clientId: cid } = req.body;
    if (!subscription || !cid) return res.status(400).json({ error: 'subscription and clientId required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id: cid, subscription: JSON.stringify(subscription), updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push/test', function(req, res) { res.json({ ok: true }); });

// ── Apply auth + partner check to all /client routes ─────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  AUTHED CLIENT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
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

// GET /api/client/session-status — dashboard Connected badge
router.get('/client/session-status', async function(req, res) {
  try {
    var sock      = sessionManager.getSession(req.clientId);
    var connected = !!sock;
    res.json({ connected: connected, status: connected ? 'connected' : 'disconnected' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/settings — returns nested bot_setup for dashboard
router.get('/client/settings', async function(req, res) {
  try {
    var sb        = getSupabase();
    var clientRes = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (clientRes.error || !clientRes.data) return res.status(404).json({ error: 'Client not found' });
    var c = clientRes.data;

    var setupRes = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    var s = (setupRes.data) || {};

    res.json({
      notification_number: c.notification_number || '',
      welcome_message:     c.welcome_message     || '',
      fallback_message:    c.fallback_message     || '',
      bank_name:           c.bank_name            || '',
      account_number:      c.account_number       || '',
      account_name:        c.account_name         || '',
      business_hours:      c.business_hours       || '',
      bot_setup: {
        instagram:        s.instagram         || '',
        facebook:         s.facebook          || '',
        tiktok:           s.tiktok            || '',
        whatsapp_channel: s.whatsapp_channel  || '',
        // support both old column names (delivers_to) and new (delivery_areas)
        delivery_areas:   s.delivery_areas    || s.delivers_to         || '',
        delivery_fee:     s.delivery_fee      || s.delivery_fee_local  || '',
        delivery_time:    s.delivery_time     || s.delivery_time_local || '',
        minimum_order:    s.minimum_order     || '',
        return_policy:    s.return_policy     || '',
        promo:            s.promo             || s.current_promo       || '',
        payment_methods:  Array.isArray(s.payment_methods)
          ? s.payment_methods.join(',')
          : (s.payment_methods || '')
      },
      is_partner:          c.is_partner          || false,
      partner_expires_at:  c.partner_expires_at  || null,
      subscription_active: c.subscription_active || false
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/flows
router.get('/client/flows', async function(req, res) {
  try {
    var flows = await db.getFlows(req.clientId, false);
    res.json(flows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/flows
router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    var flow = await db.addFlow(req.clientId, 'Custom', keywords, response_type || 'text', response, media_url || null, 0);
    res.json(flow);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/status-posts
router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/status-posts
// Accepts dashboard fields: { caption, media_url, post_time, scheduled_days }
//         AND legacy fields: { caption, mediaUrl, scheduledTime, scheduledDays }
// Saves BOTH scheduled_time AND post_time so the scheduler always finds the row
router.post('/client/status-posts', async function(req, res) {
  try {
    var b = req.body;
    var caption        = b.caption       || '';
    var mediaUrl       = b.media_url     || b.mediaUrl     || null;
    var postTime       = b.post_time     || b.scheduledTime || null;
    var scheduledDays  = b.scheduled_days || b.scheduledDays || null;

    if (!caption)  return res.status(400).json({ error: 'caption is required' });
    if (!postTime) return res.status(400).json({ error: 'post_time is required' });

    var sb = getSupabase();
    var result = await sb.from('status_posts').insert({
      client_id:      req.clientId,
      caption:        caption,
      media_url:      mediaUrl       || null,
      post_time:      postTime,       // column read by dashboard display
      scheduled_time: postTime,       // column queried by getDueStatusPosts
      scheduled_days: scheduledDays  || null,
      active:         true
    }).select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/status-posts/:id
router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcasts — history
router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcast-logs — alias
router.get('/client/broadcast-logs', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcasts — broadcast to all known customers
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
      try {
        await sock.sendMessage(jids[i], { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) {
        console.error('[ClientAPI] Broadcast failed for ' + jids[i]);
      }
    }

    await db.logBroadcast(req.clientId, message, sent);
    res.json({ sent: sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcast — send to specific phone numbers
router.post('/client/broadcast', async function(req, res) {
  try {
    var { message, numbers } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var targets = Array.isArray(numbers) ? numbers : [];
    if (!targets.length) return res.status(400).json({ error: 'numbers array required' });

    var sent = 0;
    for (var i = 0; i < targets.length; i++) {
      var num = String(targets[i]).replace(/\D/g, '');
      if (!num) continue;
      var jid = num + '@s.whatsapp.net';
      try {
        await sock.sendMessage(jid, { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) {
        console.error('[ClientAPI] Broadcast to ' + jid + ' failed:', e.message);
      }
    }

    res.json({ sent: sent, total: targets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name', 'welcome_message', 'fallback_message',
      'bank_name', 'account_number', 'account_name', 'business_hours'
    ];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var updated = await db.updateClient(req.clientId, update);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message: fallback_message });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Occupation ────────────────────────────────────────────────
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({
      occupation: occupation, occupation_data: answers || {}
    }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({
      client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Location ──────────────────────────────────────────────────
router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({
      location_address: location_address || null, location_maps_url: location_maps_url || null
    }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service Listings ──────────────────────────────────────────
router.get('/client/listings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('service_listings')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords are required' });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id: req.clientId, name: name, description: description || null,
      price: price || null, price_label: price_label || null, location: location || null,
      category: category || null, keywords: keywords, available: true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','available'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('service_listings')
      .update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listing Media ─────────────────────────────────────────────
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media')
      .select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId, url: url, media_type: media_type,
      caption: caption || null, filename: filename || null, sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File Upload → Supabase Storage ───────────────────────────
router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    var sb       = getSupabase();
    var ext      = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var bucket   = 'forgebot-listings';
    var result   = await sb.storage.from(bucket).upload(filename, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false
    });
    if (result.error) throw new Error(result.error.message);
    var urlResult = sb.storage.from(bucket).getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FAQ ───────────────────────────────────────────────────────
router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb     = getSupabase();
    var result = await sb.from('business_faq').insert({
      client_id: req.clientId, question: question, answer: answer,
      keywords: keywords || null, sort_order: sort_order || 0
    }).select().single();
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
    var sb     = getSupabase();
    var result = await sb.from('business_faq').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
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

// ── Partner / Trial Status ────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c         = result.data;
    var now       = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
    var expired   = expiresAt ? expiresAt < now : false;
    res.json({
      is_partner:   c.is_partner || false, expires_at: c.partner_expires_at || null,
      days_left:    daysLeft, expired: expired, still_active: c.subscription_active
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Qualification toggle ──────────────────────────────────────
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

// ── Bot Setup (PUT) ───────────────────────────────────────────
// Accepts BOTH old field names (delivers_to, delivery_fee_local, etc.)
// AND new field names (delivery_areas, delivery_fee, etc.).
// Saves BOTH so onboard.html and dashboard.html both work correctly.
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb  = getSupabase();
    var b   = req.body;
    var cid = req.clientId;

    if (b.occupation) {
      await sb.from('clients').update({
        occupation: b.occupation, occupation_data: b.occupation_data || {}
      }).eq('id', cid);
    }

    var setupData = {
      client_id:         cid,
      availability_days: b.availability_days  || null,
      instagram:         b.instagram          || null,
      facebook:          b.facebook           || null,
      tiktok:            b.tiktok             || null,
      whatsapp_channel:  b.whatsapp_channel   || null,
      service_areas:     b.service_areas      || null,
      studio_location:   b.studio_location    || null,
      home_service:      b.home_service       || null,
      advance_booking:   b.advance_booking    || null,
      deposit_required:  b.deposit_required   || null,
      session_duration:  b.session_duration   || null,
      who_do_you_serve:  b.who_do_you_serve   || null,
      free_consult:      b.free_consult       || null,
      minimum_order:     b.minimum_order      || null,
      bulk_orders:       b.bulk_orders        || null,
      updated_at:        new Date().toISOString()
    };

    // payment_methods — handle array or comma string
    if (b.payment_methods !== undefined) {
      setupData.payment_methods = b.payment_methods || null;
    }

    // Delivery — save BOTH old and new column names
    if (b.delivery_areas !== undefined) {
      setupData.delivery_areas = b.delivery_areas || null;
      setupData.delivers_to   = b.delivery_areas || null;  // backward compat
    }
    if (b.delivers_to !== undefined) {
      setupData.delivers_to   = b.delivers_to   || null;
      setupData.delivery_areas = b.delivers_to  || null;  // forward compat
    }

    if (b.delivery_fee !== undefined) {
      setupData.delivery_fee       = b.delivery_fee || null;
      setupData.delivery_fee_local = b.delivery_fee || null;
    }
    if (b.delivery_fee_local !== undefined) {
      setupData.delivery_fee_local = b.delivery_fee_local || null;
      setupData.delivery_fee       = b.delivery_fee_local || null;
    }

    if (b.delivery_time !== undefined) {
      setupData.delivery_time       = b.delivery_time || null;
      setupData.delivery_time_local = b.delivery_time || null;
    }
    if (b.delivery_time_local !== undefined) {
      setupData.delivery_time_local = b.delivery_time_local || null;
      setupData.delivery_time       = b.delivery_time_local || null;
    }

    // Promo — save both column names
    if (b.promo !== undefined) {
      setupData.promo         = b.promo || null;
      setupData.current_promo = b.promo || null;
    }
    if (b.current_promo !== undefined) {
      setupData.current_promo = b.current_promo || null;
      setupData.promo         = b.current_promo || null;
    }

    // Return policy
    if (b.return_policy !== undefined) {
      setupData.return_policy = b.return_policy || null;
    }

    // Remove undefined keys to avoid Supabase complaints
    Object.keys(setupData).forEach(function(k) {
      if (setupData[k] === undefined) delete setupData[k];
    });

    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', cid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────────
router.get('/client/orders', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders')
      .select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false }).limit(100);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/orders/:id', async function(req, res) {
  try {
    var allowed = ['status', 'notes', 'amount', 'delivery_address'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updated_at = new Date().toISOString();
    var sb     = getSupabase();
    var result = await sb.from('orders').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────
router.get('/client/analytics', async function(req, res) {
  try {
    var month = req.query.month; // YYYY-MM
    var sb    = getSupabase();

    var start = month ? month + '-01' : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];
    var endDate = month
      ? new Date(month.split('-')[0], month.split('-')[1], 0).toISOString().split('T')[0]
      : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString().split('T')[0];

    var [custRes, orderRes, broadRes] = await Promise.all([
      sb.from('customers').select('id', { count: 'exact' }).eq('client_id', req.clientId)
        .gte('last_contact', start).lte('last_contact', endDate),
      sb.from('orders').select('id,amount,status', { count: 'exact' }).eq('client_id', req.clientId)
        .gte('created_at', start).lte('created_at', endDate),
      sb.from('broadcasts').select('sent_count').eq('client_id', req.clientId)
        .gte('created_at', start).lte('created_at', endDate)
    ]);

    var orders  = orderRes.data || [];
    var revenue = orders.filter(function(o) { return o.status === 'completed'; })
                        .reduce(function(sum, o) { return sum + (parseFloat(o.amount) || 0); }, 0);
    var broadcastReach = (broadRes.data || []).reduce(function(sum, b) { return sum + (b.sent_count || 0); }, 0);

    res.json({
      month:            month || start.slice(0, 7),
      new_customers:    custRes.count  || 0,
      total_orders:     orderRes.count || 0,
      completed_orders: orders.filter(function(o) { return o.status === 'completed'; }).length,
      revenue:          revenue,
      broadcast_reach:  broadcastReach
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Tasks (errands) ───────────────────────────────────────
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { task_type, message, scheduled_time, scheduled_days, recipient_jid } = req.body;
    if (!task_type || !message) return res.status(400).json({ error: 'task_type and message required' });
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').insert({
      client_id:      req.clientId,
      task_type:      task_type,
      message:        message,
      scheduled_time: scheduled_time || null,
      scheduled_days: scheduled_days || null,
      recipient_jid:  recipient_jid  || null,
      active:         true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var allowed = ['task_type', 'message', 'scheduled_time', 'scheduled_days', 'recipient_jid', 'active'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updated_at = new Date().toISOString();
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push Notifications (authed) ───────────────────────────────
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id: req.clientId, subscription: JSON.stringify(subscription),
      updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/push/test', function(req, res) { res.json({ ok: true, message: 'Push test acknowledged' }); });

module.exports = router;
