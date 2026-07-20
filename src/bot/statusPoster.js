// ============================================================
//  ForgeBot — Status Poster
//  src/bot/statusPoster.js
//
//  Caption strategy:
//    Line 1: *Product Name* — ₦Price
//    Line 2: listing.description (the product details)
//    Line 3: random fun/hype caption template
//  This means clients never write captions manually —
//  the description they typed on the listing does the work.
// ============================================================

'use strict';

const db = require('../db/supabase');

const runningPosters = new Map();
const MEME_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri

// ════════════════════════════════════════════════════════════════
//  CAPTION TEMPLATES
// ════════════════════════════════════════════════════════════════

const PRODUCT_CAPTIONS = [
  'Buy this and thank me later 🔥💯',
  'This one will make people ask "where did you get that?" 😂✨',
  'Stop scrolling and order this now! 🛒🔥',
  'You deserve this! Get yours today 😍🛍️',
  'This is selling fast! Don\'t miss out 🏃💨',
  'Your next favourite purchase is right here 👀✨',
  'Quality you can trust 💪🔥',
  'DM us now before it\'s gone! 📲🔥',
  'This will be your best decision today 😊✅',
  'First come, first served! 🙌 Don\'t sleep on this',
  'Abeg don\'t say we didn\'t show you 👀🔥',
  'This thing go make you happy, I promise 😂💯',
  'See quality! Na this one you need 🙌✨',
  'Order now and collect sharp sharp 🏃💨',
  'You go like am, I swear 😂🔥 DM us!',
  'This one na must buy! 💯🛒',
  'No dulling! Grab yours now 🔥💪',
  'Your people go ask you where you buy am 😍✨',
  'Affordable. Quality. Fast delivery. What else? 😊📦',
  'We don\'t joke with quality here 💯✅',
  'Weekend treat for yourself? We\'ve got you 🎁',
  'New arrival! Be the first to own this 🆕🔥',
  'Limited stock! Act fast 🏃🛒',
  'Best price in town, guaranteed 💰✅',
  'Your satisfaction is our priority 🤝💯',
  'Message us NOW to order 📩👇',
  'Tap to order — delivery to your doorstep 🚚📦',
  'DM to place your order today! We deliver 🚀',
  'Enemies no go let you see this, but here you are 😂🔥',
  'Your enemies don\'t want you to see this 😂👀',
  'Na only you wey go see this and not order? 😂👀',
];

