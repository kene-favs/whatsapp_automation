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

// Serve static HTML files (admin panel, client dashboard, landing)
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ──────────────────────────────────────────────────
// Client routes mounted at /api — routes inside are /client/*, /push/*
app.use('/api', clientRoutes);

// Admin routes mounted at /admin — routes inside are /login, /partners/*, /clients/*
app.use('/admin', adminRoutes);

// ── HTML page fallbacks ─────────────────────────────────────────
// Serve admin panel at /admin-panel  (keeps /admin free for the API)
app.get('/admin-panel', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve client dashboard
app.get('/dashboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve onboarding page
app.get('/onboard', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'onboard.html'));
});

// Landing page (root)
app.get('/', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 — JSON for API calls, HTML otherwise
app.use(function(req, res) {
  if (req.path.startsWith('/api') || req.path.startsWith('/admin')) {
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

  // 2. Reconnect clients that were previously connected
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
    console.log('🚀 Server running at:  http://localhost:' + PORT);
    console.log('📊 Admin panel:        http://localhost:' + PORT + '/admin-panel');
    console.log('📱 Client dashboard:   http://localhost:' + PORT + '/dashboard');
    console.log('');
    console.log('Press Ctrl+C to stop');
  });
}

start().catch(function(err) {
  console.error('❌ Startup error:', err);
  process.exit(1);
});
