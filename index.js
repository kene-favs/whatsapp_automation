require('dotenv').config();

const express = require('express');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;

// ── Core dependencies ───────────────────────────────────────────
const db             = require('./src/db/supabase');
const adminRoutes    = require('./src/admin/routes');
const clientRoutes   = require('./src/api/clientRoutes');
const sessionManager = require('./src/sessions/sessionManager');
const { startScheduler } = require('./src/bot/statusScheduler');

// ── Middleware ──────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static assets (CSS, JS, images) from /public
app.use(express.static(path.join(__dirname, 'public')));

// ── HTML Pages ──────────────────────────────────────────────────
// GET /admin → serve admin panel HTML
// (must be BEFORE app.use('/admin', adminRoutes) so the browser gets HTML,
//  while POST/PATCH/DELETE /admin/* still hit the API router below)
app.get('/admin', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// GET /dashboard → client dashboard
app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// GET /onboard → partner onboarding page
app.get('/onboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'onboard.html'));
});

// GET / → landing page
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── API Routes ──────────────────────────────────────────────────
// Client API — /api/client/*, /api/push/*
app.use('/api', clientRoutes);

// Admin API — /admin/login, /admin/partners/*, /admin/clients/*
app.use('/admin', adminRoutes);

// ── 404 catch-all ───────────────────────────────────────────────
app.use(function(req, res) {
  if (req.path.startsWith('/api') || req.path.startsWith('/admin/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Page not found');
});

// ── Boot ────────────────────────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║         ForgeBot Platform            ║');
  console.log('║   WhatsApp Automation for SMEs       ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // 1. Start schedulers (status posts, memes, analytics, bot errands)
  try {
    startScheduler();
    console.log('✅ Schedulers started');
  } catch (e) {
    console.error('⚠️  Scheduler error:', e.message);
  }

  // 2. Reconnect clients that were previously connected via WhatsApp
  try {
    var sb     = db.getSupabase();
    var result = await sb
      .from('clients')
      .select('id, business_name')
      .eq('whatsapp_connected', true)
      .eq('subscription_active', true);

    var clients = result.data || [];
    if (clients.length > 0) {
      await sessionManager.bootAllSessions(clients);
    } else {
      console.log('ℹ️  No previously connected clients to restore');
    }
  } catch (e) {
    console.error('⚠️  Reconnect error:', e.message);
  }

  // 3. Start HTTP server
  app.listen(PORT, function() {
    console.log('');
    console.log('🚀 Server:      http://localhost:' + PORT);
    console.log('📊 Admin panel: http://localhost:' + PORT + '/admin');
    console.log('📱 Dashboard:   http://localhost:' + PORT + '/dashboard');
    console.log('');
    console.log('Press Ctrl+C to stop');
  });
}

start().catch(function(err) {
  console.error('❌ Startup error:', err);
  process.exit(1);
});
