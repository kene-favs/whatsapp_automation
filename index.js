// ============================================================
//  ForgeBot — Server Entry Point v2
//  File location: index.js  (project root)
// ============================================================

'use strict';

require('dotenv').config();

const express        = require('express');
const path           = require('path');
const { createClient } = require('@supabase/supabase-js');

const { startScheduler } = require('./src/bot/statusScheduler');
const sessionManager     = require('./src/sessions/sessionManager');
const adminRoutes        = require('./src/admin/routes');
const clientRoutes       = require('./src/api/clientRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Lazy Supabase (used only in cron + boot) ──────────────────
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

// ── Global helpers for QR streaming ──────────────────────────
global.getSock     = function(clientId) { return sessionManager.getSession(clientId); };
global.qrListeners = new Map();

// ── Middleware ────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static files from root public/ folder
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────
app.use('/api', clientRoutes);   // JWT-protected client endpoints
app.use('/', adminRoutes);       // Admin panel endpoints

// ── Partner expiry cron ───────────────────────────────────────
async function runPartnerExpiryCheck() {
  try {
    var supabase = getSupabase();
    var now      = new Date().toISOString();

    // 1. Deactivate expired partners
    var expired = await supabase
      .from('clients')
      .select('id,business_name,notification_number')
      .eq('is_partner', true)
      .eq('subscription_active', true)
      .lt('partner_expires_at', now);

    for (var i = 0; i < (expired.data || []).length; i++) {
      var partner = expired.data[i];
      await supabase.from('clients')
        .update({ subscription_active: false })
        .eq('id', partner.id);
      await supabase.from('partner_log').insert({
        client_id: partner.id,
        action: 'expired',
        note: 'Auto-expired at ' + now
      });
      console.log('[PartnerCron] Trial expired for: ' + partner.business_name);
    }

    // 2. Warn partners expiring in < 24 hours
    var tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    var expiring = await supabase
      .from('clients')
      .select('id,business_name,notification_number,partner_expires_at')
      .eq('is_partner', true)
      .eq('subscription_active', true)
      .eq('trial_notified', false)
      .lt('partner_expires_at', tomorrow)
      .gt('partner_expires_at', now);

    for (var j = 0; j < (expiring.data || []).length; j++) {
      var p       = expiring.data[j];
      var expDate = new Date(p.partner_expires_at).toLocaleDateString('en-NG', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });
      var sock = sessionManager.getSession(p.id);
      if (sock && p.notification_number) {
        try {
          var ownerJid = p.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';
          await sock.sendMessage(ownerJid, {
            text: [
              '⚠️ *ForgeBot Partner Trial Ending Soon*',
              '',
              'Your ForgeBot partner trial expires on *' + expDate + '*.',
              '',
              'After that date, your bot will stop responding to customers.',
              '',
              'To continue without interruption, please make the one-time setup payment of *₦30,000*.',
              '',
              'Contact us now to keep your bot running:',
              (process.env.APP_URL || 'https://forgebot.net')
            ].join('\n')
          });
        } catch (e) {
          console.error('[PartnerCron] Could not send warning to ' + p.business_name + ':', e.message);
        }
      }
      await supabase.from('clients').update({ trial_notified: true }).eq('id', p.id);
      console.log('[PartnerCron] Sent expiry warning to: ' + p.business_name);
    }
  } catch (e) {
    console.error('[PartnerCron] Error:', e.message);
  }
}

// ── Boot ──────────────────────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║         ForgeBot v2 Platform         ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  startScheduler();

  try {
    var supabase = getSupabase();
    var { data: clients, error } = await supabase
      .from('clients')
      .select('id,business_name,status,subscription_active')
      .eq('status', 'active')
      .eq('subscription_active', true);

    if (error) throw error;
    await sessionManager.bootAllSessions(clients || []);
  } catch (e) {
    console.error('[Boot] Could not fetch clients from Supabase:', e.message);
    console.error('[Boot] Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars');
  }

  // Partner expiry cron — runs immediately then every hour
  runPartnerExpiryCheck();
  setInterval(runPartnerExpiryCheck, 60 * 60 * 1000);

  app.listen(PORT, function() {
    console.log('');
    console.log('🚀 ForgeBot running at: http://localhost:' + PORT);
    console.log('📊 Admin panel:         http://localhost:' + PORT + '/admin');
    console.log('');
  });
}

start().catch(function(err) {
  console.error('❌ Startup error:', err.message);
  process.exit(1);
});
