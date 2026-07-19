// ============================================================
//  ForgeBot — Client API Routes (complete)
//  File location: src/api/clientRoutes.js
//  Mounted at: /api  (app.use('/api', clientRoutes))
//
//  ⚠️  CRITICAL AUTH RULE:
//  Public routes (signup, login, payment callback, webhook, vapid-key)
//  must have NO auth middleware — they are called before a token exists.
//  All other /client/* routes use auth per-route.
//  NEVER use router.use('/client', auth) — that blocks signup.
// ============================================================

'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const sessionManager = require('../sessions/sessionManager');
const db = require('../db/supabase');

// ── Lazy Supabase init ────────────────────────────────────────
function getSupabase() {
  return db.getSupabase();
}

// ── Multer: memory storage for file uploads ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }  // 50 MB
});

// ── JWT auth middleware ───────────────────────────────────────
// Applied INDIVIDUALLY to routes that require login.
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

// ── Partner expiry auto-check ─────────────────────────────────
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

// ══════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — no auth required
//  These come FIRST and have no auth middleware.
// ══════════════════════════════════════════════════════════════

// POST /api/client/signup
router.post('/client/signup', async function(req, res) {
  try {
    var {
      full_name, business_name, business_type, whatsapp_number,
      notification_number, country,
      bank_name, account_number, account_name,
      email, password
    } = req.body;

    if (!full_name || !business_name || !email || !password || !whatsapp_number) {
      return res.status(400).json({ error: 'Required fields missing' });
    }

    var sb = getSupabase();

    // Check email uniqueness
    var existing = await sb.from('clients').select('id').eq('email', email.toLowerCase()).single();
    if (existing.data) return res.status(409).json({ error: 'Email already registered' });

    var hash = await bcrypt.hash(password, 10);

    var insert = await sb.from('clients').insert({
      full_name:           full_name,
      business_name:       business_name,
      business_type:       business_type || 'products',
      whatsapp_number:     whatsapp_number.replace(/\D/g, ''),
      notification_number: notification_number ? notification_number.replace(/\D/g, '') : null,
      country:             country || 'Nigeria',
      bank_name:           bank_name || null,
      account_number:      account_number || null,
      account_name:        account_name || null,
      email:               email.toLowerCase(),
      password_hash:       hash,
      status:              'active',
      subscription_active: false  // activated after payment
    }).select().single();

    if (insert.error) throw new Error(insert.error.message);

    var clientId = insert.data.id;
    var token    = jwt.sign({ clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({ token: token, clientId: clientId, business_name: business_name });
  } catch (e) {
    console.error('[signup]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/client/login
router.post('/client/login', async function(req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    var sb = getSupabase();
    var result = await sb.from('clients').select('*').eq('email', email.toLowerCase()).single();
    if (result.error || !result.data) return res.status(401).json({ error: 'Invalid credentials' });

    var client = result.data;
    var match  = await bcrypt.compare(password, client.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    var token = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: token, clientId: client.id, business_name: client.business_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/push/vapid-key  — public, needed before auth
router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── Flutterwave payment routes ────────────────────────────────

// POST /api/client/pay/flutterwave  — auth required (user is logged in to initiate)
router.post('/client/pay/flutterwave', auth, async function(req, res) {
  try {
    var Flutterwave = require('flutterwave-node-v3');
    var flw = new Flutterwave(process.env.FLW_PUBLIC_KEY, process.env.FLW_SECRET_KEY);

    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Client not found' });
    var client = result.data;

    var reference = 'FGB-' + req.clientId.slice(0,8) + '-' + Date.now();

    await sb.from('payments').insert({
      client_id:    req.clientId,
      payment_type: 'subscription',
      amount:       9900,
      currency:     'NGN',
      provider:     'flutterwave',
      reference:    reference
    });

    var payload = {
      tx_ref:        reference,
      amount:        '9900',
      currency:      'NGN',
      redirect_url:  (process.env.APP_URL || '') + '/api/client/pay/callback',
      customer:      { email: client.email, name: client.business_name || client.full_name },
      customizations:{ title: 'ForgeBot Subscription', logo: (process.env.APP_URL || '') + '/icons/icon-192.png' }
    };

    if (process.env.FLW_MONTHLY_PLAN_ID) {
      payload.payment_plan = process.env.FLW_MONTHLY_PLAN_ID;
    }

    var response = await flw.Charge.card(payload);
    if (response.status === 'success') {
      return res.json({ paymentLink: response.data.link || response.meta.authorization.redirect });
    }
    throw new Error(response.message || 'Payment initiation failed');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/pay/callback  — Flutterwave redirect after payment (NO auth)
router.get('/client/pay/callback', async function(req, res) {
  try {
    var { transaction_id, tx_ref, status } = req.query;
    if (status !== 'successful' || !transaction_id) {
      return res.redirect('/?payment=failed');
    }

    var axios = require('axios');
    var verify = await axios.get(
      'https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify',
      { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } }
    );

    if (verify.data.status === 'success' && verify.data.data.status === 'successful') {
      var sb = getSupabase();
      var pmtResult = await sb.from('payments').select('client_id').eq('reference', tx_ref).single();
      if (pmtResult.data) {
        var clientId = pmtResult.data.client_id;
        await sb.from('clients').update({ subscription_active: true }).eq('id', clientId);
        await sb.from('payments').update({ status: 'paid' }).eq('reference', tx_ref);

        // Generate JWT so user lands on dashboard
        var token = jwt.sign({ clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
        return res.redirect('/onboard?token=' + token);
      }
    }
    res.redirect('/?payment=failed');
  } catch (e) {
    console.error('[payment callback]', e.message);
    res.redirect('/?payment=error');
  }
});

// POST /api/client/pay/webhook  — Flutterwave server webhook (NO auth)
router.post('/client/pay/webhook', async function(req, res) {
  try {
    var hash = req.headers['verif-hash'];
    if (hash !== process.env.FLW_HASH) return res.status(401).json({ error: 'Invalid hash' });

    var event = req.body;
    if (event.event === 'charge.completed' && event.data && event.data.status === 'successful') {
      var tx_ref = event.data.tx_ref;
      var sb     = getSupabase();
      var pmtRes = await sb.from('payments').select('client_id').eq('reference', tx_ref).single();
      if (pmtRes.data) {
        await sb.from('clients').update({ subscription_active: true }).eq('id', pmtRes.data.client_id);
        await sb.from('payments').update({ status: 'paid' }).eq('reference', tx_ref);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  AUTHENTICATED ROUTES — auth middleware on every route
// ══════════════════════════════════════════════════════════════

// GET /api/client/me
router.get('/client/me', auth, async function(req, res) {
  try {
    await checkPartnerExpiry(req.clientId);
    var sb     = getSupabase();
    var result = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Not found' });
    var client = result.data;
    var sock   = sessionManager.getSession ? sessionManager.getSession(req.clientId)
               : (sessionManager.sessions ? sessionManager.sessions[req.clientId] : null);
    var { password_hash, ...safe } = client;
    safe.whatsapp_status = sock ? 'connected' : 'disconnected';
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Auto-Reply Flows ──────────────────────────────────────────

router.get('/client/flows', auth, async function(req, res) {
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

router.post('/client/flows', auth, async function(req, res) {
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

router.delete('/client/flows/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('flows').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Status Posts ──────────────────────────────────────────────

router.get('/client/status-posts', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('status_posts')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    // Normalise column names for dashboard compatibility
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

router.post('/client/status-posts', auth, async function(req, res) {
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

router.delete('/client/status-posts/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('status_posts').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Broadcasts ────────────────────────────────────────────────

router.get('/client/broadcasts', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('broadcast_logs')
      .select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false })
      .limit(20);
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/broadcasts', auth, async function(req, res) {
  try {
    var { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    var sock = sessionManager.getSession ? sessionManager.getSession(req.clientId) : null;
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
        console.error('[broadcast] failed for', jids[i]);
      }
    }

    await sb.from('broadcast_logs').insert({ client_id: req.clientId, message: message, recipients: sent });
    res.json({ sent: sent, total: jids.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Settings ──────────────────────────────────────────────────

// PUT /api/client/settings — saves client-level settings
router.put('/client/settings', auth, async function(req, res) {
  try {
    var allowed = [
      'notification_number', 'business_name', 'bank_name',
      'account_number', 'account_name', 'business_hours',
      'welcome_message', 'fallback_message', 'business_type'
    ];
    var update = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    var sb     = getSupabase();
    var result = await sb.from('clients').update(update).eq('id', req.clientId).select().single();
    if (result.error) throw new Error(result.error.message);
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/fallback — backwards compatibility
router.put('/client/fallback', auth, async function(req, res) {
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

// ── Bot Setup / Questionnaire ─────────────────────────────────

// PUT /api/client/bot-setup — saves questionnaire from onboard.html
router.put('/client/bot-setup', auth, async function(req, res) {
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
      availability_days:  availability_days || null,
      payment_methods:    payment_methods || null,
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

    // Remove nulls to avoid overwriting existing data
    Object.keys(setup).forEach(function(k) {
      if ((setup[k] === null || setup[k] === undefined || setup[k] === '') && k !== 'client_id') {
        delete setup[k];
      }
    });

    var { error } = await sb.from('bot_setup').upsert(setup, { onConflict: 'client_id' });
    if (error) throw new Error(error.message);

    // Mark setup as completed
    await sb.from('clients').update({ setup_completed: true }).eq('id', clientId);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/bot-setup — gets questionnaire answers for Settings tab
router.get('/client/bot-setup', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    if (result.error && result.error.code === 'PGRST116') return res.json({});
    if (result.error) throw new Error(result.error.message);
    res.json(result.data || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/occupation
router.put('/client/occupation', auth, async function(req, res) {
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

router.put('/client/location', auth, async function(req, res) {
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

router.get('/client/listings', auth, async function(req, res) {
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

router.post('/client/listings', auth, async function(req, res) {
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

router.patch('/client/listings/:id', auth, async function(req, res) {
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

router.delete('/client/listings/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('service_listings').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Listing Media ─────────────────────────────────────────────

router.get('/client/listings/:id/media', auth, async function(req, res) {
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

router.post('/client/listings/:id/media', auth, async function(req, res) {
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

router.delete('/client/media/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('listing_media').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── File Upload → Supabase Storage ───────────────────────────

router.post('/client/upload', auth, upload.single('file'), async function(req, res) {
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

// ── Business FAQ ──────────────────────────────────────────────

router.get('/client/faq', auth, async function(req, res) {
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

router.post('/client/faq', auth, async function(req, res) {
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

router.patch('/client/faq/:id', auth, async function(req, res) {
  try {
    var update = {};
    ['question','answer','keywords','sort_order'].forEach(function(k) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });
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

router.delete('/client/faq/:id', auth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('business_faq').delete().eq('id', req.params.id).eq('client_id', req.clientId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Partner / Trial Status ────────────────────────────────────

router.get('/client/partner-status', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('is_partner,partner_expires_at,subscription_active')
      .eq('id', req.clientId).single();
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

// PUT /api/client/qualification-toggle
router.put('/client/qualification-toggle', auth, async function(req, res) {
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

// ── WhatsApp QR Stream (SSE) ──────────────────────────────────

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
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (!global.qrListeners) global.qrListeners = new Map();

  function sendEvent(event, data) {
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch(e) {}
  }

  var existingSock = sessionManager.getSession ? sessionManager.getSession(clientId) : null;
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
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { fn('qr', { qr: qr }); });
    },
    onConnected: function() {
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { fn('connected', { status: 'connected' }); });
      global.qrListeners.delete(clientId);
    },
    onDisconnected: function() {
      (global.qrListeners.get(clientId) || []).forEach(function(fn) { fn('disconnected', { status: 'disconnected' }); });
    }
  });

  req.on('close', function() {
    var all = global.qrListeners.get(clientId) || [];
    global.qrListeners.set(clientId, all.filter(function(fn) { return fn !== sendEvent; }));
  });
});

// ══════════════════════════════════════════════════════════════
//  ORDERS — customer orders + payment confirmation + delivery
// ══════════════════════════════════════════════════════════════

// GET /api/client/orders  — list all orders (optionally filter by status)
router.get('/client/orders', auth, async function(req, res) {
  try {
    var { status } = req.query;
    var sb     = getSupabase();
    var q      = sb.from('orders').select('*').eq('client_id', req.clientId);
    if (status) q = q.eq('status', status);
    var result = await q.order('created_at', { ascending: false }).limit(100);
    res.json(result.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/client/orders/:id  — single order detail
router.get('/client/orders/:id', auth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('orders').select('*').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (result.error || !result.data) return res.status(404).json({ error: 'Order not found' });
    res.json(result.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/client/orders/:id  — update order status + notify customer via WhatsApp
router.put('/client/orders/:id', auth, async function(req, res) {
  try {
    var { status, notes } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    var sb = getSupabase();

    // Get order (verify it belongs to this client)
    var orderResult = await sb.from('orders').select('*').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (orderResult.error || !orderResult.data) return res.status(404).json({ error: 'Order not found' });
    var order = orderResult.data;

    // Map status to payment_status if needed
    var update = { status: status, updated_at: new Date().toISOString() };
    if (notes) update.notes = notes;
    if (status === 'confirmed') update.payment_status = 'confirmed';
    if (status === 'rejected')  update.payment_status = 'rejected';

    await sb.from('orders').update(update).eq('id', req.params.id);

    // Get client for bot name
    var clientResult = await sb.from('clients').select('business_name,notification_number').eq('id', req.clientId).single();
    var bizName      = clientResult.data ? (clientResult.data.business_name || 'us') : 'us';

    // Send WhatsApp message to customer
    var sock = sessionManager.getSession ? sessionManager.getSession(req.clientId) : null;
    if (sock && order.customer_jid) {
      var custName = order.customer_name || 'there';
      var message  = null;

      if (status === 'confirmed') {
        message =
          '✅ Great news *' + custName + '*! Your payment has been *confirmed*. 🎉\n\n' +
          'Do you need delivery? If yes, please type your *full delivery address* so we can send your order to you. 📍\n\n' +
          '(Reply *"pickup"* if you want to collect it yourself.)';
      } else if (status === 'rejected') {
        message =
          'Hi *' + custName + '*, we could not verify your payment. 🙏\n\n' +
          'Please check and resend your receipt, or contact us for help.';
      } else if (status === 'packaging' || status === 'preparing') {
        message =
          '📦 Hi *' + custName + '*! Great news — your order is now being *prepared and packaged* for you!\n\n' +
          'We\'ll notify you as soon as it\'s on its way. 🚀';
      } else if (status === 'shipped' || status === 'out_for_delivery') {
        message =
          '🚚 *' + custName + '*, your order is *on its way*!\n\n' +
          'Your package is out for delivery now. You\'ll receive it soon. Thank you for shopping with *' + bizName + '*! ❤️';
      } else if (status === 'delivered') {
        message =
          '✅ *' + custName + '*, your order has been *delivered*! 🎉\n\n' +
          'We hope you love it! If you have any issues, please don\'t hesitate to reach out. Thank you for choosing *' + bizName + '*! 🙏';
      }

      if (message) {
        try {
          await sock.sendMessage(order.customer_jid, { text: message });
        } catch (e) {
          console.error('[orders] WhatsApp notify failed:', e.message);
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Analytics ─────────────────────────────────────────────────

// GET /api/client/analytics?month=YYYY-MM
router.get('/client/analytics', auth, async function(req, res) {
  try {
    var month = req.query.month;
    if (!month) {
      var now = new Date();
      month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    var stats = await db.getMonthlyStats(req.clientId, month);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Products ──────────────────────────────────────────────────

router.get('/client/products', auth, async function(req, res) {
  try {
    var products = await db.getProducts(req.clientId);
    res.json(products);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/products', auth, async function(req, res) {
  try {
    var { name, price, description, image_url } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price required' });
    var product = await db.addProduct(req.clientId, name, price, description, image_url);
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/client/products/:id', auth, async function(req, res) {
  try {
    var product = await db.updateProduct(req.params.id, req.body);
    res.json(product);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/products/:id', auth, async function(req, res) {
  try {
    await db.deleteProduct(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Services ──────────────────────────────────────────────────

router.get('/client/services', auth, async function(req, res) {
  try {
    var services = await db.getServices(req.clientId);
    res.json(services);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/client/services', auth, async function(req, res) {
  try {
    var { name, price, description, duration } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price required' });
    var service = await db.addService(req.clientId, name, price, description, duration);
    res.json(service);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/client/services/:id', auth, async function(req, res) {
  try {
    await db.deleteService(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Push Notifications ────────────────────────────────────────

router.post('/push/subscribe', auth, async function(req, res) {
  try {
    var { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: 'subscription data required' });
    await db.savePushSubscription(req.clientId, endpoint, keys.p256dh, keys.auth);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/push/test', auth, async function(req, res) {
  try {
    webpush.setVapidDetails(
      'mailto:support@forgebot.ng',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    var subs = await db.getPushSubscriptions(req.clientId);
    if (!subs.length) return res.status(400).json({ error: 'No push subscriptions found' });
    for (var s of subs) {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: 'ForgeBot', body: 'Push notifications are working!' })
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
