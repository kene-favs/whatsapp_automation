// ============================================================
//  ForgeBot — Status Poster
//  File location: src/bot/statusPoster.js
//
//  Runs a scheduler that checks every 60 seconds whether it is
//  time to post a WhatsApp status for any active client.
//
//  Posts:
//   1. Product status  — picks a random available listing,
//      sends the image + caption to status@broadcast
//   2. Meme / promo    — sends a random URL from meme_media_urls
//
//  Uses bot_status_log to prevent double-posting on the same day.
//  All Supabase calls are wrapped in try/catch (fixes .catch() crash).
// ============================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');
const sessionManager   = require('../sessions/sessionManager');

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

// ── Helpers ───────────────────────────────────────────────────

// Returns true if today's 3-letter abbreviation is in the schedule string
// e.g. schedule_days = "Mon,Wed,Fri"
function isTodayScheduled(scheduleDays) {
  if (!scheduleDays) return true; // no schedule = every day
  var days  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var today = days[new Date().getDay()];
  return scheduleDays.split(',').map(function(s) { return s.trim(); }).indexOf(today) !== -1;
}

// Returns true if the current HH:MM matches targetTime (e.g. "09:00")
function isTimeNow(targetTime) {
  if (!targetTime) return false;
  var now = new Date();
  var hh  = String(now.getHours()).padStart(2, '0');
  var mm  = String(now.getMinutes()).padStart(2, '0');
  return (hh + ':' + mm) === targetTime.trim();
}

// Check if we already logged this post type today
async function alreadyPostedToday(clientId, logType) {
  try {
    var sb    = getSupabase();
    var today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    var result = await sb
      .from('bot_status_log')
      .select('id')
      .eq('client_id', clientId)
      .eq('log_type',  logType)
      .gte('created_at', today + 'T00:00:00Z')
      .limit(1);
    return !!(result.data && result.data.length > 0);
  } catch (e) {
    return false;
  }
}

async function logPost(clientId, logType, note) {
  try {
    var sb = getSupabase();
    await sb.from('bot_status_log').insert({
      client_id: clientId,
      log_type:  logType,
      note:      note || ''
    });
  } catch (e) {}
}

// ── Post a product listing as a WhatsApp status ───────────────
async function postProductStatus(clientId, sock) {
  try {
    var sb = getSupabase();

    // Pick all available listings for this client
    var result = await sb
      .from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false })
      .limit(10);

    if (!result.data || !result.data.length) {
      console.log('[StatusPoster] No listings to post for', clientId);
      return;
    }

    // Pick a random one
    var listing = result.data[Math.floor(Math.random() * result.data.length)];
    var images  = (listing.listing_media || [])
      .filter(function(m) { return m.media_type === 'image'; })
      .sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });

    var caption = '*' + listing.name + '*';
    if (listing.price)       caption += '\n💰 ' + listing.price;
    if (listing.description) caption += '\n\n' + listing.description;
    if (listing.location)    caption += '\n📍 ' + listing.location;
    caption += '\n\nDM us to order! 📩';

    if (images.length > 0) {
      await sock.sendMessage('status@broadcast', {
        image:   { url: images[0].url },
        caption: caption
      });
    } else {
      await sock.sendMessage('status@broadcast', { text: caption });
    }

    await logPost(clientId, 'product_post', 'Posted: ' + listing.name);
    console.log('[StatusPoster] Product status posted for', clientId, '-', listing.name);
  } catch (e) {
    console.error('[StatusPoster] postProductStatus error for', clientId + ':', e.message);
  }
}

// ── Post a meme / promo image as a WhatsApp status ───────────
async function postMemeStatus(clientId, sock, setup) {
  try {
    if (!setup.meme_media_urls) {
      console.log('[StatusPoster] No meme_media_urls set for', clientId);
      return;
    }

    var urls = setup.meme_media_urls
      .split(',')
      .map(function(u) { return u.trim(); })
      .filter(Boolean);

    if (!urls.length) return;

    var url     = urls[Math.floor(Math.random() * urls.length)];
    var caption = setup.current_promo || '🔥 Check us out!';

    await sock.sendMessage('status@broadcast', {
      image:   { url: url },
      caption: caption
    });

    await logPost(clientId, 'meme_post', 'Posted meme: ' + url);
    console.log('[StatusPoster] Meme status posted for', clientId);
  } catch (e) {
    console.error('[StatusPoster] postMemeStatus error for', clientId + ':', e.message);
  }
}

