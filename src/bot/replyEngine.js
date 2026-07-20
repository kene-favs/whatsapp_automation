// ============================================================
//  ForgeBot — Reply Engine v3
//  src/bot/replyEngine.js
//
//  What's new in v3:
//   - Conversation state tracking (name capture flow)
//   - After name capture → smart business intro
//   - Owner notification on new customer first contact
//   - Expanded listing triggers (enquiry, see products, etc.)
//   - ₦ currency auto-formatted in listing replies
//   - All original logic preserved
// ============================================================

'use strict';

const db = require('../db/supabase');
const { isPaymentClaim, notifyOwnerOfPaymentClaim, handleOwnerReply, notifyOwnerHumanRequest } = require('./paymentNotifier');

// ── In-memory conversation state ───────────────────────────
// Key: "clientId:jid"  Value: { state, name, firstContact }
const convState = new Map();

function getState(clientId, jid) {
  return convState.get(clientId + ':' + jid) || {};
}
function setState(clientId, jid, data) {
  var key = clientId + ':' + jid;
  convState.set(key, Object.assign(getState(clientId, jid), data));
}
function clearState(clientId, jid) {
  convState.delete(clientId + ':' + jid);
}

// ── Human handoff ──────────────────────────────────────────
const humanPaused = new Map();
function humanDelay() {
  return new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 2000); });
}

const HUMAN_HANDOFF_KEYWORDS = [
  'speak to human','talk to human','real person','speak to someone',
  'talk to agent','connect me','i want to talk','speak to owner',
  'talk to owner','human please','abeg connect me','give me human',
  'i want owner','customer service','customer care','live agent',
  'actual person','not bot','no bot','human being'
];
function wantsHuman(text) {
  var lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

// ── Format price with ₦ symbol ─────────────────────────────
function formatPrice(listing) {
  if (listing.price_label) return listing.price_label;
  if (listing.price) {
    var num = parseFloat(listing.price);
    if (!isNaN(num)) return '₦' + num.toLocaleString('en-NG');
    return listing.price;
  }
  return null;
}

// ── Listing triggers (expanded) ────────────────────────────
const LISTING_TRIGGERS = [
  // Direct product queries
  'do you have','do you sell','do you offer','is it available','price of',
  'how much is','how much for','what is the price','i want to buy','i want to order',
  'i need','looking for','show me','send me','any available','in stock',
  'do you do','can you do','available for','services','products','what do you have',
  'what do you sell','your prices','package','packages','catalogue','catalog',
  // Real estate
  'bedroom','apartment','house','land','property','plot','duplex','flat',
  // General attributes
  'size','colour','color','style','design','type','model',
  // Nigerian english / enquiry
  'enquiry','make enquiry','want to enquire','enquire about','check your',
  'i want to see','let me see','show your','your items','your goods',
  'what you have','wetin you get','wetin you sell','na wetin','how e be',
  'see products','see services','view products','view services',
  'your product','your service','your listing','your catalog',
  'i want to order','place order','make order','i dey look for',
  'abeg show','see your','browse','menu','price list','pricelist',
  'what can you do','what do you do','what you do','tell me about'
];

function isListingQuery(text) {
  var lower = text.toLowerCase();
  return LISTING_TRIGGERS.some(function(t) { return lower.includes(t); });
}

// ── Check if this is a greeting / first contact ────────────
const GREETING_TRIGGERS = [
  'hello','hi','hey','good morning','good afternoon','good evening',
  'helo','hy','sup','hiya','yo','morning','afternoon','evening',
  'good day','howdy','greetings','hi there','hello there'
];
function isGreeting(text) {
  var lower = text.trim().toLowerCase();
  return GREETING_TRIGGERS.some(function(g) { return lower === g || lower.startsWith(g + ' ') || lower === g + '!'; });
}

// ── Search listings ─────────────────────────────────────────
async function searchListings(clientId, query) {
  try {
    var sb = db.getSupabase();
    var lower = query.toLowerCase();
    var result = await sb
      .from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false });
    if (result.error || !result.data || !result.data.length) return [];
    var scored = result.data.map(function(listing) {
      var score = 0;
      var fields = [
        listing.name        || '',
        listing.description || '',
        listing.keywords    || '',
        listing.category    || '',
        listing.location    || '',
        listing.price_label || ''
      ].map(function(f) { return f.toLowerCase(); });
      var words = lower.split(/\s+/).filter(function(w) { return w.length > 2; });
      words.forEach(function(word) {
        fields.forEach(function(field) { if (field.includes(word)) score += word.length; });
      });
      if (fields[0].includes(lower)) score += 20;
      return { listing: listing, score: score };
    });
    return scored
      .filter(function(s) { return s.score > 0; })
      .sort(function(a, b) { return b.score - a.score; })
      .slice(0, 3)
      .map(function(s) { return s.listing; });
  } catch (e) {
    console.error('[ReplyEngine] Listing search error:', e.message);
    return [];
  }
}

