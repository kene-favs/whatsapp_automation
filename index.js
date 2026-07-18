require('dotenv').config();
const express = require('express');
const path = require('path');

const { startScheduler } = require('./src/bot/statusScheduler');
const { createSession } = require('./src/sessions/sessionManager');
const sessionManager    = require('./src/sessions/sessionManager');
const db = require('./src/db/database');
const adminRoutes = require('./src/admin/routes');
const apiRoutes   = require('./routes');   // ← new client dashboard API

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Global sock map (used by routes.js & replyEngine.js) ─────────────────
// sessionManager already holds socks internally; we expose a simple getter
// so routes.js can call getSock(clientId) → Baileys sock
global.getSock = (clientId) => sessionManager.getSession(clientId);

// ─── Global QR listener map (used by the /api/client/qr-stream SSE route) ─
global.qrListeners = new Map();

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve client-facing pages: index.html, onboard.html, dashboard.html,
// setup.html, manifest.json, sw.js, icons/, etc.
app.use(express.static(path.join(__dirname, 'public')));

// Serve ForgeBot super-admin panel static files
app.use(express.static(path.join(__dirname, 'src/admin/public')));

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);      // ← client dashboard API  (NEW)
app.use('/', adminRoutes);       // ← your existing admin panel

// ─── Boot ──────────────────────────────────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   WhatsApp Automation Platform       ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // Start the status post scheduler
  startScheduler();

  // Reconnect clients that were previously connected
  const clients = db.getClients().filter(c =>
    c.status === 'connected' || c.status === 'reconnecting'
  );

  if (clients.length > 0) {
    console.log(`🔄 Reconnecting ${clients.length} existing client(s)...`);
    for (const client of clients) {
      await createSession(client.id, null);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Start server
  app.listen(PORT, () => {
    console.log('');
    console.log(`🚀 Server running at: http://localhost:${PORT}`);
    console.log(`📊 Admin panel:       http://localhost:${PORT}`);
    console.log('');
    console.log('Press Ctrl+C to stop');
  });
}

start().catch(err => {
  console.error('❌ Startup error:', err);
  process.exit(1);
});
