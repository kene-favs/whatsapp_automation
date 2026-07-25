// ============================================================
//  ForgeBot — Status Scheduler
//  File location: src/bot/statusScheduler.js
//
//  Fix applied:
//   - REPLACED broken `const { sessions } = require(...)` import.
//     `sessions` was never exported from sessionManager, so it was
//     always undefined and getSock() always returned null → status
//     posts, memes, and bot errands never fired.
//     Now uses `sessionManager.getSession(clientId)` correctly.
//   - Job 5 (daily 3am subscription expiry check) included.
//   ALL other logic preserved exactly as on GitHub.
// ============================================================

'use strict';

const cron           = require('node-cron');
const db             = require('../db/supabase');
const { getCaption } = require('./captions');

// FIX: Import sessionManager and use .getSession() — sessions object was never exported
const sessionManager = require('../sessions/sessionManager');

// ── Nigerian Business Memes (rotate by week) ─────────────────
const MEMES = [
  "Me before ForgeBot: reading 200 unread WhatsApp messages at midnight 😭\nMe after ForgeBot: sleeping peacefully while bot closes sales 🤖💰 #SmallBusinessNaija",
  "Customer: Are you available?\nMe at 3am: 💤💤💤\nForgeBot: YES! We are open 24/7! How can I help you today? 😊\n\nThis bot dey do pass me 😭🔥 #ForgeBot",
  "The WhatsApp message that came in at 2am while you were sleeping:\n'I want to buy 10 pieces'\n\nForgeBot: Already replied, collected details and sent payment info. You're welcome. 🤖💸",
  "Nigerian customer: How much?\nOther businesses: *no reply for 3 hours*\nForgeBot businesses: Instant reply with price list, availability AND payment details 😎\n\nThe difference is clear. #AutomateYourBusiness",
  "2015: I will hustle my way to the top 💪\n2025: I automated my WhatsApp and let a bot do the hustling for me 🤖\n\nWork smarter, not harder. #ForgeBot #NaijaEntrepreneur",
  "Boss energy = waking up to WhatsApp notifications that say 'Payment confirmed' from sales your bot closed while you slept 💰🛌 #PassiveIncome",
  "Them: You need to be online 24/7 to run a successful business\nMe: 😂 Nah. My bot works the night shift.\n\n#ForgeBot is that 24/7 employee that never asks for salary 🤖",
  "Imagine missing a sale because you were busy or sleeping 😩\nImagine not missing ANY sale because your bot replies instantly, always ✅\n\nThat second one? That's us. #ForgeBot",
  "Customer texts at 7am before you're even awake:\n'Good morning, do you have this in red?'\n\nYour ForgeBot: Good morning! Yes we do! Here are the available sizes and prices 😊\n\nYou wake up to a confirmed order. Beautiful. 💪",
  "Things that are working even when you're resting:\n✅ Your lungs\n✅ Your heart\n✅ Your ForgeBot\n\nLet the automation breathe for your business 🔥 #NaijaHustle",
  "Small business owner starter pack:\n😩 Late nights replying customers\n😫 Missing messages\n💸 Lost sales\n\nForgeBot owner starter pack:\n😎 Automated replies\n✅ Zero missed messages\n💰 Sales while sleeping\n\nChoose wisely.",
  "The fact that my WhatsApp bot just replied a customer in Pidgin and made a sale while I was at church 🙏🤖\n\nGod and technology working together 😂 #ForgeBot",
  "Your competition: manually replying WhatsApp 24/7, stressed, burning out\nYou with ForgeBot: automated, organized, sleeping well AND making more sales\n\n2025 is for those who work smart 💡 #NaijaEntrepreneur",
  "Customer: Do you deliver to my area?\nMe (before): Let me check... *30 min later* Sorry I was busy!\nMe (after ForgeBot): Bot replied in 2 seconds with full delivery info 😌\n\nNever lose a customer to slow replies again.",
  "The audacity of this bot 😂\nCustomer sent a voice note in Yoruba at midnight\nForgeBot: *transcribed it* *replied in English* *sent price list*\n\nI woke up to a completed order. This thing is something else 🔥 #ForgeBot",
  "Top 3 things Nigerian business owners worry about:\n1. Sales dropping\n2. Missing customers\n3. NEPA taking light\n\nForgeBot handles number 1 and 2.\nFor number 3... we're working on it 😂 #NaijaProblems",
  "Plot twist: The bot is more professional than me 😭\n\nCustomer: Can I get a discount?\nMe: *would have said yes immediately*\nForgeBot: Thank you for asking! Our prices are fixed but we offer bulk discounts for 10+ orders 😊\n\nThe bot has better business sense 🤣 #ForgeBot",
  "Hustle culture said work 18 hours a day 😤\nForgeBot said: work smart, automate the rest, and enjoy your life 😌\n\nThe real glow up is automating your WhatsApp and getting your time back 💯 #NaijaEntrepreneur",
  "When the customer says 'I'll think about it' at 9pm\nAnd your ForgeBot sends a follow-up at 10am the next day saying 'Hi! Just checking if you made a decision? We still have stock available 😊'\n\nThat's how you close deals in your sleep 💪",
  "My business hours used to be: whenever I'm awake and not busy\nNow my business hours are: 24 hours, 7 days a week, 365 days a year\n\nAll because of a WhatsApp bot. The game has changed. 🤖💰 #ForgeBot"
];