// Fetch ALL available listings for a client (for menu/browse requests)
async function getAllListings(clientId) {
  try {
    var sb = db.getSupabase();
    var result = await sb
      .from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false });
    return (result.data || []).slice(0, 10); // cap at 10 for WhatsApp readability
  } catch (e) { return []; }
}

// ── Send listings as WhatsApp messages ─────────────────────
async function sendListingResults(sock, jid, listings, client, showAll) {
  if (!listings.length) return false;
  var businessName = client.business_name || 'us';

  if (listings.length === 1 && !showAll) {
    var l = listings[0];
    var price = formatPrice(l);
    var msg = '✅ *Yes! Here is what we have:*\n\n';
    msg += '*' + l.name + '*\n';
    if (price) msg += '💰 *Price:* ' + price + '\n';
    if (l.description) msg += '\n📝 ' + l.description + '\n';
    if (l.location) msg += '📍 *Location:* ' + l.location + '\n';
    msg += '\n_Interested? Just reply to place your order!_ 😊';
    await sock.sendMessage(jid, { text: msg });
    var media = (l.listing_media || []).filter(function(m) { return m.media_type === 'image'; });
    for (var i = 0; i < media.length; i++) {
      try {
        await sock.sendMessage(jid, { image: { url: media[i].url }, caption: l.name });
        await new Promise(function(r) { setTimeout(r, 800); });
      } catch (e) {}
    }
    var pdf = (l.listing_media || []).find(function(m) { return m.media_type === 'pdf'; });
    if (pdf) {
      try {
        await sock.sendMessage(jid, { document: { url: pdf.url }, mimetype: 'application/pdf', fileName: l.name + '.pdf', caption: 'Full details — ' + l.name });
      } catch (e) {}
    }
  } else {
    var intro = showAll
      ? '🛍️ *Here is everything we offer:*\n\n'
      : '✅ *We found ' + listings.length + ' option' + (listings.length > 1 ? 's' : '') + ' for you:*\n\n';
    listings.forEach(function(l, i) {
      var price = formatPrice(l);
      intro += '*' + (i + 1) + '. ' + l.name + '*\n';
      if (price) intro += '   💰 ' + price + '\n';
      if (l.location) intro += '   📍 ' + l.location + '\n';
      if (l.description) intro += '   ' + l.description.slice(0, 100) + (l.description.length > 100 ? '...' : '') + '\n';
      intro += '\n';
    });
    intro += '_Reply with the *number* (1, 2, 3…) of the one you want more info on, or type what you need!_';
    await sock.sendMessage(jid, { text: intro });
    for (var j = 0; j < listings.length; j++) {
      var imgs = (listings[j].listing_media || []).filter(function(m) { return m.media_type === 'image'; });
      if (imgs.length) {
        try {
          var price2 = formatPrice(listings[j]);
          await sock.sendMessage(jid, { image: { url: imgs[0].url }, caption: '*' + (j + 1) + '.* ' + listings[j].name + (price2 ? ' — ' + price2 : '') });
          await new Promise(function(r) { setTimeout(r, 800); });
        } catch (e) {}
      }
    }
  }
  return true;
}

// ── Notify owner of new customer ────────────────────────────
async function notifyOwnerNewCustomer(sock, clientId, jid, name) {
  try {
    var client = await db.getClientById(clientId);
    var notifNum = client && client.notification_number;
    if (!notifNum) return;
    var phone = notifNum.replace(/\D/g, '');
    if (!phone.startsWith('234')) phone = '234' + phone.replace(/^0/, '');
    var ownerJid = phone + '@s.whatsapp.net';
    var customerPhone = jid.replace('@s.whatsapp.net', '');
    await sock.sendMessage(ownerJid, {
      text: '👋 *New customer contacted your bot!*\n\n' +
        '📱 Phone: +' + customerPhone + '\n' +
        (name ? '🙋 Name: ' + name + '\n' : '') +
        '\nReply to them directly if needed.'
    });
  } catch (e) {
    console.error('[ReplyEngine] Owner notify error:', e.message);
  }
}

