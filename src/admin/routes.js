const express = require('express');
const router = express.Router();
const db = require('../db/supabase');
const sessionManager = require('../sessions/sessionManager');

// Simple admin auth middleware
function adminAuth(req, res, next) {
  const { email, password } = req.headers;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// GET all clients
router.get('/clients', adminAuth, async (req, res) => {
  const clients = await db.getAllClients();
  const sessions = sessionManager.getAllSessions();
  const withStatus = clients.map(c => ({
    ...c,
    session_active: sessions.includes(c.id),
    password_hash: undefined
  }));
  res.json(withStatus);
});

// GET client detail
router.get('/clients/:id', adminAuth, async (req, res) => {
  const client = await db.getClientById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  const { password_hash, ...safe } = client;
  res.json(safe);
});

// PATCH client (admin override)
router.patch('/clients/:id', adminAuth, async (req, res) => {
  const updated = await db.updateClient(req.params.id, req.body);
  res.json(updated);
});

// Start/connect client session manually
router.post('/clients/:id/connect', adminAuth, async (req, res) => {
  const client = await db.getClientById(req.params.id);
  if (!client) return res.status(404).json({ error: 'Not found' });
  await sessionManager.startSession(client.id, {});
  res.json({ ok: true, message: 'Session start initiated' });
});

// Disconnect client
router.post('/clients/:id/disconnect', adminAuth, async (req, res) => {
  await sessionManager.stopSession(req.params.id);
  res.json({ ok: true });
});

// GET flows for client
router.get('/clients/:id/flows', adminAuth, async (req, res) => {
  const flows = await db.getFlows(req.params.id, false);
  res.json(flows);
});

// POST flow for client
router.post('/clients/:id/flows', adminAuth, async (req, res) => {
  const { flow_name, keywords, response_type, response, media_url, priority } = req.body;
  const flow = await db.addFlow(req.params.id, flow_name, keywords, response_type, response, media_url, priority);
  res.json(flow);
});

// DELETE flow
router.delete('/flows/:id', adminAuth, async (req, res) => {
  await db.deleteFlow(req.params.id);
  res.json({ ok: true });
});

// GET status posts for client
router.get('/clients/:id/status-posts', adminAuth, async (req, res) => {
  const posts = await db.getStatusPosts(req.params.id);
  res.json(posts);
});

// POST status post for client
router.post('/clients/:id/status-posts', adminAuth, async (req, res) => {
  const { caption, media_url, post_time, repeat_daily } = req.body;
  const post = await db.addStatusPost(req.params.id, caption, media_url, post_time, repeat_daily);
  res.json(post);
});

// GET available keywords
router.get('/keywords', adminAuth, (req, res) => {
  const { KEYWORDS } = require('../bot/keywords');
  res.json(KEYWORDS);
});

// Broadcast message to all contacts for a client
router.post('/clients/:id/broadcast', adminAuth, async (req, res) => {
  const { message, numbers } = req.body;
  const sock = sessionManager.getSession(req.params.id);
  if (!sock) return res.status(400).json({ error: 'Client not connected' });

  let sent = 0;
  for (const number of numbers) {
    try {
      const jid = number.replace(/\D/g, '') + '@s.whatsapp.net';
      await sock.sendMessage(jid, { text: message });
      sent++;
      await new Promise(r => setTimeout(r, 1200)); // rate-limit
    } catch (err) {
      console.error(`Broadcast failed for ${number}:`, err.message);
    }
  }

  await db.logBroadcast(req.params.id, message, sent);
  res.json({ sent, total: numbers.length });
});

module.exports = router;
