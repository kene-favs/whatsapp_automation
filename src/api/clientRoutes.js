// ============================================================
//  ForgeBot — Client API Routes v2
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  FIXES (Jul 2026 — no overwrite, only broken sections changed):
//   1. GET  /client/listings        — added listing_media join so images show
//   2. POST /client/status-posts    — accept dashboard field names (media_url,
//                                     post_time) alongside old names; save both
//                                     post_time AND scheduled_time columns so
//                                     getDueStatusPosts() can find the record
//   3. GET  /client/session-status  — NEW: dashboard Connected/Disconnected badge
//   4. GET  /client/settings        — NEW: pre-fill Settings + BotSetup pages
//   5. PUT  /client/settings        — added welcome_message + fallback_message
//   6. PUT  /client/bot-setup       — save both old AND new column names so
//                                     delivery_areas/promo always persist
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
//  EXISTING ROUTES (preserved exactly)
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

// ── FIX #3: GET /api/client/session-status ───────────────────
// Dashboard uses this for the Connected/Disconnected badge.
// Was missing entirely → dashboard showed 'Disconnected' even when live.
router.get('/client/session-status', async function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock, status: !!sock ? 'connected' : 'disconnected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FIX #4: GET /api/client/settings ─────────────────────────
// Dashboard Settings page calls this to pre-fill all fields.
// Was missing → fields always blank on page load.
router.get('/client/settings', async function(req, res) {
  try {
    var sb       = getSupabase();
    var clientRes = await sb.from('clients')
      .select('*')
      .eq('id', req.clientId)
      .single();
    if (clientRes.error || !clientRes.data) return res.status(404).json({ error: 'Not found' });
    var c = clientRes.data;

    var setupRes = await sb.from('bot_setup')
      .select('*')
      .eq('client_id', req.clientId)
      .maybeSingle();
    var s = setupRes.data || {};

    // Build nested bot_setup structure that matches what dashboard JS reads
    var { password_hash, ...safeClient } = c;
    res.json({
      ...safeClient,
      bot_setup: {
        delivery_areas:   s.delivery_areas   || s.delivers_to          || '',
        delivery_fee:     s.delivery_fee     || s.delivery_fee_local   || '',
        delivery_time:    s.delivery_time    || s.delivery_time_local  || '',
        promo:            s.promo            || s.current_promo        || '',
        payment_methods:  Array.isArray(s.payment_methods)
                            ? s.payment_methods.join(',')
                            : (s.payment_methods || ''),
        welcome_message:  s.welcome_message  || c.welcome_message      || '',
        fallback_message: s.fallback_message || c.fallback_message     || '',
        minimum_order:    s.minimum_order    || '',
        return_policy:    s.return_policy    || '',
        instagram:        s.instagram        || '',
        facebook:         s.facebook         || '',
        tiktok:           s.tiktok           || '',
        whatsapp_channel: s.whatsapp_channel || ''
      }
    });
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

// ── FIX #2: POST /api/client/status-posts ────────────────────
// Dashboard sends { caption, media_url, post_time, scheduled_days }
// Old route expected { mediaUrl, scheduledTime, scheduledDays } → 400 error
// → post never saved → scheduler had nothing to send.
// Fix: accept BOTH naming conventions.
// Also saves to BOTH post_time AND scheduled_time so getDueStatusPosts()
// finds the record regardless of which column name it queries.
router.post('/client/status-posts', async function(req, res) {
  try {
    var b             = req.body;
    var mediaUrl      = b.media_url      || b.mediaUrl      || null;
    var caption       = b.caption        || null;
    var scheduledTime = b.post_time      || b.scheduledTime  || null;
    var scheduledDays = b.scheduled_days || b.scheduledDays  || null;

    if (!scheduledTime || !scheduledDays) {
      return res.status(400).json({ error: 'post_time and scheduled_days are required' });
    }

    var sb = getSupabase();
    var result = await sb.from('status_posts').insert({
      client_id:      req.clientId,
      caption:        caption,
      media_url:      mediaUrl,
      post_time:      scheduledTime,
      scheduled_time: scheduledTime,   // getDueStatusPosts queries this column
      scheduled_days: scheduledDays,
      active:         true,
      last_posted:    null
    }).select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
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

// ── FIX #5: PUT /api/client/settings ─────────────────────────
// Added welcome_message + fallback_message to allowed fields
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name', 'bank_name', 'account_number',
      'account_name', 'business_hours', 'welcome_message', 'fallback_message'
    ];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var updated = await db.updateClient(req.clientId, update);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var updated = await db.updateClient(req.clientId, { fallback_message: fallback_message });
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES v2
// ══════════════════════════════════════════════════════════════

// PUT /api/client/occupation
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation: occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({
      client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/location
router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({
      location_address: location_address || null, location_maps_url: location_maps_url || null
    }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FIX #1: GET /api/client/listings — added listing_media join ──
// Was: .select('*') → no image data → card showed box icon + "0 media files"
// Now: .select('*, listing_media(...)') → images returned with listing
router.get('/client/listings', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('service_listings')
      .select('*, listing_media(id, url, media_type, caption, sort_order)')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/listings
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/client/listings/:id
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/listings/:id
router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/listings/:id/media
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('listing_media')
      .select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/listings/:id/media
router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId, url: url,
      media_type: media_type, caption: caption || null, filename: filename || null,
      sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/media/:id
router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/faq
router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId)
      .order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/faq
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/client/faq/:id
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/faq/:id
router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/partner-status
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
    res.json({ is_partner: c.is_partner || false, expires_at: c.partner_expires_at || null,
      days_left: daysLeft, expired: expired, still_active: c.subscription_active });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb          = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FIX #6: PUT /api/client/bot-setup ────────────────────────
// Now saves BOTH old and new column names so delivery_areas/promo etc.
// always persist regardless of which name the DB schema uses.
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var clientId = req.clientId;
    var b = req.body;

    if (b.occupation) {
      await sb.from('clients').update({ occupation: b.occupation, occupation_data: b.occupation_data || {} }).eq('id', clientId);
    }

    var setupData = {
      client_id:           clientId,
      updated_at:          new Date().toISOString(),
      availability_days:   b.availability_days   || null,
      payment_methods:     b.payment_methods     || null,
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
      minimum_order:       b.minimum_order       || null,
      bulk_orders:         b.bulk_orders         || null,
      welcome_message:     b.welcome_message     || null,
      fallback_message:    b.fallback_message    || null
    };

    // Save delivery_areas — store under BOTH column names
    var deliveryAreas = b.delivery_areas || b.delivers_to || null;
    if (deliveryAreas !== undefined) {
      setupData.delivery_areas = deliveryAreas;
      setupData.delivers_to    = deliveryAreas;
    }

    var deliveryFee = b.delivery_fee || b.delivery_fee_local || null;
    if (deliveryFee !== undefined) {
      setupData.delivery_fee       = deliveryFee;
      setupData.delivery_fee_local = deliveryFee;
    }

    var deliveryTime = b.delivery_time || b.delivery_time_local || null;
    if (deliveryTime !== undefined) {
      setupData.delivery_time       = deliveryTime;
      setupData.delivery_time_local = deliveryTime;
    }

    var promo = b.promo || b.current_promo || null;
    if (promo !== undefined) {
      setupData.promo        = promo;
      setupData.current_promo = promo;
    }

    // Remove undefined keys
    Object.keys(setupData).forEach(function(k) {
      if (setupData[k] === undefined) delete setupData[k];
    });

    var { error } = await sb.from('bot_setup').upsert(setupData, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    await sb.from('clients').update({ setup_completed: true }).eq('id', clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