// ── Build business intro message ────────────────────────────
function buildBusinessIntro(client, setup, name) {
  var biz = client.business_name || 'our business';
  var greeting = name ? 'Nice to meet you, *' + name + '*! 😊\n\n' : 'Great! 😊\n\n';
  var intro = greeting + 'Welcome to *' + biz + '*. ';

  // Add what they do based on setup
  if (setup) {
    if (setup.current_promo) {
      intro += '\n\n🎁 *Current Offer:* ' + setup.current_promo;
    }
    if (setup.instagram || setup.facebook || setup.tiktok || setup.whatsapp_channel) {
      intro += '\n\n📲 *Follow us:*';
      if (setup.instagram) intro += '\n   Instagram: ' + setup.instagram;
      if (setup.facebook) intro += '\n   Facebook: ' + setup.facebook;
      if (setup.tiktok) intro += '\n   TikTok: ' + setup.tiktok;
      if (setup.whatsapp_channel) intro += '\n   WhatsApp: ' + setup.whatsapp_channel;
    }
  }
  intro += '\n\n💬 _What would you like to know? You can ask about our products, prices, delivery, or anything else!_';
  return intro;
}

// ── Check if customer record exists with name ───────────────
async function getCustomerRecord(clientId, jid) {
  try {
    var sb = db.getSupabase();
    var result = await sb.from('customers').select('*').eq('client_id', clientId).eq('jid', jid).single();
    return result.data || null;
  } catch (e) { return null; }
}

async function saveCustomerName(clientId, jid, name) {
  try {
    var sb = db.getSupabase();
    await sb.from('customers').upsert({
      client_id:    clientId,
      jid:          jid,
      customer_name: name,
      last_contact: new Date().toISOString(),
      last_seen:    new Date().toISOString()
    }, { onConflict: 'client_id,jid' });
  } catch (e) {}
}

// ── Voice note handler (inline) ─────────────────────────────
async function transcribeVoiceNote(sock, msg) {
  // Transcription is handled by voiceHandler.js — keep stub here
  try {
    var { transcribeVoiceNote: transcribe } = require('./voiceHandler');
    return await transcribe(sock, msg);
  } catch (e) { return null; }
}

// ════════════════════════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════════════════════════

