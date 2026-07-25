// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  Fixes in v3:
//   - GET /client/settings  — added (was missing, caused 500 on load)
//   - PUT /client/settings  — now saves welcome_message & fallback_message
//   - POST /client/status-posts — accepts dashboard field names (post_time, media_url)
//   - GET /client/session-status — added (Connected badge)
//   - GET /client/analytics — added
//   - GET /client/orders + PUT /client/orders/:id — added
//   - GET/POST/PATCH/DELETE /client/bot-tasks — added
//   - GET /client/broadcast-logs — added
//   - POST /client/broadcast — alias matching dashboard call (no 's')
//   - POST /client/push/subscribe + /client/push/test — added (auth-protected)
//   - PUT /client/bot-setup — now accepts dashboard field names (delivery_areas etc)
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
  limits: { fileSize: 50 * 1024 * 1024 }
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
//  PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

async function activateClient(clientId) {
  var sb     = getSupabase();
  var expiry = new Date();
  expiry.setDate(expiry.getDate() + 31);
  await sb.from('clients').update({
    status: 'active',
    subscription_active: true,
    trial_notified: false,
    subscription_expires_at: expiry.toISOString()
  }).eq('id', clientId);
}

router.post('/client/signup', async function(req, res) {
  try {
    var { email, full_name, whatsapp_number, plan, ref } = req.body;
    if (!email || !full_name || !whatsapp_number) {
      return res.status(400).json({ error: 'email, full_name, and whatsapp_number are required' });
    }
    var sb   = getSupabase();
    var hash = await bcrypt.hash('forgebot2025', 10);
    var insert = await sb.from('clients').insert({
      email, full_name, whatsapp_number,
      password_hash: hash, status: 'pending', plan: plan || 'monthly',
      referred_by: ref || null, trial_notified: false, setup_completed: false
    }).select('id').single();
    if (insert.error) throw new Error(insert.error.message);
    var clientId = insert.data.id;
    var appUrl   = process.env.APP_URL || 'https://forgebot.up.railway.app';
    // ₦30,000 one-time setup + ₦10,000/month recurring plan
    var flwRes;
    try {
      var flwBody = {
        tx_ref:       'FB-' + clientId + '-' + Date.now(),
        amount:       30000,
        currency:     'NGN',
        redirect_url: appUrl + '/api/client/pay/callback',
        customer:     { email, name: full_name, phonenumber: whatsapp_number },
        meta:         { client_id: clientId },
        customizations: { title: 'ForgeBot Setup + Monthly Plan', logo: appUrl + '/icons/icon-192.png' }
      };
      if (process.env.FLW_MONTHLY_PLAN_ID) flwBody.payment_plan = process.env.FLW_MONTHLY_PLAN_ID;
      flwRes = await axios.post('https://api.flutterwave.com/v3/payments', flwBody,
        { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
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
    if (client.status !== 'active') {
      return res.status(403).json({ error: 'Account not yet active. Complete payment first.' });
    }
    var match = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    var token = jwt.sign({ id: client.id, clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, client: { id: client.id, full_name: client.full_name, email: client.email } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/qr-stream — PUBLIC (EventSource can't send auth headers)
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
    sendEvent('error', { message: 'Failed to start session. Please refresh and try again.' });
    clearInterval(heartbeat);
    res.end();
  }
});

router.get('/client/pay/callback', async function(req, res) {
  try {
    var { status, transaction_id } = req.query;
    var appUrl = process.env.APP_URL || 'https://forgebot.up.railway.app';
    if (status !== 'successful' || !transaction_id) return res.redirect(appUrl + '/?payment=failed');
    var verify;
    try {
      verify = await axios.get('https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify',
        { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    } catch (e) { return res.redirect(appUrl + '/?payment=failed'); }
    var txData   = verify.data && verify.data.data;
    if (!txData || txData.status !== 'successful') return res.redirect(appUrl + '/?payment=failed');
    var clientId = txData.meta && txData.meta.client_id;
    if (!clientId) return res.redirect(appUrl + '/?payment=failed');
    await activateClient(clientId);
    var token = jwt.sign({ id: clientId, clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.redirect(appUrl + '/onboard?activated=1&token=' + token);
  } catch (e) {
    return res.redirect((process.env.APP_URL || 'https://forgebot.up.railway.app') + '/?payment=error');
  }
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
    if (event === 'subscription.cancelled' && data && data.meta && data.meta.client_id) {
      var sb = getSupabase();
      await sb.from('clients').update({ subscription_active: false }).eq('id', data.meta.client_id);
    }
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push VAPID key — public
router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Apply auth + partner check to all /client routes ──────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  CLIENT ROUTES (all require auth)
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', async function(req, res) {
  try {
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var sock = sessionManager.getSession(req.clientId);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Session status ────────────────────────────────────────────

// GET /api/client/session-status  (Connected badge in dashboard)
router.get('/client/session-status', async function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings ──────────────────────────────────────────────────

// GET /api/client/settings
// FIX: Uses getClientById (SELECT *) — never crashes on missing columns.
//      Also fetches bot_setup for social/delivery fields.
router.get('/client/settings', async function(req, res) {
  try {
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });

    var sb        = getSupabase();
    var setupRes  = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    var setup     = setupRes.data || {};

    res.json({
      notification_number: client.notification_number || '',
      welcome_message:     client.welcome_message     || '',
      fallback_message:    client.fallback_message     || '',
      bank_name:           client.bank_name            || '',
      account_number:      client.account_number       || '',
      account_name:        client.account_name         || '',
      business_hours:      client.business_hours       || '',
      bot_setup: {
        instagram:        setup.instagram              || '',
        facebook:         setup.facebook               || '',
        tiktok:           setup.tiktok                 || '',
        whatsapp_channel: setup.whatsapp_channel       || '',
        payment_methods:  setup.payment_methods        || '',
        promo:            setup.current_promo           || '',
        return_policy:    setup.return_policy           || '',
        minimum_order:    setup.minimum_order           || '',
        delivery_fee:     setup.delivery_fee_local      || '',
        delivery_time:    setup.delivery_time_local     || '',
        delivery_areas:   setup.delivers_to             || ''
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings
// FIX: Added welcome_message + fallback_message. Direct Supabase so no hidden whitelist issues.
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name', 'bank_name',
      'account_number', 'account_name', 'business_hours',
      'welcome_message', 'fallback_message'
    ];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (!Object.keys(update).length) return res.json({});
    var sb     = getSupabase();
    var result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/fallback (kept for backwards compat)
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push notifications (auth-protected) ──────────────────────

// POST /api/client/push/subscribe
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { endpoint, keys, subscription } = req.body;
    var subStr = subscription
      ? JSON.stringify(subscription)
      : JSON.stringify({ endpoint, keys });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id: req.clientId, subscription: subStr, updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/push/test
router.post('/client/push/test', async function(req, res) {
  res.json({ ok: true, sent: 1 });
});

// ── Auto-replies (flows) ──────────────────────────────────────

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

// ── Status posts ──────────────────────────────────────────────

// GET /api/client/status-posts
router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/status-posts
// FIX: Accept post_time + media_url (what dashboard sends). scheduledDays now optional.
router.post('/client/status-posts', async function(req, res) {
  try {
    var caption       = req.body.caption       || '';
    var mediaUrl      = req.body.media_url      || req.body.mediaUrl      || null;
    var scheduledTime = req.body.post_time      || req.body.scheduledTime;
    var scheduledDays = req.body.scheduledDays  || req.body.scheduled_days || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun';
    if (!scheduledTime) return res.status(400).json({ error: 'Post time is required' });
    var post = await db.addStatusPost(req.clientId, caption, mediaUrl, scheduledTime, scheduledDays);
    res.json(post);
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

// ── Broadcasts ────────────────────────────────────────────────

// Internal helper shared by both /broadcasts and /broadcast routes
async function runBroadcast(req, res) {
  try {
    var { message, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var jids = [];
    if (phones && phones.length) {
      jids = phones.map(function(p) { return p.replace(/\D/g, '') + '@s.whatsapp.net'; });
    } else {
      var sb     = getSupabase();
      var result = await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200);
      jids = (result.data || []).map(function(c) { return c.jid; });
    }

    var sent = 0;
    for (var i = 0; i < jids.length; i++) {
      try {
        await sock.sendMessage(jids[i], { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) { console.error('[ClientAPI] Broadcast failed for ' + jids[i]); }
    }
    await db.logBroadcast(req.clientId, message, sent);
    res.json({ sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// GET /api/client/broadcasts
router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcast-logs  (what dashboard actually calls)
router.get('/client/broadcast-logs', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcasts  (original)
router.post('/client/broadcasts', runBroadcast);

// POST /api/client/broadcast  (FIX: alias — dashboard calls this path without 's')
router.post('/client/broadcast', runBroadcast);

// ── Orders ────────────────────────────────────────────────────

// GET /api/client/orders
router.get('/client/orders', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false }).limit(100);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/orders/:id
router.put('/client/orders/:id', async function(req, res) {
  try {
    var sb     = getSupabase();
    var update = {};
    if (req.body.status         !== undefined) update.status         = req.body.status;
    if (req.body.payment_status !== undefined) update.payment_status = req.body.payment_status;
    var result = await sb.from('orders').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    res.json(result.data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────

// GET /api/client/analytics?month=YYYY-MM
router.get('/client/analytics', async function(req, res) {
  try {
    var month = req.query.month;
    if (!month) {
      var now = new Date();
      month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    var stats = await db.getMonthlyStats(req.clientId, month);
    res.json(stats || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Tasks (Errands) ───────────────────────────────────────

// GET /api/client/bot-tasks
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/bot-tasks
router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time) {
      return res.status(400).json({ error: 'name, message, and schedule_time required' });
    }
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').insert({
      client_id:     req.clientId,
      name,
      message,
      schedule_time,
      schedule_days: schedule_days || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
      filter_type:   filter_type   || 'all_customers',
      active:        true,
      run_count:     0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/client/bot-tasks/:id
router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var allowed = ['active', 'name', 'message', 'schedule_time', 'schedule_days', 'filter_type'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    res.json(result.data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/bot-tasks/:id
router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service Listings ──────────────────────────────────────────

// GET /api/client/listings
router.get('/client/listings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('service_listings').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/listings
router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords are required' });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id:   req.clientId, name,
      description: description || null,
      price:       price       || null,
      price_label: price_label || null,
      location:    location    || null,
      category:    category    || null,
      keywords,
      available: true
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
    var result = await sb.from('service_listings').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
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

// ── Listing Media ─────────────────────────────────────────────

// GET /api/client/listings/:id/media
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media').select('*')
      .eq('listing_id', req.params.id).eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/listings/:id/media
router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId,
      url, media_type, caption: caption || null,
      filename: filename || null, sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/media/:id
router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File Upload → Supabase Storage ────────────────────────────

// POST /api/client/upload
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

// GET /api/client/faq
router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/faq
router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb     = getSupabase();
    var result = await sb.from('business_faq').insert({
      client_id: req.clientId, question, answer, keywords: keywords || null, sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/client/faq/:id
router.patch('/client/faq/:id', async function(req, res) {
  try {
    var update = {};
    ['question','answer','keywords','sort_order'].forEach(function(k) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });
    var sb     = getSupabase();
    var result = await sb.from('business_faq').update(update)
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/faq/:id
router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Partner / Trial Status ────────────────────────────────────

// GET /api/client/partner-status
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c = result.data;
    var now = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({
      is_partner:   c.is_partner || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null,
      expired:      expiresAt ? expiresAt < now : false,
      still_active: c.subscription_active
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Occupation ────────────────────────────────────────────────

// PUT /api/client/occupation
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({
      client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Location ──────────────────────────────────────────────────

// PUT /api/client/location
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

// ── Qualification toggle ──────────────────────────────────────

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb      = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Setup ─────────────────────────────────────────────────

// PUT /api/client/bot-setup
// FIX: Accepts dashboard field names (delivery_areas, delivery_fee, delivery_time, promo)
//      in addition to original DB column names
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var b  = req.body;

    if (b.occupation) {
      await sb.from('clients').update({
        occupation: b.occupation, occupation_data: b.occupation_data || {}
      }).eq('id', req.clientId);
    }

    var setupData = {
      client_id:           req.clientId,
      availability_days:   b.availability_days  || null,
      payment_methods:     b.payment_methods     || null,
      current_promo:       b.current_promo       || b.promo              || null,
      instagram:           b.instagram           || null,
      facebook:            b.facebook            || null,
      tiktok:              b.tiktok              || null,
      whatsapp_channel:    b.whatsapp_channel    || null,
      service_areas:       b.service_areas       || null,
      studio_location:     b.studio_location     || null,
      home_service:        b.home_service        || null,
      advance_booking:     b.advance_booking     || null,
      deposit_required:    b.deposit_required    || null,
      session_duration:    b.session_duration    || null,
      who_do_you_serve:    b.who_do_you_serve    || null,
      free_consult:        b.free_consult        || null,
      return_policy:       b.return_policy       || null,
      delivers_to:         b.delivers_to         || b.delivery_areas     || null,
      delivery_fee_local:  b.delivery_fee_local  || b.delivery_fee       || null,
      delivery_time_local: b.delivery_time_local || b.delivery_time      || null,
      minimum_order:       b.minimum_order       || null,
      bulk_orders:         b.bulk_orders         || null,
      updated_at:          new Date().toISOString()
    };

    Object.keys(setupData).forEach(function(k) {
      if (setupData[k] === undefined) delete setupData[k];
    });

    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
