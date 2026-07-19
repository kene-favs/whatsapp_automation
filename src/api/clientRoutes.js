// ============================================================
//  ForgeBot — Client API Routes
//  File location: src/routes/clientRoutes.js
//
//  ⚠️  CRITICAL: Auth middleware is applied PER-ROUTE.
//      NEVER use router.use('/client', auth) — that blocks
//      signup and login which must remain public.
// ============================================================

'use strict';

const express    = require('express');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const multer     = require('multer');
const axios      = require('axios');
const webpush    = require('web-push');
const router     = express.Router();
const db         = require('../db/supabase');
const { sessions } = require('../sessions/sessionManager');

// ── Multer (in-memory uploads) ────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId  = payload.id || payload.clientId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Partner expiry guard (soft block) ────────────────────────
async function checkPartnerExpiry(clientId) {
  try {
    const client = await db.getClientById(clientId);
    if (!client) return;
    if (client.trial_ends_at && new Date(client.trial_ends_at) < new Date() && !client.subscription_active) {
      // Soft expiry — just log, don't hard block (can be upgraded later)
      console.log('[PartnerExpiry] Client', clientId, 'trial expired. Status:', client.status);
    }
  } catch (e) {
    // Non-fatal
  }
}

// ── Session helper ────────────────────────────────────────────
function getSessionSock(clientId) {
  if (sessions && typeof sessions.get === 'function') return sessions.get(clientId);
  if (sessions && typeof sessions === 'object')        return sessions[clientId];
  return null;
}

// ── WhatsApp send helper ──────────────────────────────────────
async function sendWhatsApp(clientId, phone, message) {
  const sock = getSessionSock(clientId);
  if (!sock) return;
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: message });
}

