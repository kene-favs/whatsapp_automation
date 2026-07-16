require('dotenv').config();
const express = require('express');
const path = require('path');

const db = require('./src/db/supabase');
const sessionManager = require('./src/sessions/sessionManager');
const { startScheduler } = require('./src/bot/statusScheduler');
const adminRoutes = require('./src/admin/routes');
const clientRoutes = require('./src/routes/client-portal');
const webhookRoutes = require('./src/routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'src/admin/public')));

// ── Routes ─────────────────────────────────────────────────────
app.use('/api/client', clientRoutes);
app.use('/api/admin', adminRoutes);
app.use('/webhooks', webhookRoutes);

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/onboard', (req, res) => res.sendFile(path.join(__dirname, 'public/onboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'src/admin/public/index.html')));

// ── Start ──────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🤖 ForgeBot server running on port ${PORT}`);
  console.log(`   Landing:   http://localhost:${PORT}/`);
  console.log(`   Admin:     http://localhost:${PORT}/admin`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard\n`);

  try {
    const activeClients = await db.getActiveClients();
    await sessionManager.bootAllSessions(activeClients);
    startScheduler();
  } catch (err) {
    console.error('Boot error:', err.message);
  }
});
