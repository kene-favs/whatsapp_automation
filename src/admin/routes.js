// ============================================================
//  ForgeBot — Admin API Routes
//  File location: src/admin/routes.js
//
//  Mount in index.js:
//    app.use('/admin', adminRoutes);
//
//  GET /admin          → served by index.js (admin.html)
//  POST /admin/login   → returns JWT
//  All other /admin/*  → protected by adminAuth middleware
// ============================================================

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const router  = express.Router();

const db             = require('../db/supabase');
const sessionManager = require('../sessions/sessionManager');

function adminSecret() {
  return (process.env.JWT_SECRET || 'forgebot-secret') + '-admin';
}

// ── Admin auth middleware ─────────────────────────────────────
function adminAuth(req, res, next) {
  var authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    try { jwt.verify(authHeader.slice(7), adminSecret()); return next(); } catch (e) {}
  }
  var xToken = req.headers['x-admin-token'];
  if (xToken) {
    try { jwt.verify(xToken, adminSecret()); return next(); } catch (e) {}
  }
  var email   = (req.headers['email']    || '').trim().toLowerCase();
  var pass    = (req.headers['password'] || '').trim();
  if (email && email === (process.env.ADMIN_EMAIL || '').toLowerCase() && pass === (process.env.ADMIN_PASSWORD || '')) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC: Login
// ════════════════════════════════════════════════════════════════

