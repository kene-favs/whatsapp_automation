// ============================================================
//  ForgeBot — Status Scheduler
//  File location: src/scheduler/statusScheduler.js
//  Jobs:
//    1. Every minute  → check & post due status posts
//    2. Sunday 8pm    → post weekly Nigerian business meme
//    3. 1st of month, 9am → send monthly analytics summary to
//       each client's notification_number via WhatsApp
// ============================================================

'use strict';

const cron = require('node-cron');
const db   = require('../db/supabase');
const { getCaption } = require('./captions');
const { sessions }   = require('../sessions/sessionManager');

// ── Nigerian Business Memes (rotate weekly) ──────────────────
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
  const weekNumber = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return MEMES[weekNumber % MEMES.length];
}

// ── Helper: get session sock for a clientId ──────────────────
function getSock(clientId) {
  // sessions may be a Map or a plain object depending on sessionManager
  if (sessions && typeof sessions.get === 'function') return sessions.get(clientId);
  if (sessions && typeof sessions === 'object')        return sessions[clientId];
  return null;
}

// ── Post WhatsApp status for a single client ─────────────────
async function postStatus(clientId, mediaUrl, caption) {
  const sock = getSock(clientId);
  if (!sock) return;
  try {
    if (mediaUrl) {
      await sock.sendMessage('status@broadcast', { image: { url: mediaUrl }, caption: caption || '' });
    } else {
      await sock.sendMessage('status@broadcast', { text: caption });
    }
    console.log('[StatusScheduler] Posted status for client', clientId);
  } catch (err) {
    console.error('[StatusScheduler] Failed for client', clientId + ':', err.message);
  }
}

// ── Send text to a phone number JID ──────────────────────────
async function sendWhatsApp(sock, phone, message) {
  const jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: message });
}

// ── Build monthly analytics report message ────────────────────
function buildMonthlyReport(client, stats, month) {
  const [year, monthNum] = month.split('-');
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthLabel = monthNames[parseInt(monthNum) - 1] + ' ' + year;

  const revenue = stats.total_revenue
    ? '₦' + Number(stats.total_revenue).toLocaleString()
    : '₦0';

  let report =
    '📊 *ForgeBot Monthly Report — ' + monthLabel + '*\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n' +
    '*Business:* ' + (client.business_name || 'Your Business') + '\n\n' +
    '👥 *New Customers:* ' + (stats.new_customers || 0) + '\n' +
    '🎯 *Price Inquiries (Leads):* ' + (stats.leads || 0) + '\n' +
    '🛒 *Orders Placed:* ' + (stats.orders_placed || 0) + '\n' +
    '✅ *Orders Confirmed:* ' + (stats.orders_confirmed || 0) + '\n' +
    '💰 *Revenue Confirmed:* ' + revenue + '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n';

  if (stats.orders_placed > 0 && stats.orders_confirmed > 0) {
    const conv = Math.round((stats.orders_confirmed / stats.orders_placed) * 100);
    report += '📈 *Conversion Rate:* ' + conv + '% of orders confirmed\n';
  }

  report += '\n_View full analytics on your dashboard: ' +
    (process.env.APP_URL || 'https://forgebot.ng') + '/dashboard_\n\n' +
    'Keep going! 💪 Your ForgeBot is working hard for your business. 🤖';

  return report;
}

// ══════════════════════════════════════════════════════════════
//  MAIN SCHEDULER INIT
// ══════════════════════════════════════════════════════════════

function startScheduler() {

  // ── JOB 1: Every minute — check & send due status posts ────
  cron.schedule('* * * * *', async function() {
    try {
      const now      = new Date();
      const timeStr  = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      const days     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const today    = days[now.getDay()];
      const todayDate = now.toISOString().split('T')[0];

      const duePosts = await db.getDueStatusPosts(timeStr, today);

      for (const post of duePosts) {
        if (post.last_posted_date === todayDate) continue;
        const client = post.clients;
        if (!client || client.status !== 'active' || !client.subscription_active) continue;

        const caption = post.caption || getCaption(client.business_type || 'general');
        await postStatus(client.id, post.media_url, caption);
        await db.markStatusPosted(post.id, todayDate);
      }
    } catch (err) {
      console.error('[StatusScheduler] Status post cron error:', err.message);
    }
  });

  // ── JOB 2: Mon / Wed / Fri / Sat / Sun at 8:00pm — post meme
  cron.schedule('0 20 * * 0,1,3,5,6', async function() {
    console.log('[StatusScheduler] Posting meme to all active clients...');
    try {
      const clients = await db.getActiveClients();
      const meme    = getWeeklyMeme();

      for (const client of clients) {
        if (!client.subscription_active) continue;
        const sock = getSock(client.id);
        if (!sock) continue;

        try {
          await sock.sendMessage('status@broadcast', { text: meme });
          console.log('[StatusScheduler] Weekly meme posted for client', client.id);
        } catch (err) {
          console.error('[StatusScheduler] Meme failed for client', client.id + ':', err.message);
        }

        await new Promise(function(r) { setTimeout(r, 2000); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Weekly meme error:', err.message);
    }
  });

  // ── JOB 3: 1st of every month at 9:00am — monthly analytics
  // Sends each client their previous month's performance summary
  // to their notification_number on WhatsApp.
  cron.schedule('0 9 1 * *', async function() {
    console.log('[StatusScheduler] Running monthly analytics reports...');
    try {
      const clients = await db.getActiveClients();

      // We're on the 1st of the current month — report on LAST month
      const now       = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const month     = lastMonth.getFullYear() + '-' +
                        String(lastMonth.getMonth() + 1).padStart(2, '0');

      for (const client of clients) {
        if (!client.subscription_active) continue;
        if (!client.notification_number)  continue;

        const sock = getSock(client.id);
        if (!sock) continue;

        try {
          const stats  = await db.getMonthlyStats(client.id, month);
          const report = buildMonthlyReport(client, stats, month);
          await sendWhatsApp(sock, client.notification_number, report);
          console.log('[StatusScheduler] Monthly report sent for client', client.id, 'month:', month);
        } catch (err) {
          console.error('[StatusScheduler] Monthly report failed for client', client.id + ':', err.message);
        }

        // Spread out messages across clients
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Monthly report cron error:', err.message);
    }
  });

  console.log('[StatusScheduler] Started. Status posts: every minute. Memes: Mon/Wed/Fri/Sat/Sun 8pm. Monthly reports: 1st of month 9am.');
}

module.exports = { startScheduler };
