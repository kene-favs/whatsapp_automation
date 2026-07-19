// ============================================================
//  ForgeBot — Client API Routes  (src/api/clientRoutes.js)
//  Mounted at /api  in index.js:  app.use('/api', clientRoutes)
//
//  PUBLIC (no token needed):
//    POST /api/client/signup
//    POST /api/client/login
//    POST /api/client/pay/flutterwave
//    GET  /api/client/pay/callback
//    POST /api/client/pay/webhook
//    GET  /api/push/vapid-key
//
//  AUTH (Bearer token required):
//    All /api/client/* routes below
//    POST /api/push/subscribe
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const multer  = require('multer');
const { createClient } = require('@supabase/supabase-js');

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

// ── Lazy web-push init ────────────────────────────────────────
let _webpush = null;
function getWebpush() {
  if (!_webpush) {
    _webpush = require('web-push');
    var pub  = process.env.VAPID_PUBLIC_KEY;
    var priv = process.env.VAPID_PRIVATE_KEY;
    if (pub && priv) {
      try { _webpush.setVapidDetails('mailto:support@forgebot.com', pub, priv); }
      catch (e) { console.warn('[ForgeBot] VAPID setup failed:', e.message); }
    }
  }
  return _webpush;
}

// ── Session manager (fails gracefully if missing) ─────────────
var sessionManager;
try { sessionManager = require('../sessions/sessionManager'); }
catch (e) { sessionManager = { getSession: function() { return null; }, startSession: async function() {}, stopSession: async function() {} }; }

