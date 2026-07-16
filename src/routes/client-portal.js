const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db/supabase');
const flutterwave = require('../payments/flutterwave');
const stripe = require('../payments/stripe');
const sessionManager = require('../sessions/sessionManager');

const JWT_SECRET = process.env.JWT_SECRET;

// ── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    req.clientId = decoded.clientId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Signup ───────────────────────────────────────────────────────────────────
router.post('/api/client/signup', async (req, res) => {
  try {
    const { email, password, full_name, business_name, business_type, whatsapp_number, country, notification_number } = req.body;
    const existing = await db.getClientByEmail(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const password_hash = await bcrypt.hash(password, 10);
    const client = await db.createClient_({
      email, password_hash, full_name, business_name,
      business_type: business_type || 'general',
      whatsapp_number,
      country: country || 'nigeria',
      notification_number: notification_number || null
    });
    const token = jwt.sign({ clientId: client.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, clientId: client.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Login ────────────────────────────────────────────────────────────────────
router.post('/api/client/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const client = await db.getClientByEmail(email);
    if (!client) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ clientId: client.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, clientId: client.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Flutterwave payment (Nigeria N30,000) ────────────────────────────────────
router.post('/api/client/pay/flutterwave', authMiddleware, async (req, res) => {
  try {
    const client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const redirectUrl = req.protocol + '://' + req.get('host') + '/api/webhooks/flutterwave/callback';
    const result = await flutterwave.initializeSetupPayment(client.email, client.id, redirectUrl);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe payment (International $45) ──────────────────────────────────────
router.post('/api/client/pay/stripe', authMiddleware, async (req, res) => {
  try {
    const client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const token = req.headers.authorization.slice(7);
    const successUrl = req.protocol + '://' + req.get('host') + '/onboard?token=' + token;
    const cancelUrl = req.protocol + '://' + req.get('host') + '/';
    const session = await stripe.createCheckoutSession(client.email, client.full_name, client.id, successUrl, cancelUrl);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── QR Stream (SSE) ──────────────────────────────────────────────────────────
router.get('/api/client/qr-stream', async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    let clientId;
    try { clientId = jwt.verify(token, JWT_SECRET).clientId; }
    catch (err) { return res.status(401).json({ error: 'Invalid token' }); }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = function(type, data) {
      res.write('data: ' + JSON.stringify({ type: type, data: data }) + '\n\n');
    };
    sessionManager.startSession(clientId, {
      onQR: function(qr) { send('qr', qr); },
      onConnected: function() { send('connected', true); },
      onDisconnected: function() { send('disconnected', true); }
    });
    req.on('close', function() {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get client profile ───────────────────────────────────────────────────────
router.get('/api/client/me', authMiddleware, async (req, res) => {
  try {
    const client = await db.getClientById(req.clientId);
    if (!client) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = client;
    res.json(safe);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Flows ────────────────────────────────────────────────────────────────────
router.get('/api/client/flows', authMiddleware, async (req, res) => {
  try { res.json(await db.getFlows(req.clientId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/api/client/flows', authMiddleware, async (req, res) => {
  try {
    const { keywords, response, response_type, media_url } = req.body;
    res.json(await db.addFlow(req.clientId, keywords, response, response_type, media_url));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/api/client/flows/:id', authMiddleware, async (req, res) => {
  try { await db.deleteFlow(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Status Posts ─────────────────────────────────────────────────────────────
router.get('/api/client/status-posts', authMiddleware, async (req, res) => {
  try { res.json(await db.getStatusPosts(req.clientId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/api/client/status-posts', authMiddleware, async (req, res) => {
  try {
    const { mediaUrl, caption, scheduledTime, scheduledDays } = req.body;
    res.json(await db.addStatusPost(req.clientId, mediaUrl, caption, scheduledTime, scheduledDays));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.delete('/api/client/status-posts/:id', authMiddleware, async (req, res) => {
  try { await db.deleteStatusPost(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Broadcasts ───────────────────────────────────────────────────────────────
router.get('/api/client/broadcasts', authMiddleware, async (req, res) => {
  try { res.json(await db.getBroadcastLogs(req.clientId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/api/client/broadcasts', authMiddleware, async (req, res) => {
  try {
    const log = await db.logBroadcast(req.clientId, req.body.message, 0);
    res.json({ success: true, log: log });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Fallback message ─────────────────────────────────────────────────────────
router.put('/api/client/fallback', authMiddleware, async (req, res) => {
  try {
    const updated = await db.updateClient(req.clientId, { fallback_message: req.body.fallback_message });
    res.json({ success: true, client: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Settings ─────────────────────────────────────────────────────────────────
router.put('/api/client/settings', authMiddleware, async (req, res) => {
  try {
    const updated = await db.updateClient(req.clientId, { notification_number: req.body.notification_number });
    res.json({ success: true, client: updated });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
