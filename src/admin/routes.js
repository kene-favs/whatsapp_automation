const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const router = express.Router();
const sessionManager = require('../sessions/sessionManager');

// ── Lazy Supabase ─────────────────────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('Supabase env vars missing');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

// ── Admin auth middleware ─────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  // Support both header-based and token-based auth
  const token = req.headers['x-admin-token'] || req.headers['authorization'];
  if (token && token.replace('Bearer ', '') === 'forgebot-admin-session') return next();

  const email = (req.headers['email'] || '').trim();
  const password = (req.headers['password'] || '').trim();
  const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
  const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

  if (email === adminEmail && password === adminPassword) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── Serve admin panel ─────────────────────────────────────────────────────────
router.get('/admin', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

// ── Admin login endpoint ──────────────────────────────────────────────────────
router.post('/admin/login', (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const password = (req.body.password || '').trim();
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim();
    const adminPassword = (process.env.ADMIN_PASSWORD || '').trim();

    if (email === adminEmail && password === adminPassword) {
      return res.json({ ok: true, token: 'forgebot-admin-session' });
    }
    return res.status(401).json({ error: 'Incorrect email or password' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET all clients ───────────────────────────────────────────────────────────
router.get('/clients', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: clients, error } = await supabase
      .from('clients')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const sessions = sessionManager.getAllSessions ? sessionManager.getAllSessions() : [];
    const withStatus = (clients || []).map(c => ({
      ...c,
      password_hash: undefined,
      session_active: sessions.includes(c.id)
    }));
    res.json(withStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET single client ─────────────────────────────────────────────────────────
router.get('/clients/:id', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Not found' });
    const { password_hash, ...safe } = data;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH client (admin override) ─────────────────────────────────────────────
router.patch('/clients/:id', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clients')
      .update(req.body)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Activate / deactivate client ──────────────────────────────────────────────
router.post('/clients/:id/activate', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('clients').update({ subscription_active: true, status: 'active' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/deactivate', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('clients').update({ subscription_active: false, status: 'inactive' }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connect / disconnect session ──────────────────────────────────────────────
router.post('/clients/:id/connect', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data: client } = await supabase.from('clients').select('*').eq('id', req.params.id).single();
    if (!client) return res.status(404).json({ error: 'Not found' });
    if (sessionManager.startSession) await sessionManager.startSession(client.id, {});
    else if (sessionManager.createSession) await sessionManager.createSession(client.id, null);
    res.json({ ok: true, message: 'Session start initiated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/disconnect', adminAuth, async (req, res) => {
  try {
    if (sessionManager.stopSession) await sessionManager.stopSession(req.params.id);
    else if (sessionManager.removeSession) sessionManager.removeSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET flows for client ──────────────────────────────────────────────────────
router.get('/clients/:id/flows', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('flows')
      .select('*')
      .eq('client_id', req.params.id)
      .order('priority', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST flow for client ──────────────────────────────────────────────────────
router.post('/clients/:id/flows', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { flow_name, keywords, response_type, response, media_url, priority } = req.body;
    const { data, error } = await supabase
      .from('flows')
      .insert({ client_id: req.params.id, flow_name, keywords, response_type, response, media_url, priority: priority || 0 })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE flow ───────────────────────────────────────────────────────────────
router.delete('/flows/:id', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('flows').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Status posts ──────────────────────────────────────────────────────────────
router.get('/clients/:id/status-posts', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('status_posts')
      .select('*')
      .eq('client_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clients/:id/status-posts', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { caption, media_url, post_time, repeat_daily, days, scheduled_time } = req.body;
    const { data, error } = await supabase
      .from('status_posts')
      .insert({ client_id: req.params.id, caption, media_url, post_time: post_time || scheduled_time, repeat_daily, days, scheduled_time: scheduled_time || post_time })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
router.post('/clients/:id/broadcast', adminAuth, async (req, res) => {
  try {
    const { message, numbers } = req.body;
    const sock = sessionManager.getSession ? sessionManager.getSession(req.params.id)
               : sessionManager.sessions ? sessionManager.sessions.get(req.params.id) : null;
    if (!sock) return res.status(400).json({ error: 'Client not connected' });

    let sent = 0;
    for (const number of numbers) {
      try {
        const jid = number.replace(/\D/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        sent++;
        await new Promise(r => setTimeout(r, 1200));
      } catch (err) {
        console.error('Broadcast failed for ' + number + ':', err.message);
      }
    }
    res.json({ sent, total: numbers.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Keywords ──────────────────────────────────────────────────────────────────
router.get('/keywords', adminAuth, (req, res) => {
  try {
    const { KEYWORDS } = require('../bot/keywords');
    res.json(KEYWORDS);
  } catch {
    res.json([]);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARTNER / INFLUENCER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET all partners ──────────────────────────────────────────────────────────
router.get('/partners', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('clients')
      .select('id, business_name, email, whatsapp_number, occupation, status, subscription_active, is_partner, partner_expires_at, trial_notified, created_at')
      .eq('is_partner', true)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const now = new Date();
    const partners = (data || []).map(p => {
      const expires = p.partner_expires_at ? new Date(p.partner_expires_at) : null;
      const days_left = expires ? Math.ceil((expires - now) / (1000 * 60 * 60 * 24)) : null;
      return { ...p, days_left };
    });
    res.json(partners);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create partner ───────────────────────────────────────────────────────
router.post('/partners', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { business_name, email, whatsapp_number, occupation, trial_days } = req.body;
    if (!business_name || !email || !whatsapp_number) {
      return res.status(400).json({ error: 'business_name, email, and whatsapp_number are required' });
    }

    const days = parseInt(trial_days) || 30;
    const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    // Generate a random password
    const rawPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!';
    const password_hash = await bcrypt.hash(rawPassword, 10);

    const { data: partner, error } = await supabase
      .from('clients')
      .insert({
        business_name,
        email,
        whatsapp_number,
        occupation: occupation || 'general',
        password_hash,
        status: 'active',
        subscription_active: true,
        is_partner: true,
        partner_expires_at: expires_at,
        trial_notified: false
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Email already exists' });
      throw error;
    }

    // Log the creation
    await supabase.from('partner_log').insert({
      client_id: partner.id,
      action: 'created',
      note: "Trial account created. Expires in " + days + " days."
    });

    res.json({
      ok: true,
      partner_id: partner.id,
      email,
      password: rawPassword,
      expires_at,
      login_url: (process.env.APP_URL || '') + '/dashboard'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH extend partner trial ────────────────────────────────────────────────
router.patch('/partners/:id/extend', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const extra_days = parseInt(req.body.days) || 7;

    const { data: partner } = await supabase.from('clients').select('partner_expires_at').eq('id', req.params.id).single();
    if (!partner) return res.status(404).json({ error: 'Partner not found' });

    const current = partner.partner_expires_at ? new Date(partner.partner_expires_at) : new Date();
    const new_expiry = new Date(Math.max(current.getTime(), Date.now()) + extra_days * 24 * 60 * 60 * 1000).toISOString();

    await supabase.from('clients').update({ partner_expires_at: new_expiry, status: 'active', subscription_active: true }).eq('id', req.params.id);
    await supabase.from('partner_log').insert({ client_id: req.params.id, action: 'extended', note: "Extended by " + extra_days + " days. New expiry: " + new_expiry });

    res.json({ ok: true, new_expiry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH revoke partner ──────────────────────────────────────────────────────
router.patch('/partners/:id/revoke', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('clients').update({ subscription_active: false, status: 'inactive' }).eq('id', req.params.id);
    await supabase.from('partner_log').insert({ client_id: req.params.id, action: 'revoked', note: 'Access revoked by admin' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH convert partner to paid ─────────────────────────────────────────────
router.patch('/partners/:id/convert', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('clients').update({
      is_partner: false,
      partner_expires_at: null,
      subscription_active: true,
      status: 'active'
    }).eq('id', req.params.id);
    await supabase.from('partner_log').insert({ client_id: req.params.id, action: 'converted', note: 'Converted to paid client' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE partner ────────────────────────────────────────────────────────────
router.delete('/partners/:id', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    await supabase.from('clients').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET partner log ───────────────────────────────────────────────────────────
router.get('/partners/:id/log', adminAuth, async (req, res) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('partner_log')
      .select('*')
      .eq('client_id', req.params.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