const MEME_CAPTIONS = [
  'Tag someone who needs this right now 😂👇',
  'Send this to your bestie 🤣💯',
  'This is your sign to treat yourself today 🎯✨',
  'POV: You just discovered the best shop 👀🔥',
  'We don\'t gatekeep good things 😂💯',
  'Your wallet will hate me, your heart will love me 😂❤️',
  'Plot twist: You needed this before you even knew 😂🔥',
  'Person wey no buy from us, we dey feel sorry for them 😂💯',
  'See life! See good product! Why you dey hesitate? 😂🔥',
  'This week buy am, next week they ask you where you get am 😂✨',
  'No be beans! Order now before price change 😂💪',
  'If you no buy this, you go regret am 😂🔥',
  'Happy customers only 😊✅ Join the family!',
  'Warning: Highly addictive product 😂🔥 DM to order!',
  'Good vibes + good products = happy you 🌟',
  'We stay winning 💯🏆 Come shop with us!',
  'Na your destiny bring you here 😂🔥 DM us now!',
  'God sent you to our page for a reason 😂🙏 Check it out!',
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ════════════════════════════════════════════════════════════════
//  BUILD CAPTION: name + description + fun template
// ════════════════════════════════════════════════════════════════
function buildProductCaption(listing, promo) {
  var price = listing.price_label || (listing.price ? '₦' + Number(listing.price).toLocaleString('en-NG') : null);
  var parts = [];

  // Line 1: name + price
  parts.push(price ? '*' + listing.name + '* — ' + price : '*' + listing.name + '*');

  // Line 2: description (the client already wrote this — no extra input needed)
  if (listing.description && listing.description.trim()) {
    parts.push(listing.description.trim());
  }

  // Line 3: fun hype caption
  parts.push(randomFrom(PRODUCT_CAPTIONS));

  // Optionally append active promo
  if (promo) {
    parts.push('🏷️ ' + promo);
  }

  return parts.join('\n\n');
}

// ════════════════════════════════════════════════════════════════
//  STATUS POST HELPERS
// ════════════════════════════════════════════════════════════════

async function postImageStatus(sock, url, caption) {
  try {
    await sock.sendMessage('status@broadcast', { image: { url: url }, caption: caption }, { statusJidList: [] });
    return true;
  } catch (e) { console.error('[StatusPoster] Image post failed:', e.message); return false; }
}

async function postVideoStatus(sock, url, caption) {
  try {
    await sock.sendMessage('status@broadcast', { video: { url: url }, caption: caption }, { statusJidList: [] });
    return true;
  } catch (e) { console.error('[StatusPoster] Video post failed:', e.message); return false; }
}

async function postTextStatus(sock, text) {
  try {
    await sock.sendMessage('status@broadcast', { text: text, backgroundColor: '#128C7E', font: 2 }, { statusJidList: [] });
    return true;
  } catch (e) { console.error('[StatusPoster] Text post failed:', e.message); return false; }
}

function isVideo(url) {
  if (!url) return false;
  var ext = url.split('?')[0].split('.').pop().toLowerCase();
  return ['mp4', 'mov', 'avi', 'webm', '3gp', 'mkv'].includes(ext);
}

function isWithinWindow(scheduledTime, windowMins) {
  if (!scheduledTime) return false;
  var now     = new Date();
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var parts   = scheduledTime.split(':');
  var target  = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return Math.abs(nowMins - target) <= (windowMins || 5);
}

async function alreadyPostedToday(sb, clientId, logType, key) {
  var today = new Date().toISOString().slice(0, 10);
  try {
    var res = await sb.from('bot_status_log')
      .select('id').eq('client_id', clientId).eq('log_type', logType).eq('note', key || logType)
      .gte('created_at', today + 'T00:00:00Z').single();
    return !!(res && res.data);
  } catch(e) { return false; }
}

async function logPost(sb, clientId, logType, key) {
  try {
    await sb.from('bot_status_log').insert({ client_id: clientId, log_type: logType, note: key || logType, created_at: new Date().toISOString() });
  } catch(e) {}
}

// ════════════════════════════════════════════════════════════════
//  MAIN RUNNER
// ════════════════════════════════════════════════════════════════

async function runClientPosts(clientId, sock) {
  try {
    var sb  = db.getSupabase();
    var now = new Date();
    var day = now.getDay(); // 0=Sun … 6=Sat

    var setupRes;
    try { setupRes = await sb.from('bot_setup').select('*').eq('client_id', clientId).single(); } catch(e) { setupRes = { data: null }; }
    var setup = (setupRes && setupRes.data) || {};
    var promo = setup.current_promo || setup.promo || null;

    // ── 1. MANUAL SCHEDULED POSTS (from Status Posts tab) ──────
    var postsRes = await sb.from('status_posts').select('*').eq('client_id', clientId).order('created_at', { ascending: true });
    var scheduledPosts = postsRes.data || [];

    for (var i = 0; i < scheduledPosts.length; i++) {
      var post = scheduledPosts[i];
      if (!post.post_time || !isWithinWindow(post.post_time)) continue;
      var today = now.toISOString().slice(0, 10);
      if (post.last_posted && post.last_posted.slice(0, 10) === today) continue;

      // Check scheduled days
      if (post.scheduled_days) {
        var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        var todayName = dayNames[day];
        if (!post.scheduled_days.includes(todayName)) continue;
      }

      var posted = false;
      if (post.media_url) {
        var cap = post.caption || buildProductCaption({ name: 'New Arrival', description: null }, promo);
        posted = isVideo(post.media_url) ? await postVideoStatus(sock, post.media_url, cap) : await postImageStatus(sock, post.media_url, cap);
      } else if (post.caption) {
        posted = await postTextStatus(sock, post.caption);
      }

      if (posted) {
        await sb.from('status_posts').update({ last_posted: now.toISOString(), post_count: (post.post_count || 0) + 1 }).eq('id', post.id);
        console.log('[StatusPoster] Manual post sent for client ' + clientId);
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    }

    // ── 2. AUTO PRODUCT POSTS (from listings — 70-80% of posts) ─
    var productPostTime = setup.product_post_time || '09:00';
    if (isWithinWindow(productPostTime)) {
      var prodPostedToday = await alreadyPostedToday(sb, clientId, 'product_post', 'product_post');
      if (!prodPostedToday) {
        var listRes = await sb.from('service_listings')
          .select('id, name, description, price, price_label, listing_media(url, media_type, sort_order)')
          .eq('client_id', clientId).eq('available', true).order('created_at', { ascending: false });

        var listings = (listRes.data || []).filter(function(l) { return l.listing_media && l.listing_media.length > 0; });

        if (listings.length) {
          listings = listings.sort(function() { return Math.random() - 0.5; });
          var toPost = listings.slice(0, Math.min(4, listings.length));
          var anyPosted = false;

          for (var j = 0; j < toPost.length; j++) {
            var listing = toPost[j];
            // Build caption: name + description + fun template (the key fix)
            var cap = buildProductCaption(listing, promo);

            var media  = (listing.listing_media || []).sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
            var images = media.filter(function(m) { return m.media_type === 'image'; });
            var videos = media.filter(function(m) { return m.media_type === 'video'; });

            // Post images (up to 3 per listing)
            for (var k = 0; k < Math.min(images.length, 3); k++) {
              await postImageStatus(sock, images[k].url, k === 0 ? cap : '*' + listing.name + '*');
              await new Promise(function(r) { setTimeout(r, 2000); });
              anyPosted = true;
            }

            // Post videos together with images
            for (var v = 0; v < Math.min(videos.length, 2); v++) {
              await postVideoStatus(sock, videos[v].url, v === 0 ? cap : '*' + listing.name + '*');
              await new Promise(function(r) { setTimeout(r, 2500); });
              anyPosted = true;
            }

            await new Promise(function(r) { setTimeout(r, 2000); });
          }

          if (anyPosted) {
            await logPost(sb, clientId, 'product_post', 'product_post');
            console.log('[StatusPoster] Product posts sent for client ' + clientId);
          }
        }
      }
    }

    // ── 3. MEME POSTS (Mon–Fri only, 20-30% of posts) ──────────
    if (!MEME_DAYS.includes(day)) return;
    var memePostTime = setup.meme_post_time || '12:00';
    if (!isWithinWindow(memePostTime)) return;

    var memePostedToday = await alreadyPostedToday(sb, clientId, 'meme_post', 'meme_post');
    if (memePostedToday) return;

    var memeUrls = [];
    if (setup.meme_media_urls) {
      memeUrls = setup.meme_media_urls.split(',').map(function(u) { return u.trim(); }).filter(Boolean);
    }

    var memePosted = false;
    var memeCap    = randomFrom(MEME_CAPTIONS);

    if (memeUrls.length) {
      var shuffledMemes = memeUrls.sort(function() { return Math.random() - 0.5; });
      for (var m = 0; m < Math.min(shuffledMemes.length, 2); m++) {
        if (isVideo(shuffledMemes[m])) await postVideoStatus(sock, shuffledMemes[m], m === 0 ? memeCap : '');
        else await postImageStatus(sock, shuffledMemes[m], m === 0 ? memeCap : '');
        await new Promise(function(r) { setTimeout(r, 2000); });
        memePosted = true;
      }
    } else {
      // No meme images set — post a funny text status
      memePosted = await postTextStatus(sock, memeCap + '\n\n📲 Message us to shop!');
    }

    // After meme, always follow with a product (70-80% rule)
    if (memePosted) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      var followRes = await sb.from('service_listings')
        .select('id, name, description, price, price_label, listing_media(url, media_type)')
        .eq('client_id', clientId).eq('available', true).limit(20);

      var followListings = (followRes.data || []).filter(function(l) { return l.listing_media && l.listing_media.length > 0; });
      if (followListings.length) {
        var pick   = followListings[Math.floor(Math.random() * followListings.length)];
        var pMedia = (pick.listing_media || []).sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
        var pImg   = pMedia.find(function(m) { return m.media_type === 'image'; });
        var pVid   = pMedia.find(function(m) { return m.media_type === 'video'; });
        var pCap   = buildProductCaption(pick, promo); // uses description here too
        if (pImg) await postImageStatus(sock, pImg.url, pCap);
        if (pVid) { await new Promise(function(r) { setTimeout(r, 2000); }); await postVideoStatus(sock, pVid.url, '*' + pick.name + '*'); }
      }

      await logPost(sb, clientId, 'meme_post', 'meme_post');
      console.log('[StatusPoster] Meme + follow-up posted for client ' + clientId);
    }

  } catch (e) {
    console.error('[StatusPoster] Error for client ' + clientId + ':', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  START / STOP
// ════════════════════════════════════════════════════════════════

async function startStatusPoster(clientId, sock) {
  if (runningPosters.has(clientId)) clearInterval(runningPosters.get(clientId));
  console.log('[StatusPoster] Starting for client ' + clientId);
  runClientPosts(clientId, sock).catch(function(e) { console.error('[StatusPoster] Initial run error:', e.message); });
  var interval = setInterval(function() {
    runClientPosts(clientId, sock).catch(function(e) { console.error('[StatusPoster] Interval error:', e.message); });
  }, 5 * 60 * 1000);
  runningPosters.set(clientId, interval);
}

function stopStatusPoster(clientId) {
  if (runningPosters.has(clientId)) {
    clearInterval(runningPosters.get(clientId));
    runningPosters.delete(clientId);
    console.log('[StatusPoster] Stopped for client ' + clientId);
  }
}

module.exports = { startStatusPoster, stopStatusPoster };
