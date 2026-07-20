// ============================================================
//  ForgeBot — Status Poster
//  src/bot/statusPoster.js
//
//  What this does:
//   - Posts WhatsApp statuses automatically on a schedule
//   - 70-80% product images/videos (with captions)
//   - 20-30% internet memes / promo posts
//   - Rotates through a rich library of caption templates
//   - Meme posts Mon–Fri (5 days a week)
//   - Images + videos posted TOGETHER in the same session
//   - Checks every 5 minutes against scheduled post times
// ============================================================

'use strict';

const db = require('../db/supabase');

// ── Running posters tracker ────────────────────────────────
const runningPosters = new Map();

// ── Meme days (Mon=1 through Fri=5) ───────────────────────
const MEME_DAYS = [1, 2, 3, 4, 5]; // Mon–Fri, 5 days a week

// ════════════════════════════════════════════════════════════
//  CAPTION TEMPLATES
//  Rotated randomly for each status post
// ════════════════════════════════════════════════════════════

const PRODUCT_CAPTIONS = [
  // Hype captions
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
  // Nigerian style
  'Abeg don\'t say we didn\'t show you 👀🔥',
  'This thing go make you happy, I promise 😂💯',
  'See quality! Na this one you need 🙌✨',
  'Order now and collect sharp sharp 🏃💨',
  'You go like am, I swear 😂🔥 DM us!',
  'This one na must buy! 💯🛒',
  'No dulling! Grab yours now 🔥💪',
  'Your people go ask you where you buy am 😍✨',
  // Value captions
  'Affordable. Quality. Fast delivery. What else? 😊📦',
  'We don\'t joke with quality here 💯✅',
  'Weekend treat for yourself? We\'ve got you 🎁',
  'New arrival! Be the first to own this 🆕🔥',
  'Limited stock! Act fast 🏃🛒',
  'Best price in town, guaranteed 💰✅',
  'Your satisfaction is our priority 🤝💯',
  // Call to action
  'Message us NOW to order 📩👇',
  'Tap to order — delivery to your doorstep 🚚📦',
  'DM to place your order today! We deliver 🚀',
  'Comment "MINE" to claim yours 👇🔥',
  'Click our link in bio or DM us 📲✨',
];

const MEME_CAPTIONS = [
  // Funny engagement captions
  'Tag someone who needs this right now 😂👇',
  'Send this to your bestie 🤣💯',
  'Me when I see our products 😍🔥',
  'This is your sign to treat yourself today 🎯✨',
  'POV: You just discovered us 👀🔥',
  'We don\'t gatekeep good things 😂💯',
  'Tell me you have good taste without telling me 😏✨',
  'The most important decision you\'ll make today 👇😂',
  'Your wallet will hate me, your heart will love me 😂❤️',
  'Plot twist: You needed this before you even knew 😂🔥',
  // Nigerian meme energy
  'Person wey no buy from us, we dey feel sorry for them 😂💯',
  'See life! See good product! Why you dey hesitate? 😂🔥',
  'Your enemies don\'t want you to see this 😂👀',
  'This week buy am, next week they ask you where you get am 😂✨',
  'No be beans! Order now before price change 😂💪',
  'If you no buy this, you go regret am 😂🔥',
  'Na only you wey go see this and not order? 😂👀',
  // General fun
  'Happy customers only 😊✅ Join the family!',
  'Good vibes + good products = happy you 🌟',
  'Warning: Highly addictive product 😂🔥 DM to order!',
  'Your life before us vs after us 😂✨',
  'We stay winning 💯🏆 Come shop with us!',
];

const PROMO_CAPTIONS = [
  'SPECIAL OFFER! 🔥 Don\'t miss this one 👇',
  '🎁 We\'re feeling generous today! Check this out',
  '⚡ Flash deal! Limited time only 🏃',
  '💥 Big savings on quality items! Order now',
  '🎉 Celebration special — treat yourself today!',
  '✨ Exclusive deal for our loyal customers 💯',
  '🔥 Hot deal alert! This won\'t last long',
  '💰 Save big without compromising quality ✅',
];

