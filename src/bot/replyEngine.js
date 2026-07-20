// ============================================================
//  ForgeBot — Reply Engine v3
//  src/bot/replyEngine.js
//
//  ORIGINAL CODE PRESERVED EXACTLY.
//  v3 additions only:
//   - Conversation state (name capture flow)
//   - Order intent → payment info
//   - Owner notifications (new customer + new order)
//   - Expanded listing triggers (enquiry, browse, etc.)
//   - MENU shortcut → show all listings
//   - Number selection (1, 2, 3) after menu
// ============================================================

'use strict';

const db = require('../db/supabase');
const { matchKeyword } = require('./keywords');
const { transcribeVoiceNote } = require('./voiceHandler');
const { isPaymentClaim, notifyOwnerOfPaymentClaim, handleOwnerReply, notifyOwnerHumanRequest } = require('./paymentNotifier');

// ── Human handoff pause map ────────────────────────────────
const humanPaused = new Map();

function humanDelay() {
  return new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 2000); });
}

const HUMAN_HANDOFF_KEYWORDS = [
  'speak to human', 'talk to human', 'real person', 'speak to someone',
  'talk to agent', 'connect me', 'i want to talk', 'speak to owner',
  'talk to owner', 'human please', 'abeg connect me', 'give me human',
  'i want owner', 'customer service', 'customer care', 'live agent',
  'actual person', 'not bot', 'no bot', 'human being'
];

