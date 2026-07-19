// ============================================================
//  ForgeBot — Client API Routes
//  File location: src/api/clientRoutes.js
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//
//  PUBLIC (no auth):
//    POST /api/client/signup        — create account + initiate payment
//    POST /api/client/login         — get JWT
//    GET  /api/client/pay/callback  — Flutterwave redirect
//    POST /api/client/pay/webhook   — Flutterwave webhook
//    GET  /api/push/vapid-key       — VAPID public key
//
//  PROTECTED (Bearer JWT):
//    All /api/client/* routes below
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const axios   = require('axios');
const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

const sessionManager = require('../sessions/sessionManager');

// ── Lazy Supabase init ────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    var url = process.env.SUPABASE_URL;
    var key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// ── Multer: memory storage for file uploads ───────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── VAPID setup ───────────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.ADMIN_EMAIL || 'admin@forgebot.ng'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

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

// ── Partner expiry auto-check ─────────────────────────────────
async function checkPartnerExpiry(clientId) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', clientId).single();
    if (result.error || !result.data) return;
    var c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active && new Date(c.partner_expires_at) < new Date()) {
      await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
      await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired on API request check' });
    }
  } catch (e) { /* non-fatal */ }
}

// Apply auth + expiry check to all /client/* protected routes
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — no auth required
// ════════════════════════════════════════════════════════════════