// ── Status update message builder ────────────────────────────
function buildStatusMessage(order, newStatus, bizName) {
  const statusMessages = {
    confirmed:  '✅ Great news! Your order has been *confirmed*.',
    packaging:  '📦 Your order is now being *packaged*.',
    shipped:    '🚚 Your order has been *shipped* and is on its way!',
    delivered:  '🎉 Your order has been *delivered*! Thank you for shopping with us.',
    rejected:   '❌ Unfortunately, we could not process your order. Please contact us for details.'
  };
  return (
    '🛍 *Order Update — ' + (bizName || 'ForgeBot') + '*\n\n' +
    (statusMessages[newStatus] || 'Your order status has been updated to: ' + newStatus) +
    '\n\nOrder ref: ' + (order.id || '').toString().slice(-8).toUpperCase() +
    (order.total ? '\nTotal: ₦' + Number(order.total).toLocaleString() : '') +
    '\n\nThank you for your business! 🙏'
  );
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES — NO AUTH REQUIRED
// ════════════════════════════════════════════════════════════════

// ── POST /client/signup ───────────────────────────────────────
router.post('/client/signup', async function(req, res) {
  try {
    const { email, password, business_name, phone, occupation, business_type } = req.body;
    if (!email || !password || !business_name) {
      return res.status(400).json({ error: 'email, password, business_name required' });
    }
    const existing = await db.getClientByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hash   = await bcrypt.hash(password, 10);
    const client = await db.createClient_({
      email, password_hash: hash, business_name,
      phone: phone || null,
      occupation: occupation || null,
      business_type: business_type || 'both',
      status: 'active',
      subscription_active: true,  // starts trial
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    });

    const token = jwt.sign({ id: client.id }, process.env.JWT_SECRET, { expiresIn: '90d' });
    return res.json({ token, client: { id: client.id, email: client.email, business_name: client.business_name, occupation: client.occupation, business_type: client.business_type } });
  } catch (err) {
    console.error('[Signup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/login ────────────────────────────────────────
router.post('/client/login', async function(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const client = await db.getClientByEmail(email);
    if (!client) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, client.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: client.id }, process.env.JWT_SECRET, { expiresIn: '90d' });
    return res.json({ token, client: { id: client.id, email: client.email, business_name: client.business_name, occupation: client.occupation, business_type: client.business_type, subscription_active: client.subscription_active } });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /push/vapid-key ───────────────────────────────────────
router.get('/push/vapid-key', function(req, res) {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ── GET /client/pay/callback — Flutterwave redirect ──────────
router.get('/client/pay/callback', async function(req, res) {
  try {
    const { transaction_id, tx_ref } = req.query;
    if (!transaction_id || !tx_ref) return res.redirect('/dashboard?pay=failed');

    const verifyRes = await axios.get(
      'https://api.flutterwave.com/v3/transactions/' + transaction_id + '/verify',
      { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } }
    );
    const tx = verifyRes.data && verifyRes.data.data;
    if (!tx || tx.status !== 'successful') return res.redirect('/dashboard?pay=failed');

    const payment = await db.getPaymentByReference(tx_ref);
    if (payment && payment.status !== 'completed') {
      await db.updatePaymentStatus(tx_ref, 'completed');
      await db.updateClient(payment.client_id, { subscription_active: true });
    }
    return res.redirect('/dashboard?pay=success');
  } catch (err) {
    console.error('[Pay callback] Error:', err.message);
    return res.redirect('/dashboard?pay=error');
  }
});

// ── POST /client/pay/webhook — Flutterwave webhook ───────────
router.post('/client/pay/webhook', async function(req, res) {
  try {
    const hash = req.headers['verif-hash'];
    if (hash !== process.env.FLW_HASH) return res.sendStatus(401);
    const { event, data } = req.body;
    if (event === 'charge.completed' && data.status === 'successful') {
      const payment = await db.getPaymentByReference(data.tx_ref);
      if (payment && payment.status !== 'completed') {
        await db.updatePaymentStatus(data.tx_ref, 'completed');
        await db.updateClient(payment.client_id, { subscription_active: true });
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Pay webhook] Error:', err.message);
    return res.sendStatus(500);
  }
});

// ════════════════════════════════════════════════════════════════
//  PROTECTED ROUTES — AUTH REQUIRED PER ROUTE
// ════════════════════════════════════════════════════════════════

// ── GET /client/me ────────────────────────────────────────────
router.get('/client/me', auth, async function(req, res) {
  try {
    const client = await db.getClientWithSetup(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    await checkPartnerExpiry(req.clientId);
    return res.json(client);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/pay/flutterwave — initiate subscription ─────
router.post('/client/pay/flutterwave', auth, async function(req, res) {
  try {
    const client    = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const ref       = 'fb_' + req.clientId.slice(0, 8) + '_' + Date.now();
    await db.createPayment(req.clientId, 'subscription', 5000, 'NGN', 'flutterwave', ref);
    const payload   = {
      tx_ref:       ref,
      amount:       5000,
      currency:     'NGN',
      redirect_url: (process.env.APP_URL || '') + '/api/client/pay/callback',
      customer: { email: client.email, name: client.business_name, phonenumber: client.phone || '' },
      customizations: { title: 'ForgeBot Subscription', logo: '' },
      payment_plan: process.env.FLW_MONTHLY_PLAN_ID || undefined
    };
    const flwRes = await axios.post('https://api.flutterwave.com/v3/payments', payload,
      { headers: { Authorization: 'Bearer ' + process.env.FLW_SECRET_KEY } });
    return res.json({ link: flwRes.data.data.link });
  } catch (err) {
    console.error('[Pay init] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/qr-stream — SSE stream of WhatsApp QR ────────
router.get('/client/qr-stream', auth, function(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { startSession } = require('../sessions/sessionManager');
  const clientId = req.clientId;
  let closed = false;

  function send(event, data) {
    if (!closed) res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  startSession(clientId, {
    onQR: function(qr) { send('qr', { qr: qr }); },
    onConnected: function() {
      send('connected', { message: 'WhatsApp connected!' });
      if (!closed) { closed = true; res.end(); }
    },
    onError: function(err) { send('error', { message: err.message || err }); }
  });

  req.on('close', function() { closed = true; });
});

// ── GET /client/session-status ────────────────────────────────
router.get('/client/session-status', auth, async function(req, res) {
  try {
    const sock = getSessionSock(req.clientId);
    return res.json({ connected: !!sock, clientId: req.clientId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/flows ─────────────────────────────────────────
router.get('/client/flows', auth, async function(req, res) {
  try {
    await checkPartnerExpiry(req.clientId);
    const flows = await db.getFlows(req.clientId, false);
    return res.json(flows || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/flows ────────────────────────────────────────
router.post('/client/flows', auth, async function(req, res) {
  try {
    const { flow_name, keywords, response_type, response, media_url, priority } = req.body;
    if (!flow_name || !keywords || !response) return res.status(400).json({ error: 'flow_name, keywords, response required' });
    const flow = await db.addFlow(req.clientId, flow_name, keywords, response_type || 'text', response, media_url || null, priority || 0);
    return res.json(flow);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /client/flows/:id ──────────────────────────────────
router.delete('/client/flows/:id', auth, async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/status-posts ──────────────────────────────────
router.get('/client/status-posts', auth, async function(req, res) {
  try {
    const posts = await db.getStatusPosts(req.clientId);
    return res.json(posts || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/status-posts ─────────────────────────────────
router.post('/client/status-posts', auth, async function(req, res) {
  try {
    const { caption, media_url, post_time, repeat_daily } = req.body;
    if (!caption || !post_time) return res.status(400).json({ error: 'caption and post_time required' });
    const post = await db.addStatusPost(req.clientId, caption, media_url || null, post_time, repeat_daily !== false);
    return res.json(post);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── DELETE /client/status-posts/:id ──────────────────────────
router.delete('/client/status-posts/:id', auth, async function(req, res) {
  try {
    await db.deleteStatusPost(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/broadcast ────────────────────────────────────
router.post('/client/broadcast', auth, async function(req, res) {
  try {
    const { message, phones } = req.body;
    if (!message || !Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ error: 'message and phones[] required' });
    }
    const sock = getSessionSock(req.clientId);
    if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' });

    let sent = 0;
    for (const phone of phones) {
      try {
        await sendWhatsApp(req.clientId, phone, message);
        sent++;
        await new Promise(function(r) { setTimeout(r, 1500); });
      } catch (e) {
        console.error('[Broadcast] Failed for', phone, e.message);
      }
    }
    await db.logBroadcast(req.clientId, message, phones);
    return res.json({ sent, total: phones.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/broadcast-logs ────────────────────────────────
router.get('/client/broadcast-logs', auth, async function(req, res) {
  try {
    const logs = await db.getBroadcastLogs(req.clientId);
    return res.json(logs || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/settings ──────────────────────────────────────
router.get('/client/settings', auth, async function(req, res) {
  try {
    const client   = await db.getClientById(req.clientId);
    const botSetup = await db.getBotSetup(req.clientId);
    return res.json({ ...client, bot_setup: botSetup });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /client/settings ──────────────────────────────────────
router.put('/client/settings', auth, async function(req, res) {
  try {
    const allowed = ['business_name', 'phone', 'notification_number', 'welcome_message', 'fallback_message', 'bank_name', 'account_number', 'account_name', 'business_hours'];
    const updates = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
    const client = await db.updateClient(req.clientId, updates);
    return res.json(client);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /client/bot-setup ─────────────────────────────────────
router.put('/client/bot-setup', auth, async function(req, res) {
  try {
    await db.upsertBotSetup(req.clientId, req.body);
    const setup = await db.getBotSetup(req.clientId);
    return res.json(setup);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/bot-setup ─────────────────────────────────────
router.get('/client/bot-setup', auth, async function(req, res) {
  try {
    const setup = await db.getBotSetup(req.clientId);
    return res.json(setup);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/fallback ──────────────────────────────────────
router.get('/client/fallback', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    return res.json({ fallback_message: client.fallback_message });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /client/fallback ──────────────────────────────────────
router.put('/client/fallback', auth, async function(req, res) {
  try {
    const client = await db.updateClient(req.clientId, { fallback_message: req.body.fallback_message });
    return res.json({ fallback_message: client.fallback_message });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/occupation ────────────────────────────────────
router.get('/client/occupation', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    return res.json({ occupation: client.occupation, business_type: client.business_type });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /client/occupation ────────────────────────────────────
router.put('/client/occupation', auth, async function(req, res) {
  try {
    const { occupation, business_type } = req.body;
    const client = await db.updateClient(req.clientId, { occupation, business_type });
    return res.json({ occupation: client.occupation, business_type: client.business_type });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/location ──────────────────────────────────────
router.get('/client/location', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    return res.json({ city: client.city, state: client.state, country: client.country });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUT /client/location ──────────────────────────────────────
router.put('/client/location', auth, async function(req, res) {
  try {
    const { city, state, country } = req.body;
    const client = await db.updateClient(req.clientId, { city, state, country });
    return res.json({ city: client.city, state: client.state, country: client.country });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/qualification ─────────────────────────────────
router.get('/client/qualification', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    return res.json({ qualification_complete: client.qualification_complete });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /client/qualification-toggle ────────────────────────
router.post('/client/qualification-toggle', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    const toggled = await db.updateClient(req.clientId, { qualification_complete: !client.qualification_complete });
    return res.json({ qualification_complete: toggled.qualification_complete });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /client/partner-status ────────────────────────────────
router.get('/client/partner-status', auth, async function(req, res) {
  try {
    const client = await db.getClientById(req.clientId);
    return res.json({
      status: client.status,
      subscription_active: client.subscription_active,
      trial_ends_at: client.trial_ends_at
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PRODUCTS CRUD ─────────────────────────────────────────────

router.get('/client/products', auth, async function(req, res) {
  try {
    const products = await db.getProducts(req.clientId);
    return res.json(products);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/client/products', auth, async function(req, res) {
  try {
    const { name, price, description, image_url } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price required' });
    const product = await db.addProduct(req.clientId, name, price, description || '', image_url || null);
    return res.json(product);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/client/products/:id', auth, async function(req, res) {
  try {
    const product = await db.updateProduct(req.params.id, req.body);
    return res.json(product);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/client/products/:id', auth, async function(req, res) {
  try {
    await db.deleteProduct(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── SERVICES CRUD ─────────────────────────────────────────────

router.get('/client/services', auth, async function(req, res) {
  try {
    const services = await db.getServices(req.clientId);
    return res.json(services);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/client/services', auth, async function(req, res) {
  try {
    const { name, price, description, duration } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'name and price required' });
    const service = await db.addService(req.clientId, name, price, description || '', duration || null);
    return res.json(service);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/client/services/:id', auth, async function(req, res) {
  try {
    await db.deleteService(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── LISTINGS CRUD ─────────────────────────────────────────────

router.get('/client/listings', auth, async function(req, res) {
  try {
    const { data, error } = await db.getSupabase()
      .from('service_listings').select('*, listing_media(*)')
      .eq('client_id', req.clientId).order('created_at', { ascending: false });
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/client/listings', auth, async function(req, res) {
  try {
    const { title, description, price, category, tags } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const { data, error } = await db.getSupabase().from('service_listings')
      .insert([{ client_id: req.clientId, title, description, price, category, tags, active: true }])
      .select().single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/client/listings/:id', auth, async function(req, res) {
  try {
    const { data, error } = await db.getSupabase().from('service_listings')
      .update(req.body).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/client/listings/:id', auth, async function(req, res) {
  try {
    const { error } = await db.getSupabase().from('service_listings')
      .delete().eq('id', req.params.id).eq('client_id', req.clientId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── LISTING MEDIA ─────────────────────────────────────────────

router.post('/client/listings/:id/media', auth, upload.single('file'), async function(req, res) {
  try {
    const { type, url } = req.body;
    let mediaUrl = url || null;

    if (req.file) {
      const ext      = req.file.originalname.split('.').pop() || 'jpg';
      const path     = 'listings/' + req.clientId + '/' + req.params.id + '/' + Date.now() + '.' + ext;
      const { data: upData, error: upErr } = await db.getSupabase().storage
        .from('forgebot-listings').upload(path, req.file.buffer, { contentType: req.file.mimetype });
      if (upErr) throw upErr;
      const { data: urlData } = db.getSupabase().storage.from('forgebot-listings').getPublicUrl(path);
      mediaUrl = urlData.publicUrl;
    }

    if (!mediaUrl) return res.status(400).json({ error: 'file or url required' });

    const { data, error } = await db.getSupabase().from('listing_media')
      .insert([{ listing_id: req.params.id, type: type || 'image', url: mediaUrl }]).select().single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/client/listings/:id/media/:mediaId', auth, async function(req, res) {
  try {
    const { error } = await db.getSupabase().from('listing_media').delete().eq('id', req.params.mediaId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── FAQ CRUD ─────────────────────────────────────────────────

router.get('/client/faq', auth, async function(req, res) {
  try {
    const { data, error } = await db.getSupabase()
      .from('business_faq').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/client/faq', auth, async function(req, res) {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
    const { data, error } = await db.getSupabase().from('business_faq')
      .insert([{ client_id: req.clientId, question, answer }]).select().single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.put('/client/faq/:id', auth, async function(req, res) {
  try {
    const { data, error } = await db.getSupabase().from('business_faq')
      .update(req.body).eq('id', req.params.id).eq('client_id', req.clientId).select().single();
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/client/faq/:id', auth, async function(req, res) {
  try {
    const { error } = await db.getSupabase().from('business_faq')
      .delete().eq('id', req.params.id).eq('client_id', req.clientId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── FILE UPLOAD (receipt images, etc.) ───────────────────────
router.post('/client/upload', auth, upload.single('file'), async function(req, res) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const ext    = req.file.originalname.split('.').pop() || 'jpg';
    const folder = req.body.folder || 'receipts';
    const path   = folder + '/' + req.clientId + '/' + Date.now() + '.' + ext;
    const bucket = folder === 'receipts' ? 'forgebot-receipts' : 'forgebot-listings';
    const { error: upErr } = await db.getSupabase().storage
      .from(bucket).upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (upErr) throw upErr;
    const { data: urlData } = db.getSupabase().storage.from(bucket).getPublicUrl(path);
    return res.json({ url: urlData.publicUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── ORDERS ────────────────────────────────────────────────────

// GET /client/orders — list orders (optionally filter by status)
router.get('/client/orders', auth, async function(req, res) {
  try {
    const { status } = req.query;
    const orders = await db.getOrders(req.clientId, status || null);
    return res.json(orders || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /client/orders/:id — single order
router.get('/client/orders/:id', auth, async function(req, res) {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order || order.client_id !== req.clientId) return res.status(404).json({ error: 'Order not found' });
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PUT /client/orders/:id — update order status + notify customer via WhatsApp
router.put('/client/orders/:id', auth, async function(req, res) {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order || order.client_id !== req.clientId) return res.status(404).json({ error: 'Order not found' });

    const { status, payment_status, notes, delivery_address } = req.body;
    const updates = {};
    if (status          !== undefined) updates.status          = status;
    if (payment_status  !== undefined) updates.payment_status  = payment_status;
    if (notes           !== undefined) updates.notes           = notes;
    if (delivery_address !== undefined) updates.delivery_address = delivery_address;

    // Map legacy actions to status
    if (req.body.action === 'confirm')  { updates.status = 'confirmed';  updates.payment_status = 'confirmed'; }
    if (req.body.action === 'reject')   { updates.status = 'rejected'; }
    if (req.body.action === 'ship')     { updates.status = 'shipped'; }
    if (req.body.action === 'deliver')  { updates.status = 'delivered'; }

    const updated = await db.updateOrder(order.id, updates);

    // Notify customer on WhatsApp when status changes to notable states
    const notifyStatuses = ['confirmed', 'packaging', 'shipped', 'delivered', 'rejected'];
    const newStatus = updates.status;
    if (newStatus && notifyStatuses.includes(newStatus) && order.customer_jid) {
      try {
        const client    = await db.getClientById(req.clientId);
        const message   = buildStatusMessage(order, newStatus, client && client.business_name);
        const phone     = order.customer_jid.replace('@s.whatsapp.net', '');
        await sendWhatsApp(req.clientId, phone, message);
      } catch (e) {
        console.error('[Orders] WhatsApp notify failed:', e.message);
        // Non-fatal — order was still updated
      }
    }

    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── ANALYTICS ────────────────────────────────────────────────

// GET /client/analytics?month=YYYY-MM
router.get('/client/analytics', auth, async function(req, res) {
  try {
    const now        = new Date();
    const defaultMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const month      = req.query.month || defaultMonth;
    const stats      = await db.getMonthlyStats(req.clientId, month);
    return res.json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────────

// POST /client/push/subscribe
router.post('/client/push/subscribe', auth, async function(req, res) {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'endpoint and keys (p256dh, auth) required' });
    }
    await db.savePushSubscription(req.clientId, endpoint, keys.p256dh, keys.auth);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /client/push/test
router.post('/client/push/test', auth, async function(req, res) {
  try {
    const subs = await db.getPushSubscriptions(req.clientId);
    if (!subs || !subs.length) return res.status(404).json({ error: 'No push subscriptions found' });

    webpush.setVapidDetails(
      'mailto:' + (process.env.VAPID_EMAIL || 'admin@forgebot.ng'),
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const payload = JSON.stringify({ title: 'ForgeBot', body: 'Push notifications are working! 🤖' });
    let sent = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (e) {
        console.error('[Push] Failed:', e.message);
      }
    }
    return res.json({ sent, total: subs.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  BOT TASKS — Scheduled auto-outreach ("Bot Errands")
// ════════════════════════════════════════════════════════════════

// GET /client/bot-tasks — list all tasks for this client
router.get('/client/bot-tasks', auth, async function(req, res) {
  try {
    const activeOnly = req.query.active === 'true';
    const tasks = await db.getBotTasks(req.clientId, activeOnly);
    return res.json(tasks || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /client/bot-tasks — create a new scheduled task
router.post('/client/bot-tasks', auth, async function(req, res) {
  try {
    const { name, message, schedule_time, schedule_days, filter_type } = req.body;
    if (!name || !message || !schedule_time) {
      return res.status(400).json({ error: 'name, message, schedule_time required' });
    }
    // schedule_time must be HH:MM format
    if (!/^\d{2}:\d{2}$/.test(schedule_time)) {
      return res.status(400).json({ error: 'schedule_time must be HH:MM (e.g. "09:00")' });
    }
    const validFilters = ['all_customers', 'pending_orders', 'inactive_7d', 'inactive_14d'];
    const filterType   = validFilters.includes(filter_type) ? filter_type : 'all_customers';

    const task = await db.createBotTask({
      client_id:     req.clientId,
      name,
      message,
      schedule_time,
      schedule_days: schedule_days || 'Mon,Tue,Wed,Thu,Fri,Sat,Sun',
      filter_type:   filterType,
      active:        true,
      run_count:     0
    });
    return res.json(task);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /client/bot-tasks/:id — edit or toggle task
router.patch('/client/bot-tasks/:id', auth, async function(req, res) {
  try {
    // Verify task belongs to this client
    const existing = await db.getSupabase()
      .from('bot_tasks').select('*').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (existing.error || !existing.data) return res.status(404).json({ error: 'Task not found' });

    const allowed = ['name', 'message', 'schedule_time', 'schedule_days', 'filter_type', 'active'];
    const updates = {};
    allowed.forEach(function(k) { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

    const task = await db.updateBotTask(req.params.id, updates);
    return res.json(task);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /client/bot-tasks/:id — delete task
router.delete('/client/bot-tasks/:id', auth, async function(req, res) {
  try {
    // Verify task belongs to this client
    const existing = await db.getSupabase()
      .from('bot_tasks').select('id').eq('id', req.params.id).eq('client_id', req.clientId).single();
    if (existing.error || !existing.data) return res.status(404).json({ error: 'Task not found' });

    await db.deleteBotTask(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════

module.exports = router;
