// ============================================================
//  ForgeBot — Client API Routes v3
//  src/api/clientRoutes.js
//
//  v3 changes:
//   - POST /listings: keywords optional (only name required)
//   - POST /listings/:id/media: accepts multer file uploads
//   - GET  /listings/:id: single listing fetch
//   - GET  /qr-stream: 20s heartbeat + correct SSE headers
//   - GET  /session-status: { connected }
//   - Broadcast audience presets (all/inactive_7d/inactive_14d/custom)
//   - Full bot-tasks CRUD
//   - Push notification subscribe + test
//   - All v2 routes preserved
// ============================================================

'use strict';

const express   = require('express');
const jwt       = require('jsonwebtoken');
const multer    = require('multer');
const webpush   = require('web-push');
const db        = require('../db/supabase');
const sessionMgr = require('../bot/sessionManager');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── VAPID (never regenerate these keys) ─────────────────────
webpush.setVapidDetails(
  'mailto:support@forgebot.ng',
  process.env.VAPID_PUBLIC_KEY  || 'BBN1ci_BmHj26FTeNf_lnzqVGAhM2_X1RBlDz0lYlVOh3ULn5aKO9iNnhHBdyuDBGQXCvkjAN03yNrwhd6S0JNs',
  process.env.VAPID_PRIVATE_KEY || 'V1HPNYUQboY3DGGgRn92A4WSzZfWmtFLQewEeYvKiDo'
);

// ── Auth middleware ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  var auth  = req.headers.authorization;
  var token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ────────────────────────────────────────────────────────────
//  QR STREAM  (token via query param — EventSource limitation)
// ────────────────────────────────────────────────────────────
router.get('/qr-stream', function(req, res) {
  var token = req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  var clientId;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    clientId = decoded.clientId || decoded.id;
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sendEvent(eventName, data) {
    try {
      res.write('event: ' + eventName + '\n');
      res.write('data: ' + JSON.stringify(data) + '\n\n');
    } catch (e) {}
  }

  var heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 20000);

  sessionMgr.registerQRListener(clientId, sendEvent);
  sessionMgr.startSession(clientId).catch(function(e) {
    console.error('[QR-Stream] startSession error:', e.message);
  });

  req.on('close', function() {
    clearInterval(heartbeat);
    sessionMgr.unregisterQRListener(clientId, sendEvent);
  });
});

// ────────────────────────────────────────────────────────────
//  SESSION STATUS
// ────────────────────────────────────────────────────────────
router.get('/session-status', authMiddleware, async function(req, res) {
  try {
    var connected = sessionMgr.isConnected(req.clientId);
    res.json({ connected: !!connected });
  } catch (e) {
    res.json({ connected: false });
  }
});

