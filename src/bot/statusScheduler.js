// ============================================================
//  ForgeBot — Status Scheduler (upgraded)
//  src/bot/statusScheduler.js
//
//  Jobs:
//    1. Every minute → check & post due manual status posts
//    2. Every minute → catalogue auto-posting (70-80% per schedule)
//    3. Mon/Wed/Fri/Sat/Sun 8pm → Nigerian business meme
//    4. 1st of month, 9am → monthly analytics WhatsApp summary
//    5. Every minute → run client bot errands (auto-outreach)
// ============================================================

'use strict';

const cron = require('node-cron');
const db   = require('../db/supabase');
const { getCaption } = require('./captions');
const { sessions }   = require('../sessions/sessionManager');

let _openai = null;
function getOpenAI() {
  if (!_openai) {
    const { OpenAI } = require('openai');
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ── Nigerian Business Memes ───────────────────────────────────
const NIGERIAN_MEMES = [
  "Me before ForgeBot: reading 200 unread WhatsApp messages at midnight 😭\nMe after ForgeBot: sleeping peacefully while bot closes sales 🤖💰 #SmallBusinessNaija",
  "Customer: Are you available?\nMe at 3am: 💤💤💤\nForgeBot: YES! We are open 24/7! How can I help you today? 😊\n\nThis bot dey do pass me 😭🔥",
  "The WhatsApp message that came in at 2am while you were sleeping:\n'I want to buy 10 pieces'\n\nForgeBot: Already replied, collected details and sent payment info. You're welcome. 🤖💸",
  "Nigerian customer: How much?\nOther businesses: *no reply for 3 hours*\nForgeBot businesses: Instant reply with price list, availability AND payment details 😎\n\nThe difference is clear.",
  "2015: I will hustle my way to the top 💪\n2025: I automated my WhatsApp and let a bot do the hustling for me 🤖\n\nWork smarter, not harder. #NaijaEntrepreneur",
  "Boss energy = waking up to WhatsApp notifications that say 'Payment confirmed' from sales your bot closed while you slept 💰🛌",
  "Them: You need to be online 24/7 to run a successful business\nMe: 😂 Nah. My bot works the night shift.\n\nThat 24/7 employee that never asks for salary 🤖",
  "Imagine missing a sale because you were busy or sleeping 😩\nImagine not missing ANY sale because your bot replies instantly, always ✅\n\nThat second one? That's us.",
  "Small business owner starter pack:\n😩 Late nights replying customers\n😫 Missing messages\n💸 Lost sales\n\nForgeBot owner starter pack:\n😎 Automated replies\n✅ Zero missed messages\n💰 Sales while sleeping\n\nChoose wisely.",
  "The fact that my WhatsApp bot just replied a customer in Pidgin and made a sale while I was at church 🙏🤖\n\nGod and technology working together 😂",
  "Your competition: manually replying WhatsApp 24/7, stressed, burning out\nYou with automation: automated, organized, sleeping well AND making more sales\n\n2025 is for those who work smart 💡",
  "Customer: Do you deliver to my area?\nMe before: Let me check... *30 min later* Sorry I was busy!\nMe now: Bot replied in 2 seconds with full delivery info 😌\n\nNever lose a customer to slow replies again.",
  "Plot twist: The bot is more professional than me 😭\n\nCustomer: Can I get a discount?\nMe: *would have said yes immediately*\nBot: Our prices are fixed but we offer bulk discounts for 10+ orders 😊\n\nThe bot has better business sense 🤣",
  "When the customer says 'I'll think about it' at 9pm\nAnd your bot sends a follow-up at 10am the next day saying 'Hi! Just checking — we still have stock available 😊'\n\nThat's how you close deals in your sleep 💪",
  "My business hours used to be: whenever I'm awake and not busy\nNow my business hours are: 24 hours, 7 days a week, 365 days a year\n\nThe game has changed. 🤖💰"
];

// ── Internet-style meme formats ───────────────────────────────
const INTERNET_MEMES = [
  { url: 'https://api.memegen.link/images/drake/Manually+replying+WhatsApp+all+day/Letting+my+bot+handle+everything.png', caption: 'Real business owners know the difference 😂🤖' },
  { url: 'https://api.memegen.link/images/doge/such+automation/very+sales/wow.png', caption: 'My WhatsApp bot be like... 😂💰' },
  { url: 'https://api.memegen.link/images/success/Started+with+zero+automation/Now+my+bot+closes+deals+while+I+sleep.png', caption: 'Glow up season 💪🔥' },
  { url: 'https://api.memegen.link/images/batman-slaps-robin/But+I+need+to+manually+reply+customers/You+have+a+WhatsApp+bot+for+that.png', caption: 'Stop doing it the hard way 😂' },
  { url: 'https://api.memegen.link/images/rollsafe/Can%27t+miss+a+sale+if+your+bot+never+sleeps.png', caption: 'Big brain business move 🧠💰' },
  { url: 'https://api.memegen.link/images/two-buttons/Reply+all+customer+messages+manually/Use+an+auto-reply+bot.png', caption: 'The choice is obvious 😌' },
  { url: 'https://api.memegen.link/images/distracted-boyfriend/My+bot/Replying+customers+24~7/Me+sleeping+peacefully.png', caption: 'This is the way 😂🤖' },
  { url: 'https://api.memegen.link/images/y-u-no/Customer/Just+reply+on+time.png', caption: 'Never again with automation 😂✅' }
];

function getWeeklyMeme() {
  var week = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return NIGERIAN_MEMES[week % NIGERIAN_MEMES.length];
}

function getRandomInternetMeme() {
  return INTERNET_MEMES[Math.floor(Math.random() * INTERNET_MEMES.length)];
}

// ── Helpers ───────────────────────────────────────────────────
function getSock(clientId) {
  if (sessions && typeof sessions.get === 'function') return sessions.get(clientId);
  if (sessions && typeof sessions === 'object') return sessions[clientId];
  return null;
}

function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

// ── Post a WhatsApp status ────────────────────────────────────
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
    console.error('[StatusScheduler] Status post failed:', err.message);
  }
}

