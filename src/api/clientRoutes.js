// ============================================================
//  ForgeBot — Client API Routes v3 (FIXED + COMPLETE)
//  src/api/clientRoutes.js
//
//  v3 adds: GET /client/settings, /client/analytics, /client/orders,
//           /client/session-status, /client/broadcast-logs, /client/broadcast,
//           /client/bot-tasks (CRUD), push under auth, file-upload for media.
//  All existing v2 routes preserved exactly.
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

// ── Lazy webpush ──────────────────────────────────────────────
let _webpush = null;
function getWebPush() {
  if (!_webpush) {
    try {
      _webpush = require('web-push');
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        _webpush.setVapidDetails(
          'mailto:support@thefavsforge.com',
          process.env.VAPID_PUBLIC_KEY,
          process.env.VAPID_PRIVATE_KEY
        );
      }
    } catch(e) { _webpush = null; }
  }
  return _webpush;
}

// ── Lazy Supabase ─────────────────────────────────────────────
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

// ── Multer ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── JWT auth ──────────────────────────────────────────────────
function auth(req, res, next) {
  try {
    var header  = req.headers.authorization || '';
    var token   = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
    next();
  } catch(e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Partner expiry ────────────────────────────────────────────
async function checkPartnerExpiry(clientId) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', clientId).single();
    if (result.error || !result.data) return;
    var c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active) {
      if (new Date(c.partner_expires_at) < new Date()) {
        await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
        await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired' });
      }
    }
  } catch(e) { console.error('[ClientAPI] Partner check:', e.message); }
}

// ── Push helper ───────────────────────────────────────────────
async function sendPushToClient(clientId, title, body, url) {
  var wp = getWebPush();
  if (!wp) return;
  try {
    var sb     = getSupabase();
    var result = await sb.from('push_subscriptions').select('subscription').eq('client_id', clientId);
    if (result.error || !result.data || !result.data.length) return;
    var payload = JSON.stringify({ title: title, body: body, url: url || '/dashboard', requireInteraction: true });
    for (var i = 0; i < result.data.length; i++) {
      try {
        var sub = JSON.parse(result.data[i].subscription);
        await wp.sendNotification(sub, payload);
      } catch(e) {
        if (e.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('client_id', clientId);
        }
      }
    }
  } catch(e) { console.error('[Push] Send error:', e.message); }
}

// Make available to other modules
global.sendPushToClient = sendPushToClient;

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

async function activateClient(clientId) {
  var sb = getSupabase();
  await sb.from('clients').update({ status: 'active', trial_notified: false }).eq('id', clientId);
}