// ────────────────────────────────────────────────────────────
//  AUTH — Login
// ────────────────────────────────────────────────────────────
router.post('/login', async function(req, res) {
  try {
    var { phone, password } = req.body;
    if (!phone || !password) return res.status(400).json({ error: 'Phone and password required' });
    var sb = db.getSupabase();
    var { data: client, error } = await sb
      .from('clients')
      .select('*')
      .eq('phone', phone)
      .single();
    if (error || !client) return res.status(401).json({ error: 'Invalid credentials' });
    var bcrypt = require('bcryptjs');
    var valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    var token = jwt.sign(
      { clientId: client.id, phone: client.phone },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, clientId: client.id, businessName: client.business_name });
  } catch (e) {
    console.error('[Login]', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ────────────────────────────────────────────────────────────
//  SETTINGS
// ────────────────────────────────────────────────────────────
router.get('/settings', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var [clientRes, setupRes] = await Promise.all([
      sb.from('clients').select('*').eq('id', req.clientId).single(),
      sb.from('bot_setup').select('*').eq('client_id', req.clientId).single()
    ]);
    res.json({
      client: clientRes.data || {},
      setup:  setupRes.data  || {}
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/settings', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var {
      business_name, fallback_message, welcome_message,
      notification_number, business_category,
      // bot_setup fields
      delivery_areas, delivery_fee, payment_methods,
      return_policy, business_hours, custom_qa,
      current_promo, instagram, facebook, tiktok, whatsapp_channel
    } = req.body;

    await sb.from('clients').update({
      business_name, fallback_message, welcome_message,
      notification_number, business_category
    }).eq('id', req.clientId);

    await sb.from('bot_setup').upsert({
      client_id: req.clientId,
      delivery_areas, delivery_fee, payment_methods,
      return_policy, business_hours, custom_qa,
      current_promo, instagram, facebook, tiktok, whatsapp_channel,
      updated_at: new Date().toISOString()
    }, { onConflict: 'client_id' });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────
//  AUTO-REPLY FLOWS
// ────────────────────────────────────────────────────────────
router.get('/flows', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('flows').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/flows', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { keywords, response, response_type, media_url, active } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response required' });
    var { data, error } = await sb.from('flows').insert({
      client_id: req.clientId, keywords, response,
      response_type: response_type || 'text', media_url, active: active !== false
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/flows/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { keywords, response, response_type, media_url, active } = req.body;
    var { data, error } = await sb.from('flows').update({
      keywords, response, response_type, media_url, active, updated_at: new Date().toISOString()
    }).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/flows/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  LISTINGS
// ────────────────────────────────────────────────────────────
router.get('/listings', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb
      .from('service_listings')
      .select('*, listing_media(id, url, media_type, caption, sort_order)')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/listings/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb
      .from('service_listings')
      .select('*, listing_media(id, url, media_type, caption, sort_order)')
      .eq('id', req.params.id)
      .eq('client_id', req.clientId)
      .single();
    if (error) return res.status(404).json({ error: 'Not found' });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create listing — only name required
router.post('/listings', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { name, description, category, price, price_label, keywords, location, available } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var { data, error } = await sb.from('service_listings').insert({
      client_id: req.clientId,
      name,
      description: description || null,
      category:    category    || null,
      price:       price       || null,
      price_label: price_label || null,
      keywords:    keywords    || '',
      location:    location    || null,
      available:   available !== false
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update listing (PUT or PATCH)
function updateListing(req, res) {
  return (async function() {
    try {
      var sb = db.getSupabase();
      var { name, description, category, price, price_label, keywords, location, available } = req.body;
      var { data, error } = await sb.from('service_listings').update({
        name, description, category, price, price_label, keywords, location, available,
        updated_at: new Date().toISOString()
      }).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
      if (error) return res.status(400).json({ error: error.message });
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  })();
}
router.put('/listings/:id',   authMiddleware, updateListing);
router.patch('/listings/:id', authMiddleware, updateListing);

router.delete('/listings/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('listing_media').delete().eq('listing_id', req.params.id);
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listing media — accepts file upload OR JSON URL ──────────
router.post('/listings/:id/media',
  authMiddleware,
  upload.single('file'),
  async function(req, res) {
    try {
      var sb = db.getSupabase();
      var listingId = req.params.id;
      var clientId  = req.clientId;

      // Verify ownership
      var { data: listing } = await sb.from('service_listings').select('id').eq('id', listingId).eq('client_id', clientId).single();
      if (!listing) return res.status(404).json({ error: 'Listing not found' });

      var url, media_type, caption, filename;

      if (req.file) {
        // File upload → push to Supabase Storage
        var ext   = req.file.originalname.split('.').pop().toLowerCase();
        var mtype = req.file.mimetype;
        media_type = mtype.startsWith('image') ? 'image' : (mtype === 'application/pdf' ? 'pdf' : 'other');
        filename  = listingId + '/' + Date.now() + '.' + ext;
        caption   = req.body.caption || null;

        var { error: uploadErr } = await sb.storage
          .from('forgebot-listings')
          .upload(filename, req.file.buffer, { contentType: mtype, upsert: false });
        if (uploadErr) return res.status(400).json({ error: 'Upload failed: ' + uploadErr.message });

        var { data: publicData } = sb.storage.from('forgebot-listings').getPublicUrl(filename);
        url = publicData.publicUrl;
      } else {
        // JSON URL
        url        = req.body.url;
        media_type = req.body.media_type || 'image';
        caption    = req.body.caption    || null;
        filename   = req.body.filename   || null;
        if (!url) return res.status(400).json({ error: 'file or url required' });
      }

      var sort_order = req.body.sort_order || 0;
      var { data, error } = await sb.from('listing_media').insert({
        listing_id: listingId,
        url, media_type, caption, filename,
        sort_order: parseInt(sort_order) || 0
      }).select().single();
      if (error) return res.status(400).json({ error: error.message });
      res.json(data);
    } catch (e) {
      console.error('[Media Upload]', e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

router.delete('/listings/:id/media/:mediaId', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data: media } = await sb.from('listing_media').select('*').eq('id', req.params.mediaId).single();
    if (media && media.filename) {
      await sb.storage.from('forgebot-listings').remove([media.filename]);
    }
    await sb.from('listing_media').delete().eq('id', req.params.mediaId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  ORDERS
// ────────────────────────────────────────────────────────────
router.get('/orders', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('orders').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/orders/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { status, notes } = req.body;
    var { data, error } = await sb.from('orders').update({ status, notes, updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  ANALYTICS
// ────────────────────────────────────────────────────────────
router.get('/analytics', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var month = req.query.month || new Date().toISOString().slice(0, 7);
    var start = month + '-01T00:00:00.000Z';
    var end   = new Date(month + '-01');
    end.setMonth(end.getMonth() + 1);
    var endStr = end.toISOString();

    var [custRes, msgRes, orderRes] = await Promise.all([
      sb.from('customers').select('id', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', endStr),
      sb.from('message_logs').select('id', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', endStr),
      sb.from('orders').select('id,total', { count: 'exact' }).eq('client_id', req.clientId).gte('created_at', start).lt('created_at', endStr)
    ]);

    var revenue = (orderRes.data || []).reduce(function(sum, o) { return sum + (parseFloat(o.total) || 0); }, 0);
    res.json({
      newCustomers: custRes.count || 0,
      messages:     msgRes.count  || 0,
      orders:       orderRes.count || 0,
      revenue:      revenue
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  BROADCAST
// ────────────────────────────────────────────────────────────
router.get('/broadcast-logs', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('broadcast_logs').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(50);
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/broadcast', authMiddleware, async function(req, res) {
  try {
    var sb   = db.getSupabase();
    var sock = sessionMgr.getSocket(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });

    var { message, audience, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    var recipients = [];

    if (audience === 'custom' && phones) {
      var phoneList = (Array.isArray(phones) ? phones : phones.split(/[\n,]+/))
        .map(function(p) { return p.toString().replace(/\D/g, ''); })
        .filter(function(p) { return p.length >= 7; });
      recipients = phoneList.map(function(p) {
        if (!p.startsWith('234')) p = '234' + p.replace(/^0/, '');
        return p + '@s.whatsapp.net';
      });
    } else {
      var query = sb.from('customers').select('jid').eq('client_id', req.clientId);
      if (audience === 'inactive_7d') {
        var d7 = new Date(); d7.setDate(d7.getDate() - 7);
        query = query.lt('last_contact', d7.toISOString());
      } else if (audience === 'inactive_14d') {
        var d14 = new Date(); d14.setDate(d14.getDate() - 14);
        query = query.lt('last_contact', d14.toISOString());
      }
      var { data: customers } = await query;
      recipients = (customers || []).map(function(c) { return c.jid; });
    }

    if (!recipients.length) return res.status(400).json({ error: 'No recipients found' });

    var sent = 0, failed = 0;
    for (var i = 0; i < recipients.length; i++) {
      try {
        await sock.sendMessage(recipients[i], { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 1000); });
      } catch (e) { failed++; }
    }

    await sb.from('broadcast_logs').insert({
      client_id: req.clientId,
      message, audience: audience || 'custom',
      total: recipients.length, sent, failed,
      created_at: new Date().toISOString()
    });

    res.json({ success: true, sent, failed, total: recipients.length });
  } catch (e) {
    console.error('[Broadcast]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ────────────────────────────────────────────────────────────
//  BOT TASKS (Errands)
// ────────────────────────────────────────────────────────────
router.get('/bot-tasks', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('bot_tasks').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bot-tasks', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { title, message, audience, schedule_time, repeat, active } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    var { data, error } = await sb.from('bot_tasks').insert({
      client_id: req.clientId, title, message,
      audience: audience || 'all_customers',
      schedule_time: schedule_time || null,
      repeat: repeat || 'none',
      active: active !== false
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/bot-tasks/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('bot_tasks').update(Object.assign({}, req.body, { updated_at: new Date().toISOString() })).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bot-tasks/:id', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('bot_tasks').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  STATUS POST SCHEDULE
// ────────────────────────────────────────────────────────────
router.get('/post-schedule', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data } = await sb.from('post_schedules').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/post-schedule', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { schedules } = req.body;
    if (!Array.isArray(schedules)) return res.status(400).json({ error: 'schedules array required' });
    await sb.from('post_schedules').delete().eq('client_id', req.clientId);
    if (schedules.length) {
      var rows = schedules.map(function(s) { return Object.assign({ client_id: req.clientId }, s); });
      await sb.from('post_schedules').insert(rows);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  PUSH NOTIFICATIONS
// ────────────────────────────────────────────────────────────
router.post('/push/subscribe', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var sub = req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
    await sb.from('push_subscriptions').upsert({
      client_id: req.clientId,
      endpoint: sub.endpoint,
      subscription: JSON.stringify(sub),
      created_at: new Date().toISOString()
    }, { onConflict: 'client_id,endpoint' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push/test', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data: subs } = await sb.from('push_subscriptions').select('subscription').eq('client_id', req.clientId);
    if (!subs || !subs.length) return res.status(400).json({ error: 'No push subscription found. Open the dashboard in your browser first.' });
    var payload = JSON.stringify({ title: 'ForgeBot Test', body: 'Push notifications are working! ✅', icon: '/icons/icon-192.png' });
    var sent = 0;
    for (var i = 0; i < subs.length; i++) {
      try {
        var subObj = typeof subs[i].subscription === 'string' ? JSON.parse(subs[i].subscription) : subs[i].subscription;
        await webpush.sendNotification(subObj, payload);
        sent++;
      } catch (e) {
        if (e.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('client_id', req.clientId).eq('endpoint', subObj.endpoint);
        }
      }
    }
    res.json({ success: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  CUSTOMERS
// ────────────────────────────────────────────────────────────
router.get('/customers', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data, error } = await sb.from('customers').select('*').eq('client_id', req.clientId).order('last_contact', { ascending: false });
    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  SETUP (5-step wizard)
// ────────────────────────────────────────────────────────────
router.post('/setup', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('bot_setup').upsert(
      Object.assign({ client_id: req.clientId, updated_at: new Date().toISOString() }, req.body),
      { onConflict: 'client_id' }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/setup', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { data } = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  PROFILE (change password)
// ────────────────────────────────────────────────────────────
router.post('/change-password', authMiddleware, async function(req, res) {
  try {
    var sb = db.getSupabase();
    var { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    var { data: client } = await sb.from('clients').select('password_hash').eq('id', req.clientId).single();
    var bcrypt = require('bcryptjs');
    var valid = await bcrypt.compare(current_password, client.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password incorrect' });
    var hash = await bcrypt.hash(new_password, 10);
    await sb.from('clients').update({ password_hash: hash }).eq('id', req.clientId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────
//  VAPID PUBLIC KEY (for push setup in frontend)
// ────────────────────────────────────────────────────────────
router.get('/push/vapid-public-key', function(req, res) {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || 'BBN1ci_BmHj26FTeNf_lnzqVGAhM2_X1RBlDz0lYlVOh3ULn5aKO9iNnhHBdyuDBGQXCvkjAN03yNrwhd6S0JNs' });
});

module.exports = router;
