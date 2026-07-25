// ============================================================
//  ForgeBot — Status Scheduler (fixed)
//  File location: src/bot/statusScheduler.js
//
//  Fixes:
//   1. Use sessionManager.getSession(clientId) — not sessions.get()
//   2. Pass todayDate ISO string to getDueStatusPosts — not "Sat"
// ============================================================

'use strict';

const cron           = require('node-cron');
const db             = require('../db/supabase');
const sessionManager = require('../sessions/sessionManager');

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

// ── Post status for a single client ──────────────────────────
async function postStatus(clientId, mediaUrl, caption) {
  var sock = sessionManager.getSession(clientId);
  if (!sock) {
    console.log('[StatusScheduler] Client', clientId, 'not connected — skipping');
    return;
  }

  try {
    if (mediaUrl) {
      await sock.sendMessage('status@broadcast', {
        image:   { url: mediaUrl },
        caption: caption || ''
      });
    } else {
      await sock.sendMessage('status@broadcast', { text: caption });
    }
    console.log('[StatusScheduler] ✅ Posted status for client', clientId);
  } catch (err) {
    console.error('[StatusScheduler] Failed for client', clientId, ':', err.message);
  }
}

// ── Main scheduler ────────────────────────────────────────────
function startScheduler() {
  // Every minute: check for due scheduled status posts
  cron.schedule('* * * * *', async function() {
    try {
      var now       = new Date();
      var timeStr   = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
      var todayDate = now.toISOString().split('T')[0]; // "2026-07-25" — ISO date, not "Sat"

      // FIX: pass ISO date string, NOT day name like "Sat"
      var duePosts = await db.getDueStatusPosts(timeStr, todayDate);

      for (var i = 0; i < duePosts.length; i++) {
        var post   = duePosts[i];
        // Skip if already posted today (DB already filters, this is a safety check)
        if (post.last_posted === todayDate) continue;

        var client = post.clients;
        if (!client || client.status !== 'active' || !client.subscription_active) continue;

        await postStatus(client.id, post.media_url, post.caption || '');
        await db.markStatusPosted(post.id, todayDate);
      }
    } catch (err) {
      console.error('[StatusScheduler] Cron error:', err.message);
    }
  });

  // Every Sunday at 8pm: post weekly meme to all active clients
  cron.schedule('0 20 * * 0', async function() {
    console.log('[StatusScheduler] Posting weekly meme to all active clients...');
    try {
      var clients = await db.getActiveClients();
      var meme    = getWeeklyMeme();

      for (var i = 0; i < clients.length; i++) {
        var c    = clients[i];
        if (!c.subscription_active) continue;

        var sock = sessionManager.getSession(c.id);
        if (!sock) continue;

        try {
          await sock.sendMessage('status@broadcast', { text: meme });
          console.log('[StatusScheduler] Weekly meme posted for client', c.id);
        } catch (err) {
          console.error('[StatusScheduler] Meme failed for client', c.id, ':', err.message);
        }

        await new Promise(function(r) { setTimeout(r, 2000); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Weekly meme error:', err.message);
    }
  });

  console.log('[StatusScheduler] Started. Posts every minute, memes Sundays 8pm.');
}

module.exports = { startScheduler };