// ── AI caption generation ─────────────────────────────────────
async function generateAICaption(listing, client) {
  try {
    var openai = getOpenAI();
    var prompt = 'Write a short, engaging WhatsApp status caption for a Nigerian business.\n' +
      'Business: ' + (client.business_name || 'our business') + '\n' +
      'Item: ' + listing.name + '\n' +
      'Price: ' + (listing.price || 'contact us for price') + '\n' +
      'Details: ' + (listing.description || '') + '\n' +
      (listing.location ? 'Location: ' + listing.location + '\n' : '') +
      (client.current_promo ? 'Promo: ' + client.current_promo + '\n' : '') +
      '\nRules: 2-3 sentences MAX. Nigerian/casual tone. 1-2 emojis. End with CTA to DM. Do not mention ForgeBot.';

    var res = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.85
    });
    return res.choices[0].message.content.trim();
  } catch (e) {
    // Fallback caption if AI fails
    var cap = '✨ *' + listing.name + '*';
    if (listing.price) cap += '\n💰 ' + listing.price;
    if (listing.description) cap += '\n\n' + listing.description.slice(0, 100);
    cap += '\n\nDM us to order or get more details! 📩';
    return cap;
  }
}

// ── Catalogue posting session for one client ──────────────────
async function runCatalogueSession(client, todayDayName) {
  var sock = getSock(client.id);
  if (!sock) return;

  var sb = db.getSupabase();

  // Fetch all available listings with their first image
  var result = await sb
    .from('service_listings')
    .select('*, listing_media(url, media_type, sort_order)')
    .eq('client_id', client.id)
    .eq('available', true);

  if (result.error || !result.data || !result.data.length) {
    console.log('[StatusScheduler] No listings for client', client.id);
    return;
  }

  var listings = result.data;

  // Select 70-80% randomly
  var pct      = 0.70 + Math.random() * 0.10;
  var count    = Math.max(1, Math.ceil(listings.length * pct));
  var selected = shuffle(listings).slice(0, count);

  // Build the post queue: mix in memes on meme days
  var schedule   = client.bot_setup || {};
  var incMemes   = schedule.post_include_memes !== false;
  var memeDays   = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  var isMemeDay  = incMemes && memeDays.includes(todayDayName);

  // Insert 1-2 meme slots at random positions in the queue
  var queue = selected.map(function(l) { return { type: 'listing', data: l }; });
  if (isMemeDay && queue.length >= 2) {
    var memeCount = Math.floor(Math.random() * 2) + 1; // 1 or 2 memes
    for (var m = 0; m < memeCount; m++) {
      var memeType = Math.random() > 0.4 ? 'internet' : 'nigerian';
      var pos = Math.floor(Math.random() * (queue.length + 1));
      queue.splice(pos, 0, { type: 'meme', memeType: memeType });
    }
  }

  console.log('[StatusScheduler] Client', client.id, '— posting', queue.length, 'items (' + selected.length + ' listings, memes:', isMemeDay + ')');

  // Post each item with a gap of 2-5 minutes between posts
  for (var i = 0; i < queue.length; i++) {
    var item = queue[i];
    try {
      if (item.type === 'meme') {
        if (item.memeType === 'internet') {
          var meme = getRandomInternetMeme();
          await postStatus(client.id, meme.url, meme.caption);
        } else {
          var text = getWeeklyMeme();
          await postStatus(client.id, null, text);
        }
      } else {
        var listing = item.data;
        var caption = await generateAICaption(listing, client);
        // Get first image from listing
        var images = (listing.listing_media || [])
          .filter(function(m) { return m.media_type === 'image'; })
          .sort(function(a, b) { return a.sort_order - b.sort_order; });
        var imgUrl = images.length ? images[0].url : null;
        await postStatus(client.id, imgUrl, caption);
      }
    } catch (e) {
      console.error('[StatusScheduler] Queue item error:', e.message);
    }

    // Wait 2-4 minutes between posts (WhatsApp status has limits)
    if (i < queue.length - 1) {
      await delay(120000 + Math.random() * 120000);
    }
  }

  console.log('[StatusScheduler] Catalogue session complete for client', client.id);
}

