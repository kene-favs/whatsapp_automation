// ============================================================
//  ForgeBot — Client API Routes v3
//  File location: src/api/clientRoutes.js
//  Mounted at: /api  (app.use('/api', clientRoutes))
// ============================================================
'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const { createClient } = require('@supabase/supabase-js');

const db             = require('../db/supabase');
const sessionManager = require('../sessions/sessionManager');

let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _supabase;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function auth(req, res, next) {
  try {
    var token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
    next();
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
}

async function checkPartnerExpiry(clientId) {
  try {
    var sb = getSupabase();
    var result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', clientId).single();
    if (result.error || !result.data) return;
    var c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active && new Date(c.partner_expires_at) < new Date()) {
      await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
      await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired on API request check' });
    }
  } catch (e) { console.error('[ClientAPI] Partner check error:', e.message); }
}

router.use('/client', auth, async function(req, res, next) {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ── GET /api/client/me ────────────────────────────────────────
router.get('/client/me', async function(req, res) {
  try {
    var client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var sock = sessionManager.getSession(req.clientId);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Flows ─────────────────────────────────────────────────────
router.get('/client/flows', async function(req, res) {
  try { res.json(await db.getFlows(req.clientId, false)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/flows', async function(req, res) {
  try {
    var { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response are required' });
    res.json(await db.addFlow(req.clientId, 'Custom', keywords, response_type || 'text', response, media_url || null, 0));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/flows/:id', async function(req, res) {
  try { await db.deleteFlow(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Status Posts ──────────────────────────────────────────────
router.get('/client/status-posts', async function(req, res) {
  try { res.json(await db.getStatusPosts(req.clientId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/status-posts', async function(req, res) {
  try {
    var { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
    res.json(await db.addStatusPost(req.clientId, caption, mediaUrl, scheduledTime, scheduledDays));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/status-posts/:id', async function(req, res) {
  try {
    await getSupabase().from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Broadcasts ────────────────────────────────────────────────
router.get('/client/broadcasts', async function(req, res) {
  try {
    var r = await getSupabase().from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(20);
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/broadcasts', async function(req, res) {
  try {
    var { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    var sb = getSupabase();
    var jids = ((await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200)).data || []).map(function(c) { return c.jid; });
    var sent = 0;
    for (var i = 0; i < jids.length; i++) {
      try { await sock.sendMessage(jids[i], { text: message }); sent++; await new Promise(function(r) { setTimeout(r, 1200); }); }
      catch (e) { console.error('[Broadcast] Failed for ' + jids[i]); }
    }
    await db.logBroadcast(req.clientId, message, sent);
    res.json({ sent: sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Settings ──────────────────────────────────────────────────
router.put('/client/settings', async function(req, res) {
  try {
    var allowed = ['notification_number','business_name','welcome_message','fallback_message','bank_name','account_number','account_name','business_hours'];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    res.json(await db.updateClient(req.clientId, update));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/fallback', async function(req, res) {
  try {
    var { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    res.json(await db.updateClient(req.clientId, { fallback_message }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── QR Stream (SSE) — with heartbeat to survive Railway nginx ─
router.get('/client/qr-stream', async function(req, res) {
  var token = req.query.token;
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId || decoded.id;
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Railway/nginx buffering
  res.flushHeaders();

  var clientId = req.clientId;

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) {}
  }

  // If already connected, tell the client immediately and close
  if (sessionManager.getSession(clientId)) {
    sendEvent('connected', { status: 'connected' });
    res.end();
    return;
  }

  // Register this SSE connection as a listener (gets cached QR immediately if available)
  sessionManager.registerQRListener(clientId, sendEvent);

  // Start session (mutex inside prevents double-start)
  sessionManager.startSession(clientId).catch(function(e) {
    console.error('[QR-Stream] startSession error:', e.message);
  });

  // Heartbeat every 20s — keeps Railway from closing the SSE connection
  var heartbeat = setInterval(function() {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 20000);

  // Cleanup on disconnect
  req.on('close', function() {
    clearInterval(heartbeat);
    sessionManager.unregisterQRListener(clientId, sendEvent);
  });
});

// ── bot-setup (questionnaire from onboard.html) ───────────────
router.put('/client/bot-setup', async function(req, res) {
  try {
    var sb = getSupabase();
    var {
      occupation, occupation_data, availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel, service_areas, property_types,
      studio_location, advance_booking, deposit_required, home_service,
      return_policy, delivers_to, minimum_order, delivery_time_local, delivery_fee_local,
      session_duration, session_type, who_do_you_serve, free_consult, bulk_orders
    } = req.body;

    if (occupation) {
      await sb.from('clients').update({ occupation: occupation, occupation_data: occupation_data || {} }).eq('id', req.clientId);
    }

    var setup = {
      client_id: req.clientId,
      availability_days: availability_days,
      payment_methods: payment_methods,
      current_promo: current_promo || null,
      instagram: instagram || null,
      facebook: facebook || null,
      tiktok: tiktok || null,
      whatsapp_channel: whatsapp_channel || null,
      service_areas: service_areas || property_types || null,
      studio_location: studio_location || null,
      advance_booking: advance_booking || null,
      deposit_required: deposit_required || null,
      home_service: home_service || null,
      return_policy: return_policy || null,
      delivers_to: delivers_to || null,
      minimum_order: minimum_order || null,
      delivery_time_local: delivery_time_local || null,
      delivery_fee_local: delivery_fee_local || null,
      session_duration: session_duration || session_type || null,
      who_do_you_serve: who_do_you_serve || null,
      bulk_orders: bulk_orders || null,
      updated_at: new Date().toISOString()
    };

    // Don't overwrite existing values with null/empty
    Object.keys(setup).forEach(function(k) {
      if (k !== 'client_id' && (setup[k] === null || setup[k] === undefined || setup[k] === '')) delete setup[k];
    });

    var { error } = await sb.from('bot_setup').upsert(setup, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
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
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Location ──────────────────────────────────────────────────
router.put('/client/location', async function(req, res) {
  try {
    var { location_address, location_maps_url } = req.body;
    await getSupabase().from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listings ──────────────────────────────────────────────────
router.get('/client/listings', async function(req, res) {
  try {
    var r = await getSupabase().from('service_listings').select('*, listing_media(*)').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', async function(req, res) {
  try {
    var { name, description, price, price_label, location, category, keywords, listing_type, available } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    var r = await getSupabase().from('service_listings').insert({ client_id: req.clientId, name, description: description||null, price: price||null, price_label: price_label||null, location: location||null, category: category||null, keywords: keywords||null, listing_type: listing_type||'product', available: available !== false }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','listing_type','available'];
    var update = { updated_at: new Date().toISOString() };
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var r = await getSupabase().from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/listings/:id', async function(req, res) {
  try {
    var allowed = ['name','description','price','price_label','location','category','keywords','listing_type','available'];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var r = await getSupabase().from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/listings/:id', async function(req, res) {
  try {
    await getSupabase().from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listing Media ─────────────────────────────────────────────
router.get('/client/listings/:id/media', async function(req, res) {
  try {
    var r = await getSupabase().from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(r.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', upload.single('file'), async function(req, res) {
  try {
    var sb = getSupabase();
    var mediaType = req.body.media_type || 'image';
    var publicUrl, origFilename;
    if (req.file) {
      var ext = req.file.originalname.split('.').pop().toLowerCase();
      var filename = req.clientId + '/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
      var up = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (up.error) throw new Error(up.error.message);
      publicUrl = sb.storage.from('forgebot-listings').getPublicUrl(filename).data.publicUrl;
      origFilename = req.file.originalname;
    } else {
      if (!req.body.url) return res.status(400).json({ error: 'file or url required' });
      publicUrl = req.body.url; origFilename = req.body.filename || null;
    }
    var r = await sb.from('listing_media').insert({ listing_id: req.params.id, client_id: req.clientId, url: publicUrl, media_type: mediaType, caption: req.body.caption||null, filename: origFilename, sort_order: parseInt(req.body.sort_order)||0 }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', async function(req, res) {
  try {
    await getSupabase().from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/upload', upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    var sb = getSupabase();
    var ext = req.file.originalname.split('.').pop().toLowerCase();
    var filename = req.clientId + '/' + Date.now() + '.' + ext;
    var r = await sb.storage.from('forgebot-listings').upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (r.error) throw new Error(r.error.message);
    res.json({ url: sb.storage.from('forgebot-listings').getPublicUrl(filename).data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── FAQ ───────────────────────────────────────────────────────
router.get('/client/faq', async function(req, res) {
  try { var r = await getSupabase().from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true }); res.json(r.data || []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    var r = await getSupabase().from('business_faq').insert({ client_id: req.clientId, question, answer, keywords: keywords||null, sort_order: sort_order||0 }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', async function(req, res) {
  try {
    var { question, answer, keywords, sort_order } = req.body;
    var update = {};
    if (question !== undefined) update.question = question;
    if (answer !== undefined) update.answer = answer;
    if (keywords !== undefined) update.keywords = keywords;
    if (sort_order !== undefined) update.sort_order = sort_order;
    var r = await getSupabase().from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', async function(req, res) {
  try { await getSupabase().from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Partner status ────────────────────────────────────────────
router.get('/client/partner-status', async function(req, res) {
  try {
    var r = await getSupabase().from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (r.error || !r.data) return res.json({ is_partner: false });
    var c = r.data; var now = new Date(); var exp = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    res.json({ is_partner: c.is_partner||false, expires_at: c.partner_expires_at||null, days_left: exp ? Math.ceil((exp-now)/86400000) : null, expired: exp ? exp < now : false, still_active: c.subscription_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/qualification-toggle', async function(req, res) {
  try {
    var sb = getSupabase();
    var current = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    var occData = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!req.body.enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!req.body.enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  NEW ROUTES v3 (dashboard additions)
// ══════════════════════════════════════════════════════════════

router.get('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();
    var clientRes = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (clientRes.error || !clientRes.data) return res.status(404).json({ error: 'Client not found' });
    var client = clientRes.data; delete client.password_hash;
    var setup = ((await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single()).data) || {};
    res.json({
      notification_number: client.notification_number||'', welcome_message: client.welcome_message||'',
      fallback_message: client.fallback_message||'', bank_name: client.bank_name||'',
      account_number: client.account_number||'', account_name: client.account_name||'', business_hours: client.business_hours||'',
      bot_setup: {
        instagram: setup.instagram||'', facebook: setup.facebook||'', tiktok: setup.tiktok||'', whatsapp_channel: setup.whatsapp_channel||'',
        delivery_areas: setup.service_areas||setup.delivery_areas||'', delivery_fee: setup.delivery_fee_local||'',
        delivery_time: setup.delivery_time_local||'', minimum_order: setup.minimum_order||'', return_policy: setup.return_policy||'',
        promo: setup.current_promo||'', payment_methods: Array.isArray(setup.payment_methods) ? setup.payment_methods.join(',') : (setup.payment_methods||''),
        post_schedule_days: setup.post_schedule_days||[], post_schedule_time: setup.post_schedule_time||'', post_include_memes: setup.post_include_memes !== false
      },
      is_partner: client.is_partner||false, partner_expires_at: client.partner_expires_at||null, subscription_active: client.subscription_active||false
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/session-status', function(req, res) {
  try { var sock = sessionManager.getSession(req.clientId); res.json({ connected: !!(sock), status: sock ? 'connected' : 'disconnected' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/orders', async function(req, res) {
  try { var r = await getSupabase().from('orders').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(100); res.json(r.data || []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/orders/:id', async function(req, res) {
  try {
    var allowed = ['status','payment_status','notes','delivery_address'];
    var update = { updated_at: new Date().toISOString() };
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var r = await getSupabase().from('orders').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/analytics', async function(req, res) {
  try {
    var month = req.query.month || (function(){ var n=new Date(); return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0'); })();
    var parts = month.split('-'); var sb = getSupabase();
    var start = month+'-01'; var end = new Date(parseInt(parts[0]), parseInt(parts[1]), 1).toISOString().split('T')[0];
    var custRes  = await sb.from('customers').select('id',{count:'exact',head:true}).eq('client_id',req.clientId).gte('created_at',start).lt('created_at',end);
    var ordRes   = await sb.from('orders').select('status,total').eq('client_id',req.clientId).gte('created_at',start).lt('created_at',end);
    var orders   = ordRes.data||[]; var conf = orders.filter(function(o){return ['confirmed','packaging','shipped','delivered'].includes(o.status);});
    var leadsRes = await sb.from('customers').select('id',{count:'exact',head:true}).eq('client_id',req.clientId).gte('last_contact',start).lt('last_contact',end);
    res.json({ new_customers: custRes.count||0, leads: leadsRes.count||0, orders_placed: orders.length, orders_confirmed: conf.length, total_revenue: conf.reduce(function(s,o){return s+(parseFloat(o.total)||0);},0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/broadcast-logs', async function(req, res) {
  try { var r = await getSupabase().from('broadcasts').select('*').eq('client_id', req.clientId).order('sent_at', { ascending: false }).limit(20); res.json(r.data || []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/broadcast', async function(req, res) {
  try {
    var { message, phones } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    var sock = sessionManager.getSession(req.clientId);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    var list = Array.isArray(phones) ? phones : (phones||'').split('\n').map(function(p){return p.trim();}).filter(Boolean);
    if (!list.length) return res.status(400).json({ error: 'No phone numbers provided' });
    var sent = 0;
    for (var i=0;i<list.length;i++) {
      try { await sock.sendMessage(list[i].replace(/\D/g,'')+'@s.whatsapp.net', {text:message}); sent++; await new Promise(function(r){setTimeout(r,1200);}); }
      catch(e) {}
    }
    await getSupabase().from('broadcasts').insert({ client_id: req.clientId, message, recipients: sent, sent_at: new Date().toISOString() });
    res.json({ sent, total: list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/bot-tasks', async function(req, res) {
  try { var r = await getSupabase().from('bot_tasks').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }); res.json(r.data || []); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/bot-tasks', async function(req, res) {
  try {
    var { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name||!message||!schedule_time||!schedule_days) return res.status(400).json({ error: 'name, message, schedule_time and schedule_days required' });
    var r = await getSupabase().from('bot_tasks').insert({ client_id: req.clientId, name, message, schedule_time, schedule_days, filter_type: filter_type||'all_customers', active: true, run_count: 0 }).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/bot-tasks/:id', async function(req, res) {
  try {
    var allowed = ['active','name','message','schedule_time','schedule_days','filter_type'];
    var update = {};
    allowed.forEach(function(k){if(req.body[k]!==undefined)update[k]=req.body[k];});
    var r = await getSupabase().from('bot_tasks').update(update).eq('id',req.params.id).eq('client_id',req.clientId).select().single();
    if (r.error) throw new Error(r.error.message);
    res.json(r.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/bot-tasks/:id', async function(req, res) {
  try { await getSupabase().from('bot_tasks').delete().eq('id',req.params.id).eq('client_id',req.clientId); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/client/post-schedule', async function(req, res) {
  try {
    var data = ((await getSupabase().from('bot_setup').select('post_schedule_days,post_schedule_time,post_include_memes').eq('client_id',req.clientId).single()).data)||{};
    res.json({ days: data.post_schedule_days||[], time: data.post_schedule_time||'', include_memes: data.post_include_memes !== false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/post-schedule', async function(req, res) {
  try {
    var { days, time, include_memes } = req.body;
    await getSupabase().from('bot_setup').upsert({ client_id: req.clientId, post_schedule_days: days||[], post_schedule_time: time||null, post_include_memes: include_memes !== false, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/push/subscribe', async function(req, res) {
  try {
    var { endpoint, keys } = req.body;
    if (!endpoint||!keys) return res.status(400).json({ error: 'endpoint and keys required' });
    await getSupabase().from('push_subscriptions').upsert({ client_id: req.clientId, subscription: JSON.stringify({endpoint,keys}), updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: true }); }
});

router.post('/client/push/test', function(req, res) { res.json({ ok: true }); });

module.exports = router;