function wantsHuman(text) {
  var lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

// ── Smart listings search ──────────────────────────────────
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
        fields.forEach(function(field) {
          if (field.includes(word)) score += word.length;
        });
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

// ── Listing triggers (expanded in v3) ─────────────────────
const LISTING_TRIGGERS = [
  'do you have', 'do you sell', 'do you offer', 'is it available', 'price of',
  'how much is', 'how much for', 'what is the price', 'i want to buy', 'i want to order',
  'i need', 'looking for', 'show me', 'send me', 'any available', 'in stock',
  'do you do', 'can you do', 'available for', 'services', 'products', 'what do you have',
  'what do you sell', 'your prices', 'package', 'packages', 'catalogue', 'catalog',
  'bedroom', 'apartment', 'house', 'land', 'property', 'plot', 'duplex', 'flat',
  'size', 'colour', 'color', 'style', 'design', 'type', 'model',
  // v3 additions
  'enquiry', 'make enquiry', 'want to enquire', 'enquire about', 'check your',
  'i want to see', 'let me see', 'show your', 'your items', 'your goods',
  'what you have', 'wetin you get', 'wetin you sell', 'na wetin', 'how e be',
  'see products', 'see services', 'view products', 'view services',
  'your product', 'your service', 'your listing', 'your catalog',
  'place order', 'make order', 'i dey look for', 'abeg show', 'browse',
  'price list', 'pricelist', 'what can you do', 'what do you do',
  'what you do', 'tell me about', 'order', 'buy'
];

function isListingQuery(text) {
  var lower = text.toLowerCase();
  return LISTING_TRIGGERS.some(function(t) { return lower.includes(t); });
}

// ── Send listing results (original logic preserved exactly) ─
async function sendListingResults(sock, jid, listings, client) {
  if (!listings.length) return false;

  var businessName = client.business_name || 'us';

  if (listings.length === 1) {
    var l = listings[0];
    var msg = '✅ Yes! Here is what we have:\n\n';
    msg += '*' + l.name + '*\n';
    if (l.price) msg += '💰 *Price:* ' + l.price + '\n';
    if (l.description) msg += '📝 ' + l.description + '\n';
    if (l.location) msg += '📍 *Location:* ' + l.location + '\n';
    msg += '\nInterested? DM us or reply to place your order! 😊';

    await sock.sendMessage(jid, { text: msg });

    var media = (l.listing_media || []).filter(function(m) { return m.media_type === 'image'; });
    for (var i = 0; i < Math.min(media.length, 3); i++) {
      try {
        await sock.sendMessage(jid, { image: { url: media[i].url }, caption: l.name });
        await new Promise(function(r) { setTimeout(r, 800); });
      } catch (e) {}
    }

    // Send videos if any
    var videos = (l.listing_media || []).filter(function(m) { return m.media_type === 'video'; });
    for (var iv = 0; iv < Math.min(videos.length, 2); iv++) {
      try {
        await sock.sendMessage(jid, { video: { url: videos[iv].url }, caption: l.name });
        await new Promise(function(r) { setTimeout(r, 1000); });
      } catch (e) {}
    }

    var pdf = (l.listing_media || []).find(function(m) { return m.media_type === 'pdf'; });
    if (pdf) {
      try {
        await sock.sendMessage(jid, {
          document: { url: pdf.url },
          mimetype: 'application/pdf',
          fileName: l.name + '.pdf',
          caption: 'Full details for ' + l.name
        });
      } catch (e) {}
    }
  } else {
    var intro = '✅ We found *' + listings.length + ' options* for you:\n\n';
    listings.forEach(function(l, i) {
      intro += '*' + (i + 1) + '. ' + l.name + '*\n';
      if (l.price) intro += '   💰 ' + l.price + '\n';
      if (l.location) intro += '   📍 ' + l.location + '\n';
      if (l.description) intro += '   ' + l.description.slice(0, 80) + (l.description.length > 80 ? '...' : '') + '\n';
      intro += '\n';
    });
    intro += 'Reply with the *number* of the one you want more details on, or DM us directly! 😊';
    await sock.sendMessage(jid, { text: intro });

    for (var j = 0; j < listings.length; j++) {
      var imgs = (listings[j].listing_media || []).filter(function(m) { return m.media_type === 'image'; });
      if (imgs.length) {
        try {
          await sock.sendMessage(jid, {
            image: { url: imgs[0].url },
            caption: '*' + (j + 1) + '.* ' + listings[j].name + (listings[j].price ? ' — ' + listings[j].price : '')
          });
          await new Promise(function(r) { setTimeout(r, 800); });
        } catch (e) {}
      }
      // Also send first video if no image available
      if (!imgs.length) {
        var vids = (listings[j].listing_media || []).filter(function(m) { return m.media_type === 'video'; });
        if (vids.length) {
          try {
            await sock.sendMessage(jid, { video: { url: vids[0].url }, caption: '*' + (j + 1) + '.* ' + listings[j].name + (listings[j].price ? ' — ' + listings[j].price : '') });
            await new Promise(function(r) { setTimeout(r, 800); });
          } catch (e) {}
        }
      }
    }
  }
  return true;
}

// ════════════════════════════════════════════════════════════
//  v3 NEW HELPERS
// ════════════════════════════════════════════════════════════

// ── Conversation state (name capture + order flow) ─────────
const convState = new Map();
function getConv(clientId, jid) { return convState.get(clientId + ':' + jid) || {}; }
function setConv(clientId, jid, data) {
  var key = clientId + ':' + jid;
  convState.set(key, Object.assign(getConv(clientId, jid), data));
}

// ── Greeting detection ─────────────────────────────────────
const GREETING_TRIGGERS = [
  'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening',
  'helo', 'hy', 'sup', 'hiya', 'yo', 'morning', 'afternoon', 'evening',
  'good day', 'howdy', 'greetings', 'hi there', 'hello there'
];
function isGreeting(text) {
  var lower = text.trim().toLowerCase();
  return GREETING_TRIGGERS.some(function(g) {
    return lower === g || lower.startsWith(g + ' ') || lower === g + '!';
  });
}

// ── Order intent detection ─────────────────────────────────
const ORDER_INTENT_PHRASES = [
  'i want it', 'i want this', 'i will take', 'i will buy', 'yes i want', 'yes please',
  'i am interested', 'am interested', 'i like it', 'i like this', 'i ll take',
  'ok i want', 'add to cart', 'buy this', 'order this', 'i want number',
  'i want option', 'deal', 'i go take am', 'i dey interested', 'oya i go buy'
];
function isOrderIntent(text) {
  var lower = text.trim().toLowerCase();
  // "yes" alone only if it's the whole message
  if (lower === 'yes' || lower === 'yes!' || lower === 'yes.') return true;
  return ORDER_INTENT_PHRASES.some(function(t) { return lower.includes(t); });
}

// ── Get all listings (for browse / MENU) ───────────────────
async function getAllListings(clientId) {
  try {
    var sb = db.getSupabase();
    var result = await sb.from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false });
    return (result.data || []).slice(0, 10);
  } catch (e) { return []; }
}

