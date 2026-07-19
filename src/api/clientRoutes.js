// ============================================================
//  ForgeBot — Client API Routes v2
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  New in v2:
//   - /api/client/listings   (CRUD for service listings)
//   - /api/client/listings/:id/media  (media per listing)
//   - /api/client/media/:id  (delete media)
//   - /api/client/faq        (unlimited FAQ)
//   - /api/client/occupation (save occupation + answers)
//   - /api/client/location   (save location details)
//   - /api/client/upload     (file upload → Supabase Storage)
//   - /api/client/partner-status (trial info)
//   - /api/client/qr-stream  (SSE for QR code)
//   All existing routes preserved
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
    // Non-critical — log and continue
    console.error('[ClientAPI] Partner check error:', e.message);
  }
}


// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — no auth required
//  MUST be defined BEFORE router.use('/client', auth) so they
//  are not blocked by the JWT middleware.
// ══════════════════════════════════════════════════════════════

// helper
async function activateClient(clientId) {
  var sb = getSupabase();
  await sb.from('clients')
    .update({ status: 'active', subscription_active: true })
    .eq('id', clientId);
}

// POST /api/client/signup
router.post('/client/signup', async function(req, res) {
  try {
    var { full_name, business_name, email, password, whatsapp_number, occupation, plan } = req.body;
    if (!full_name || !business_name || !email || !password || !whatsapp_number) {
      return res.status(400).json({ error: 'All required fields must be filled in.' });
    }
    var sb = getSupabase();
    var existing = await sb.from('clients').select('id').eq('email', email).maybeSingle();
    if (existing.data) return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    var password_hash = await bcrypt.hash(password, 10);
    var insert = await sb.from('clients').insert({
      full_name: full_name, business_name: business_name, email: email,
      password_hash: password_hash, whatsapp_number: whatsapp_number,
      occupation: occupation || null, status: 'pending_payment',
      subscription_active: false, trial_notified: false, setup_completed: false
    }).select('id').single();
    if (insert.error) throw new Error(insert.error.message);
    var clientId = insert.data.id;
    var appUrl   = process.env.APP_URL || 'https://localhost:3000';
    var amount   = plan === 'usd' ? 45 : 30000;
    var currency = plan === 'usd' ? 'USD' : 'NGN';
    var flwRes = await axios.post('https://api.flutterwave.com/v3/payments', {
      tx_ref: 'forgebot-' + clientId + '-' + Date.now(),
      amount: amount, currency: currency,
      redirect_url: appUrl + '/api/client/pay/callback',
      customer: { email: email, name: full_name, phonenumber: whatsapp_number },
      customizations: { title: 'ForgeBot Subscription', description: 'WhatsApp automation for ' + business_name, logo: appUrl + '/icons/icon-192x192.png' },
      meta: { client_id: clientId }
    }, { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    if (!flwRes.data || flwRes.data.status !== 'success') {
      await sb.from('clients').delete().eq('id', clientId);
      return res.status(502).json({ error: 'Could not initiate payment. Please try again.' });
    }
    return res.json({ payment_link: flwRes.data.data.link });
  } catch (e) {
    console.error('[Signup]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/client/login
router.post('/client/login', async function(req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    var sb = getSupabase();
    var result = await sb.from('clients')
      .select('id,password_hash,status,subscription_active,full_name,business_name')
      .eq('email', email).maybeSingle();
    if (!result.data) return res.status(401).json({ error: 'No account found with that email address.' });
    var client = result.data;
    var match  = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    if (client.status === 'pending_payment') return res.status(403).json({ error: 'Payment required to activate your account.' });
    var token = jwt.sign({ id: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.json({ token: token, clientId: client.id, full_name: client.full_name, business_name: client.business_name });
  } catch (e) {
    console.error('[Login]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/client/qr-stream (SSE)
// PUBLIC — handles its own token via query param (EventSource cannot send headers)
// MUST be before router.use('/client', auth) or Railway auth middleware will block it
router.get('/client/qr-stream', async function(req, res) {
  var token = req.query.token;
  var clientId;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    clientId = decoded.clientId || decoded.id;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
  }

  // Heartbeat every 20s to keep Railway connection alive
  var heartbeat = setInterval(function() {
    try { res.write(':heartbeat\n\n'); } catch(e) {}
  }, 20000);

  function cleanup() {
    clearInterval(heartbeat);
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  }

  req.on('close', cleanup);

  // If already connected, tell the client immediately
  var existingSock = global.getSock && global.getSock(clientId);
  if (existingSock) {
    sendEvent('connected', { status: 'connected' });
    clearInterval(heartbeat);
    res.end();
    return;
  }

  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  try {
    await sessionManager.startSession(clientId, {
      onQR: function(qr) {
        var all = global.qrListeners.get(clientId) || [];
        all.forEach(function(fn) { try { fn('qr', { qr: qr }); } catch(e) {} });
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
  } catch (e) {
    console.error('[QR-Stream] startSession error:', e.message);
    sendEvent('error', { message: 'Failed to start session. Please refresh.' });
    clearInterval(heartbeat);
    res.end();
  }
});

// GET /api/client/pay/callback (Flutterwave redirect)
router.get('/client/pay/callback', async function(req, res) {
  try {
    var { transaction_id, status, tx_ref } = req.query;
    var appUrl = process.env.APP_URL || 'https://localhost:3000';
    if (status !== 'successful' || !transaction_id) return res.redirect(appUrl + '/?payment=failed');
    var verify = await axios.get(
      'https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify',
      { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } }
    );
    if (!verify.data || verify.data.data.status !== 'successful') return res.redirect(appUrl + '/?payment=failed');
    var txData   = verify.data.data;
    var clientId = txData.meta && txData.meta.client_id;
    if (!clientId) {
      var parts = (tx_ref || '').split('-');
      if (parts.length >= 6) clientId = parts.slice(1, 6).join('-');
    }
    if (!clientId) return res.redirect(appUrl + '/?payment=error');
    await activateClient(clientId);
    var token = jwt.sign({ id: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.redirect(appUrl + '/onboard?activated=1&token=' + token);
  } catch (e) {
    console.error('[PayCallback]', e.message);
    return res.redirect((process.env.APP_URL || '') + '/?payment=error');
  }
});

// POST /api/client/pay/webhook (Flutterwave webhook)
router.post('/client/pay/webhook', async function(req, res) {
  try {
    var hash = req.headers['verif-hash'];
    if (!hash || hash !== process.env.FLW_HASH) return res.status(401).json({ error: 'Invalid signature' });
    var { data } = req.body;
    if (!data || data.status !== 'successful') return res.json({ ok: true });
    var clientId = data.meta && data.meta.client_id;
    if (!clientId) {
      var parts = (data.tx_ref || '').split('-');
      if (parts.length >= 6) clientId = parts.slice(1, 6).join('-');
    }
    if (clientId) await activateClient(clientId);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[PayWebhook]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/push/vapid-key
router.get('/push/vapid-key', function(req, res) {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe
router.post('/push/subscribe', async function(req, res) {
  try {
    var { subscription, clientId } = req.body;
    if (!subscription || !clientId) return res.status(400).json({ error: 'Missing fields' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({ client_id: clientId, subscription: subscription, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/push/test
router.post('/push/test', async function(req, res) {
  try {
    var webpush = require('web-push');
    webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'admin@forgebot.com'), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    var { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'No subscription provided' });
    await webpush.sendNotification(subscription, JSON.stringify({ title: 'ForgeBot Test', body: 'Notifications are working! 🎉' }));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Apply auth + partner check to all client routes ───────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  EXISTING ROUTES (preserved exactly as before)
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

// PUT /api/client/settings
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = ['notification_number', 'business_name', 'bank_name', 'account_number', 'account_name', 'business_hours'];
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

// /api/client/qr-stream — moved above auth middleware (see PUBLIC ROUTES section)

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES v2
// ══════════════════════════════════════════════════════════════

// ── Occupation ────────────────────────────────────────────────

// PUT /api/client/occupation  — save occupation + specific answers
router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });

    var sb = getSupabase();
    // Update clients table
    await sb.from('clients').update({
      occupation:       occupation,
      occupation_data:  answers || {}
    }).eq('id', req.clientId);

    // Upsert into bot_setup
    await sb.from('bot_setup').upsert({
      client_id:           req.clientId,
      occupation_answers:  answers || {},
      updated_at:          new Date().toISOString()
    }, { onConflict: 'client_id' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Location ──────────────────────────────────────────────────

// PUT /api/client/location
router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({
      location_address:  location_address || null,
      location_maps_url: location_maps_url || null
    }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Service Listings ──────────────────────────────────────────

// GET /api/client/listings
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

// POST /api/client/listings
router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords are required' });

    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id:   req.clientId,
      name:        name,
      description: description || null,
      price:       price || null,
      price_label: price_label || null,
      location:    location || null,
      category:    category || null,
      keywords:    keywords,
      available:   true
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

// DELETE /api/client/listings/:id
router.delete('/client/listings/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    // Cascade: listing_media is deleted by DB constraint (ON DELETE CASCADE)
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

// GET /api/client/listings/:id/media
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

// POST /api/client/listings/:id/media  — add media by URL
router.post('/client/listings/:id/media', async function(req, res) {
  try {
    var { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });

    var sb     = getSupabase();
    var result = await sb.from('listing_media').insert({
      listing_id:  req.params.id,
      client_id:   req.clientId,
      url:         url,
      media_type:  media_type,
      caption:     caption || null,
      filename:    filename || null,
      sort_order:  sort_order || 0
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
// POST /api/client/upload
router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    var sb       = getSupabase();
    var ext      = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var bucket   = 'forgebot-listings';

    var result = await sb.storage
      .from(bucket)
      .upload(filename, req.file.buffer, {
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

// GET /api/client/faq
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

// POST /api/client/faq
router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });

    var sb     = getSupabase();
    var result = await sb.from('business_faq').insert({
      client_id:  req.clientId,
      question:   question,
      answer:     answer,
      keywords:   keywords || null,
      sort_order: sort_order || 0
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

// DELETE /api/client/faq/:id
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

// ── Partner / Trial Status ────────────────────────────────────

// GET /api/client/partner-status
router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', req.clientId)
      .single();

    if (result.error || !result.data) return res.json({ is_partner: false });

    var c          = result.data;
    var now        = new Date();
    var expiresAt  = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft   = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
    var expired    = expiresAt ? expiresAt < now : false;

    res.json({
      is_partner:    c.is_partner || false,
      expires_at:    c.partner_expires_at || null,
      days_left:     daysLeft,
      expired:       expired,
      still_active:  c.subscription_active
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Qualification toggle ──────────────────────────────────────

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb          = getSupabase();

    // Merge into existing occupation_data JSON
    var current = await sb.from('clients')
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

module.exports = router;