function getWeeklyMeme() {
  var weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return MEMES[weekNumber % MEMES.length];
}

// ── FIX: getSock now correctly returns the active socket ──────
// OLD (broken): const { sessions } = require('../sessions/sessionManager')
//   `sessions` was never in the exports → always undefined → always null
// NEW (fixed):
function getSock(clientId) {
  return sessionManager.getSession(clientId);
}

// ── Post WhatsApp status for a single client ─────────────────
async function postStatus(clientId, mediaUrl, caption) {
  var sock = getSock(clientId);
  if (!sock) return;
  try {
    if (mediaUrl) {
      await sock.sendMessage('status@broadcast', { image: { url: mediaUrl }, caption: caption || '' });
    } else {
      await sock.sendMessage('status@broadcast', { text: caption });
    }
    console.log('[StatusScheduler] Status posted for client', clientId);
  } catch (err) {
    console.error('[StatusScheduler] Status post failed for client', clientId + ':', err.message);
  }
}

// ── Send WhatsApp to a phone number ──────────────────────────
async function sendToPhone(sock, phone, message) {
  var jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: message });
}

// ── Build monthly analytics report ───────────────────────────
function buildMonthlyReport(client, stats, month) {
  var parts      = month.split('-');
  var year       = parts[0];
  var monthNum   = parts[1];
  var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var monthLabel = monthNames[parseInt(monthNum) - 1] + ' ' + year;
  var revenue    = stats.total_revenue ? '₦' + Number(stats.total_revenue).toLocaleString() : '₦0';

  return (
    '📊 *ForgeBot Monthly Report — ' + monthLabel + '*\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n' +
    '*Business:* ' + (client.business_name || 'Your Business') + '\n\n' +
    '👥 *New Customers:* '           + (stats.new_customers    || 0) + '\n' +
    '🎯 *Price Inquiries (Leads):* ' + (stats.leads            || 0) + '\n' +
    '🛒 *Orders Placed:* '           + (stats.orders_placed    || 0) + '\n' +
    '✅ *Orders Confirmed:* '         + (stats.orders_confirmed || 0) + '\n' +
    '💰 *Revenue Confirmed:* '        + revenue + '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '_View full analytics: ' + (process.env.APP_URL || 'https://forgebot.ng') + '/dashboard_\n\n' +
    'Keep going! 💪 Your ForgeBot is working hard for your business. 🤖'
  );
}

// ══════════════════════════════════════════════════════════════
//  MAIN SCHEDULER
// ══════════════════════════════════════════════════════════════

