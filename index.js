// ============================================================
//  ForgeBot — Main Server Entry Point
//  File: index.js  (project root)
// ============================================================
require('dotenv').config();
const express = require('express');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const { startScheduler }  = require('./src/bot/statusScheduler');
const sessionManager      = require('./src/sessions/sessionManager');
const adminRoutes         = require('./src/admin/routes');

// ── Wire globals before any route file loads ────────────────
global.getSock      = (clientId) => sessionManager.getSession(clientId);
global.qrListeners  = new Map();

// ── Client API routes (dashboard) ──────────────────────────
// Only mount if the file exists (graceful if not deployed yet)
let clientApiRoutes = null;
try {
  clientApiRoutes = require('./routes');
} catch (_) {
  console.warn('[ForgeBot] ./routes.js not found — client API not mounted');
}

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve public folder (onboard.html, setup.html, dashboard, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Serve admin panel static files
app.use(express.static(path.join(__dirname, 'src/admin/public')));

// ── Mount routes ────────────────────────────────────────────
if (clientApiRoutes) {
  app.use('/api', clientApiRoutes);
}
app.use('/', adminRoutes);

// ── Boot ────────────────────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║        ForgeBot — Starting Up        ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // Start status post scheduler
  try { startScheduler(); } catch (e) { console.warn('[ForgeBot] Scheduler error:', e.message); }

  // Reconnect previously active client sessions via Supabase
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: clients } = await supabase
      .from('clients')
      .select('id, business_name, status, subscription_active')
      .eq('status', 'active')
      .eq('subscription_active', true);

    if (clients && clients.length > 0) {
      console.log('[ForgeBot] Reconnecting ' + clients.length + ' active client(s)...');
      for (const client of clients) {
        try {
          await sessionManager.startSession(client.id, {});
          console.log('[ForgeBot] Started session for: ' + client.business_name);
          await new Promise(r => setTimeout(r, 1500));
        } catch (err) {
          console.error('[ForgeBot] Failed to start session for ' + client.id + ':', err.message);
        }
      }
    } else {
      console.log('[ForgeBot] No active clients to reconnect.');
    }
  } catch (err) {
    console.warn('[ForgeBot] Could not load active clients from Supabase:', err.message);
    console.warn('[ForgeBot] Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.');
  }

  // Start server
  app.listen(PORT, () => {
    console.log('');
    console.log('[ForgeBot] Server running on port ' + PORT);
    console.log('[ForgeBot] Admin panel: http://localhost:' + PORT);
    console.log('');
  });
}

start().catch(err => {
  console.error('[ForgeBot] Startup error:', err.message);
  process.exit(1);
});