router.post('/client/signup', async function(req, res) {
  try {
    var {
      email, full_name, whatsapp_number, plan, ref,
      notification_number, bank_name, account_number, account_name,
      business_name, business_type, country, welcome_message, fallback_message
    } = req.body;
    if (!email || !full_name || !whatsapp_number)
      return res.status(400).json({ error: 'email, full_name, and whatsapp_number are required' });

    var sb   = getSupabase();
    var hash = await bcrypt.hash('forgebot2025', 10);

    var insert = await sb.from('clients').insert({
      email:               email,
      full_name:           full_name,
      business_name:       business_name || full_name,
      whatsapp_number:     whatsapp_number,
      notification_number: notification_number || whatsapp_number,
      bank_name:           bank_name           || null,
      account_number:      account_number      || null,
      account_name:        account_name        || null,
      business_type:       business_type       || null,
      country:             country             || 'nigeria',
      welcome_message:     welcome_message     || null,
      fallback_message:    fallback_message    || null,
      password_hash:       hash,
      status:              'pending',
      plan:                plan || 'monthly',
      referred_by:         ref  || null,
      trial_notified:      false,
      setup_completed:     false
    }).select('id').single();

    if (insert.error) throw new Error(insert.error.message);
    var clientId = insert.data.id;
    var amount   = (plan === 'yearly') ? 24000 : 2500;
    var appUrl   = process.env.APP_URL || 'https://forgebot.up.railway.app';
    var flwRes;
    try {
      flwRes = await axios.post('https://api.flutterwave.com/v3/payments', {
        tx_ref:       'FB-' + clientId + '-' + Date.now(),
        amount:       amount,
        currency:     'NGN',
        redirect_url: appUrl + '/api/client/pay/callback',
        customer:     { email: email, name: full_name, phonenumber: whatsapp_number },
        meta:         { client_id: clientId },
        customizations: { title: 'ForgeBot Subscription', logo: appUrl + '/icons/icon-192.png' }
      }, { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    } catch(e) {
      await sb.from('clients').delete().eq('id', clientId);
      return res.status(502).json({ error: 'Payment gateway unavailable.' });
    }
    if (!flwRes.data || flwRes.data.status !== 'success') {
      await sb.from('clients').delete().eq('id', clientId);
      return res.status(502).json({ error: 'Could not create payment link.' });
    }
    res.json({ payment_url: flwRes.data.data.link });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/login', async function(req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('email', email).single();
    if (result.error || !result.data) return res.status(401).json({ error: 'Invalid credentials' });
    var client = result.data;
    if (client.status !== 'active') return res.status(403).json({ error: 'Account not yet active.' });
    var match = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    var token = jwt.sign({ id: client.id, clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, client: { id: client.id, full_name: client.full_name, email: client.email } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// QR stream — PUBLIC (EventSource can't send auth headers)
router.get('/client/qr-stream', async function(req, res) {
  var token; var clientId;
  try {
    var decoded = jwt.verify(req.query.token, process.env.JWT_SECRET);
    clientId = decoded.clientId || decoded.id;
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
  }

  var heartbeat = setInterval(function() {
    try { res.write(':heartbeat\n\n'); } catch(e) {}
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
  } catch(e) {
    sendEvent('error', { message: 'Failed to start session.' });
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
      verify = await axios.get('https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify',
        { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    } catch(e) { return res.redirect(appUrl + '/?payment=failed'); }
    var txData = verify.data && verify.data.data;
    if (!txData || txData.status !== 'successful') return res.redirect(appUrl + '/?payment=failed');
    var clientId = txData.meta && txData.meta.client_id;
    if (!clientId) return res.redirect(appUrl + '/?payment=failed');
    await activateClient(clientId);
    var tok = jwt.sign({ id: clientId, clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.redirect(appUrl + '/onboard?activated=1&token=' + tok);
  } catch(e) { return res.redirect((process.env.APP_URL || 'https://forgebot.up.railway.app') + '/?payment=error'); }
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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Apply auth to all /client routes ─────────────────────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  CORE CLIENT ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/client/me', async function(req, res) {
  try {
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var sock   = sessionManager.getSession(req.clientId);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /client/settings ─────────────────────────────────────
router.get('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();
    var cr = await sb.from('clients').select(
      'notification_number,welcome_message,fallback_message,bank_name,account_number,account_name,business_hours,business_name,full_name'
    ).eq('id', req.clientId).single();

    var sr = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();

    var c = cr.data  || {};
    var s = sr.data  || {};

    res.json({
      notification_number: c.notification_number,
      welcome_message:     c.welcome_message,
      fallback_message:    c.fallback_message,
      bank_name:           c.bank_name,
      account_number:      c.account_number,
      account_name:        c.account_name,
      business_hours:      c.business_hours,
      business_name:       c.business_name || c.full_name,
      bot_setup: {
        instagram:         s.instagram,
        facebook:          s.facebook,
        tiktok:            s.tiktok,
        whatsapp_channel:  s.whatsapp_channel,
        delivery_areas:    s.delivery_areas || s.service_areas || s.delivers_to,
        delivery_fee:      s.delivery_fee   || s.delivery_fee_local,
        delivery_time:     s.delivery_time  || s.delivery_time_local,
        minimum_order:     s.minimum_order,
        return_policy:     s.return_policy,
        promo:             s.promo          || s.current_promo,
        payment_methods:   s.payment_methods,
        meme_post_time:    s.meme_post_time,
        product_post_time: s.product_post_time,
        schedule_days:     s.schedule_days
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /client/settings ─────────────────────────────────────
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number','welcome_message','fallback_message',
      'bank_name','account_number','account_name','business_hours','business_name'
    ];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var updated = await db.updateClient(req.clientId, update);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /client/session-status ───────────────────────────────
router.get('/client/session-status', async function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Flows ─────────────────────────────────────────────────────
router.get('/client/flows', async function(req, res) {
  try {
    var flows = await db.getFlows(req.clientId, false);
    res.json(flows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response required' });
    var flow = await db.addFlow(req.clientId, 'Custom', keywords, response_type || 'text', response, media_url || null, 0);
    res.json(flow);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/flows/:id', async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Status Posts ──────────────────────────────────────────────
router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/status-posts', async function(req, res) {
  try {
    var mediaUrl      = req.body.media_url      || req.body.mediaUrl      || null;
    var postTime      = req.body.post_time       || req.body.scheduledTime || req.body.postTime || null;
    var scheduledDays = req.body.scheduledDays   || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun';
    var caption       = req.body.caption         || null;
    var post = await db.addStatusPost(req.clientId, caption, mediaUrl, postTime, scheduledDays);
    res.json(post);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Orders ────────────────────────────────────────────────────
router.get('/client/orders', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(100);
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/orders/:id', async function(req, res) {
  try {
    var allowed = ['status','payment_status','notes'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    update.updated_at = new Date().toISOString();

    var sb     = getSupabase();
    var result = await sb.from('orders')
      .update(update)
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .select().single();

    if (result.error) throw new Error(result.error.message);

    // Push notification: order confirmed
    if (update.status === 'confirmed') {
      await sendPushToClient(req.clientId, 'Order Confirmed', 'You confirmed an order!', '/dashboard');
    }

    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ─────────────────────────────────────────────────
router.get('/client/analytics', async function(req, res) {
  try {
    var month  = req.query.month; // YYYY-MM
    var sb     = getSupabase();

    var startDate = month ? month + '-01' : new Date().toISOString().slice(0,7) + '-01';
    var d         = new Date(startDate);
    d.setMonth(d.getMonth() + 1);
    var endDate   = d.toISOString().slice(0,10);

    // New customers this month
    var custR = await sb.from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .gte('created_at', startDate)
      .lt('created_at', endDate);

    // Orders placed
    var ordersPlacedR = await sb.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .gte('created_at', startDate)
      .lt('created_at', endDate);

    // Confirmed orders
    var ordersConfR = await sb.from('orders')
      .select('id,total', { count: 'exact' })
      .eq('client_id', req.clientId)
      .in('status', ['confirmed','shipped','delivered'])
      .gte('created_at', startDate)
      .lt('created_at', endDate);

    // Revenue
    var revenue = 0;
    if (ordersConfR.data) {
      revenue = ordersConfR.data.reduce(function(sum, o) {
        return sum + (parseFloat(o.total) || 0);
      }, 0);
    }

    // Price inquiries — flows triggered (approx via conversation_logs if exists)
    var leadsR = await sb.from('conversation_logs')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .eq('log_type', 'price_inquiry')
      .gte('created_at', startDate)
      .lt('created_at', endDate)
      .catch(function() { return { count: 0 }; });

    res.json({
      new_customers:    custR.count       || 0,
      leads:            leadsR.count      || 0,
      orders_placed:    ordersPlacedR.count || 0,
      orders_confirmed: ordersConfR.count || 0,
      total_revenue:    revenue
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcast ─────────────────────────────────────────────────
router.get('/client/broadcast-logs', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('sent_at', { ascending: false })
      .limit(20);
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/broadcast', async function(req, res) {
  try {
    var { message, audience, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var sb = getSupabase();
    var jids = [];

    if (audience === 'custom' && phones && phones.length) {
      jids = phones.map(function(p) { return p.replace(/\D/g,'') + '@s.whatsapp.net'; });
    } else {
      var query = sb.from('customers').select('jid').eq('client_id', req.clientId).limit(500);

      if (audience === 'inactive_7d') {
        var cutoff7 = new Date(Date.now() - 7*24*60*60*1000).toISOString();
        query = query.lt('last_contact', cutoff7);
      } else if (audience === 'inactive_14d') {
        var cutoff14 = new Date(Date.now() - 14*24*60*60*1000).toISOString();
        query = query.lt('last_contact', cutoff14);
      }

      var custResult = await query;
      jids = (custResult.data || []).map(function(c) { return c.jid; });
    }

    var sent = 0;
    for (var i = 0; i < jids.length; i++) {
      try {
        await sock.sendMessage(jids[i], { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch(e) {}
    }

    await sb.from('broadcasts').insert({
      client_id: req.clientId,
      message:   message,
      audience:  audience || 'custom',
      sent:      sent,
      total:     jids.length,
      sent_at:   new Date().toISOString()
    });

    res.json({ sent: sent, total: jids.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Legacy /client/broadcasts alias
router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId)
      .order('sent_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Tasks (Errands) ───────────────────────────────────────
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time)
      return res.status(400).json({ error: 'name, message and schedule_time required' });

    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').insert({
      client_id:     req.clientId,
      name:          name,
      message:       message,
      schedule_time: schedule_time,
      schedule_days: schedule_days || 'Mon,Tue,Wed,Thu,Fri',
      filter_type:   filter_type   || 'all_customers',
      active:        true,
      run_count:     0
    }).select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var allowed = ['name','message','schedule_time','schedule_days','filter_type','active'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    var sb     = getSupabase();
    var result = await sb.from('bot_tasks')
      .update(update)
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Push Notifications (under auth) ──────────────────────────
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { endpoint, keys } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    var sub = JSON.stringify({ endpoint: endpoint, keys: keys });
    var sb  = getSupabase();
    await sb.from('push_subscriptions').upsert(
      { client_id: req.clientId, subscription: sub, updated_at: new Date().toISOString() },
      { onConflict: 'client_id' }
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/push/test', async function(req, res) {
  try {
    await sendPushToClient(req.clientId,
      'ForgeBot Test',
      'Push notifications are working! You will be alerted for orders and payments.',
      '/dashboard'
    );
    res.json({ sent: 1, ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Post Schedule ─────────────────────────────────────────────
router.get('/client/post-schedule', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_setup').select('product_post_time,meme_post_time,schedule_days').eq('client_id', req.clientId).single();
    res.json(result.data || {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Setup ─────────────────────────────────────────────────
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase(); var b = req.body;

    // Accept both dashboard names and DB names
    var delivery_areas = b.delivery_areas || b.service_areas   || b.delivers_to     || null;
    var delivery_fee   = b.delivery_fee   || b.delivery_fee_local                   || null;
    var delivery_time  = b.delivery_time  || b.delivery_time_local                  || null;
    var promo          = b.promo          || b.current_promo                         || null;

    if (b.occupation) {
      await sb.from('clients').update({
        occupation:      b.occupation,
        occupation_data: b.occupation_data || {}
      }).eq('id', req.clientId);
    }

    var setupData = {
      client_id:         req.clientId,
      availability_days: b.availability_days || null,
      payment_methods:   b.payment_methods   || null,
      current_promo:     promo,
      promo:             promo,
      instagram:         b.instagram         || null,
      facebook:          b.facebook          || null,
      tiktok:            b.tiktok            || null,
      whatsapp_channel:  b.whatsapp_channel  || null,
      service_areas:     delivery_areas,
      delivery_areas:    delivery_areas,
      delivers_to:       delivery_areas,
      delivery_fee:      delivery_fee,
      delivery_fee_local:delivery_fee,
      delivery_time:     delivery_time,
      delivery_time_local:delivery_time,
      minimum_order:     b.minimum_order     || null,
      return_policy:     b.return_policy     || null,
      bulk_orders:       b.bulk_orders       || null,
      product_post_time: b.product_post_time || null,
      meme_post_time:    b.meme_post_time    || null,
      schedule_days:     b.schedule_days     || null,
      updated_at:        new Date().toISOString()
    };

    // Remove undefined keys
    Object.keys(setupData).forEach(function(k) {
      if (setupData[k] === undefined) delete setupData[k];
    });

    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listings ──────────────────────────────────────────────────
router.get('/client/listings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('service_listings')
      .select('*, listing_media(id, url, media_type, caption, sort_order)')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id:   req.clientId,
      name:        name,
      description: description || null,
      price:       price       || null,
      price_label: price_label || null,
      location:    location    || null,
      category:    category    || null,
      keywords:    keywords    || name.toLowerCase(),
      available:   true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listing Media — supports both file upload and JSON URL ─────
router.post('/client/listings/:id/media', upload.single('file'), async function(req, res) {
  try {
    var sb        = getSupabase();
    var listingId = req.params.id;
    var mediaUrl, mediaType, filename;

    if (req.file) {
      // File uploaded via multipart
      var ext  = (req.file.originalname || 'file').split('.').pop().toLowerCase();
      var path = req.clientId + '/' + listingId + '/' + Date.now() + '.' + ext;
      var bucket = 'forgebot-listings';
      var up   = await sb.storage.from(bucket).upload(path, req.file.buffer, {
        contentType: req.file.mimetype, upsert: false
      });
      if (up.error) throw new Error(up.error.message);
      var urlRes = sb.storage.from(bucket).getPublicUrl(path);
      mediaUrl  = urlRes.data.publicUrl;
      filename  = req.file.originalname;
      var mime  = req.file.mimetype || '';
      mediaType = mime.startsWith('video/') ? 'video'
                : mime.startsWith('image/') ? 'image'
                : mime === 'application/pdf' ? 'pdf' : 'other';
    } else {
      // JSON body with URL
      mediaUrl  = req.body.url;
      mediaType = req.body.media_type;
      filename  = req.body.filename || null;
      if (!mediaUrl || !mediaType) return res.status(400).json({ error: 'url and media_type required' });
    }

    var result = await sb.from('listing_media').insert({
      listing_id: listingId,
      client_id:  req.clientId,
      url:        mediaUrl,
      media_type: mediaType,
      caption:    req.body.caption    || null,
      filename:   filename,
      sort_order: req.body.sort_order || 0
    }).select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media').select('*')
      .eq('listing_id', req.params.id).eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── File Upload (standalone) ──────────────────────────────────
router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    var sb       = getSupabase();
    var ext      = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var result   = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false
    });
    if (result.error) throw new Error(result.error.message);
    var urlResult = sb.storage.from('forgebot-listings').getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FAQ ───────────────────────────────────────────────────────
router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Partner Status ────────────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c        = result.data;
    var now      = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({
      is_partner:   c.is_partner   || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null,
      expired:      expiresAt ? expiresAt < now : false,
      still_active: c.subscription_active
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Occupation / Location ─────────────────────────────────────
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message });
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb      = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