function startScheduler() {

  // ── JOB 1: Every minute — due status posts ─────────────────
  cron.schedule('* * * * *', async function() {
    try {
      var now       = new Date();
      var timeStr   = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      var dayNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var today     = dayNames[now.getDay()];
      var todayDate = now.toISOString().split('T')[0];

      var duePosts = await db.getDueStatusPosts(timeStr, todayDate);

      for (var i = 0; i < duePosts.length; i++) {
        var post = duePosts[i];
        if (post.last_posted === todayDate) continue;

        var scheduledDays = (post.scheduled_days || post.days || '').toLowerCase();
        if (scheduledDays && !scheduledDays.includes(today.toLowerCase())) continue;

        var client = post.clients;
        if (!client || client.status !== 'active' || !client.subscription_active) continue;

        var caption = post.caption || getCaption(client.business_type || 'general');
        await postStatus(client.id, post.media_url, caption);
        await db.markStatusPosted(post.id, todayDate);
      }
    } catch (err) {
      console.error('[StatusScheduler] Status post cron error:', err.message);
    }
  });

  // ── JOB 2: Mon/Wed/Fri/Sat/Sun at 8pm — post meme ─────────
  cron.schedule('0 20 * * 0,1,3,5,6', async function() {
    console.log('[StatusScheduler] Posting meme to all active clients...');
    try {
      var clients = await db.getActiveClients();
      var meme    = getWeeklyMeme();
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client.subscription_active) continue;
        var sock = getSock(client.id);
        if (!sock) continue;
        try {
          await sock.sendMessage('status@broadcast', { text: meme });
          console.log('[StatusScheduler] Meme posted for client', client.id);
        } catch (err) {
          console.error('[StatusScheduler] Meme failed for client', client.id + ':', err.message);
        }
        await new Promise(function(r) { setTimeout(r, 2000); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Meme cron error:', err.message);
    }
  });

  // ── JOB 3: 1st of month at 9am — monthly analytics report ──
  cron.schedule('0 9 1 * *', async function() {
    console.log('[StatusScheduler] Running monthly analytics reports...');
    try {
      var clients   = await db.getActiveClients();
      var now       = new Date();
      var lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var month     = lastMonth.getFullYear() + '-' + String(lastMonth.getMonth() + 1).padStart(2, '0');

      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (!client.subscription_active || !client.notification_number) continue;
        var sock = getSock(client.id);
        if (!sock) continue;
        try {
          var stats  = await db.getMonthlyStats(client.id, month);
          var report = buildMonthlyReport(client, stats, month);
          await sendToPhone(sock, client.notification_number, report);
          console.log('[StatusScheduler] Monthly report sent for client', client.id);
        } catch (err) {
          console.error('[StatusScheduler] Monthly report failed for client', client.id + ':', err.message);
        }
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Monthly report cron error:', err.message);
    }
  });

  // ── JOB 4: Every minute — run due bot errands ──────────────
  cron.schedule('* * * * *', async function() {
    try {
      var now       = new Date();
      var timeStr   = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      var dayNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var today     = dayNames[now.getDay()];
      var todayDate = now.toISOString().split('T')[0];

      var tasks = await db.getDueBotTasks(timeStr);

      for (var t = 0; t < tasks.length; t++) {
        var task = tasks[t];
        if (task.last_run_date === todayDate) continue;

        var scheduledDays = (task.schedule_days || '').toLowerCase();
        if (scheduledDays && !scheduledDays.includes(today.toLowerCase())) continue;

        var client = task.clients;
        if (!client || !client.subscription_active) continue;

        var sock = getSock(task.client_id);
        if (!sock) continue;

        var sb     = db.getSupabase();
        var jids   = [];
        var cutoff = new Date();

        if (task.filter_type === 'all_customers') {
          var r1 = await sb.from('customers').select('jid').eq('client_id', task.client_id).limit(500);
          jids = (r1.data || []).map(function(c) { return c.jid; });

        } else if (task.filter_type === 'pending_orders') {
          var r2 = await sb.from('orders').select('customer_jid')
            .eq('client_id', task.client_id)
            .in('status', ['pending', 'awaiting_receipt', 'confirmed'])
            .eq('payment_status', 'unpaid');
          jids = [...new Set((r2.data || []).map(function(o) { return o.customer_jid; }).filter(Boolean))];

        } else if (task.filter_type === 'inactive_14d') {
          cutoff.setDate(cutoff.getDate() - 14);
          var r3 = await sb.from('customers').select('jid').eq('client_id', task.client_id)
            .lt('last_contact', cutoff.toISOString()).limit(500);
          jids = (r3.data || []).map(function(c) { return c.jid; });

        } else if (task.filter_type === 'inactive_7d') {
          cutoff.setDate(cutoff.getDate() - 7);
          var r4 = await sb.from('customers').select('jid').eq('client_id', task.client_id)
            .lt('last_contact', cutoff.toISOString()).limit(500);
          jids = (r4.data || []).map(function(c) { return c.jid; });
        }

        if (!jids.length) {
          await db.updateBotTask(task.id, { last_run_date: todayDate });
          continue;
        }

        var sent = 0;
        for (var j = 0; j < jids.length; j++) {
          try {
            await sock.sendMessage(jids[j], { text: task.message });
            sent++;
            await new Promise(function(r) { setTimeout(r, 1500); });
          } catch (e) {
            console.error('[BotErrands] Failed for', jids[j] + ':', e.message);
          }
        }

        await db.updateBotTask(task.id, {
          last_run_date: todayDate,
          run_count:     (task.run_count || 0) + 1
        });

        console.log('[BotErrands] Task "' + task.name + '" sent to ' + sent + '/' + jids.length + ' customers for client', task.client_id);
      }
    } catch (err) {
      console.error('[BotErrands] Cron error:', err.message);
    }
  });

  // ── JOB 5: Daily at 3am — subscription expiry check ────────
  // Stops the bot for any client whose subscription_expires_at has passed
  cron.schedule('0 3 * * *', async function() {
    try {
      var sb     = db.getSupabase();
      var now    = new Date().toISOString();
      var result = await sb.from('clients')
        .select('id, business_name')
        .eq('subscription_active', true)
        .not('subscription_expires_at', 'is', null)
        .lt('subscription_expires_at', now);

      var expired = result.data || [];
      for (var i = 0; i < expired.length; i++) {
        await sb.from('clients').update({ subscription_active: false }).eq('id', expired[i].id);
        console.log('[StatusScheduler] Subscription expired — bot stopped for', expired[i].business_name || expired[i].id);
      }
      if (expired.length) {
        console.log('[StatusScheduler] Expiry check done:', expired.length, 'subscription(s) deactivated');
      }
    } catch (err) {
      console.error('[StatusScheduler] Expiry check error:', err.message);
    }
  });

  console.log('[StatusScheduler] Started – status posts: every minute | memes: Mon/Wed/Fri/Sat/Sun 8pm | reports: 1st of month 9am | bot errands: every minute | expiry check: daily 3am');
}

module.exports = { startScheduler };