// ── Multer: memory storage ────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

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
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', clientId).single();
    if (result.error || !result.data) return;
    var c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active && new Date(c.partner_expires_at) < new Date()) {
      await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
      try { await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired on API request check' }); } catch(e) {}
    }
  } catch (e) { console.error('[ClientAPI] Partner check error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — No auth required
// ══════════════════════════════════════════════════════════════

// POST /api/client/signup
router.post('/client/signup', async function(req, res) {
  try {
    var {
      full_name, business_name, business_type,
      whatsapp_number, notification_number, country,
      bank_name, account_number, account_name,
      email, password
    } = req.body;

    if (!full_name || !business_name || !whatsapp_number || !email || !password) {
      return res.status(400).json({ error: 'Please fill in all required fields.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    var sb = getSupabase();
    var check = await sb.from('clients').select('id').eq('email', email);
    if (!check.error && check.data && check.data.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    var hash   = await bcrypt.hash(password, 10);
    var insert = await sb.from('clients').insert({
      full_name:           full_name,
      business_name:       business_name,
      business_type:       business_type       || 'general',
      whatsapp_number:     whatsapp_number,
      notification_number: notification_number || whatsapp_number,
      country:             country             || 'nigeria',
      bank_name:           bank_name           || null,
      account_number:      account_number      || null,
      account_name:        account_name        || null,
      email:               email,
      password_hash:       hash,
      status:              'pending_payment',
      subscription_active: false,
      is_partner:          false
    }).select().single();

    if (insert.error) throw new Error(insert.error.message);

    var client = insert.data;
    var token  = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    console.log('[ForgeBot] New signup: ' + email + ' (' + business_name + ')');
    res.json({ token: token, clientId: client.id });
  } catch (e) {
    console.error('[ClientAPI] Signup error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/login
router.post('/client/login', async function(req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('email', email).single();
    if (result.error || !result.data) return res.status(401).json({ error: 'Invalid email or password.' });

    var client = result.data;
    var match  = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    var token = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, clientId: client.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/pay/flutterwave — init payment
router.post('/client/pay/flutterwave', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Client not found.' });

    var client = result.data;
    var axios  = require('axios');
    var txRef  = 'FGT-' + req.clientId + '-' + Date.now();
    var appUrl = (process.env.APP_URL || 'https://automation-production-99d1.up.railway.app').replace(/\/$/, '');

    var payload = {
      tx_ref:       txRef,
      amount:       30000,
      currency:     'NGN',
      redirect_url: appUrl + '/api/client/pay/callback',
      customer: {
        email:       client.email,
        name:        client.full_name || client.business_name,
        phonenumber: client.whatsapp_number
      },
      customizations: {
        title:       'ForgeBot Setup Payment',
        description: 'WhatsApp Automation — One-Time Setup Fee',
        logo:        appUrl + '/icons/icon-192.png'
      },
      meta: { client_id: req.clientId }
    };

    var flwRes = await axios.post('https://api.flutterwave.com/v3/payments', payload, {
      headers: { 'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY, 'Content-Type': 'application/json' }
    });

    if (flwRes.data && flwRes.data.data && flwRes.data.data.link) {
      try { await sb.from('clients').update({ pending_tx_ref: txRef }).eq('id', req.clientId); } catch(e) {}
      res.json({ authorization_url: flwRes.data.data.link });
    } else {
      throw new Error('No payment link returned from Flutterwave');
    }
  } catch (e) {
    console.error('[ClientAPI] Flutterwave init error:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(500).json({ error: 'Payment initialisation failed. Please try again.' });
  }
});

// GET /api/client/pay/callback — Flutterwave redirect
router.get('/client/pay/callback', async function(req, res) {
  try {
    var status = req.query.status, tx_ref = req.query.tx_ref, transaction_id = req.query.transaction_id;
    if (status !== 'successful') return res.redirect('/?payment=cancelled');

    var axios  = require('axios');
    var verify = await axios.get('https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify', {
      headers: { 'Authorization': 'Bearer ' + process.env.FLW_SECRET_KEY }
    });

    var txData = verify.data && verify.data.data;
    if (!txData || txData.status !== 'successful') return res.redirect('/?payment=failed');

    var clientId = (txData.meta && txData.meta.client_id);
    if (!clientId) {
      var sb2  = getSupabase();
      var row2 = await sb2.from('clients').select('id').eq('pending_tx_ref', tx_ref).single();
      clientId = row2.data && row2.data.id;
    }
    if (!clientId) return res.redirect('/?payment=error');

    var sb = getSupabase();
    await sb.from('clients').update({ status: 'active', subscription_active: true, paid_at: new Date().toISOString() }).eq('id', clientId);

    var token = jwt.sign({ clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    console.log('[ForgeBot] Payment confirmed for client:', clientId);
    res.redirect('/onboard?token=' + token);
  } catch (e) {
    console.error('[ClientAPI] Payment callback error:', e.message);
    res.redirect('/?payment=error');
  }
});

// POST /api/client/pay/webhook
router.post('/client/pay/webhook', async function(req, res) {
  try {
    var hash = req.headers['verif-hash'];
    if (process.env.FLW_HASH && hash !== process.env.FLW_HASH) return res.status(401).json({ error: 'Unauthorized' });

    var payload = req.body;
    if (payload.event === 'charge.completed' && payload.data && payload.data.status === 'successful') {
      var clientId = payload.data.meta && payload.data.meta.client_id;
      if (clientId) {
        var sb = getSupabase();
        await sb.from('clients').update({ status: 'active', subscription_active: true, paid_at: new Date().toISOString() }).eq('id', clientId);
      }
    }
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/push/vapid-key
router.get('/push/vapid-key', function(req, res) {
  var key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// ══════════════════════════════════════════════════════════════
//  AUTHENTICATED ROUTES — auth applied per-route
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', auth, async function(req, res) {
  try {
    await checkPartnerExpiry(req.clientId);
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    var client = Object.assign({}, result.data);
    delete client.password_hash;
    var sock = sessionManager.getSession ? sessionManager.getSession(req.clientId) : null;
    client.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(client);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/flows
router.get('/client/flows', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('flows').select('*').eq('client_id', req.clientId).order('priority', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/flows
router.post('/client/flows', auth, async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    var sb     = getSupabase();
    var result = await sb.from('flows').insert({
      client_id: req.clientId, flow_name: 'Custom', keywords, response_type: response_type || 'text', response, media_url: media_url || null, priority: 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/client/flows/:id
router.patch('/client/flows/:id', auth, async function(req, res) {
  try {
    var allowed = ['keywords','response','response_type','media_url','priority','active'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('flows').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/status-posts
router.get('/client/status-posts', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('status_posts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/status-posts
router.post('/client/status-posts', auth, async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime) return res.status(400).json({ error: 'mediaUrl and scheduledTime required' });
    var sb     = getSupabase();
    var result = await sb.from('status_posts').insert({
      client_id: req.clientId, media_url: mediaUrl, caption: caption || null, post_time: scheduledTime, scheduled_days: scheduledDays || null
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/status-posts/:id
router.delete('/client/status-posts/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcasts
router.get('/client/broadcasts', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcasts
router.post('/client/broadcasts', auth, async function(req, res) {
  try {
    var { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    var sock = sessionManager.getSession ? sessionManager.getSession(req.clientId) : null;
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var sb     = getSupabase();
    var result = await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200);
    var jids   = (result.data || []).map(function(c) { return c.jid; });
    var sent   = 0;

    for (var i = 0; i < jids.length; i++) {
      try { await sock.sendMessage(jids[i], { text: message }); sent++; await new Promise(function(r) { setTimeout(r, 1200); }); }
      catch (e) { console.error('[ClientAPI] Broadcast failed for ' + jids[i]); }
    }

    await sb.from('broadcasts').insert({ client_id: req.clientId, message, sent_count: sent, created_at: new Date().toISOString() });
    res.json({ sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings
router.put('/client/settings', auth, async function(req, res) {
  try {
    var allowed = ['notification_number','business_name','bank_name','account_number','account_name','business_hours'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/fallback
router.put('/client/fallback', auth, async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var sb     = getSupabase();
    var result = await sb.from('clients').update({ fallback_message }).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/qr-stream (SSE)
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
  res.flushHeaders();

  function sendEvent(event, data) { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }

  if (!global.qrListeners) global.qrListeners = new Map();

  var existingSock = sessionManager.getSession ? sessionManager.getSession(clientId) : null;
  if (existingSock) { sendEvent('connected', { status: 'connected' }); res.end(); return; }

  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  try {
    await sessionManager.startSession(clientId, {
      onQR: function(qr) {
        var all = global.qrListeners.get(clientId) || [];
        all.forEach(function(fn) { try { fn('qr', { qr }); } catch(e) {} });
      },
      onConnected: function() {
        var all = global.qrListeners.get(clientId) || [];
        all.forEach(function(fn) { try { fn('connected', { status: 'connected' }); } catch(e) {} });
        global.qrListeners.delete(clientId);
      },
      onDisconnected: function() {
        var all = global.qrListeners.get(clientId) || [];
        all.forEach(function(fn) { try { fn('disconnected', { status: 'disconnected' }); } catch(e) {} });
      }
    });
  } catch (e) { sendEvent('error', { message: e.message }); res.end(); return; }

  req.on('close', function() {
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });
});

// PUT /api/client/bot-setup — saves onboard.html questionnaire
router.put('/client/bot-setup', auth, async function(req, res) {
  try {
    var {
      business_type_choice, occupation,
      service_areas, studio_location, home_service, advance_booking,
      deposit_required, session_duration, who_do_you_serve, free_consult,
      return_policy, delivers_to, delivery_fee_local, delivery_time_local,
      minimum_order, bulk_orders,
      availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel
    } = req.body;

    var sb = getSupabase();
    var clientUpdate = { occupation_data: req.body };
    if (occupation)           clientUpdate.occupation    = occupation;
    if (business_type_choice) clientUpdate.business_type = business_type_choice;
    await sb.from('clients').update(clientUpdate).eq('id', req.clientId);

    try {
      await sb.from('bot_setup').upsert({
        client_id: req.clientId,
        business_type_choice: business_type_choice || null,
        occupation:           occupation           || null,
        service_areas:        service_areas        || null,
        studio_location:      studio_location      || null,
        home_service:         home_service         || null,
        advance_booking:      advance_booking      || null,
        deposit_required:     deposit_required     || null,
        session_duration:     session_duration     || null,
        who_do_you_serve:     who_do_you_serve     || null,
        free_consult:         free_consult         || null,
        return_policy:        return_policy        || null,
        delivers_to:          delivers_to          || null,
        delivery_fee_local:   delivery_fee_local   || null,
        delivery_time_local:  delivery_time_local  || null,
        minimum_order:        minimum_order        || null,
        bulk_orders:          bulk_orders          || null,
        availability_days:    Array.isArray(availability_days) ? availability_days.join(',') : (availability_days || null),
        payment_methods:      Array.isArray(payment_methods)   ? payment_methods.join(',')   : (payment_methods   || null),
        current_promo:        current_promo        || null,
        instagram:            instagram            || null,
        facebook:             facebook             || null,
        tiktok:               tiktok               || null,
        whatsapp_channel:     whatsapp_channel     || null,
        updated_at:           new Date().toISOString()
      }, { onConflict: 'client_id' });
    } catch (e) { console.warn('[ClientAPI] bot_setup upsert skipped:', e.message); }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/occupation
router.put('/client/occupation', auth, async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    try {
      await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    } catch (e) { console.warn('[ClientAPI] bot_setup occupation upsert skipped:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/location
router.put('/client/location', auth, async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', auth, async function(req, res) {
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

// ── Service Listings ──────────────────────────────────────────

router.get('/client/listings', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('service_listings').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', auth, async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var sb = getSupabase();
    var result = await sb.from('service_listings').insert({ client_id: req.clientId, name, description: description||null, price: price||null, price_label: price_label||null, location: location||null, category: category||null, keywords: keywords||null, available: true }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/listings/:id', auth, async function(req, res) {
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

router.delete('/client/listings/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/listings/:id/media', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', auth, async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb = getSupabase();
    var result = await sb.from('listing_media').insert({ listing_id: req.params.id, client_id: req.clientId, url, media_type, caption: caption||null, filename: filename||null, sort_order: sort_order||0 }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/upload
router.post('/client/upload', auth, upload.single('file'), async function(req, res) {
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

// ── FAQ ───────────────────────────────────────────────────────

router.get('/client/faq', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', auth, async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var sb = getSupabase();
    var result = await sb.from('business_faq').insert({ client_id: req.clientId, question, answer, keywords: keywords||null, sort_order: sort_order||0 }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', auth, async function(req, res) {
  try {
    var update = {};
    ['question','answer','keywords','sort_order'].forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb = getSupabase();
    var result = await sb.from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/partner-status
router.get('/client/partner-status', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c = result.data, now = new Date(), expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({
      is_partner:   c.is_partner   || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    expiresAt ? Math.ceil((expiresAt - now) / (1000*60*60*24)) : null,
      expired:      expiresAt ? expiresAt < now : false,
      still_active: c.subscription_active
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push Notifications ────────────────────────────────────────

router.post('/push/subscribe', auth, async function(req, res) {
  try {
    var { subscription } = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription object required' });
    var sb = getSupabase();
    try {
      await sb.from('push_subscriptions').upsert({ client_id: req.clientId, endpoint: subscription.endpoint, subscription, updated_at: new Date().toISOString() }, { onConflict: 'client_id,endpoint' });
    } catch (e) {
      try { await sb.from('push_subscriptions').upsert({ client_id: req.clientId, endpoint: subscription.endpoint, subscription, updated_at: new Date().toISOString() }); }
      catch (e2) { console.warn('[ClientAPI] push_subscriptions upsert skipped:', e2.message); }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push/send', auth, async function(req, res) {
  try {
    var { title, body, url, tag } = req.body;
    var wp      = getWebpush();
    var sb      = getSupabase();
    var result  = await sb.from('push_subscriptions').select('subscription').eq('client_id', req.clientId);
    var subs    = result.data || [];
    var sent    = 0;
    var payload = JSON.stringify({ title: title||'ForgeBot', body: body||'', url: url||'/dashboard', tag: tag||'forgebot' });

    for (var i = 0; i < subs.length; i++) {
      try { await wp.sendNotification(subs[i].subscription, payload); sent++; }
      catch (e) {
        console.error('[ClientAPI] Push send failed:', e.message);
        if (e.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', subs[i].subscription.endpoint);
        }
      }
    }
    res.json({ sent, total: subs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
