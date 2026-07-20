// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//
//  v3 changes (everything else preserved from v2):
//  - activateClient() now sets subscription_active + subscription_expires_at
//  - Signup: one-time ₦30,000 setup + FLW_MONTHLY_PLAN_ID for ₦10,000/month
//  - PUT /client/settings uses direct Supabase (fixes bank details reset)
//  - GET /client/settings added (dashboard polls this)
//  - GET /client/bot-setup added (was missing)
//  - PUT /client/bot-setup includes scheduler fields
//  - GET /client/session-status added
//  - GET /client/analytics added
//  - GET /client/broadcast-logs added
//  - GET /client/bot-tasks added
//  - GET /client/orders added
//  - POST /client/push/subscribe added (auth section)
//  - POST /client/push/test sends real notification
//  - DELETE /client/listings/:id also removes Storage files
//  - DELETE /client/media/:id also removes Storage file
//  - Webhook handles subscription.cancelled to stop bot
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

// ── Helper: send push to a client ────────────────────────────
async function sendPushToClient(clientId, title, body) {
  try {
    var webpush = require('web-push');
    webpush.setVapidDetails(
      'mailto:admin@forgebot.ng',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    var sb  = getSupabase();
    var r   = await sb.from('push_subscriptions').select('subscription').eq('client_id', clientId).single();
    if (r.error || !r.data) return;
    var sub = typeof r.data.subscription === 'string' ? JSON.parse(r.data.subscription) : r.data.subscription;
    await webpush.sendNotification(sub, JSON.stringify({ title: title || 'ForgeBot', body: body || '' }));
  } catch (e) {
    console.error('[Push] sendPushToClient error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
//  activateClient — v3: also sets subscription_active + expiry
// ══════════════════════════════════════════════════════════════
async function activateClient(clientId) {
  var sb      = getSupabase();
  var expiry  = new Date();
  expiry.setDate(expiry.getDate() + 31);
  await sb.from('clients').update({
    status:                 'active',
    subscription_active:    true,
    trial_notified:         false,
    subscription_expires_at: expiry.toISOString()
  }).eq('id', clientId);
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ══════════════════════════════════════════════════════════════

router.post('/client/signup', async function(req, res) {
  try {
    var { email, full_name, whatsapp_number, ref } = req.body;
    if (!email || !full_name || !whatsapp_number) return res.status(400).json({ error: 'email, full_name, and whatsapp_number are required' });

    var sb   = getSupabase();
    var hash = await bcrypt.hash('forgebot2025', 10);
    var insert = await sb.from('clients').insert({
      email: email, full_name: full_name, whatsapp_number: whatsapp_number,
      password_hash: hash, status: 'pending', plan: 'monthly',
      referred_by: ref || null, trial_notified: false, setup_completed: false
    }).select('id').single();
    if (insert.error) throw new Error(insert.error.message);
    var clientId = insert.data.id;

    // One-time setup fee: ₦30,000. FLW auto-charges ₦10,000/month via plan.
    var planId  = process.env.FLW_MONTHLY_PLAN_ID || null;
    var appUrl  = process.env.APP_URL || 'https://forgebot.up.railway.app';
    var payBody = {
      tx_ref:       'FB-' + clientId + '-' + Date.now(),
      amount:       30000,
      currency:     'NGN',
      redirect_url: appUrl + '/api/client/pay/callback',
      customer:     { email: email, name: full_name, phonenumber: whatsapp_number },
      meta:         { client_id: clientId },
      customizations: { title: 'ForgeBot Setup', logo: appUrl + '/icons/icon-192.png' }
    };
    if (planId) payBody.payment_plan = planId;

    var flwRes;
    try {
      flwRes = await axios.post('https://api.flutterwave.com/v3/payments', payBody, {
        headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY }
      });
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
      if (clientId) {
        await activateClient(clientId);
        await sendPushToClient(clientId, 'ForgeBot Active!', 'Your subscription is now active. Your bot is live.');
      }
    }

    // Auto-renewal: recurring charge success — extend expiry by 31 days
    if ((event === 'subscription.payment.completed' || event === 'charge.completed') && data && data.status === 'successful' && data.plan) {
      var sb       = getSupabase();
      var custMail = data.customer && data.customer.email;
      if (custMail) {
        var cr = await sb.from('clients').select('id,subscription_expires_at').eq('email', custMail).single();
        if (cr.data) {
          var base   = cr.data.subscription_expires_at ? new Date(cr.data.subscription_expires_at) : new Date();
          if (base < new Date()) base = new Date();
          base.setDate(base.getDate() + 31);
          await sb.from('clients').update({
            subscription_active:    true,
            subscription_expires_at: base.toISOString()
          }).eq('id', cr.data.id);
          await sendPushToClient(cr.data.id, 'Subscription Renewed', 'Your ForgeBot subscription has been renewed for another month.');
        }
      }
    }

    // Cancellation: stop bot
    if (event === 'subscription.cancelled' && data) {
      var sb2      = getSupabase();
      var custMail2 = data.customer && data.customer.email;
      if (custMail2) {
        await sb2.from('clients').update({ subscription_active: false }).eq('email', custMail2);
      }
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
    await sb.from('push_subscriptions').upsert({
      client_id:  cid,
      subscription: JSON.stringify(subscription),
      updated_at:  new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Apply auth + partner check to all /client routes ──────────
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
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var sock   = sessionManager.getSession(req.clientId);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/settings — dashboard polls this
router.get('/client/settings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('id,email,full_name,business_name,whatsapp_number,notification_number,welcome_message,fallback_message,bank_name,account_number,account_name,business_hours,status,subscription_active,subscription_expires_at,plan,occupation,location_address,location_maps_url')
      .eq('id', req.clientId)
      .single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings — direct Supabase (bypasses db.updateClient whitelist)
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'welcome_message', 'fallback_message',
      'bank_name', 'account_number', 'account_name',
      'business_hours', 'business_name'
    ];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    if (!Object.keys(update).length) return res.json({ ok: true });
    var sb     = getSupabase();
    var result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/session-status
router.get('/client/session-status', async function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/analytics
router.get('/client/analytics', async function(req, res) {
  try {
    var sb  = getSupabase();
    var cid = req.clientId;
    var [custRes, broadRes, listRes] = await Promise.all([
      sb.from('customers').select('id', { count: 'exact', head: true }).eq('client_id', cid),
      sb.from('broadcasts').select('id', { count: 'exact', head: true }).eq('client_id', cid),
      sb.from('service_listings').select('id', { count: 'exact', head: true }).eq('client_id', cid)
    ]);
    res.json({
      total_customers:  custRes.count  || 0,
      total_broadcasts: broadRes.count || 0,
      total_listings:   listRes.count  || 0
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcast-logs
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

// GET /api/client/bot-tasks
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(result.data || []);
  } catch (e) {
    // Table might not exist yet — return empty array
    res.json([]);
  }
});

// GET /api/client/orders
router.get('/client/orders', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(50);
    res.json(result.data || []);
  } catch (e) {
    // Table might not exist yet — return empty array
    res.json([]);
  }
});

// GET /api/client/bot-setup
router.get('/client/bot-setup', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_setup')
      .select('*')
      .eq('client_id', req.clientId)
      .single();
    res.json(result.data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/bot-setup — includes scheduler fields
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb        = getSupabase();
    var clientId  = req.clientId;
    var {
      occupation, occupation_data,
      availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel,
      service_areas, studio_location, home_service,
      advance_booking, deposit_required, session_duration,
      who_do_you_serve, free_consult, return_policy,
      delivers_to, delivery_fee_local, delivery_time_local,
      minimum_order, bulk_orders,
      // Scheduler fields
      product_post_time, meme_post_time, schedule_days, meme_media_urls
    } = req.body;

    if (occupation) {
      await sb.from('clients').update({
        occupation: occupation, occupation_data: occupation_data || {}
      }).eq('id', clientId);
    }

    var setupData = {
      client_id:          clientId,
      availability_days:  availability_days  || null,
      payment_methods:    payment_methods    || null,
      current_promo:      current_promo      || null,
      instagram:          instagram          || null,
      facebook:           facebook           || null,
      tiktok:             tiktok             || null,
      whatsapp_channel:   whatsapp_channel   || null,
      service_areas:      service_areas      || null,
      studio_location:    studio_location    || null,
      home_service:       home_service       || null,
      advance_booking:    advance_booking    || null,
      deposit_required:   deposit_required   || null,
      session_duration:   session_duration   || null,
      who_do_you_serve:   who_do_you_serve   || null,
      free_consult:       free_consult       || null,
      return_policy:      return_policy      || null,
      delivers_to:        delivers_to        || null,
      delivery_fee_local: delivery_fee_local || null,
      delivery_time_local:delivery_time_local|| null,
      minimum_order:      minimum_order      || null,
      bulk_orders:        bulk_orders        || null,
      product_post_time:  product_post_time  || null,
      meme_post_time:     meme_post_time     || null,
      schedule_days:      schedule_days      || null,
      meme_media_urls:    meme_media_urls    || null,
      updated_at:         new Date().toISOString()
    };

    Object.keys(setupData).forEach(function(k) { if (setupData[k] === undefined) delete setupData[k]; });
    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', clientId);
    res.json({ ok: true });
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
router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
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

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message: fallback_message });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push notifications (auth section) ────────────────────────

// POST /api/client/push/subscribe
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id:    req.clientId,
      subscription: JSON.stringify(subscription),
      updated_at:   new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/push/test
router.post('/client/push/test', async function(req, res) {
  try {
    await sendPushToClient(req.clientId, 'ForgeBot Test', 'Push notifications are working!');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Occupation ────────────────────────────────────────────────
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation: occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({
      client_id:           req.clientId,
      occupation_answers:  answers || {},
      updated_at:          new Date().toISOString()
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
      location_address:  location_address  || null,
      location_maps_url: location_maps_url || null
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
    var result = await sb.from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb     = getSupabase();
    // Get media files first so we can delete from Storage
    var media  = await sb.from('listing_media').select('filename').eq('listing_id', req.params.id).eq('client_id', req.clientId);
    if (media.data && media.data.length) {
      var paths = media.data.filter(function(m){ return m.filename; }).map(function(m){ return req.clientId + '/' + m.filename; });
      if (paths.length) await sb.storage.from('forgebot-listings').remove(paths);
    }
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listing Media ─────────────────────────────────────────────
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId, url: url,
      media_type: media_type, caption: caption || null, filename: filename || null, sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb  = getSupabase();
    var row = await sb.from('listing_media').select('filename').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (row.data && row.data.filename) {
      await sb.storage.from('forgebot-listings').remove([req.clientId + '/' + row.data.filename]);
    }
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
    var result   = await sb.storage.from(bucket).upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (result.error) throw new Error(result.error.message);
    var urlResult = sb.storage.from(bucket).getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FAQ ───────────────────────────────────────────────────────
router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb     = getSupabase();
    var result = await sb.from('business_faq').insert({ client_id: req.clientId, question: question, answer: answer, keywords: keywords || null, sort_order: sort_order || 0 }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    var update = {};
    if (question !== undefined)   update.question   = question;
    if (answer !== undefined)     update.answer     = answer;
    if (keywords !== undefined)   update.keywords   = keywords;
    if (sort_order !== undefined) update.sort_order = sort_order;
    var sb     = getSupabase();
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

// ── Partner / Trial Status ────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c         = result.data;
    var now       = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000*60*60*24)) : null;
    var expired   = expiresAt ? expiresAt < now : false;
    res.json({ is_partner: c.is_partner || false, expires_at: c.partner_expires_at || null, days_left: daysLeft, expired: expired, still_active: c.subscription_active });
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
