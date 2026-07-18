// ============================================================
//  ForgeBot — Admin API Routes v2
//  File location: src/admin/routes.js
// ============================================================

'use strict';

const express  = require('express');
const router   = express.Router();
const path     = require('path');
const bcrypt   = require('bcryptjs');
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

// ── Admin auth middleware ─────────────────────────────────────
function adminAuth(req, res, next) {
  var email    = (req.headers.email || '').trim().toLowerCase();
  var password = (req.headers.password || '').trim();
  var adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  var adminPass  = (process.env.ADMIN_PASSWORD || '').trim();
  if (email === adminEmail && password === adminPass) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Serve admin panel HTML ────────────────────────────────────
// admin.html lives in the root public/ folder
router.get('/admin', function(req, res) {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// ══════════════════════════════════════════════════════════════
//  EXISTING CLIENT ROUTES
// ══════════════════════════════════════════════════════════════

router.get('/clients', adminAuth, async function(req, res) {
  try {
    var clients  = await db.getAllClients();
    var sessions = sessionManager.getAllSessions();
    var out = clients.map(function(c) {
      return Object.assign({}, c, {
        session_active: sessions.includes(c.id),
        password_hash: undefined
      });
    });
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/:id', adminAuth, async function(req, res) {
  try {
    var client = await db.getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    var { password_hash, ...safe } = client;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/clients/:id', adminAuth, async function(req, res) {
  try {
    var updated = await db.updateClient(req.params.id, req.body);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/connect', adminAuth, async function(req, res) {
  try {
    var client = await db.getClientById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Not found' });
    await sessionManager.startSession(client.id, {});
    res.json({ ok: true, message: 'Session start initiated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/disconnect', adminAuth, async function(req, res) {
  try {
    await sessionManager.stopSession(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/:id/flows', adminAuth, async function(req, res) {
  try {
    var flows = await db.getFlows(req.params.id, false);
    res.json(flows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/flows', adminAuth, async function(req, res) {
  try {
    var { flow_name, keywords, response_type, response, media_url, priority } = req.body;
    var flow = await db.addFlow(req.params.id, flow_name, keywords, response_type, response, media_url, priority);
    res.json(flow);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/flows/:id', adminAuth, async function(req, res) {
  try {
    await db.deleteFlow(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/clients/:id/status-posts', adminAuth, async function(req, res) {
  try {
    var posts = await db.getStatusPosts(req.params.id);
    res.json(posts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/status-posts', adminAuth, async function(req, res) {
  try {
    var { caption, media_url, post_time, repeat_daily } = req.body;
    var post = await db.addStatusPost(req.params.id, caption, media_url, post_time, repeat_daily);
    res.json(post);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/clients/:id/broadcast', adminAuth, async function(req, res) {
  try {
    var { message, numbers } = req.body;
    var sock = sessionManager.getSession(req.params.id);
    if (!sock) return res.status(400).json({ error: 'Client not connected' });
    var sent = 0;
    for (var i = 0; i < numbers.length; i++) {
      try {
        var jid = numbers[i].replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        sent++;
        await new Promise(function(r) { setTimeout(r, 1200); });
      } catch (e) { console.error('[Admin] Broadcast failed for ' + numbers[i]); }
    }
    await db.logBroadcast(req.params.id, message, sent);
    res.json({ sent: sent, total: numbers.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  PARTNER / INFLUENCER MANAGEMENT
// ══════════════════════════════════════════════════════════════

router.get('/partners', adminAuth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('clients')
      .select('id,business_name,email,whatsapp_number,occupation,subscription_active,is_partner,partner_expires_at,trial_notified,created_at')
      .eq('is_partner', true)
      .order('created_at', { ascending: false });

    var now      = new Date();
    var partners = (result.data || []).map(function(p) {
      var expiresAt = p.partner_expires_at ? new Date(p.partner_expires_at) : null;
      var daysLeft  = expiresAt ? Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)) : null;
      return Object.assign({}, p, {
        days_left: daysLeft,
        expired:   expiresAt ? expiresAt < now : false
      });
    });
    res.json(partners);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/partners', adminAuth, async function(req, res) {
  try {
    var { business_name, email, whatsapp_number, occupation, trial_days } = req.body;
    if (!business_name || !email || !whatsapp_number) {
      return res.status(400).json({ error: 'business_name, email, and whatsapp_number are required' });
    }
    var days    = parseInt(trial_days) || 7;
    var expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    var rawPassword = Math.random().toString(36).slice(2, 10).toUpperCase();
    var hashedPw    = await bcrypt.hash(rawPassword, 10);

    var sb     = getSupabase();
    var result = await sb.from('clients').insert({
      business_name:       business_name,
      email:               email.toLowerCase().trim(),
      whatsapp_number:     whatsapp_number.replace(/\D/g, ''),
      occupation:          occupation || 'general',
      password_hash:       hashedPw,
      status:              'active',
      subscription_active: true,
      is_partner:          true,
      partner_expires_at:  expires,
      trial_notified:      false,
      setup_completed:     false
    }).select('id,business_name,email,occupation,partner_expires_at').single();

    if (result.error) throw new Error(result.error.message);

    await sb.from('partner_log').insert({
      client_id: result.data.id,
      action: 'created',
      note: 'Trial period: ' + days + ' days. Expires: ' + expires
    });

    res.json({
      ok:         true,
      client:     result.data,
      password:   rawPassword,
      trial_days: days,
      expires_at: expires,
      login_url:  (process.env.APP_URL || 'https://forgebot.net') + '/'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/partners/:id/extend', adminAuth, async function(req, res) {
  try {
    var days    = parseInt(req.body.extra_days) || 7;
    var sb      = getSupabase();
    var current = await sb.from('clients')
      .select('partner_expires_at,subscription_active')
      .eq('id', req.params.id).single();

    if (current.error || !current.data) return res.status(404).json({ error: 'Partner not found' });

    var base      = (current.data.partner_expires_at && new Date(current.data.partner_expires_at) > new Date())
      ? new Date(current.data.partner_expires_at) : new Date();
    var newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

    await sb.from('clients').update({
      partner_expires_at:  newExpiry,
      subscription_active: true,
      trial_notified:      false
    }).eq('id', req.params.id);

    await sb.from('partner_log').insert({
      client_id: req.params.id,
      action: 'extended',
      note: 'Extended by ' + days + ' days. New expiry: ' + newExpiry
    });

    res.json({ ok: true, new_expiry: newExpiry, extra_days: days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/partners/:id/revoke', adminAuth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('clients').update({ subscription_active: false }).eq('id', req.params.id);
    await sb.from('partner_log').insert({
      client_id: req.params.id,
      action: 'revoked',
      note: req.body.reason || 'Manually revoked by admin'
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/partners/:id/convert', adminAuth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('clients').update({
      is_partner:          false,
      partner_expires_at:  null,
      trial_notified:      false,
      subscription_active: true,
      setup_completed:     true
    }).eq('id', req.params.id);
    await sb.from('partner_log').insert({
      client_id: req.params.id,
      action: 'converted',
      note: 'Converted to full paying client by admin'
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/partners/:id', adminAuth, async function(req, res) {
  try {
    var sb = getSupabase();
    await sb.from('clients').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/partners/:id/log', adminAuth, async function(req, res) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('partner_log')
      .select('*').eq('client_id', req.params.id)
      .order('created_at', { ascending: false });
    res.json(result.data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
