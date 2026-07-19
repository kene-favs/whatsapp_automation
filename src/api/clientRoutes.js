// ============================================================
//  ForgeBot — Client API Routes v2
//  File location: src/api/clientRoutes.js
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const webpush  = require('web-push');
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

// ── Configure web-push VAPID ──────────────────────────────────
(function setupVapid() {
  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (pub && priv) {
    try {
      webpush.setVapidDetails('mailto:support@forgebot.com', pub, priv);
    } catch (e) {
      console.warn('[ForgeBot] VAPID setup failed:', e.message);
    }
  }
})();

// ── Multer: memory storage for file uploads ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ── JWT auth middleware ───────────────────────────────────────
function auth(req, res, next) {
  try {
    const header  = req.headers.authorization || '';
    const token   = header.replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId  = decoded.clientId || decoded.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Partner expiry check ──────────────────────────────────────
async function checkPartnerExpiry(clientId) {
  try {
    const sb     = getSupabase();
    const result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', clientId).single();
    if (result.error || !result.data) return;
    const c = result.data;
    if (c.is_partner && c.partner_expires_at && c.subscription_active) {
      if (new Date(c.partner_expires_at) < new Date()) {
        await sb.from('clients').update({ subscription_active: false }).eq('id', clientId);
        await sb.from('partner_log').insert({ client_id: clientId, action: 'expired', note: 'Auto-expired on API request' });
      }
    }
  } catch (e) { /* non-fatal */ }
}

// ── Apply auth + partner check to all /client routes ─────────
router.use('/client', auth, async (req, res, next) => {
  await checkPartnerExpiry(req.clientId);
  next();
});

// ══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATION ROUTES (no auth required for vapid-key)
// ══════════════════════════════════════════════════════════════

// GET /api/push/vapid-key — returns public key for frontend
router.get('/push/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// POST /api/push/subscribe — save a push subscription
router.post('/push/subscribe', auth, async (req, res) => {
  try {
    const sb           = getSupabase();
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

    // Upsert subscription keyed on endpoint
    await sb.from('push_subscriptions').upsert({
      client_id:    req.clientId,
      endpoint:     subscription.endpoint,
      subscription: JSON.stringify(subscription),
      updated_at:   new Date().toISOString()
    }, { onConflict: 'endpoint' });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/push/send — send push to a specific client (admin use)
router.post('/push/send', auth, async (req, res) => {
  try {
    const sb      = getSupabase();
    const { title, body, url } = req.body;
    const result  = await sb.from('push_subscriptions').select('subscription').eq('client_id', req.clientId);
    const subs    = result.data || [];
    const payload = JSON.stringify({ title: title || 'ForgeBot', body: body || '', url: url || '/dashboard' });
    const sent    = [];

    for (const row of subs) {
      try {
        await webpush.sendNotification(JSON.parse(row.subscription), payload);
        sent.push(row.subscription);
      } catch (e) {
        if (e.statusCode === 410) {
          // Subscription expired — remove it
          await sb.from('push_subscriptions').delete().eq('subscription', row.subscription);
        }
      }
    }
    res.json({ ok: true, sent: sent.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  CORE CLIENT ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = result.data;
    const sock = sessionManager.getSession
      ? sessionManager.getSession(req.clientId)
      : (sessionManager.sessions ? sessionManager.sessions.get(req.clientId) : null);
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/flows
router.get('/client/flows', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('flows').select('*').eq('client_id', req.clientId).order('priority', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/flows
router.post('/client/flows', async (req, res) => {
  try {
    const { keywords, response, response_type, media_url } = req.body;
    if (!keywords || !response) return res.status(400).json({ error: 'keywords and response required' });
    const sb     = getSupabase();
    const result = await sb.from('flows').insert({
      client_id: req.clientId, flow_name: 'Custom', keywords,
      response_type: response_type || 'text', response, media_url: media_url || null, priority: 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/flows/:id
router.delete('/client/flows/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/status-posts
router.get('/client/status-posts', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('status_posts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    const posts  = (result.data || []).map(p => ({
      ...p,
      scheduled_time: p.scheduled_time || p.post_time || '',
      scheduled_days: p.scheduled_days || p.days || ''
    }));
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/status-posts
router.post('/client/status-posts', async (req, res) => {
  try {
    const { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    if (!mediaUrl || !scheduledTime || !scheduledDays) return res.status(400).json({ error: 'Missing fields' });
    const sb     = getSupabase();
    const result = await sb.from('status_posts').insert({
      client_id: req.clientId, caption: caption || null, media_url: mediaUrl,
      post_time: scheduledTime, scheduled_time: scheduledTime,
      days: scheduledDays,     scheduled_days: scheduledDays
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/client/status-posts/:id
router.delete('/client/status-posts/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/broadcasts
router.get('/client/broadcasts', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('broadcasts').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false }).limit(20);
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/client/broadcasts
router.post('/client/broadcasts', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const sock = sessionManager.getSession
      ? sessionManager.getSession(req.clientId)
      : (sessionManager.sessions ? sessionManager.sessions.get(req.clientId) : null);
    if (!sock) return res.status(400).json({ error: 'WhatsApp not connected' });
    const sb     = getSupabase();
    const result = await sb.from('customers').select('jid').eq('client_id', req.clientId).limit(200);
    const jids   = (result.data || []).map(c => c.jid);
    let sent = 0;
    for (const jid of jids) {
      try { await sock.sendMessage(jid, { text: message }); sent++; } catch (e) {}
      await new Promise(r => setTimeout(r, 1200));
    }
    await sb.from('broadcasts').insert({ client_id: req.clientId, message, recipients: sent });
    res.json({ sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/settings
router.put('/client/settings', async (req, res) => {
  try {
    const allowed = ['notification_number','business_name','bank_name','account_number','account_name','business_hours'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const sb     = getSupabase();
    const result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/fallback
router.put('/client/fallback', async (req, res) => {
  try {
    const { fallback_message } = req.body;
    if (!fallback_message) return res.status(400).json({ error: 'fallback_message required' });
    const sb     = getSupabase();
    const result = await sb.from('clients').update({ fallback_message }).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/client/qr-stream (SSE)
router.get('/client/qr-stream', async (req, res) => {
  let clientId;
  try {
    const decoded = jwt.verify(req.query.token, process.env.JWT_SECRET);
    clientId = decoded.clientId || decoded.id;
  } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  const existingSock = global.getSock && global.getSock(clientId);
  if (existingSock) { sendEvent('connected', { status: 'connected' }); res.end(); return; }

  const listeners = global.qrListeners.get(clientId) || [];
  listeners.push(sendEvent);
  global.qrListeners.set(clientId, listeners);

  await sessionManager.startSession(clientId, {
    onQR:          (qr) => { (global.qrListeners.get(clientId) || []).forEach(fn => { try { fn('qr', { qr }); } catch(e){} }); },
    onConnected:   ()   => { (global.qrListeners.get(clientId) || []).forEach(fn => { try { fn('connected', { status: 'connected' }); } catch(e){} }); global.qrListeners.delete(clientId); },
    onDisconnected:()   => { (global.qrListeners.get(clientId) || []).forEach(fn => { try { fn('disconnected', { status: 'disconnected' }); } catch(e){} }); }
  });

  req.on('close', () => {
    const all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(fn => fn !== sendEvent));
  });
});

// ══════════════════════════════════════════════════════════════
//  BOT SETUP / ONBOARDING
// ══════════════════════════════════════════════════════════════

// PUT /api/client/bot-setup
router.put('/client/bot-setup', async (req, res) => {
  try {
    const sb       = getSupabase();
    const clientId = req.clientId;
    const {
      occupation, occupation_data,
      availability_days, payment_methods, current_promo,
      instagram, facebook, tiktok, whatsapp_channel,
      service_areas, property_types, studio_location,
      advance_booking, deposit_required, home_service,
      return_policy, delivers_to, minimum_order,
      delivery_time_local, delivery_fee_local,
      session_duration, session_type, who_do_you_serve,
      free_consult, bulk_orders
    } = req.body;

    if (occupation) {
      await sb.from('clients').update({ occupation, occupation_data: occupation_data || {} }).eq('id', clientId);
    }

    const setup = {
      client_id:           clientId,
      availability_days,
      payment_methods,
      current_promo:       current_promo || null,
      instagram:           instagram     || null,
      facebook:            facebook      || null,
      tiktok:              tiktok        || null,
      whatsapp_channel:    whatsapp_channel || null,
      service_areas:       service_areas || property_types || null,
      studio_location:     studio_location  || null,
      advance_booking:     advance_booking  || null,
      deposit_required:    deposit_required || null,
      home_service:        home_service     || null,
      return_policy:       return_policy    || null,
      delivers_to:         delivers_to      || null,
      minimum_order:       minimum_order    || null,
      delivery_time_local: delivery_time_local || null,
      delivery_fee_local:  delivery_fee_local  || null,
      session_duration:    session_duration || session_type || null,
      who_do_you_serve:    who_do_you_serve || null,
      bulk_orders:         bulk_orders      || null,
      updated_at:          new Date().toISOString()
    };

    // Remove empty keys to avoid overwriting existing data
    Object.keys(setup).forEach(k => {
      if (k !== 'client_id' && (setup[k] === null || setup[k] === undefined || setup[k] === '')) delete setup[k];
    });

    const { error } = await sb.from('bot_setup').upsert(setup, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/occupation
router.put('/client/occupation', async (req, res) => {
  try {
    const { occupation, answers } = req.body;
    if (!occupation) return res.status(400).json({ error: 'occupation required' });
    const sb = getSupabase();
    await sb.from('clients').update({ occupation, occupation_data: answers || {} }).eq('id', req.clientId);
    await sb.from('bot_setup').upsert({ client_id: req.clientId, occupation_answers: answers || {}, updated_at: new Date().toISOString() }, { onConflict: 'client_id' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  SERVICE LISTINGS
// ══════════════════════════════════════════════════════════════

router.get('/client/listings', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('service_listings').select('*').eq('client_id', req.clientId).order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings', async (req, res) => {
  try {
    const { name, description, price, price_label, location, category, keywords } = req.body;
    if (!name || !keywords) return res.status(400).json({ error: 'name and keywords required' });
    const sb     = getSupabase();
    const result = await sb.from('service_listings').insert({
      client_id: req.clientId, name, description: description || null, price: price || null,
      price_label: price_label || null, location: location || null, category: category || null,
      keywords, available: true
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/listings/:id', async (req, res) => {
  try {
    const allowed = ['name','description','price','price_label','location','category','keywords','available'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const sb     = getSupabase();
    const result = await sb.from('service_listings').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/listings/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Listing media ─────────────────────────────────────────────
router.get('/client/listings/:id/media', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('listing_media').select('*').eq('listing_id', req.params.id).eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/listings/:id/media', async (req, res) => {
  try {
    const { url, media_type, caption, filename, sort_order } = req.body;
    if (!url || !media_type) return res.status(400).json({ error: 'url and media_type required' });
    const sb     = getSupabase();
    const result = await sb.from('listing_media').insert({
      listing_id: req.params.id, client_id: req.clientId, url, media_type,
      caption: caption || null, filename: filename || null, sort_order: sort_order || 0
    }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/media/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── File upload → Supabase Storage ───────────────────────────
router.post('/client/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const sb       = getSupabase();
    const ext      = req.file.originalname.split('.').pop().toLowerCase();
    const filename = req.clientId + '/' + Date.now() + '.' + ext;
    const bucket   = 'forgebot-listings';
    const result   = await sb.storage.from(bucket).upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    if (result.error) throw new Error(result.error.message);
    const urlResult = sb.storage.from(bucket).getPublicUrl(filename);
    res.json({ url: urlResult.data.publicUrl, filename: req.file.originalname });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  FAQ
// ══════════════════════════════════════════════════════════════

router.get('/client/faq', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('business_faq').select('*').eq('client_id', req.clientId).order('sort_order', { ascending: true });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/faq', async (req, res) => {
  try {
    const { question, answer, keywords, sort_order } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    const sb     = getSupabase();
    const result = await sb.from('business_faq').insert({ client_id: req.clientId, question, answer, keywords: keywords || null, sort_order: sort_order || 0 }).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/faq/:id', async (req, res) => {
  try {
    const update = {};
    ['question','answer','keywords','sort_order'].forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const sb     = getSupabase();
    const result = await sb.from('business_faq').update(update).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/faq/:id', async (req, res) => {
  try {
    const sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  MISC
// ══════════════════════════════════════════════════════════════

// GET /api/client/partner-status
router.get('/client/partner-status', async (req, res) => {
  try {
    const sb     = getSupabase();
    const result = await sb.from('clients').select('is_partner,partner_expires_at,subscription_active').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.json({ is_partner: false });
    const c         = result.data;
    const expiresAt = c.partner_expires_at ? new Date(c.partner_expires_at) : null;
    const daysLeft  = expiresAt ? Math.ceil((expiresAt - new Date()) / 86400000) : null;
    res.json({ is_partner: c.is_partner || false, expires_at: c.partner_expires_at || null, days_left: daysLeft, expired: expiresAt ? expiresAt < new Date() : false, still_active: c.subscription_active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/location
router.put('/client/location', async (req, res) => {
  try {
    const { location_address, location_maps_url } = req.body;
    const sb = getSupabase();
    await sb.from('clients').update({ location_address: location_address || null, location_maps_url: location_maps_url || null }).eq('id', req.clientId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', async (req, res) => {
  try {
    const { enabled } = req.body;
    const sb          = getSupabase();
    const current     = await sb.from('clients').select('occupation_data').eq('id', req.clientId).single();
    const occData     = (current.data && current.data.occupation_data) || {};
    occData.qualification_enabled = !!enabled;
    await sb.from('clients').update({ occupation_data: occData }).eq('id', req.clientId);
    res.json({ ok: true, qualification_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
