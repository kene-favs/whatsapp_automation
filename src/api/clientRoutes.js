// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  v3 fixes over v2:
//   - PUT /client/settings  → direct Supabase (bypasses db.updateClient whitelist)
//   - GET /client/bot-setup → ADDED (was missing, dashboard couldn't load schedule)
//   - PUT /client/bot-setup → now saves product_post_time, meme_post_time, schedule_days
//   - POST /client/push/subscribe → moved into auth section (uses JWT clientId)
//   - POST /client/push/test     → actually sends push via web-push (was empty)
//   All other routes preserved exactly as v2
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

// ── Send a push notification to a client ─────────────────────
async function sendPushToClient(clientId, title, body, data) {
  try {
    var webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:admin@forgebot.io',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    var sb     = getSupabase();
    var result = await sb
      .from('push_subscriptions')
      .select('subscription')
      .eq('client_id', clientId)
      .single();

    if (result.error || !result.data) return false;

    var sub = result.data.subscription;
    if (typeof sub === 'string') sub = JSON.parse(sub);

    var payload = JSON.stringify({
      title: title || 'ForgeBot',
      body:  body  || '',
      data:  data  || {}
    });

    await webpush.sendNotification(sub, payload);
    return true;
  } catch (e) {
    console.error('[ClientAPI] sendPushToClient error:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — before router.use('/client', auth …)
// ══════════════════════════════════════════════════════════════

// ── Activate / renew a client's subscription ─────────────────
// Called on:
//  - First payment: ₦30,000 setup fee → gives 31 days access
//  - Every monthly auto-renewal: ₦10,000 → extends by another 31 days
async function activateClient(clientId, plan) {
  var sb = _supabase || createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Every payment (setup or renewal) gives 31 days of bot access
  var expiry = new Date();
  expiry.setDate(expiry.getDate() + 31);

  await sb.from('clients').update({
    status:                 'active',
    subscription_active:    true,
    trial_notified:         false,
    subscription_expires_at: expiry.toISOString()
  }).eq('id', clientId);
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
    // Pricing: ₦30,000 one-time setup fee at signup.
    // After that, ₦10,000/month auto-charged via Flutterwave recurring plan.
    // FLW_MONTHLY_PLAN_ID in Railway env = the ₦10,000/month plan ID from Flutterwave dashboard.
    var SETUP_AMOUNT = 30000;
    var appUrl       = process.env.APP_URL || 'https://forgebot.up.railway.app';
    var planId       = process.env.FLW_MONTHLY_PLAN_ID; // ₦10,000/month recurring plan
    var flwRes;
    try {
      var paymentBody = {
        tx_ref:       'FB-' + clientId + '-' + Date.now(),
        amount:       SETUP_AMOUNT,
        currency:     'NGN',
        redirect_url: appUrl + '/api/client/pay/callback',
        customer:     { email: email, name: full_name, phonenumber: whatsapp_number },
        meta:         { client_id: clientId, plan: 'monthly' },
        customizations: { title: 'ForgeBot Setup', logo: appUrl + '/icons/icon-192.png' }
      };
      // Attaches ₦10,000/month recurring plan so Flutterwave auto-charges every month
      if (planId) paymentBody.payment_plan = planId;
      flwRes = await axios.post('https://api.flutterwave.com/v3/payments', paymentBody,
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
    var plan     = (txData.meta && txData.meta.plan) || 'monthly';
    if (!clientId) return res.redirect(appUrl + '/?payment=failed');
    await activateClient(clientId, plan);
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
      var plan     = (data.meta && data.meta.plan) || 'monthly';
      if (clientId) await activateClient(clientId, plan);
    }
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// VAPID key — public, no auth needed
router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Apply auth + partner check to all /client routes ─────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  AUTHENTICATED ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', async function(req, res) {
  try {
    // Use direct Supabase so all columns (including new ones) are returned
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    var sock   = sessionManager.getSession(req.clientId);
    var client = result.data;
    delete client.password_hash;
    client.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(client);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/flows
router.get('/client/flows', async function(req, res) {
  try {
    var flows = await db.getFlows(req.clientId, false);
    res.json(flows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/flows
router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    var flow = await db.addFlow(req.clientId, 'Custom', keywords, response_type || 'text', response, media_url || null, 0);
    res.json(flow);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/status-posts
router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/status-posts
router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
    var post = await db.addStatusPost(req.clientId, caption, mediaUrl, scheduledTime, scheduledDays);
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/status-posts/:id
router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/broadcasts
router.get('/client/broadcasts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Settings ──────────────────────────────────────────────────
// PUT /api/client/settings
// FIX v3: Direct Supabase call instead of db.updateClient()
// db.updateClient has a whitelist that silently ignores bank_name,
// account_number, account_name, notification_number, business_hours
router.put('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();
    var b  = req.body;
    var update = {};
    var allowed = [
      'notification_number',
      'welcome_message',
      'fallback_message',
      'bank_name',
      'account_number',
      'account_name',
      'business_hours',
      'business_name'
    ];
    allowed.forEach(function(k) {
      if (b[k] !== undefined) update[k] = b[k];
    });
    if (!Object.keys(update).length) return res.json({ ok: true });
    var { data, error } = await sb
      .from('clients')
      .update(update)
      .eq('id', req.clientId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data || { ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var sb = getSupabase();
    var { data, error } = await sb
      .from('clients')
      .update({ fallback_message: fallback_message })
      .eq('id', req.clientId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data || { ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot Setup ─────────────────────────────────────────────────

// GET /api/client/bot-setup  ← ADDED in v3 (was missing — dashboard couldn't load schedule)
router.get('/client/bot-setup', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb
      .from('bot_setup')
      .select('*')
      .eq('client_id', req.clientId)
      .single();
    // Return empty object if no setup yet — don't 404
    res.json(result.data || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/bot-setup
// FIX v3: now saves product_post_time, meme_post_time, schedule_days, meme_media_urls
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb       = getSupabase();
    var clientId = req.clientId;
    var {
      occupation, occupation_data,
      availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel,
      service_areas, studio_location, home_service,
      advance_booking, deposit_required, session_duration,
      who_do_you_serve, free_consult, return_policy,
      delivers_to, delivery_fee_local, delivery_time_local,
      minimum_order, bulk_orders,
      // ── Schedule fields (v3 additions) ──
      product_post_time, meme_post_time, schedule_days, meme_media_urls
    } = req.body;

    if (occupation) {
      await sb.from('clients')
        .update({ occupation: occupation, occupation_data: occupation_data || {} })
        .eq('id', clientId);
    }

    var setupData = {
      client_id:           clientId,
      availability_days:   availability_days   || null,
      payment_methods:     payment_methods     || null,
      current_promo:       current_promo       || null,
      instagram:           instagram           || null,
      facebook:            facebook            || null,
      tiktok:              tiktok              || null,
      whatsapp_channel:    whatsapp_channel    || null,
      service_areas:       service_areas       || null,
      studio_location:     studio_location     || null,
      home_service:        home_service        || null,
      advance_booking:     advance_booking     || null,
      deposit_required:    deposit_required    || null,
      session_duration:    session_duration    || null,
      who_do_you_serve:    who_do_you_serve    || null,
      free_consult:        free_consult        || null,
      return_policy:       return_policy       || null,
      delivers_to:         delivers_to         || null,
      delivery_fee_local:  delivery_fee_local  || null,
      delivery_time_local: delivery_time_local || null,
      minimum_order:       minimum_order       || null,
      bulk_orders:         bulk_orders         || null,
      // Schedule
      product_post_time:   product_post_time   || null,
      meme_post_time:      meme_post_time       || null,
      schedule_days:       schedule_days       || null,
      meme_media_urls:     meme_media_urls     || null,
      updated_at:          new Date().toISOString()
    };

    // Remove undefined keys
    Object.keys(setupData).forEach(function(k) {
      if (setupData[k] === undefined) delete setupData[k];
    });

    var { error } = await sb
      .from('bot_setup')
      .upsert(setupData, { onConflict: 'client_id' });

    if (error) throw new Error(error.message);

    await sb.from('clients').update({ setup_completed: true }).eq('id', clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Occupation ────────────────────────────────────────────────
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({
      occupation:      occupation,
      occupation_data: answers || {}
    }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({
      client_id:          req.clientId,
      occupation_answers: answers || {},
      updated_at:         new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Location ──────────────────────────────────────────────────
router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({
      location_address:  location_address  || null,
      location_maps_url: location_maps_url || null
    }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Qualification toggle ──────────────────────────────────────
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb          = getSupabase();
    var current     = await sb.from('clients')
      .select('occupation_data')
      .eq('id', req.clientId)
      .single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients')
      .update({ occupation_data: occData })
      .eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Partner / Trial Status ────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', req.clientId)
      .single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c         = result.data;
    var now       = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
    var expired   = expiresAt ? expiresAt < now : false;
    res.json({
      is_partner:   c.is_partner || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    daysLeft,
      expired:      expired,
      still_active: c.subscription_active
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords are required' });
    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id:   req.clientId,
      name:        name,
      description: description || null,
      price:       price       || null,
      price_label: price_label || null,
      location:    location    || null,
      category:    category    || null,
      keywords:    keywords,
      available:   true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','available'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('service_listings')
      .update(update)
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    // Get all media files for this listing so we can delete from Storage too
    var mediaResult = await sb
      .from('listing_media')
      .select('url')
      .eq('listing_id', req.params.id)
      .eq('client_id', req.clientId);

    // Delete files from Supabase Storage
    if (mediaResult.data && mediaResult.data.length) {
      var bucket    = 'forgebot-listings';
      var baseUrl   = process.env.SUPABASE_URL + '/storage/v1/object/public/' + bucket + '/';
      var filePaths = mediaResult.data
        .map(function(m) {
          var url = m.url || '';
          var idx = url.indexOf(bucket + '/');
          return idx !== -1 ? url.slice(idx + bucket.length + 1) : null;
        })
        .filter(Boolean);
      if (filePaths.length) {
        try { await sb.storage.from(bucket).remove(filePaths); } catch (e) {}
      }
    }

    // Delete the listing (listing_media cascades via DB constraint)
    await sb.from('service_listings')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', req.clientId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Listing Media ─────────────────────────────────────────────

router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media')
      .select('*')
      .eq('listing_id', req.params.id)
      .eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id: req.params.id,
      client_id:  req.clientId,
      url:        url,
      media_type: media_type,
      caption:    caption    || null,
      filename:   filename   || null,
      sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    // Fetch the URL before deleting so we can remove from Storage
    var mediaRow = await sb
      .from('listing_media')
      .select('url')
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .single();

    if (mediaRow.data && mediaRow.data.url) {
      var bucket = 'forgebot-listings';
      var url    = mediaRow.data.url;
      var idx    = url.indexOf(bucket + '/');
      if (idx !== -1) {
        var filePath = url.slice(idx + bucket.length + 1);
        try { await sb.storage.from(bucket).remove([filePath]); } catch (e) {}
      }
    }

    await sb.from('listing_media')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', req.clientId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
      contentType: req.file.mimetype,
      upsert: false
    });
    if (result.error) throw new Error(result.error.message);
    var urlResult = sb.storage.from(bucket).getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FAQ ───────────────────────────────────────────────────────

router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq')
      .select('*')
      .eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb     = getSupabase();
    var result = await sb.from('business_faq').insert({
      client_id:  req.clientId,
      question:   question,
      answer:     answer,
      keywords:   keywords   || null,
      sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    var result = await sb.from('business_faq')
      .update(update)
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push Notifications ────────────────────────────────────────

// POST /api/client/push/subscribe
// FIX v3: moved into auth section — uses clientId from JWT (not body)
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription required' });
    var sub = (typeof subscription === 'string') ? subscription : JSON.stringify(subscription);
    var sb  = getSupabase();
    var { error } = await sb.from('push_subscriptions').upsert({
      client_id:   req.clientId,
      subscription: sub,
      updated_at:  new Date().toISOString()
    }, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/push/test
// FIX v3: actually sends a push notification via web-push (was empty before)
router.post('/client/push/test', async function(req, res) {
  try {
    var sent = await sendPushToClient(
      req.clientId,
      '🔔 ForgeBot Notification',
      'Push notifications are working! You will receive order alerts here.',
      { type: 'test' }
    );
    if (!sent) {
      return res.status(404).json({
        error: 'No push subscription found. Click "Enable Push Notifications" on the dashboard first.'
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/push/unsubscribe
router.post('/client/push/unsubscribe', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('push_subscriptions').delete().eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.sendPushToClient = sendPushToClient;