// ── Get customer record ─────────────────────────────────────
async function getCustomerRecord(clientId, jid) {
  try {
    var sb = db.getSupabase();
    var result = await sb.from('customers').select('*').eq('client_id', clientId).eq('jid', jid).single();
    return result.data || null;
  } catch (e) { return null; }
}

// ── Save customer name ──────────────────────────────────────
async function saveCustomerName(clientId, jid, name) {
  try {
    var sb = db.getSupabase();
    await sb.from('customers').upsert({
      client_id: clientId, jid: jid, customer_name: name,
      last_contact: new Date().toISOString(), last_seen: new Date().toISOString()
    }, { onConflict: 'client_id,jid' });
  } catch (e) {}
}

// ── Save order to orders table ──────────────────────────────
async function saveOrder(clientId, jid, customerName, itemName, listingId) {
  try {
    var sb = db.getSupabase();
    await sb.from('orders').insert({
      client_id: clientId, customer_jid: jid, customer_name: customerName || 'Unknown',
      item_name: itemName || 'Unknown', listing_id: listingId || null,
      status: 'pending', created_at: new Date().toISOString()
    });
  } catch (e) {}
}

// ── Notify owner new customer ───────────────────────────────
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
      text: '👋 *New customer contacted your bot!*\n\n📱 Phone: +' + customerPhone + '\n' +
            (name ? '🙋 Name: ' + name + '\n' : '') + '\nReply to them directly if needed.'
    });
  } catch (e) {}
}

// ── Notify owner new order ──────────────────────────────────
async function notifyOwnerOrder(sock, clientId, jid, customerName, itemName) {
  try {
    var client = await db.getClientById(clientId);
    var notifNum = client && client.notification_number;
    if (!notifNum) return;
    var phone = notifNum.replace(/\D/g, '');
    if (!phone.startsWith('234')) phone = '234' + phone.replace(/^0/, '');
    var ownerJid = phone + '@s.whatsapp.net';
    var customerPhone = jid.replace('@s.whatsapp.net', '');
    await sock.sendMessage(ownerJid, {
      text: '🛒 *New Order Alert!*\n\n🙋 Customer: ' + (customerName || 'Unknown') +
            '\n📱 Phone: +' + customerPhone +
            (itemName ? '\n📦 Item: ' + itemName : '') +
            '\n\nThey have been sent your payment details. Please follow up!'
    });
  } catch (e) {}
}

// ── Send payment info to customer ───────────────────────────
async function sendPaymentInfo(sock, jid, clientId, itemName, customerName) {
  try {
    var sb = db.getSupabase();
    var setupRes = await sb.from('bot_setup').select('payment_methods').eq('client_id', clientId).single().catch(function() { return { data: null }; });
    var paymentMethods = setupRes.data && setupRes.data.payment_methods;

    var msg = '🎉 Great choice';
    if (customerName) msg += ', *' + customerName + '*';
    msg += '!\n\n';
    if (itemName) msg += 'You selected: *' + itemName + '*\n\n';

    if (paymentMethods) {
      msg += '💳 *Payment Details:*\n' + paymentMethods + '\n\n';
    } else {
      msg += '💳 *To complete your order:*\nPlease ask us for payment details and we will send them right away!\n\n';
    }
    msg += 'Once payment is done, send us *"I have paid"* and we will confirm immediately. ✅\n\n';
    msg += '_Need help? Type *HUMAN* to speak to us directly._';

    await sock.sendMessage(jid, { text: msg });
  } catch (e) {}
}