async function handleMessage(sock, msg, clientId) {
  try {
    var jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    var msgContent = msg.message;
    var isVoice = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    var isAudio = !!(msgContent && msgContent.audioMessage);

    var text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    // ── Voice note ────────────────────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      var transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, { text: 'I received your voice note! Could you please type your message so I can help you faster? 😊' });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, { text: 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...' });
    }

    if (!text.trim()) return;

    // ── Get client ────────────────────────────────────────────
    var client = await db.getClientById(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    // ── Track customer ────────────────────────────────────────
    try {
      var sb = db.getSupabase();
      await sb.from('customers').upsert({
        client_id:    clientId,
        jid:          jid,
        last_contact: new Date().toISOString(),
        last_seen:    new Date().toISOString()
      }, { onConflict: 'client_id,jid', ignoreDuplicates: false });
    } catch (e) {}

    // ── Owner reply check ─────────────────────────────────────
    var ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    // ── Human pause check ─────────────────────────────────────
    var pauseKey   = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff ─────────────────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Got it! I am connecting you with the owner right now. Please hold on — they will be with you shortly. 🙏' });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // ── Payment claim ─────────────────────────────────────────
    if (isPaymentClaim(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Thank you! Your payment claim has been received. The owner has been notified and will confirm shortly. We will update you right away! ✅' });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    // ════════════════════════════════════════════════════════
    //  CONVERSATION STATE — Name Capture Flow
    // ════════════════════════════════════════════════════════

    var conv = getState(clientId, jid);
    var customerRecord = await getCustomerRecord(clientId, jid);

    // If we're waiting for the customer's name
    if (conv.awaiting_name) {
      var name = text.trim()
        .replace(/^(i am|am|i'm|my name is|they call me|na me be|i go by)\s+/i, '')
        .replace(/[^a-zA-Z\s]/g, '')
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
        .join(' ');

      if (name.length < 2) {
        // Doesn't look like a name, treat as a regular message
        setState(clientId, jid, { awaiting_name: false });
      } else {
        // Save name
        await saveCustomerName(clientId, jid, name);
        setState(clientId, jid, { awaiting_name: false, name: name });

        // Get bot_setup for promo / social links
        var setupResult = await db.getSupabase().from('bot_setup').select('*').eq('client_id', clientId).single().catch(function() { return { data: null }; });
        var setup = setupResult.data;

        // Send business intro
        await sock.sendMessage(jid, { text: buildBusinessIntro(client, setup, name) });

        // Notify owner of new customer
        await notifyOwnerNewCustomer(sock, clientId, jid, name);

        // Show listings if any exist
        var allListings = await getAllListings(clientId);
        if (allListings.length) {
          await new Promise(function(r) { setTimeout(r, 1500); });
          await sendListingResults(sock, jid, allListings, client, true);
        }
        return;
      }
    }

    // If customer is completely new (no record) or just greeted
    var isNew = !customerRecord || !customerRecord.customer_name;
    if (isGreeting(text) && isNew) {
      // Send welcome + ask for name
      var welcomeMsg = client.welcome_message ||
        ('Good day! 👋\n\nWelcome to *' + (client.business_name || 'our store') + '*. We are happy to have you here!\n\nBefore we continue, may we know your name please? 😊');
      await sock.sendMessage(jid, { text: welcomeMsg });
      setState(clientId, jid, { awaiting_name: true });
      return;
    }

    // ════════════════════════════════════════════════════════
    //  LISTING NUMBER SELECTION (1, 2, 3 after menu shown)
    // ════════════════════════════════════════════════════════

    if (conv.last_listings && /^[1-9]\d*$/.test(text.trim())) {
      var idx = parseInt(text.trim()) - 1;
      if (conv.last_listings[idx]) {
        var picked = [conv.last_listings[idx]];
        await sendListingResults(sock, jid, picked, client, false);
        setState(clientId, jid, { last_listings: null });
        return;
      }
    }

    // ════════════════════════════════════════════════════════
    //  LISTING SEARCH (before keyword matching)
    // ════════════════════════════════════════════════════════

    var isBrowseAll = /^(menu|see all|all products|all services|show all|browse|price list|pricelist|everything|all items|catalog)$/i.test(text.trim());

    if (isBrowseAll) {
      var allItems = await getAllListings(clientId);
      if (allItems.length) {
        setState(clientId, jid, { last_listings: allItems });
        await sendListingResults(sock, jid, allItems, client, true);
        return;
      }
    }

    if (isListingQuery(text)) {
      var matches = await searchListings(clientId, text);
      if (matches.length > 0) {
        setState(clientId, jid, { last_listings: matches });
        var sent = await sendListingResults(sock, jid, matches, client, false);
        if (sent) return;
      }
    }

    // ════════════════════════════════════════════════════════
    //  KEYWORD FLOW MATCHING
    // ════════════════════════════════════════════════════════

    var flows = await db.getFlows(clientId, true);
    var matched = null;
    for (var i = 0; i < flows.length; i++) {
      var flow = flows[i];
      var kws  = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
      var textLower = text.toLowerCase();
      if (kws.some(function(kw) { return textLower.includes(kw); })) {
        matched = flow;
        break;
      }
    }

    if (matched) {
      // Check if this flow includes asking for name — set state
      if (matched.response && /name/i.test(matched.response) && /know|your|what('s| is)/i.test(matched.response)) {
        setState(clientId, jid, { awaiting_name: true });
      }
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
      }
      return;
    }

    // ── Broad listing search even if not a listing query ─────
    var broadMatches = await searchListings(clientId, text);
    if (broadMatches.length > 0) {
      setState(clientId, jid, { last_listings: broadMatches });
      var broadSent = await sendListingResults(sock, jid, broadMatches, client, false);
      if (broadSent) return;
    }

    // ════════════════════════════════════════════════════════
    //  FALLBACK
    // ════════════════════════════════════════════════════════

    var customerName = (conv && conv.name) || (customerRecord && customerRecord.customer_name) || '';
    var fallback = client.fallback_message ||
      'Thank you for reaching out! Someone will get back to you shortly.';
    // Add helpful hint to fallback
    var allListingCount = await getAllListings(clientId);
    if (allListingCount.length) {
      fallback += '\n\n💡 _Type *MENU* to see all our products/services._';
    }
    await sock.sendMessage(jid, { text: fallback });

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