// ── POST /api/client/signup ───────────────────────────────────
// Creates account then initiates Flutterwave payment
router.post('/client/signup', async function(req, res) {
  try {
    var full_name       = (req.body.full_name       || req.body.name || '').trim();
    var business_name   = (req.body.business_name   || full_name).trim();
    var email           = (req.body.email           || '').trim().toLowerCase();
    var password        = (req.body.password        || '').trim();
    var whatsapp_number = (req.body.whatsapp_number || req.body.phone || '').replace(/\D/g, '');
    var occupation      = req.body.occupation       || 'general';
    var plan            = req.body.plan             || 'nigeria'; // 'nigeria' or 'international'

    if (!full_name || !email || !password || !whatsapp_number) {
      return res.status(400).json({ error: 'Name, email, password and WhatsApp number are required' });
    }

    var sb = getSupabase();

    // Check duplicate email
    var existing = await sb.from('clients').select('id').eq('email', email).single();
    if (existing.data) return res.status(409).json({ error: 'Email already registered. Please login.' });

    // Create account — subscription_active: false until payment
    var hashedPw = await bcrypt.hash(password, 10);
    var result   = await sb.from('clients').insert({
      full_name:           full_name,
      business_name:       business_name,
      email:               email,
      password_hash:       hashedPw,
      whatsapp_number:     whatsapp_number,
      occupation:          occupation,
      status:              'pending_payment',
      subscription_active: false,
      trial_notified:      false,
      setup_completed:     false
    }).select('id,email,business_name,full_name').single();

    if (result.error) throw new Error(result.error.message);
    var client = result.data;

    // Initiate Flutterwave payment
    var amount   = plan === 'international' ? 45 : 30000;
    var currency = plan === 'international' ? 'USD' : 'NGN';
    var appUrl   = process.env.APP_URL || 'https://forgebot.ng';

    var flwRes = await axios.post('https://api.flutterwave.com/v3/payments', {
      tx_ref:       'FB-' + client.id + '-' + Date.now(),
      amount:       amount,
      currency:     currency,
      redirect_url: appUrl + '/api/client/pay/callback',
      customer: {
        email:       client.email,
        name:        client.full_name,
        phonenumber: whatsapp_number
      },
      customizations: {
        title:       'ForgeBot Subscription',
        description: 'WhatsApp Bot Activation — ' + client.business_name,
        logo:        appUrl + '/icons/icon-192.png'
      },
      meta: {
        client_id: client.id,
        plan:      plan
      }
    }, {
      headers: {
        Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (flwRes.data && flwRes.data.data && flwRes.data.data.link) {
      return res.json({ ok: true, payment_link: flwRes.data.data.link, client_id: client.id });
    } else {
      // Payment init failed — delete the account to allow retry
      await sb.from('clients').delete().eq('id', client.id);
      return res.status(500).json({ error: 'Could not initiate payment. Please try again.' });
    }
  } catch (err) {
    console.error('[Signup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/client/login ────────────────────────────────────
router.post('/client/login', async function(req, res) {
  try {
    var email    = (req.body.email    || '').trim().toLowerCase();
    var password = (req.body.password || '').trim();
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('email', email).single();
    if (result.error || !result.data) return res.status(401).json({ error: 'Incorrect email or password' });

    var client = result.data;
    var match  = await bcrypt.compare(password, client.password_hash || '');
    if (!match) return res.status(401).json({ error: 'Incorrect email or password' });

    if (!client.subscription_active && client.status !== 'active') {
      return res.status(403).json({ error: 'Your account is not active. Please complete payment to continue.' });
    }

    var token = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({
      ok:    true,
      token: token,
      client: {
        id:            client.id,
        business_name: client.business_name,
        email:         client.email,
        occupation:    client.occupation,
        setup_completed: client.setup_completed
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/client/pay/callback — Flutterwave redirect after payment ─
router.get('/client/pay/callback', async function(req, res) {
  try {
    var txRef  = req.query.tx_ref   || '';
    var txId   = req.query.transaction_id || '';
    var status = req.query.status   || '';

    var appUrl = process.env.APP_URL || 'https://forgebot.ng';

    if (status !== 'successful' && status !== 'completed') {
      return res.redirect(appUrl + '/?payment=failed');
    }

    // Verify with Flutterwave
    var verify = await axios.get('https://api.flutterwave.com/v3/transactions/' + txId + '/verify', {
      headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY },
      timeout: 10000
    });

    var tx = verify.data && verify.data.data;
    if (!tx || tx.status !== 'successful') {
      return res.redirect(appUrl + '/?payment=failed');
    }

    var clientId = tx.meta && tx.meta.client_id;
    if (!clientId) return res.redirect(appUrl + '/?payment=failed');

    // Activate account
    var sb = getSupabase();
    await sb.from('clients').update({
      subscription_active: true,
      status:              'active',
      setup_completed:     false
    }).eq('id', clientId);

    return res.redirect(appUrl + '/onboard?activated=1');
  } catch (err) {
    console.error('[Pay Callback]', err.message);
    var appUrl = process.env.APP_URL || 'https://forgebot.ng';
    return res.redirect(appUrl + '/?payment=failed');
  }
});

// ── POST /api/client/pay/webhook — Flutterwave webhook ───────
router.post('/client/pay/webhook', async function(req, res) {
  try {
    var hash = req.headers['verif-hash'];
    if (!hash || hash !== process.env.FLW_HASH) return res.status(401).send('Unauthorized');

    var event = req.body;
    if (event.event !== 'charge.completed') return res.sendStatus(200);
    if (event.data && event.data.status === 'successful') {
      var clientId = event.data.meta && event.data.meta.client_id;
      if (clientId) {
        var sb = getSupabase();
        await sb.from('clients').update({ subscription_active: true, status: 'active' }).eq('id', clientId);
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Pay Webhook]', err.message);
    return res.sendStatus(200); // Always 200 to Flutterwave
  }
});

// ── GET /api/push/vapid-key ───────────────────────────────────
router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── POST /api/push/subscribe ──────────────────────────────────
router.post('/push/subscribe', auth, async function(req, res) {
  try {
    var sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id:    req.clientId,
      endpoint:     sub.endpoint,
      subscription: sub,
      updated_at:   new Date().toISOString()
    }, { onConflict: 'client_id,endpoint' });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/push/test ───────────────────────────────────────
router.post('/push/test', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('push_subscriptions').select('subscription').eq('client_id', req.clientId);
    var subs   = result.data || [];
    var sent   = 0;
    for (var i = 0; i < subs.length; i++) {
      try {
        await webpush.sendNotification(subs[i].subscription, JSON.stringify({
          title: 'ForgeBot Test ✅',
          body:  'Push notifications are working!'
        }));
        sent++;
      } catch (e) { /* non-fatal */ }
    }
    return res.json({ ok: true, sent: sent });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  PROTECTED ROUTES — all require Bearer JWT
// ════════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    var client = result.data;
    var sock   = sessionManager.getSession ? sessionManager.getSession(req.clientId) : null;
    var safe   = Object.assign({}, client);
    delete safe.password_hash;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/flows
router.get('/client/flows', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('flows').select('*').eq('client_id', req.clientId).order('priority', { ascending: false });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/flows
router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response required' });
    var sb = getSupabase();
    var r  = await sb.from('flows').insert({
      client_id: req.clientId, flow_name: 'Custom',
      keywords, response_type: response_type || 'text', response, media_url: media_url || null, priority: 0
    }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/status-posts
router.get('/client/status-posts', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('status_posts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/status-posts
router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
    var sb = getSupabase();
    var r  = await sb.from('status_posts').insert({
      client_id: req.clientId, caption: caption || null, media_url: mediaUrl,
      schedule_time: scheduledTime, schedule_days: scheduledDays, active: true
    }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
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

// GET /api/client/broadcasts
router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(20);
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcasts
router.post('/client/broadcasts', async function(req, res) {
  try {
    var { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    var sb     = getSupabase();
    var result = await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200);
    var jids   = (result.data || []).map(function(c) { return c.jid; });
    var sent   = 0;
    for (var i = 0; i < jids.length; i++) {
      try {
        await sock.sendMessage(jids[i], { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) { /* skip failed */ }
    }
    await sb.from('broadcasts').insert({ client_id: req.clientId, message: message, sent_count: sent });
    res.json({ sent: sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = ['notification_number','business_name','bank_name','account_number','account_name','business_hours'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb = getSupabase();
    var r  = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/bot-setup
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('bot_setup').upsert(
      Object.assign({ client_id: req.clientId, updated_at: new Date().toISOString() }, req.body),
      { onConflict: 'client_id' }
    ).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/bot-setup
router.get('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    res.json(r.data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var sb = getSupabase();
    await sb.from('clients').update({ fallback_message }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/qr-stream (SSE)
router.get('/client/qr-stream', async function(req, res) {
  var token = req.query.token;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  var clientId = req.clientId;
  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  var sock = sessionManager.getSession(clientId);
  if (sock) { sendEvent('connected', { status: 'connected' }); res.end(); return; }

  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  await sessionManager.startSession(clientId, {
    onQR: function(qr) {
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { try { fn('qr', { qr }); } catch(e) {} });
    },
    onConnected: function() {
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { try { fn('connected', { status: 'connected' }); } catch(e) {} });
      global.qrListeners.delete(clientId);
    },
    onDisconnected: function() {
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { try { fn('disconnected', { status: 'disconnected' }); } catch(e) {} });
    }
  });

  req.on('close', function() {
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });
});

// ── Orders ────────────────────────────────────────────────────

// GET /api/client/orders
router.get('/client/orders', async function(req, res) {
  try {
    var sb = getSupabase();
    var q  = sb.from('orders').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    if (req.query.status) q = q.eq('status', req.query.status);
    var r = await q;
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/orders/:id
router.get('/client/orders/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('orders').select('*').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (r.error || !r.data) return res.status(404).json({ error: 'Not found' });
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/orders/:id
router.put('/client/orders/:id', async function(req, res) {
  try {
    var { status } = req.body;
    var allowed    = ['confirmed','packaging','shipped','delivered','rejected'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    var sb = getSupabase();
    var r  = await sb.from('orders').update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);

    // Notify customer on WhatsApp
    var order = r.data;
    var sock  = sessionManager.getSession(req.clientId);
    if (sock && order.customer_jid) {
      var msgs = {
        confirmed:  '✅ Your order has been *confirmed*! We\'re getting it ready for you.',
        packaging:  '📦 Your order is being *packaged* and will be dispatched soon!',
        shipped:    '🚚 Your order is on its way! Expect delivery shortly.',
        delivered:  '🎉 Your order has been *delivered*! Thank you for shopping with us.',
        rejected:   '❌ Unfortunately, we could not process your order. Please contact us for assistance.'
      };
      if (msgs[status]) {
        try { await sock.sendMessage(order.customer_jid, { text: msgs[status] }); } catch (e) { /* non-fatal */ }
      }
    }
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────

// GET /api/client/analytics?month=YYYY-MM
router.get('/client/analytics', async function(req, res) {
  try {
    var month  = req.query.month || new Date().toISOString().slice(0, 7);
    var start  = month + '-01';
    var end    = new Date(new Date(start).setMonth(new Date(start).getMonth() + 1)).toISOString().slice(0, 10);
    var sb     = getSupabase();

    var [custR, ordersR, inquiryR] = await Promise.all([
      sb.from('customers').select('id', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', end),
      sb.from('orders').select('id,total,status').eq('client_id', req.clientId).gte('created_at', start).lt('created_at', end),
      sb.from('price_inquiries').select('id', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', end)
    ]);

    var orders   = ordersR.data || [];
    var revenue  = orders.filter(function(o) { return o.status === 'delivered'; }).reduce(function(s, o) { return s + (o.total || 0); }, 0);
    var confirmed = orders.filter(function(o) { return ['confirmed','packaging','shipped','delivered'].includes(o.status); }).length;

    res.json({
      month,
      new_customers:   custR.count || 0,
      price_inquiries: inquiryR.count || 0,
      orders_placed:   orders.length,
      orders_confirmed: confirmed,
      revenue
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Tasks (Errands) ───────────────────────────────────────

// GET /api/client/bot-tasks
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('bot_tasks').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/bot-tasks
router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time) return res.status(400).json({ error: 'name, message and schedule_time required' });
    if (!/^\d{2}:\d{2}$/.test(schedule_time)) return res.status(400).json({ error: 'schedule_time must be HH:MM' });
    var sb = getSupabase();
    var r  = await sb.from('bot_tasks').insert({
      client_id: req.clientId, name, message, schedule_time,
      schedule_days: schedule_days || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
      filter_type:   filter_type   || 'all_customers',
      active:        true
    }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/client/bot-tasks/:id
router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    // Verify ownership
    var sb = getSupabase();
    var check = await sb.from('bot_tasks').select('id').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (check.error || !check.data) return res.status(404).json({ error: 'Task not found' });
    var allowed = ['name','message','schedule_time','schedule_days','filter_type','active'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var r = await sb.from('bot_tasks').update(update).eq('id', req.params.id).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/bot-tasks/:id
router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    var check = await sb.from('bot_tasks').select('id').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (check.error || !check.data) return res.status(404).json({ error: 'Task not found' });
    await sb.from('bot_tasks').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Occupation ────────────────────────────────────────────────
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service Listings ──────────────────────────────────────────
router.get('/client/listings', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('service_listings').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords required' });
    var sb = getSupabase();
    var r  = await sb.from('service_listings').insert({
      client_id: req.clientId, name, description: description || null,
      price: price || null, price_label: price_label || null,
      location: location || null, category: category || null,
      keywords, available: true
    }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','available'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb = getSupabase();
    var r  = await sb.from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
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
    var sb = getSupabase();
    var r  = await sb.from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb = getSupabase();
    var r  = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId,
      url, media_type, caption: caption || null, filename: filename || null, sort_order: sort_order || 0
    }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
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
    var r        = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (r.error) throw new Error(r.error.message);
    var urlResult = sb.storage.from('forgebot-listings').getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FAQ ───────────────────────────────────────────────────────
router.get('/client/faq', async function(req, res) {
  try {
    var sb = getSupabase();
    var r  = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb = getSupabase();
    var r  = await sb.from('business_faq').insert({ client_id: req.clientId, question, answer, keywords: keywords || null, sort_order: sort_order || 0 }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', async function(req, res) {
  try {
    var update = {};
    ['question','answer','keywords','sort_order'].forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb = getSupabase();
    var r  = await sb.from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Partner Status ────────────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c         = result.data;
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({
      is_partner:   c.is_partner || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    expiresAt ? Math.ceil((expiresAt - new Date()) / 86400000) : null,
      expired:      expiresAt ? expiresAt < new Date() : false,
      still_active: c.subscription_active
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Qualification toggle ──────────────────────────────────────
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb          = getSupabase();
    var current     = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData     = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