// ── Main check — runs every 60 seconds ───────────────────────
async function checkAndPost() {
  try {
    var sb = getSupabase();

    // Get all active, paying clients
    var result = await sb
      .from('clients')
      .select('id')
      .eq('status', 'active')
      .eq('subscription_active', true);

    if (!result.data || !result.data.length) return;

    for (var i = 0; i < result.data.length; i++) {
      var clientId = result.data[i].id;

      // Only process clients that have an active WhatsApp connection
      var sock = sessionManager.getSession(clientId);
      if (!sock) continue;

      try {
        var setupResult = await sb
          .from('bot_setup')
          .select('product_post_time, meme_post_time, schedule_days, meme_media_urls, current_promo')
          .eq('client_id', clientId)
          .single();

        if (!setupResult.data) continue;
        var setup = setupResult.data;

        // Check if today is a scheduled day
        if (!isTodayScheduled(setup.schedule_days)) continue;

        // Product post
        if (setup.product_post_time && isTimeNow(setup.product_post_time)) {
          var doneProduct = await alreadyPostedToday(clientId, 'product_post');
          if (!doneProduct) {
            await postProductStatus(clientId, sock);
          }
        }

        // Meme / promo post
        if (setup.meme_post_time && isTimeNow(setup.meme_post_time)) {
          var doneMeme = await alreadyPostedToday(clientId, 'meme_post');
          if (!doneMeme) {
            await postMemeStatus(clientId, sock, setup);
          }
        }
      } catch (e) {
        console.error('[StatusPoster] Error for client', clientId + ':', e.message);
      }
    }
  } catch (e) {
    console.error('[StatusPoster] checkAndPost error:', e.message);
  }
}

// ── Subscription auto-expiry ──────────────────────────────────
// Runs once a day. Checks every active client:
//  1. If subscription_expires_at has passed → deactivate, notify
//  2. If 3 days away from expiry → send renewal reminder
async function checkSubscriptionExpiry() {
  try {
    var sb  = getSupabase();
    var now = new Date();

    // Fetch all active clients that have an expiry date
    var result = await sb
      .from('clients')
      .select('id, email, full_name, notification_number, subscription_expires_at, plan')
      .eq('subscription_active', true)
      .not('subscription_expires_at', 'is', null);

    if (!result.data || !result.data.length) return;

    for (var i = 0; i < result.data.length; i++) {
      var c      = result.data[i];
      var expiry = new Date(c.subscription_expires_at);
      var daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

      if (daysLeft <= 0) {
        // ── Subscription expired ───────────────────────────────
        console.log('[Scheduler] Subscription expired for', c.id);
        await sb.from('clients')
          .update({ subscription_active: false })
          .eq('id', c.id);

        // Stop the bot for this client
        try { sessionManager.getSession(c.id) && (await sessionManager.stopSession(c.id)); } catch (e) {}

        // Notify the client via WhatsApp if they have a notification number
        var sock = null; // session is stopped, send from another connected session if possible
        // Best effort: log the expiry
        await sb.from('partner_log').insert({
          client_id: c.id,
          action:    'subscription_expired',
          note:      'Auto-expired. subscription_expires_at was ' + c.subscription_expires_at
        }).catch(function() {});

        console.log('[Scheduler] Deactivated expired account:', c.email);

      } else if (daysLeft === 3) {
        // ── 3-day renewal reminder ─────────────────────────────
        console.log('[Scheduler] Sending 3-day renewal reminder to', c.email);

        // Try to send a WhatsApp message to the client's notification number
        var reminderSock = null;
        try {
          // Pick any connected session to relay the message
          var allSessions = sessionManager.getAllSessions();
          if (allSessions.length > 0) {
            reminderSock = sessionManager.getSession(allSessions[0]);
          }
        } catch (e) {}

        if (reminderSock && c.notification_number) {
          var ownerJid = c.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';
          var appUrl   = process.env.APP_URL || 'https://forgebot.up.railway.app';
          try {
            await reminderSock.sendMessage(ownerJid, {
              text:
                '⚠️ *ForgeBot Renewal Reminder*\n\n' +
                'Your ForgeBot subscription expires in *3 days*.\n\n' +
                'To keep your bot running without interruption, renew now:\n' +
                appUrl + '/?renew=1\n\n' +
                '_If you\'ve already renewed, ignore this message._'
            });
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.error('[Scheduler] checkSubscriptionExpiry error:', e.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────
// Call startScheduler() once from index.js / app startup
function startScheduler() {
  console.log('[StatusPoster] Scheduler started — checking every 60s');

  // Status posts: check every 60 seconds
  setTimeout(checkAndPost, 10 * 1000);
  setInterval(checkAndPost, 60 * 1000);

  // Subscription expiry: check once every 24 hours
  // Wait 30s on startup (let everything boot first)
  setTimeout(checkSubscriptionExpiry, 30 * 1000);
  setInterval(checkSubscriptionExpiry, 24 * 60 * 60 * 1000);

  console.log('[StatusPoster] Subscription expiry checker started — runs daily');
}

module.exports = {
  startScheduler,
  checkAndPost,
  checkSubscriptionExpiry,
  postProductStatus,
  postMemeStatus
};