// ── Monthly analytics report ──────────────────────────────────
async function sendToPhone(sock, phone, message) {
  var jid = phone.replace(/\D/g, '') + '@s.whatsapp.net';
  await sock.sendMessage(jid, { text: message });
}

function buildMonthlyReport(client, stats, month) {
  var parts    = month.split('-');
  var yr       = parts[0];
  var monthNum = parts[1];
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var mName    = monthNames[parseInt(monthNum) - 1] + ' ' + yr;
  var revenue  = stats.total_revenue ? '₦' + Number(stats.total_revenue).toLocaleString() : '₦0';

  return (
    '📊 *ForgeBot Monthly Report — ' + mName + '*\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n' +
    '*Business:* ' + (client.business_name || 'Your Business') + '\n\n' +
    '👥 *New Customers:* '          + (stats.new_customers   || 0) + '\n' +
    '🎯 *Price Inquiries (Leads):* ' + (stats.leads           || 0) + '\n' +
    '🛒 *Orders Placed:* '          + (stats.orders_placed   || 0) + '\n' +
    '✅ *Orders Confirmed:* '        + (stats.orders_confirmed || 0) + '\n' +
    '💰 *Revenue Confirmed:* '       + revenue + '\n' +
    '━━━━━━━━━━━━━━━━━━━━━━\n\n' +
    '_View full analytics: ' + (process.env.APP_URL || 'https://forgebot.ng') + '/dashboard_\n\n' +
    'Keep going! 💪 Your bot is working hard for your business. 🤖'
  );
}

// ═════════════════════════════════════════════════════════════
//  MAIN SCHEDULER
// ═════════════════════════════════════════════════════════════