// ── Pick a random caption ──────────────────────────────────
function randomCaption(arr, promo) {
  // If there's a promo, mix it in 40% of the time
  if (promo && Math.random() < 0.4) {
    var promoLine = PROMO_CAPTIONS[Math.floor(Math.random() * PROMO_CAPTIONS.length)];
    return promoLine + '\n\n' + promo;
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

// ════════════════════════════════════════════════════════════
//  STATUS POST HELPERS
// ════════════════════════════════════════════════════════════

async function postImageStatus(sock, url, caption) {
  try {
    await sock.sendMessage('status@broadcast', {
      image:   { url: url },
      caption: caption
    }, { statusJidList: [] });
    return true;
  } catch (e) {
    console.error('[StatusPoster] Image post failed:', e.message);
    return false;
  }
}

async function postVideoStatus(sock, url, caption) {
  try {
    await sock.sendMessage('status@broadcast', {
      video:   { url: url },
      caption: caption
    }, { statusJidList: [] });
    return true;
  } catch (e) {
    console.error('[StatusPoster] Video post failed:', e.message);
    return false;
  }
}

async function postTextStatus(sock, text) {
  try {
    await sock.sendMessage('status@broadcast', {
      text:            text,
      backgroundColor: '#128C7E',
      font:            2
    }, { statusJidList: [] });
    return true;
  } catch (e) {
    console.error('[StatusPoster] Text post failed:', e.message);
    return false;
  }
}

// ── Detect if URL is a video ───────────────────────────────
function isVideo(url) {
  if (!url) return false;
  var ext = url.split('?')[0].split('.').pop().toLowerCase();
  return ['mp4', 'mov', 'avi', 'webm', '3gp', 'mkv'].includes(ext);
}

// ── Is now within 5 min window of target time ─────────────
function isWithinWindow(scheduledTime, windowMins) {
  if (!scheduledTime) return false;
  var now      = new Date();
  var nowMins  = now.getHours() * 60 + now.getMinutes();
  var parts    = scheduledTime.split(':');
  var target   = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return Math.abs(nowMins - target) <= (windowMins || 5);
}

// ── Check if already posted today (by log type + key) ─────
async function alreadyPostedToday(sb, clientId, logType, key) {
  var today = new Date().toISOString().slice(0, 10);
  var res = await sb.from('bot_status_log')
    .select('id')
    .eq('client_id', clientId)
    .eq('log_type',  logType)
    .eq('note',      key || logType)
    .gte('created_at', today + 'T00:00:00Z')
    .single()
    .catch(function() { return { data: null }; });
  return !!res.data;
}

async function logPost(sb, clientId, logType, key) {
  await sb.from('bot_status_log').insert({
    client_id:  clientId,
    log_type:   logType,
    note:       key || logType,
    created_at: new Date().toISOString()
  }).catch(function() {});
}

// ════════════════════════════════════════════════════════════
//  MAIN POST RUNNER — runs for one client
// ════════════════════════════════════════════════════════════

async function runClientPosts(clientId, sock) {
  try {
    var sb  = db.getSupabase();
    var now = new Date();
    var day = now.getDay(); // 0=Sun … 6=Sat

    // ── Load bot_setup ─────────────────────────────────────
    var setupRes = await sb.from('bot_setup')
      .select('*')
      .eq('client_id', clientId)
      .single()
      .catch(function() { return { data: null }; });
    var setup = setupRes.data || {};
    var promo = setup.current_promo || null;

    // ── 1. SCHEDULED STATUS POSTS (manual, from Status Posts tab) ──
    var postsRes = await sb.from('status_posts')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });
    var scheduledPosts = postsRes.data || [];

    for (var i = 0; i < scheduledPosts.length; i++) {
      var post = scheduledPosts[i];
      if (!post.post_time) continue;
      if (!isWithinWindow(post.post_time)) continue;

      var today = now.toISOString().slice(0, 10);
      if (post.last_posted && post.last_posted.slice(0, 10) === today) continue;

      var posted = false;
      if (post.media_url) {
        var caption = post.caption || randomCaption(PRODUCT_CAPTIONS, promo);
        if (isVideo(post.media_url)) {
          posted = await postVideoStatus(sock, post.media_url, caption);
        } else {
          posted = await postImageStatus(sock, post.media_url, caption);
        }
      } else if (post.caption) {
        posted = await postTextStatus(sock, post.caption);
      }

      if (posted) {
        await sb.from('status_posts').update({
          last_posted: now.toISOString(),
          post_count:  (post.post_count || 0) + 1
        }).eq('id', post.id);
        console.log('[StatusPoster] Scheduled post sent for client ' + clientId);
        await new Promise(function(r) { setTimeout(r, 3000); });
      }
    }

    // ── 2. PRODUCT MEDIA POSTS (70-80% of auto-posts) ──────
    var productPostTime = setup.product_post_time || '09:00';
    if (isWithinWindow(productPostTime)) {
      var prodPostedToday = await alreadyPostedToday(sb, clientId, 'product_post', 'product_post');
      if (!prodPostedToday) {
        // Fetch all available listings with media
        var listRes = await sb.from('service_listings')
          .select('name, price, price_label, listing_media(url, media_type, sort_order)')
          .eq('client_id', clientId)
          .eq('available', true)
          .order('created_at', { ascending: false });

        var listings = (listRes.data || []).filter(function(l) {
          return l.listing_media && l.listing_media.length > 0;
        });

        if (listings.length) {
          // Shuffle and pick 2-4 listings to post
          listings = listings.sort(function() { return Math.random() - 0.5; });
          var toPost = listings.slice(0, Math.min(4, listings.length));
          var anyPosted = false;

          for (var j = 0; j < toPost.length; j++) {
            var listing  = toPost[j];
            var price    = listing.price_label || (listing.price ? '₦' + Number(listing.price).toLocaleString('en-NG') : null);
            var cap      = randomCaption(PRODUCT_CAPTIONS, promo);
            if (price) cap = '*' + listing.name + '* — ' + price + '\n\n' + cap;
            else       cap = '*' + listing.name + '*\n\n' + cap;

            // Sort media: images first, then videos
            var media = (listing.listing_media || []).sort(function(a, b) {
              return (a.sort_order || 0) - (b.sort_order || 0);
            });
            var images = media.filter(function(m) { return m.media_type === 'image'; });
            var videos = media.filter(function(m) { return m.media_type === 'video'; });

            // Post images (up to 3 per listing)
            for (var k = 0; k < Math.min(images.length, 3); k++) {
              await postImageStatus(sock, images[k].url, k === 0 ? cap : listing.name);
              await new Promise(function(r) { setTimeout(r, 2000); });
              anyPosted = true;
            }

            // Post videos TOGETHER with images (up to 2 per listing)
            for (var v = 0; v < Math.min(videos.length, 2); v++) {
              await postVideoStatus(sock, videos[v].url, v === 0 ? cap : listing.name);
              await new Promise(function(r) { setTimeout(r, 2500); });
              anyPosted = true;
            }

            await new Promise(function(r) { setTimeout(r, 2000); });
          }

          if (anyPosted) {
            await logPost(sb, clientId, 'product_post', 'product_post');
            console.log('[StatusPoster] Product media posted for client ' + clientId);
          }
        }
      }
    }

    // ── 3. MEME POSTS (20-30%, Mon–Fri only) ───────────────
    if (!MEME_DAYS.includes(day)) return;

    var memePostTime = setup.meme_post_time || '12:00';
    if (!isWithinWindow(memePostTime)) return;

    var memePostedToday = await alreadyPostedToday(sb, clientId, 'meme_post', 'meme_post');
    if (memePostedToday) return;

    // Meme URLs the client uploaded (comma-separated in bot_setup.meme_media_urls)
    var memeUrls = [];
    if (setup.meme_media_urls) {
      memeUrls = setup.meme_media_urls.split(',').map(function(u) { return u.trim(); }).filter(Boolean);
    }

    var memePosted = false;

    if (memeUrls.length) {
      // Pick 1-2 random meme URLs
      var shuffled = memeUrls.sort(function() { return Math.random() - 0.5; });
      var memeCap  = randomCaption(MEME_CAPTIONS, promo);
      for (var m = 0; m < Math.min(shuffled.length, 2); m++) {
        if (isVideo(shuffled[m])) {
          await postVideoStatus(sock, shuffled[m], m === 0 ? memeCap : '');
        } else {
          await postImageStatus(sock, shuffled[m], m === 0 ? memeCap : '');
        }
        await new Promise(function(r) { setTimeout(r, 2000); });
        memePosted = true;
      }
    } else {
      // No meme URLs — post a fun text status instead
      var textCap = randomCaption(MEME_CAPTIONS, promo);
      memePosted = await postTextStatus(sock, textCap + '\n\n📲 Message us to shop!');
    }

    // After meme, always follow with a product image (70-80% rule)
    if (memePosted) {
      await new Promise(function(r) { setTimeout(r, 3000); });
      var followUpRes = await sb.from('service_listings')
        .select('name, price, price_label, listing_media(url, media_type)')
        .eq('client_id', clientId)
        .eq('available', true)
        .order('created_at', { ascending: false })
        .limit(10);

      var followListings = (followUpRes.data || []).filter(function(l) {
        return l.listing_media && l.listing_media.length > 0;
      });

      if (followListings.length) {
        var pick = followListings[Math.floor(Math.random() * followListings.length)];
        var pMedia = (pick.listing_media || []).sort(function(a, b) { return (a.sort_order||0)-(b.sort_order||0); });
        var pImg   = pMedia.find(function(m) { return m.media_type === 'image'; });
        var pVid   = pMedia.find(function(m) { return m.media_type === 'video'; });
        var pPrice = pick.price_label || (pick.price ? '₦' + Number(pick.price).toLocaleString('en-NG') : null);
        var pCap   = '*' + pick.name + '*' + (pPrice ? ' — ' + pPrice : '') + '\n\n' + randomCaption(PRODUCT_CAPTIONS, promo);

        if (pImg)  await postImageStatus(sock, pImg.url, pCap);
        if (pVid)  { await new Promise(function(r){ setTimeout(r,2000); }); await postVideoStatus(sock, pVid.url, pick.name); }
      }

      await logPost(sb, clientId, 'meme_post', 'meme_post');
      console.log('[StatusPoster] Meme + product follow-up posted for client ' + clientId);
    }

  } catch (e) {
    console.error('[StatusPoster] Error for client ' + clientId + ':', e.message);
  }
}

// ════════════════════════════════════════════════════════════
//  START / STOP
// ════════════════════════════════════════════════════════════

async function startStatusPoster(clientId, sock) {
  if (runningPosters.has(clientId)) {
    clearInterval(runningPosters.get(clientId));
  }
  console.log('[StatusPoster] Starting for client ' + clientId);

  // Run once immediately
  runClientPosts(clientId, sock).catch(function(e) {
    console.error('[StatusPoster] Initial run error:', e.message);
  });

  // Then every 5 minutes
  var interval = setInterval(function() {
    runClientPosts(clientId, sock).catch(function(e) {
      console.error('[StatusPoster] Interval error:', e.message);
    });
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

module.exports = { startStatusPoster, stopStatusPoster, postStatus: postImageStatus };
