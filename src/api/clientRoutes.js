// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
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
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── JWT auth middleware ───────────────────────────────────────
// NOTE: ?token= fallback is required for EventSource (SSE) which cannot send headers.
function auth(req, res, next) {
  try {
    var header = req.headers.authorization || '';
    var token  = header.replace('Bearer ', '').trim();
    if (!token) token = req.query.token || '';
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
      .eq('id', clientId).single();
    if (result.error || !result.data) return;
    var c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active) {
      if (new Date(c.partner_expires_at) < new Date()) {
        await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
        await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired on API request check' });
      }
    }
  } catch (e) {
    console.error('[ClientAPI] Partner check error:', e.message);
  }
}

// ── Apply auth to all /client/* routes ────────────────────────
router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  SESSION STATUS  ← THE FIX: this endpoint was missing,
//  causing the 404 JSON handler to return {error:'Not found'},
//  which made st.connected undefined → badge always "Disconnected"
// ══════════════════════════════════════════════════════════════

// GET /api/client/session-status
router.get('/client/session-status', function(req, res) {
  try {
    var sock = sessionManager.getSession(req.clientId);
    res.json({ connected: !!sock });
  } catch (e) {
    res.json({ connected: false });
  }
});

// ══════════════════════════════════════════════════════════════
//  ME + SETTINGS
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