function startScheduler() {

  // ── JOB 1: Every minute — manual due status posts ──────────
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
      console.error('[StatusScheduler] Manual post cron error:', err.message);
    }
  });

  // ── JOB 2: Every minute — catalogue auto-posting ───────────
  cron.schedule('* * * * *', async function() {
    try {
      var now       = new Date();
      var timeStr   = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
      var dayNames  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var today     = dayNames[now.getDay()];
      var todayDate = now.toISOString().split('T')[0];

      var sb = db.getSupabase();

      // Fetch clients whose schedule matches current day + time
      // post_schedule_days is TEXT[] (e.g. ['Mon','Tue','Fri'])
      // post_schedule_time is TEXT (e.g. '09:00')
      var result = await sb
        .from('clients')
        .select('id, business_name, subscription_active, notification_number, occupation, bot_setup:bot_setup(post_schedule_days, post_schedule_time, post_include_memes, current_promo)')
        .eq('status', 'active')
        .eq('subscription_active', true);

      if (result.error || !result.data) return;

      for (var i = 0; i < result.data.length; i++) {
        var client = result.data[i];
        var setup  = client.bot_setup;
        if (!setup || !setup.post_schedule_time || !setup.post_schedule_days) continue;
        if (setup.post_schedule_time !== timeStr) continue;
        if (!setup.post_schedule_days.includes(today)) continue;

        // Check hasn't already run today (use a simple in-memory flag)
        var cacheKey = 'catalogue_' + client.id + '_' + todayDate;
        if (global._catalogueDone && global._catalogueDone[cacheKey]) continue;
        if (!global._catalogueDone) global._catalogueDone = {};
        global._catalogueDone[cacheKey] = true;

        // Run asynchronously so one slow client doesn't block others
        runCatalogueSession(Object.assign({}, client, { bot_setup: setup }), today)
          .catch(function(e) { console.error('[StatusScheduler] Catalogue session error:', e.message); });
      }
    } catch (err) {
      console.error('[StatusScheduler] Catalogue cron error:', err.message);
    }
  });

  // ── JOB 3: Mon/Wed/Fri/Sat/Sun 8pm — weekly meme ──────────
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
        } catch (err) {
          console.error('[StatusScheduler] Meme failed for client', client.id + ':', err.message);
        }
        await delay(2000);
      }
    } catch (err) {
      console.error('[StatusScheduler] Meme cron error:', err.message);
    }
  });

  // ── JOB 4: 1st of month 9am — monthly analytics report ─────
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
        } catch (err) {
          console.error('[StatusScheduler] Monthly report failed for client', client.id + ':', err.message);
        }
        await delay(3000);
      }
    } catch (err) {
      console.error('[StatusScheduler] Monthly report cron error:', err.message);
    }
  });

  // ── JOB 5: Every minute — bot errands ──────────────────────
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

        var sb   = db.getSupabase();
        var jids = [];
        var cutoff = new Date();

        if (task.filter_type === 'all_customers') {
          var r1 = await sb.from('customers').select('jid').eq('client_id', task.client_id).limit(500);
          jids = (r1.data || []).map(function(c) { return c.jid; });
        } else if (task.filter_type === 'pending_orders') {
          var r2 = await sb.from('orders').select('customer_jid').eq('client_id', task.client_id).in('status', ['pending','confirmed']).eq('payment_status','unpaid');
          jids = [...new Set((r2.data || []).map(function(o) { return o.customer_jid; }).filter(Boolean))];
        } else if (task.filter_type === 'inactive_14d') {
          cutoff.setDate(cutoff.getDate() - 14);
          var r3 = await sb.from('customers').select('jid').eq('client_id', task.client_id).lt('last_contact', cutoff.toISOString()).limit(500);
          jids = (r3.data || []).map(function(c) { return c.jid; });
        } else if (task.filter_type === 'inactive_7d') {
          cutoff.setDate(cutoff.getDate() - 7);
          var r4 = await sb.from('customers').select('jid').eq('client_id', task.client_id).lt('last_contact', cutoff.toISOString()).limit(500);
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
            await delay(1500);
          } catch (e) {
            console.error('[BotErrands] Failed for', jids[j] + ':', e.message);
          }
        }

        await db.updateBotTask(task.id, {
          last_run_date: todayDate,
          run_count:     (task.run_count || 0) + 1
        });

        console.log('[BotErrands] Task "' + task.name + '" sent to ' + sent + '/' + jids.length + ' for client', task.client_id);
      }
    } catch (err) {
      console.error('[BotErrands] Cron error:', err.message);
    }
  });

  console.log('[StatusScheduler] All jobs started. Manual posts: every min. Catalogue: every min. Memes: Mon/Wed/Fri/Sat/Sun 8pm. Reports: 1st of month 9am. Bot errands: every min.');
}

module.exports = { startScheduler };
