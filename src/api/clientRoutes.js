// ============================================================
//  ForgeBot — Client API Routes v2
//  File location: src/api/clientRoutes.js
//  Mounted at: /api  (in index.js: app.use('/api', clientRoutes))
//  Auth: JWT via Authorization: Bearer <token>
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

const sessionManager = require('../sessions/sessionManager');

// ── Lazy Supabase init ────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing');
    _supabase = createClient(url, key);
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

// ── Apply auth + partner check to all /client routes ─────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  CORE ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    var client = result.data;
    var sock   = sessionManager.getSession ? sessionManager.getSession(req.clientId)
               : (sessionManager.sessions ? sessionManager.sessions.get(req.clientId) : null);
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
    var sb     = getSupabase();
    var result = await sb.from('flows')
      .select('*')
      .eq('client_id', req.clientId)
      .order('priority', { ascending: false });
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/flows
router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    var sb     = getSupabase();
    var result = await sb.from('flows').insert({
      client_id:     req.clientId,
      flow_name:     'Custom',
      keywords:      keywords,
      response_type: response_type || 'text',
      response:      response,
      media_url:     media_url || null,
      priority:      0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/status-posts
router.get('/client/status-posts', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('status_posts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    // Normalise column names for the dashboard (supports both post_time and scheduled_time)
    var posts = (result.data || []).map(function(p) {
      return Object.assign({}, p, {
        scheduled_time: p.scheduled_time || p.post_time || '',
        scheduled_days: p.scheduled_days || p.days || ''
      });
    });
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
    var sb     = getSupabase();
    var result = await sb.from('status_posts').insert({
      client_id:      req.clientId,
      caption:        caption || null,
      media_url:      mediaUrl,
      post_time:      scheduledTime,
      days:           scheduledDays,
      scheduled_time: scheduledTime,
      scheduled_days: scheduledDays
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
    var sock = sessionManager.getSession ? sessionManager.getSession(req.clientId)
             : (sessionManager.sessions ? sessionManager.sessions.get(req.clientId) : null);
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

    await sb.from('broadcasts').insert({ client_id: req.clientId, message: message, recipients: sent });
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
    var sb     = getSupabase();
    var result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/fallback
router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    var sb     = getSupabase();
    var result = await sb.from('clients').update({ fallback_message: fallback_message }).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
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
  res.flushHeaders();

  var clientId = req.clientId;
  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  var existingSock = global.getSock && global.getSock(clientId);
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
//  NEW ROUTES v2
// ══════════════════════════════════════════════════════════════

// ── Bot setup / onboard questionnaire ────────────────────────

// PUT /api/client/bot-setup  — saves questionnaire from onboard.html
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var clientId = req.clientId;
    var {
      occupation, occupation_data,
      availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel,
      service_areas, property_types, studio_location,
      advance_booking, deposit_required, home_service,
      return_policy, delivers_to, minimum_order,
      delivery_time_local, delivery_fee_local,
      session_duration, session_type, who_do_you_serve,
      free_consult, bulk_orders, event_services,
      visa_service, home_visits, fashion_type,
      deal_type, viewings, photography_types
    } = req.body;

    // 1. Update occupation on clients table
    if (occupation) {
      await sb.from('clients').update({
        occupation:      occupation,
        occupation_data: occupation_data || {}
      }).eq('id', clientId);
    }

    // 2. Build bot_setup upsert payload (only include defined values)
    var setup = {
      client_id:          clientId,
      availability_days:  availability_days,
      payment_methods:    payment_methods,
      current_promo:      current_promo || null,
      instagram:          instagram || null,
      facebook:           facebook || null,
      tiktok:             tiktok || null,
      whatsapp_channel:   whatsapp_channel || null,
      service_areas:      service_areas || property_types || null,
      studio_location:    studio_location || null,
      advance_booking:    advance_booking || null,
      deposit_required:   deposit_required || null,
      home_service:       home_service || null,
      return_policy:      return_policy || null,
      delivers_to:        delivers_to || null,
      minimum_order:      minimum_order || null,
      delivery_time_local: delivery_time_local || null,
      delivery_fee_local:  delivery_fee_local || null,
      session_duration:    session_duration || session_type || null,
      who_do_you_serve:    who_do_you_serve || null,
      bulk_orders:         bulk_orders || null,
      updated_at:          new Date().toISOString()
    };

    // Remove null/undefined to avoid overwriting existing data with nulls
    Object.keys(setup).forEach(function(k) {
      if (setup[k] === null || setup[k] === undefined || setup[k] === '') {
        if (k !== 'client_id') delete setup[k];
      }
    });

    var { error } = await sb.from('bot_setup').upsert(setup, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Occupation ────────────────────────────────────────────────

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
    var c         = result.data;
    var now       = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
    res.json({
      is_partner:   c.is_partner || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    daysLeft,
      expired:      expiresAt ? expiresAt < now : false,
      still_active: c.subscription_active
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
    var current     = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData     = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