// GET /api/client/settings  — full settings for the dashboard Settings tab
router.get('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();

    // Fetch client row
    var clientResult = await sb.from('clients')
      .select('notification_number,welcome_message,fallback_message,bank_name,account_number,account_name,business_hours,business_name,occupation_data')
      .eq('id', req.clientId).single();

    var clientData = clientResult.data || {};

    // Fetch bot_setup row (may not exist)
    var setupResult = await sb.from('bot_setup')
      .select('*')
      .eq('client_id', req.clientId)
      .maybeSingle();

    var setup = setupResult.data || {};

    // Flatten occupation_data fields if stored there
    var occData = clientData.occupation_data || {};

    res.json({
      notification_number: clientData.notification_number || '',
      welcome_message:     clientData.welcome_message || '',
      fallback_message:    clientData.fallback_message || '',
      bank_name:           clientData.bank_name || '',
      account_number:      clientData.account_number || '',
      account_name:        clientData.account_name || '',
      business_hours:      clientData.business_hours || '',
      business_name:       clientData.business_name || '',
      bot_setup: {
        instagram:        setup.instagram || occData.instagram || '',
        facebook:         setup.facebook  || occData.facebook  || '',
        tiktok:           setup.tiktok    || occData.tiktok    || '',
        whatsapp_channel: setup.whatsapp_channel || occData.whatsapp_channel || '',
        delivery_areas:   setup.delivery_areas   || occData.delivery_areas   || '',
        delivery_fee:     setup.delivery_fee     || occData.delivery_fee     || '',
        delivery_time:    setup.delivery_time    || occData.delivery_time    || '',
        minimum_order:    setup.minimum_order    || occData.minimum_order    || '',
        return_policy:    setup.return_policy    || occData.return_policy    || '',
        promo:            setup.promo            || occData.promo            || '',
        payment_methods:  setup.payment_methods  || occData.payment_methods  || ''
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/settings
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name', 'bank_name', 'account_number',
      'account_name', 'business_hours', 'welcome_message', 'fallback_message'
    ];
    var update = {};
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

// PUT /api/client/bot-setup
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var fields = [
      'instagram','facebook','tiktok','whatsapp_channel',
      'delivery_areas','delivery_fee','delivery_time','minimum_order',
      'return_policy','promo','payment_methods'
    ];
    var data = { client_id: req.clientId, updated_at: new Date().toISOString() };
    fields.forEach(function(k) { if (req.body[k] !== undefined) data[k] = req.body[k]; });

    await sb.from('bot_setup').upsert(data, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AUTO-REPLY FLOWS
// ══════════════════════════════════════════════════════════════

router.get('/client/flows', async function(req, res) {
  try {
    var flows = await db.getFlows(req.clientId, false);
    res.json(flows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

router.delete('/client/flows/:id', async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════════

// GET /api/client/orders
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

// PUT /api/client/orders/:id
router.put('/client/orders/:id', async function(req, res) {
  try {
    var sb     = getSupabase();
    var update = {};
    if (req.body.status         !== undefined) update.status         = req.body.status;
    if (req.body.payment_status !== undefined) update.payment_status = req.body.payment_status;
    update.updated_at = new Date().toISOString();

    var result = await sb.from('orders')
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

// ══════════════════════════════════════════════════════════════
//  ANALYTICS
// ══════════════════════════════════════════════════════════════

// GET /api/client/analytics?month=YYYY-MM
router.get('/client/analytics', async function(req, res) {
  try {
    var sb    = getSupabase();
    var month = req.query.month || new Date().toISOString().slice(0, 7); // "2026-07"
    var start = month + '-01';
    var end   = month + '-31';

    // New customers this month
    var newCustomers = await sb.from('customers')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', req.clientId)
      .gte('created_at', start)
      .lte('created_at', end);

    // Orders this month
    var ordersAll = await sb.from('orders')
      .select('id,status,total', { count: 'exact' })
      .eq('client_id', req.clientId)
      .gte('created_at', start)
      .lte('created_at', end);

    var orders    = ordersAll.data || [];
    var confirmed = orders.filter(function(o) { return o.status === 'confirmed' || o.status === 'delivered'; });
    var revenue   = confirmed.reduce(function(sum, o) { return sum + (parseFloat(o.total) || 0); }, 0);

    // Leads (price inquiry messages) — approximate via messages table if it exists
    var leads = 0;
    try {
      var leadsResult = await sb.from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', req.clientId)
        .ilike('text', '%price%')
        .gte('created_at', start)
        .lte('created_at', end);
      leads = leadsResult.count || 0;
    } catch (e) { /* messages table may not exist */ }

    res.json({
      new_customers:    newCustomers.count || 0,
      leads:            leads,
      orders_placed:    orders.length,
      orders_confirmed: confirmed.length,
      total_revenue:    revenue
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  STATUS POSTS
// ══════════════════════════════════════════════════════════════

router.get('/client/status-posts', async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.clientId);
    res.json(posts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, media_url, caption, scheduledTime, post_time, scheduledDays } = req.body;
    var finalMedia = mediaUrl || media_url || null;
    var finalTime  = scheduledTime || post_time;
    if (!caption || !finalTime) return res.status(400).json({ error: 'caption and time required' });
    var post = await db.addStatusPost(req.clientId, caption, finalMedia, finalTime, scheduledDays || null);
    res.json(post);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  BROADCAST
//  Dashboard calls POST /client/broadcast and GET /client/broadcast-logs
// ══════════════════════════════════════════════════════════════

// POST /api/client/broadcast  (also keep /broadcasts for backwards compat)
async function handleBroadcast(req, res) {
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
}

router.post('/client/broadcast',  handleBroadcast);
router.post('/client/broadcasts', handleBroadcast);

// GET /api/client/broadcast-logs  (dashboard calls this)
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

// GET /api/client/broadcasts  (backwards compat)
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

// ══════════════════════════════════════════════════════════════
//  BOT ERRANDS (bot_tasks table)
// ══════════════════════════════════════════════════════════════

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
    res.json([]); // table may not exist yet
  }
});

// POST /api/client/bot-tasks
router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time) return res.status(400).json({ error: 'name, message, and schedule_time required' });

    var sb     = getSupabase();
    var result = await sb.from('bot_tasks').insert({
      client_id:     req.clientId,
      name:          name,
      message:       message,
      schedule_time: schedule_time,
      schedule_days: schedule_days || 'Mon,Tue,Wed,Thu,Fri',
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
    var sb     = getSupabase();
    var update = {};
    if (req.body.active    !== undefined) update.active    = req.body.active;
    if (req.body.name      !== undefined) update.name      = req.body.name;
    if (req.body.message   !== undefined) update.message   = req.body.message;

    var result = await sb.from('bot_tasks')
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
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  QR STREAM (SSE)
//  auth middleware already handles ?token= so req.clientId is set.
//  FIX: no longer calls res.end() when already connected — that was
//  closing the SSE and causing EventSource onerror → "Disconnected".
// ══════════════════════════════════════════════════════════════

router.get('/client/qr-stream', async function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  var clientId = req.clientId;
  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
  }

  // Heartbeat — prevents Railway's proxy from closing idle SSE connections
  var heartbeat = setInterval(function() {
    try { res.write(': ping\n\n'); } catch(e) { clearInterval(heartbeat); }
  }, 25000);

  // Register this SSE connection for all future events
  var listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  req.on('close', function() {
    clearInterval(heartbeat);
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });

  // If already connected: fire immediately and STAY OPEN (don't res.end).
  var existingSock = global.getSock ? global.getSock(clientId) : sessionManager.getSession(clientId);
  if (existingSock) {
    sendEvent('connected', { status: 'connected' });
    return;
  }

  // Start or attach to an in-progress session
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
      global.qrListeners.delete(clientId);
    }
  });
});

// ══════════════════════════════════════════════════════════════
//  SERVICE LISTINGS
// ══════════════════════════════════════════════════════════════

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
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
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

router.delete('/client/media/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── File Upload ───────────────────────────────────────────────

router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    var sb       = getSupabase();
    var ext      = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var bucket   = 'forgebot-listings';

    var result = await sb.storage.from(bucket).upload(filename, req.file.buffer, {
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

// ══════════════════════════════════════════════════════════════
//  FAQ
// ══════════════════════════════════════════════════════════════

router.get('/client/faq', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
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
      client_id: req.clientId, question, answer,
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
    var result = await sb.from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/faq/:id', async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  OCCUPATION + LOCATION
// ══════════════════════════════════════════════════════════════

router.put('/client/occupation', async function(req, res) {
  try {
    var { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    var sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    var sb = getSupabase();
    await sb.from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var { enabled } = req.body;
    var sb = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PARTNER / TRIAL STATUS
// ══════════════════════════════════════════════════════════════

router.get('/client/partner-status', async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    var c        = result.data;
    var now      = new Date();
    var expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({
      is_partner:   c.is_partner || false,
      expires_at:   c.partner_expires_at || null,
      days_left:    expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null,
      expired:      expiresAt ? expiresAt < now : false,
      still_active: c.subscription_active
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: 'endpoint and keys required' });
    var sb = getSupabase();
    await sb.from('push_subscriptions').upsert({
      client_id: req.clientId,
      endpoint:  endpoint,
      p256dh:    keys.p256dh,
      auth:      keys.auth,
      created_at: new Date().toISOString()
    }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/push/test', async function(req, res) {
  // Basic implementation — returns ok. Full implementation would use web-push library.
  res.json({ sent: 0, message: 'Push test endpoint reached' });
});

module.exports = router;