router.post('/login', async function(req, res) {
  try {
    var email   = (req.body.email    || '').trim().toLowerCase();
    var pass    = (req.body.password || '').trim();
    if (!email || !pass) return res.status(400).json({ ok: false, error: 'Email and password required' });
    if (email !== (process.env.ADMIN_EMAIL || '').toLowerCase() || pass !== (process.env.ADMIN_PASSWORD || '')) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }
    var token = jwt.sign({ role: 'admin' }, adminSecret(), { expiresIn: '12h' });
    return res.json({ ok: true, token: token });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  CLIENTS
// ════════════════════════════════════════════════════════════════

router.get('/clients', adminAuth, async function(req, res) {
  try {
    var clients = await db.getAllClients();
    var sockIds = [];
    try { sockIds = sessionManager.getAllSessions ? sessionManager.getAllSessions() : []; } catch (e) {}
    var out = (clients || []).map(function(c) {
      var safe = Object.assign({}, c);
      delete safe.password_hash;
      safe.session_active = sockIds.includes(c.id);
      return safe;
    });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/clients/:id', adminAuth, async function(req, res) {
  try {
    var client = await db.getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, client);
    delete safe.password_hash;
    return res.json(safe);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/clients/:id', adminAuth, async function(req, res) {
  try {
    var updated = await db.updateClient(req.params.id, req.body);
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/clients/:id', adminAuth, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('clients').delete().eq('id', req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/connect', adminAuth, async function(req, res) {
  try {
    var client = await db.getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    await sessionManager.startSession(client.id, {});
    return res.json({ ok: true, message: 'Session start initiated' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/disconnect', adminAuth, async function(req, res) {
  try {
    await sessionManager.stopSession(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════
//  PARTNERS
// ════════════════════════════════════════════════════════════════

router.get('/partners', adminAuth, async function(req, res) {
  try {
    var sb     = db.getSupabase();
    var result = await sb
      .from('clients')
      .select('id,business_name,full_name,email,whatsapp_number,occupation,subscription_active,is_partner,partner_expires_at,created_at')
      .eq('is_partner', true)
      .order('created_at', { ascending: false });

    if (result.error) throw new Error(result.error.message);

    var now      = new Date();
    var partners = (result.data || []).map(function(p) {
      var expiresAt = p.partner_expires_at ? new Date(p.partner_expires_at) : null;
      return Object.assign({}, p, {
        days_left: expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null,
        expired:   expiresAt ? expiresAt < now : false
      });
    });
    return res.json(partners);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/partners — create partner account
router.post('/partners', adminAuth, async function(req, res) {
  try {
    var business_name   = (req.body.business_name   || '').trim();
    var email           = (req.body.email           || '').trim().toLowerCase();
    var whatsapp_number = (req.body.whatsapp_number || req.body.phone || '').replace(/\D/g, '');
    var occupation      = req.body.occupation || 'general';
    var trial_days      = parseInt(req.body.trial_days) || 7;

    if (!business_name || !email || !whatsapp_number) {
      return res.status(400).json({ error: 'Business name, email and WhatsApp number are required' });
    }

    var existing = await db.getClientByEmail(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    var rawPassword = 'forgebot2025';
    var hashedPw    = await bcrypt.hash(rawPassword, 10);
    var expires     = new Date(Date.now() + trial_days * 24 * 60 * 60 * 1000).toISOString();
    var sb          = db.getSupabase();

    var result = await sb.from('clients').insert({
      business_name:       business_name,
      full_name:           business_name,    // required NOT NULL
      email:               email,
      whatsapp_number:     whatsapp_number,  // correct column name (not phone)
      occupation:          occupation,
      password_hash:       hashedPw,
      status:              'active',
      subscription_active: true,
      is_partner:          true,
      partner_expires_at:  expires,
      trial_notified:      false,
      setup_completed:     false
    }).select('id,business_name,email,whatsapp_number,occupation,partner_expires_at').single();

    if (result.error) throw new Error(result.error.message);

    await sb.from('partner_log').insert({
      client_id: result.data.id,
      action:    'created',
      note:      'Trial: ' + trial_days + ' days. Expires: ' + expires
    }).then(function() {}).catch(function() {});

    return res.json({
      ok:         true,
      client:     result.data,
      password:   rawPassword,
      trial_days: trial_days,
      expires_at: expires,
      login_url:  (process.env.APP_URL || '') + '/dashboard'
    });
  } catch (err) {
    console.error('[Admin] Create partner error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/partners/:id/extend', adminAuth, async function(req, res) {
  try {
    var days    = parseInt(req.body.days || req.body.extra_days) || 7;
    var sb      = db.getSupabase();
    var current = await sb.from('clients').select('partner_expires_at').eq('id', req.params.id).single();
    if (current.error || !current.data) return res.status(404).json({ error: 'Partner not found' });

    var base      = (current.data.partner_expires_at && new Date(current.data.partner_expires_at) > new Date())
      ? new Date(current.data.partner_expires_at) : new Date();
    var newExpiry = new Date(base.getTime() + days * 86400000).toISOString();

    await sb.from('clients').update({ partner_expires_at: newExpiry, subscription_active: true, trial_notified: false }).eq('id', req.params.id);
    await sb.from('partner_log').insert({ client_id: req.params.id, action: 'extended', note: 'Extended by ' + days + ' days. New expiry: ' + newExpiry })
      .then(function() {}).catch(function() {});

    return res.json({ ok: true, new_expiry: newExpiry, extra_days: days });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/partners/:id/revoke', adminAuth, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('clients').update({ subscription_active: false }).eq('id', req.params.id);
    await sb.from('partner_log').insert({ client_id: req.params.id, action: 'revoked', note: req.body.reason || 'Manually revoked by admin' })
      .then(function() {}).catch(function() {});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/partners/:id/convert', adminAuth, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('clients').update({
      is_partner: false, partner_expires_at: null,
      subscription_active: true, trial_notified: false, setup_completed: true
    }).eq('id', req.params.id);
    await sb.from('partner_log').insert({ client_id: req.params.id, action: 'converted', note: 'Converted to full paying client' })
      .then(function() {}).catch(function() {});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/partners/:id', adminAuth, async function(req, res) {
  try {
    var sb = db.getSupabase();
    await sb.from('clients').delete().eq('id', req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/partners/:id/log', adminAuth, async function(req, res) {
  try {
    var sb     = db.getSupabase();
    var result = await sb.from('partner_log').select('*').eq('client_id', req.params.id).order('created_at', { ascending: false });
    return res.json(result.data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
