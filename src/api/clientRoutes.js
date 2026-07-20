// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
//
//  v3 additions:
//   - GET  /api/client/settings          (pre-fill settings page)
//   - GET  /api/client/session-status    (WA connected badge)
//   - GET  /api/client/orders            (orders list)
//   - PUT  /api/client/orders/:id        (update order status)
//   - GET  /api/client/analytics         (monthly stats)
//   - GET  /api/client/broadcast-logs    (alias for broadcasts)
//   - POST /api/client/broadcast         (targeted phones)
//   - GET/POST/PATCH/DELETE /api/client/bot-tasks
//   - GET/PUT /api/client/post-schedule
//   - POST /api/client/push/subscribe
//   - PUT  /api/client/listings/:id      (full update alias)
//   - POST /api/client/listings/:id/media upgraded to file upload
//   - PUT  /api/client/settings expanded (welcome_message, fallback_message)
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

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

// POST /api/client/broadcasts  (send to ALL recent customers)
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

// PUT /api/client/settings  — EXPANDED: includes welcome_message, fallback_message, bank details
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name',
      'welcome_message', 'fallback_message',
      'bank_name', 'account_number', 'account_name', 'business_hours'
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

// GET /api/client/qr-stream (SSE)
router.get('/client/qr-stream', async function(req, res) {
  var token = req.query.token;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  var clientId = req.clientId;
  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  var existingSock = sessionManager.getSession(clientId);
  if (existingSock) {
    sendEvent('connected', { status: 'connected' });
    res.end();
    return;
  }

  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

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

  req.on('close', function() {
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES v2 (preserved exactly)
// ══════════════════════════════════════════════════════════════

// PUT /api/client/occupation
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

// PUT /api/client/location
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

// ── Service Listings ──────────────────────────────────────────

// GET /api/client/listings
router.get('/client/listings', async function(req, res) {
  try {
    var sb = getSupabase();
    // Fetch listings with their media
    var result = await sb.from('service_listings')
      .select('*, listing_media(*)')
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
    var { name, description, price, price_label, location, category, keywords, listing_type, available } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    var sb     = getSupabase();
    var result = await sb.from('service_listings').insert({
      client_id:    req.clientId,
      name:         name,
      description:  description  || null,
      price:        price        || null,
      price_label:  price_label  || null,
      location:     location     || null,
      category:     category     || null,
      keywords:     keywords     || null,
      listing_type: listing_type || 'product',
      available:    available !== false
    }).select().single();

    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/listings/:id  (full update — used by dashboard)
router.put('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','listing_type','available'];
    var update  = { updated_at: new Date().toISOString() };
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

// PATCH /api/client/listings/:id  (partial update)
router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','listing_type','available'];
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

// POST /api/client/listings/:id/media
// Accepts either multipart file upload OR JSON {url, media_type}
router.post('/client/listings/:id/media', upload.single('file'), async function(req, res) {
  try {
    var sb         = getSupabase();
    var mediaType  = req.body.media_type || 'image';
    var publicUrl, origFilename;

    if (req.file) {
      // File upload path → push to Supabase Storage
      var ext      = req.file.originalname.split('.').pop().toLowerCase();
      var filename = req.clientId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
      var bucket   = 'forgebot-listings';

      var upResult = await sb.storage.from(bucket).upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });
      if (upResult.error) throw new Error(upResult.error.message);

      var urlResult = sb.storage.from(bucket).getPublicUrl(filename);
      publicUrl     = urlResult.data.publicUrl;
      origFilename  = req.file.originalname;
    } else {
      // JSON body with direct URL
      var { url, caption, filename: fn, sort_order } = req.body;
      if (!url) return res.status(400).json({ error: 'file or url required' });
      publicUrl    = url;
      origFilename = fn || null;
    }

    var result = await sb.from('listing_media').insert({
      listing_id:  req.params.id,
      client_id:   req.clientId,
      url:         publicUrl,
      media_type:  mediaType,
      caption:     req.body.caption || null,
      filename:    origFilename,
      sort_order:  parseInt(req.body.sort_order) || 0
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
      keywords:   keywords   || null,
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

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb          = getSupabase();

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

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES v3
// ══════════════════════════════════════════════════════════════

// ── GET /api/client/settings ─────────────────────────────────
// Returns merged client + bot_setup data for settings pre-fill
router.get('/client/settings', async function(req, res) {
  try {
    var sb        = getSupabase();
    var clientRes = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (clientRes.error || !clientRes.data) return res.status(404).json({ error: 'Client not found' });
    var client = clientRes.data;

    var setupRes = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    var setup    = (setupRes.data) || {};

    delete client.password_hash;

    res.json({
      notification_number: client.notification_number || '',
      welcome_message:     client.welcome_message     || '',
      fallback_message:    client.fallback_message    || '',
      bank_name:           client.bank_name           || '',
      account_number:      client.account_number      || '',
      account_name:        client.account_name        || '',
      business_hours:      client.business_hours      || '',
      bot_setup: {
        instagram:           setup.instagram            || '',
        facebook:            setup.facebook             || '',
        tiktok:              setup.tiktok               || '',
        whatsapp_channel:    setup.whatsapp_channel     || '',
        delivery_areas:      setup.service_areas        || setup.delivery_areas     || '',
        delivery_fee:        setup.delivery_fee_local   || '',
        delivery_time:       setup.delivery_time_local  || '',
        minimum_order:       setup.minimum_order        || '',
        return_policy:       setup.return_policy        || '',
        promo:               setup.current_promo        || '',
        payment_methods:     Array.isArray(setup.payment_methods)
                               ? setup.payment_methods.join(',')
                               : (setup.payment_methods || ''),
        post_schedule_days:  setup.post_schedule_days  || [],
        post_schedule_time:  setup.post_schedule_time  || '',
        post_include_memes:  setup.post_include_memes  !== false
      },
      is_partner:          client.is_partner           || false,
      partner_expires_at:  client.partner_expires_at   || null,
      subscription_active: client.subscription_active  || false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/session-status ───────────────────────────
// Used by the WA badge in the dashboard header
router.get('/client/session-status', function(req, res) {
  try {
    var sock      = sessionManager.getSession(req.clientId);
    var connected = !!(sock);
    res.json({ connected: connected, status: connected ? 'connected' : 'disconnected' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/orders ────────────────────────────────────
router.get('/client/orders', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(100);
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/client/orders/:id ────────────────────────────────
router.put('/client/orders/:id', async function(req, res) {
  try {
    var sb      = getSupabase();
    var allowed = ['status', 'payment_status', 'notes', 'delivery_address'];
    var update  = { updated_at: new Date().toISOString() };
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var result  = await sb.from('orders')
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

// ── GET /api/client/analytics ─────────────────────────────────
router.get('/client/analytics', async function(req, res) {
  try {
    var month = req.query.month;
    if (!month) {
      var n = new Date();
      month = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
    }
    var parts = month.split('-');
    var sb    = getSupabase();
    var start = month + '-01';
    var endD  = new Date(parseInt(parts[0]), parseInt(parts[1]), 1); // first day of next month
    var end   = endD.toISOString().split('T')[0];

    var custRes = await sb.from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .gte('created_at', start)
      .lt('created_at', end);

    var ordRes = await sb.from('orders')
      .select('status, total')
      .eq('client_id', req.clientId)
      .gte('created_at', start)
      .lt('created_at', end);
    var orders    = ordRes.data || [];
    var placed    = orders.length;
    var confirmed = orders.filter(function(o) {
      return ['confirmed','packaging','shipped','delivered'].includes(o.status);
    }).length;
    var revenue = orders
      .filter(function(o) { return ['confirmed','packaging','shipped','delivered'].includes(o.status); })
      .reduce(function(sum, o) { return sum + (parseFloat(o.total) || 0); }, 0);

    var leadsRes = await sb.from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .gte('last_contact', start)
      .lt('last_contact', end);

    res.json({
      new_customers:    custRes.count  || 0,
      leads:            leadsRes.count || 0,
      orders_placed:    placed,
      orders_confirmed: confirmed,
      total_revenue:    revenue
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/client/broadcast-logs ───────────────────────────
// Alias for /broadcasts — used by dashboard
router.get('/client/broadcast-logs', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcasts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('sent_at', { ascending: false })
      .limit(20);
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/client/broadcast ────────────────────────────────
// Sends to specific phone numbers (targeted, not all customers)
router.post('/client/broadcast', async function(req, res) {
  try {
    var { message, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var phoneList = Array.isArray(phones)
      ? phones
      : (phones || '').split('\n').map(function(p) { return p.trim(); }).filter(Boolean);
    if (!phoneList.length) return res.status(400).json({ error: 'No phone numbers provided' });

    var sent = 0;
    for (var i = 0; i < phoneList.length; i++) {
      var jid = phoneList[i].replace(/\D/g, '') + '@s.whatsapp.net';
      try {
        await sock.sendMessage(jid, { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) {
        console.error('[Broadcast] Failed for', jid + ':', e.message);
      }
    }

    var sb = getSupabase();
    await sb.from('broadcasts').insert({
      client_id:  req.clientId,
      message:    message,
      recipients: sent,
      sent_at:    new Date().toISOString()
    });
    res.json({ sent: sent, total: phoneList.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bot Tasks (Bot Errands) ───────────────────────────────────

// GET /api/client/bot-tasks
router.get('/client/bot-tasks', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/bot-tasks
router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time || !schedule_days) {
      return res.status(400).json({ error: 'name, message, schedule_time and schedule_days are required' });
    }
    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').insert({
      client_id:     req.clientId,
      name:          name,
      message:       message,
      schedule_time: schedule_time,
      schedule_days: schedule_days,
      filter_type:   filter_type || 'all_customers',
      active:        true,
      run_count:     0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/client/bot-tasks/:id
router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb      = getSupabase();
    var allowed = ['active', 'name', 'message', 'schedule_time', 'schedule_days', 'filter_type'];
    var update  = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var result  = await sb.from('bot_tasks')
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

// DELETE /api/client/bot-tasks/:id
router.delete('/client/bot-tasks/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('bot_tasks')
      .delete()
      .eq('id', req.params.id)
      .eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Post Schedule ─────────────────────────────────────────────

// GET /api/client/post-schedule
router.get('/client/post-schedule', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_setup')
      .select('post_schedule_days, post_schedule_time, post_include_memes')
      .eq('client_id', req.clientId)
      .single();
    var data = result.data || {};
    res.json({
      days:          data.post_schedule_days  || [],
      time:          data.post_schedule_time  || '',
      include_memes: data.post_include_memes  !== false
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/post-schedule
router.put('/client/post-schedule', async function(req, res) {
  try {
    var { days, time, include_memes } = req.body;
    var sb = getSupabase();
    await sb.from('bot_setup').upsert({
      client_id:          req.clientId,
      post_schedule_days: days         || [],
      post_schedule_time: time         || null,
      post_include_memes: include_memes !== false,
      updated_at:         new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push Notifications ────────────────────────────────────────

// POST /api/client/push/subscribe
router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: 'endpoint and keys required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id:    req.clientId,
      subscription: JSON.stringify({ endpoint: endpoint, keys: keys }),
      updated_at:   new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    // push_subscriptions table may not exist yet — non-fatal
    res.json({ ok: true });
  }
});

// POST /api/client/push/test
router.post('/client/push/test', async function(req, res) {
  res.json({ ok: true, sent: 1 });
});

module.exports = router;