// ── Build business intro after name capture ─────────────────
function buildBusinessIntro(client, setup, name) {
  var biz = client.business_name || 'our business';
  var msg = 'Nice to meet you, *' + name + '*! 😊\n\nWelcome to *' + biz + '*!';
  if (setup && setup.current_promo) msg += '\n\n🎁 *Current Offer:* ' + setup.current_promo;
  if (setup && (setup.instagram || setup.facebook || setup.tiktok || setup.whatsapp_channel)) {
    msg += '\n\n📲 *Follow us:*';
    if (setup.instagram) msg += '\n   Instagram: ' + setup.instagram;
    if (setup.facebook)  msg += '\n   Facebook: '  + setup.facebook;
    if (setup.tiktok)    msg += '\n   TikTok: '    + setup.tiktok;
    if (setup.whatsapp_channel) msg += '\n   WhatsApp: ' + setup.whatsapp_channel;
  }
  msg += '\n\n💬 *What can I help you with today?*\n• Type *MENU* to see all our products/services\n• Ask about prices, delivery, availability\n• Type *HUMAN* to speak to us directly';
  return msg;
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

    // ── Voice note handling (original) ─────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      var transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, {
          text: 'I received your voice note! Could you please type your message so I can help you faster?'
        });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, {
        text: 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...'
      });
    }

    if (!text.trim()) return;

    // ── Get client (original) ───────────────────────────────
    var client = await db.getClientById(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    // ── Track customer (original) ───────────────────────────
    try {
      var sb = db.getSupabase();
      await sb.from('customers').upsert({
        client_id:    clientId,
        jid:          jid,
        last_contact: new Date().toISOString(),
        last_seen:    new Date().toISOString()
      }, { onConflict: 'client_id,jid', ignoreDuplicates: false });
    } catch (e) {}

    // ── Owner reply check (original) ───────────────────────
    var ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    // ── Human pause check (original) ───────────────────────
    var pauseKey    = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff (original) ────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on — they will be with you shortly.'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // ── Payment claim (original) ────────────────────────────
    if (isPaymentClaim(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Thank you! Your payment claim has been received. The owner has been notified and will confirm shortly. We will update you right away!'
      });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    // ════════════════════════════════════════════════════════
    //  v3: CONVERSATION STATE
    // ════════════════════════════════════════════════════════

    var conv = getConv(clientId, jid);
    var customerRecord = await getCustomerRecord(clientId, jid);
    var customerName = (conv && conv.name) || (customerRecord && customerRecord.customer_name) || '';

    // ── Name capture ────────────────────────────────────────
    if (conv.awaiting_name) {
      var extracted = text.trim()
        .replace(/^(i am|am|i'm|my name is|they call me|na me be|i go by)\s+/i, '')
        .replace(/[^a-zA-Z\s]/g, '').trim()
        .split(/\s+/).slice(0, 2)
        .map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); })
        .join(' ');

      if (extracted.length >= 2) {
        await saveCustomerName(clientId, jid, extracted);
        setConv(clientId, jid, { awaiting_name: false, name: extracted });
        customerName = extracted;

        var setupSnap = await db.getSupabase().from('bot_setup').select('*').eq('client_id', clientId).single().catch(function() { return { data: null }; });
        await sock.sendMessage(jid, { text: buildBusinessIntro(client, setupSnap.data, extracted) });
        await notifyOwnerNewCustomer(sock, clientId, jid, extracted);

        var allItems = await getAllListings(clientId);
        if (allItems.length) {
          setConv(clientId, jid, { last_listings: allItems });
          await new Promise(function(r) { setTimeout(r, 1500); });
          await sendListingResults(sock, jid, allItems, client);
        }
        return;
      } else {
        // Doesn't look like a name, clear awaiting state and continue
        setConv(clientId, jid, { awaiting_name: false });
      }
    }

    // ── Order intent (after seeing a listing) ───────────────
    if (conv.last_listings && conv.awaiting_order && isOrderIntent(text)) {
      var item = conv.order_item || (conv.last_listings && conv.last_listings[0]);
      var itemName2 = item ? item.name : null;
      var listingId = item ? item.id   : null;
      await saveOrder(clientId, jid, customerName, itemName2, listingId);
      await sendPaymentInfo(sock, jid, clientId, itemName2, customerName);
      await notifyOwnerOrder(sock, clientId, jid, customerName, itemName2);
      setConv(clientId, jid, { awaiting_order: false, order_item: null });
      return;
    }

    // ── Number selection after listing menu ─────────────────
    if (conv.last_listings && /^[1-9]\d*$/.test(text.trim())) {
      var pickIdx = parseInt(text.trim()) - 1;
      if (conv.last_listings[pickIdx]) {
        var picked = conv.last_listings[pickIdx];
        setConv(clientId, jid, { awaiting_order: true, order_item: picked, last_listings: [picked] });
        await sendListingResults(sock, jid, [picked], client);
        return;
      }
    }

    // ── MENU shortcut — show all listings ───────────────────
    if (/^(menu|see all|all products|all services|show all|browse|price list|pricelist|everything|all items|catalog)$/i.test(text.trim())) {
      var menuListings = await getAllListings(clientId);
      if (menuListings.length) {
        setConv(clientId, jid, { last_listings: menuListings });
        await sendListingResults(sock, jid, menuListings, client);
        return;
      }
    }

    // ── New customer greeting ───────────────────────────────
    var isNew = !customerRecord || !customerRecord.customer_name;
    if (isGreeting(text) && isNew) {
      var welcomeMsg = client.welcome_message ||
        ('Good day! 👋\n\nWelcome to *' + (client.business_name || 'our store') + '*. We are happy to have you here!\n\nBefore we continue, may we know your name please? 😊');
      await sock.sendMessage(jid, { text: welcomeMsg });
      setConv(clientId, jid, { awaiting_name: true });
      return;
    }

    // ════════════════════════════════════════════════════════
    //  ORIGINAL: Smart listing search (before keyword matching)
    // ════════════════════════════════════════════════════════
    if (isListingQuery(text)) {
      var matches = await searchListings(clientId, text);
      if (matches.length > 0) {
        setConv(clientId, jid, { last_listings: matches, awaiting_order: matches.length === 1, order_item: matches.length === 1 ? matches[0] : null });
        var sent = await sendListingResults(sock, jid, matches, client);
        if (sent) return;
      }
    }

    // ════════════════════════════════════════════════════════
    //  ORIGINAL: Flow keyword matching
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
      // Check if this flow is asking for the customer's name
      if (matched.response && /name/i.test(matched.response) && /know|your|what/i.test(matched.response)) {
        setConv(clientId, jid, { awaiting_name: true });
      }
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
      }
      return;
    }

    // ════════════════════════════════════════════════════════
    //  ORIGINAL: Broad search before fallback
    // ════════════════════════════════════════════════════════
    if (!isListingQuery(text)) {
      var broadMatches = await searchListings(clientId, text);
      if (broadMatches.length > 0) {
        setConv(clientId, jid, { last_listings: broadMatches, awaiting_order: broadMatches.length === 1, order_item: broadMatches.length === 1 ? broadMatches[0] : null });
        var broadSent = await sendListingResults(sock, jid, broadMatches, client);
        if (broadSent) return;
      }
    }

    // ════════════════════════════════════════════════════════
    //  ORIGINAL: Fallback message
    // ════════════════════════════════════════════════════════
    var allCount = await getAllListings(clientId);
    var fallback = client.fallback_message ||
      'Thank you for reaching out! Someone will get back to you shortly.';
    if (allCount.length) fallback += '\n\n💡 _Type *MENU* to see all our products/services._';
    await sock.sendMessage(jid, { text: fallback });

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
