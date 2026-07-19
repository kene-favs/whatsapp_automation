// ============================================================
//  ForgeBot — Smart Reply Engine v3
//  File location: src/bot/replyEngine.js
//
//  Entry point: handleMessage(sock, msg, clientId)
//  Called by sessionManager for every incoming WhatsApp message.
//
//  Features:
//  • Full state machine (GREETING → BROWSING → ORDERING → RECEIPT…)
//  • Customer name collection on first contact
//  • Cart management with quantity tracking
//  • Product & service catalog with fuzzy matching
//  • Order flow — delivery address or appointment booking
//  • Payment receipt detection & Supabase Storage upload
//  • Lead / price inquiry logging
//  • Owner WhatsApp alerts with dashboard link
//  • Custom auto-reply rules from DB
//  • FAQ matching from business_faq table
//  • Voice note transcription via Whisper (needs OPENAI_API_KEY)
//  • Human handoff with 30-min auto-resume
// ============================================================

'use strict';

const db = require('../db/supabase');

// ── State machine states ──────────────────────────────────────
const STATE = {
  GREETING:                'GREETING',
  AWAITING_NAME:           'AWAITING_NAME',
  BROWSING:                'BROWSING',
  ORDERING:                'ORDERING',
  AWAITING_ADDRESS:        'AWAITING_ADDRESS',
  AWAITING_APPT:           'AWAITING_APPT',
  AWAITING_RECEIPT:        'AWAITING_RECEIPT',
  AWAITING_DELIVERY_ADDRESS: 'AWAITING_DELIVERY_ADDRESS',
  HUMAN_PAUSED:            'HUMAN_PAUSED'
};

// Conversation state store (key: "clientId:jid")
// { state, customerName, cart, orderId }
const convStates = new Map();

// Human handoff timers
const humanPaused = new Map();

// ── Intent keyword groups ─────────────────────────────────────
const INTENT = {
  PRICE:         ['how much','price','cost','rate','fee','charge','what is the price','pricing','cost of','price of','how much for','how much is'],
  ORDER:         ['i want','order','buy','get me','i need','i\'d like','i will take','i\'ll take','purchase','can i get','let me get','add to cart','i\'ll order','place order'],
  MORE_ITEMS:    ['and also','also add','add another','i also want','and i want','plus','what about'],
  DONE_ORDER:    ['that\'s all','that is all','nothing else','done','that\'s everything','checkout','proceed','confirm order','just that'],
  CATALOG:       ['what do you have','what do you sell','show me','your products','your services','what\'s available','catalog','list','menu','what can i order','what you got','all products','all services'],
  DELIVERY:      ['delivery','deliver','shipping','how long','when will i','how many days','when do i','dispatch','when will it arrive'],
  LOCATION:      ['where are you','your location','address','where to','how to get','come and pick','pickup','pick up','your office','your shop','your studio','where is your'],
  HOURS:         ['open','opening hours','business hours','working hours','available','what time','when do you close','when do you open','are you open','closed','office hours'],
  SOCIAL:        ['instagram','facebook','tiktok','twitter','social media','follow you','your page','online','your handle','whatsapp channel','your channel'],
  PAYMENT_Q:     ['how to pay','account number','bank details','where to transfer','payment details','send account','your account','bank account','which bank'],
  COMPLAINT:     ['damaged','wrong item','wrong product','broken','not what i ordered','issue','problem','bad','spoilt','received wrong','got wrong','defective'],
  RETURN:        ['return','exchange','refund','give back','change it','swap','money back'],
  BULK:          ['bulk','wholesale','large quantity','many units','lots of','mass order','large order'],
  PROMO:         ['promo','discount','offer','sale','coupon','deal','promotion','any deal','promo code'],
  HUMAN:         ['speak to human','real person','talk to someone','agent','customer care','customer service','representative','call me','speak to someone','human please','real agent','i need help from'],
  PAYMENT_CLAIM: ['i have paid','i\'ve paid','i sent','i transferred','payment done','i paid','done paying','just paid','already paid','sent the money'],
  GREETING_W:    ['hello','hi','good morning','good afternoon','good evening','hey','helo','hii','howdy','sup','whats up','what\'s up','greetings'],
  THANKS:        ['thank you','thanks','thank u','ok thank','ok thanks','perfect','great','alright','noted','okay','got it']
};

function detect(text) {
  var t = (text || '').toLowerCase().trim();
  var keys = Object.keys(INTENT);
  for (var i = 0; i < keys.length; i++) {
    var intent   = keys[i];
    var keywords = INTENT[intent];
    for (var j = 0; j < keywords.length; j++) {
      if (t.includes(keywords[j])) return intent;
    }
  }
  return 'UNKNOWN';
}

// Fuzzy item name matcher
function findItem(text, items) {
  if (!items || !items.length) return null;
  var t = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '');
  // 1. Exact substring match
  for (var i = 0; i < items.length; i++) {
    if (t.includes(items[i].name.toLowerCase().replace(/[^a-z0-9\s]/g, ''))) return items[i];
  }
  // 2. Word overlap (60% threshold)
  for (var i = 0; i < items.length; i++) {
    var words = items[i].name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(function(w) { return w.length > 2; });
    var hits  = words.filter(function(w) { return t.includes(w); });
    if (words.length > 0 && hits.length >= Math.ceil(words.length * 0.6)) return items[i];
  }
  return null;
}

// Greeting based on server time
function timeGreeting() {
  var h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmt(price) {
  return '₦' + Number(price || 0).toLocaleString();
}

function buildDashLink() {
  return (process.env.APP_URL || 'https://forgebot.ng') + '/dashboard';
}

function buildAccountMsg(client) {
  if (!client.bank_name && !client.account_number) {
    return 'Please contact us for payment details. 😊';
  }
  return (
    '🏦 *Payment Details*\n\n' +
    (client.bank_name      ? 'Bank: *' + client.bank_name + '*\n' : '') +
    (client.account_number ? 'Account Number: *' + client.account_number + '*\n' : '') +
    (client.account_name   ? 'Account Name: *' + (client.account_name || client.business_name) + '*\n' : '') +
    '\nAfter payment, please send your *receipt or screenshot* here so we can confirm quickly. 📸'
  );
}

function addToCart(conv, item) {
  var existing = conv.cart.find(function(c) { return c.id === item.id; });
  if (existing) {
    existing.qty += 1;
  } else {
    conv.cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, type: item._type || 'product' });
  }
}

function getOrderTotal(cart) {
  return (cart || []).reduce(function(sum, i) { return sum + (i.price || 0) * (i.qty || 1); }, 0);
}

async function getClientItems(clientId, bizType) {
  var items = [];
  try {
    if (bizType === 'product' || bizType === 'both') {
      var products = await db.getProducts(clientId);
      items = items.concat(products || []);
    }
    if (bizType === 'service' || bizType === 'services' || bizType === 'both') {
      var services = await db.getServices(clientId);
      items = items.concat(services || []);
    }
    // If neither matched, load both
    if (!['product','service','services','both'].includes(bizType)) {
      var allP = await db.getProducts(clientId);
      var allS = await db.getServices(clientId);
      items = (allP || []).concat(allS || []);
    }
  } catch (e) {
    console.error('[replyEngine] getClientItems error:', e.message);
  }
  return items;
}

async function buildCatalogMsg(items, bizType, bizName) {
  if (!items || !items.length) {
    return 'We\'re currently updating our catalog. Please check back soon! 😊';
  }
  var available = items.filter(function(i) { return i.in_stock !== false && i.available !== false; });
  if (!available.length) {
    return 'All our items are currently sold out. We\'ll restock soon! 😊';
  }
  var isService = bizType === 'service' || bizType === 'services';
  var lines = available.map(function(i) {
    return '• *' + i.name + '* — ' + fmt(i.price) +
      (i.duration ? ' (' + i.duration + ')' : '') +
      (i.description ? '\n  ' + i.description.slice(0, 80) : '');
  }).join('\n\n');
  return (
    '📋 *' + bizName + ' — ' + (isService ? 'Our Services' : 'Our Products') + '*\n\n' +
    lines + '\n\n' +
    'To order, just say *"I want [name]"* 😊'
  );
}

async function suggestAlternatives(clientId, bizType, excludeId) {
  try {
    var items = await getClientItems(clientId, bizType);
    var alts  = items.filter(function(i) { return i.id !== excludeId && i.in_stock !== false && i.available !== false; }).slice(0, 3);
    if (!alts.length) return 'We\'ll let you know when it\'s back! 😊';
    return 'You might also like: ' + alts.map(function(i) { return '*' + i.name + '* (' + fmt(i.price) + ')'; }).join(', ') + '. 😊';
  } catch (e) {
    return 'We\'ll let you know when it\'s back! 😊';
  }
}

// Match message against business_faq table
async function matchFAQ(text, clientId) {
  try {
    var t   = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    var sb  = db.getSupabase();
    var res = await sb.from('business_faq').select('question,answer').eq('client_id', clientId);
    var faqs = res.data || [];
    for (var i = 0; i < faqs.length; i++) {
      var q = (faqs[i].question || '').toLowerCase().replace(/[^a-z0-9\s]/g, '');
      var words = q.split(' ').filter(function(w) { return w.length > 3; });
      if (!words.length) continue;
      var hits = words.filter(function(w) { return t.includes(w); });
      if (hits.length >= Math.ceil(words.length * 0.5)) return faqs[i].answer;
    }
  } catch (e) {
    // Non-fatal
  }
  return null;
}

// ── Voice note transcription (Whisper) ────────────────────────
async function transcribeVoiceNote(sock, msg) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    var { downloadContentFromMessage } = require('@whiskeysockets/baileys');
    var audioMsg = msg.message.audioMessage || msg.message.pttMessage;
    if (!audioMsg) return null;
    var stream = await downloadContentFromMessage(audioMsg, 'audio');
    var chunks = [];
    for await (var chunk of stream) chunks.push(chunk);
    var buffer = Buffer.concat(chunks);

    var FormData  = require('form-data');
    var axios     = require('axios');
    var form      = new FormData();
    form.append('file', buffer, { filename: 'audio.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', '');  // auto-detect (Yoruba, Hausa, Igbo, Pidgin, English)

    var resp = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: Object.assign({ Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, form.getHeaders()),
      timeout: 30000
    });
    return (resp.data && resp.data.text) ? resp.data.text.trim() : null;
  } catch (e) {
    console.error('[replyEngine] Whisper transcription error:', e.message);
    return null;
  }
}

// ── Upload receipt image to Supabase Storage ──────────────────
async function saveReceiptImage(sock, imageMsg, clientId, jid) {
  try {
    var { downloadContentFromMessage } = require('@whiskeysockets/baileys');
    var stream = await downloadContentFromMessage(imageMsg, 'image');
    var chunks = [];
    for await (var chunk of stream) chunks.push(chunk);
    var buffer = Buffer.concat(chunks);

    var filename = 'receipts/' + clientId + '/' + jid.replace('@s.whatsapp.net', '') + '/' + Date.now() + '.jpg';
    var sb       = db.getSupabase();
    var upResult = await sb.storage.from('forgebot-receipts').upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });

    if (!upResult.error) {
      var urlResult = sb.storage.from('forgebot-receipts').getPublicUrl(filename);
      return urlResult.data && urlResult.data.publicUrl ? urlResult.data.publicUrl : null;
    }
  } catch (e) {
    console.error('[replyEngine] Receipt upload error:', e.message);
  }
  return null;
}

// ── Send helper ───────────────────────────────────────────────
async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text: text });
  } catch (e) {
    console.error('[replyEngine] send error to', jid + ':', e.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  MAIN HANDLER
//  Called by sessionManager: handleMessage(sock, msg, clientId)
// ════════════════════════════════════════════════════════════════

async function handleMessage(sock, msg, clientId) {
  try {
    // ── Extract message content ───────────────────────────────
    var messageContent = msg.message || {};
    var jid            = msg.key && msg.key.remoteJid ? msg.key.remoteJid : null;
    if (!jid) return;

    // Ignore group messages and status broadcasts
    if (jid.endsWith('@g.us') || jid === 'status@broadcast') return;

    // Get text from message
    var text = (
      messageContent.conversation ||
      (messageContent.extendedTextMessage && messageContent.extendedTextMessage.text) ||
      (messageContent.imageMessage && messageContent.imageMessage.caption) ||
      ''
    ).trim();

    // Detect image (for receipts)
    var imageMsg = messageContent.imageMessage || null;

    // Detect voice note — transcribe with Whisper if available
    var isVoiceNote = !!(messageContent.audioMessage || messageContent.pttMessage);
    if (isVoiceNote && !text) {
      var transcribed = await transcribeVoiceNote(sock, msg);
      if (transcribed) {
        text = transcribed;
        console.log('[replyEngine] Voice note transcribed:', text.slice(0, 80));
      } else {
        // Can't transcribe — prompt
        await send(sock, jid, 'Hi! I received a voice note but couldn\'t transcribe it. Could you type your message instead? 😊');
        return;
      }
    }

    // Ignore if no text and no image
    if (!text && !imageMsg) return;

    // ── Load client + bot_setup ───────────────────────────────
    var client = await db.getClientWithSetup(clientId);
    if (!client) return;
    if (!client.subscription_active && client.status !== 'active') return;

    var setup   = (client.bot_setup && (Array.isArray(client.bot_setup) ? client.bot_setup[0] : client.bot_setup)) || {};
    var bizType = client.business_type || 'both';
    var bizName = client.business_name || 'our business';
    var ownerJid = client.notification_number
      ? client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net'
      : null;

    // ── Ignore messages from the owner's own number ───────────
    // Payment confirmations are handled via the dashboard Orders tab.
    if (ownerJid && jid === ownerJid) return;

    // ── Conversation state ────────────────────────────────────
    var key = clientId + ':' + jid;
    if (!convStates.has(key)) {
      convStates.set(key, { state: STATE.GREETING, customerName: null, cart: [], orderId: null });
    }
    var conv = convStates.get(key);

    // ── Human paused — ignore all messages ────────────────────
    if (conv.state === STATE.HUMAN_PAUSED) return;

    // ── Update customer last_contact (upsert) ─────────────────
    try {
      await db.upsertCustomer(clientId, jid, conv.customerName || null, jid.replace('@s.whatsapp.net', ''));
    } catch (e) { /* non-fatal */ }

    // ── Human handoff check (any state) ──────────────────────
    if (detect(text) === 'HUMAN') {
      conv.state = STATE.HUMAN_PAUSED;
      convStates.set(key, conv);
      await send(sock, jid,
        'Please hold on' + (conv.customerName ? ' ' + conv.customerName : '') + '! 🙏 ' +
        'Let me get someone to assist you right away. Someone will be with you shortly.'
      );
      if (ownerJid) {
        await send(sock, ownerJid,
          '🙋 *Human Handoff Alert — ' + bizName + '*\n\n' +
          'Customer: *' + (conv.customerName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          'Number: ' + jid.replace('@s.whatsapp.net', '') + '\n\n' +
          'They want to speak to a real person. Please respond on WhatsApp now.\n\n' +
          '👉 Dashboard: ' + buildDashLink()
        );
      }
      // Auto-resume after 30 minutes
      var handle = setTimeout(function() {
        var c = convStates.get(key);
        if (c) { c.state = STATE.BROWSING; convStates.set(key, c); }
        humanPaused.delete(key);
      }, 30 * 60 * 1000);
      humanPaused.set(key, handle);
      return;
    }

    // ════════════════════════════════════════════════════════════
    //  STATE MACHINE
    // ════════════════════════════════════════════════════════════

    // ── GREETING ─────────────────────────────────────────────
    if (conv.state === STATE.GREETING) {
      // Check if we already know this customer
      var existingCustomer = await db.getCustomer(clientId, jid);
      if (existingCustomer && existingCustomer.name) {
        conv.customerName = existingCustomer.name;
        conv.state = STATE.BROWSING;
        convStates.set(key, conv);
        await send(sock, jid,
          timeGreeting() + ' ' + existingCustomer.name + '! 👋 Welcome back to *' + bizName + '*. How can we help you today?'
        );
        return;
      }

      // First time — ask for name
      conv.state = STATE.AWAITING_NAME;
      convStates.set(key, conv);
      await send(sock, jid,
        timeGreeting() + '! 👋\n\n' +
        'Welcome to *' + bizName + '*. We\'re happy to have you here!\n\n' +
        'Before we continue, may we know your name please? 😊'
      );
      return;
    }

    // ── AWAITING NAME ─────────────────────────────────────────
    if (conv.state === STATE.AWAITING_NAME) {
      var rawName = text.trim();
      // Simple check — if they asked a question instead of giving a name, prompt again
      if (rawName.length < 2 || detect(rawName) !== 'UNKNOWN') {
        await send(sock, jid, 'Could you please tell us your name first? We\'d love to address you properly! 😊');
        return;
      }
      var formattedName = rawName.split(' ').map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(' ');

      conv.customerName = formattedName;
      conv.state = STATE.BROWSING;
      convStates.set(key, conv);

      // Save customer to DB
      try {
        await db.upsertCustomer(clientId, jid, formattedName, jid.replace('@s.whatsapp.net', ''));
      } catch (e) { /* non-fatal */ }

      await send(sock, jid,
        'Nice to meet you, *' + formattedName + '*! 😊\n\n' +
        'How can we help you today? You can:\n' +
        '• Ask about our products or services\n' +
        '• Place an order\n' +
        '• Ask about delivery, prices, or anything else\n\n' +
        'Just type your question! 👇'
      );
      return;
    }

    var custName = conv.customerName || '';

    // ── AWAITING RECEIPT ──────────────────────────────────────
    if (conv.state === STATE.AWAITING_RECEIPT) {
      if (imageMsg) {
        var receiptUrl = await saveReceiptImage(sock, imageMsg, clientId, jid);

        if (conv.orderId && receiptUrl) {
          try {
            await db.updateOrder(conv.orderId, { receipt_url: receiptUrl, payment_status: 'pending_verification' });
          } catch (e) { /* non-fatal */ }
        }

        await send(sock, jid,
          'Thank you ' + (custName ? custName : '') + '! 🙏 We\'ve received your payment receipt and it\'s been submitted for verification.\n\n' +
          'Please give us a few minutes to confirm. We\'ll notify you as soon as it\'s done! ⏳'
        );

        // Alert owner — dashboard only, NO 1/2/3 options
        if (ownerJid) {
          await send(sock, ownerJid,
            '💰 *New Payment Receipt — ' + bizName + '*\n\n' +
            'Customer: *' + (custName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
            'Number: ' + jid.replace('@s.whatsapp.net', '') + '\n' +
            (conv.cart && conv.cart.length ? 'Order total: *' + fmt(getOrderTotal(conv.cart)) + '*\n' : '') +
            '\n👉 *Confirm or reject on your dashboard:*\n' + buildDashLink()
          );
        }
        conv.state = STATE.BROWSING;
        convStates.set(key, conv);
      } else if (text) {
        // Text while awaiting receipt — check if payment claim or re-prompt
        if (detect(text) === 'PAYMENT_CLAIM') {
          await send(sock, jid,
            (custName ? custName + ', please' : 'Please') + ' send your payment *receipt or screenshot* as an image so we can verify it. 📸'
          );
        } else {
          await send(sock, jid,
            (custName ? custName + ', we\'re' : 'We\'re') + ' waiting for your payment receipt. Please send it as an *image or screenshot*. 📸'
          );
        }
      }
      return;
    }

    // ── AWAITING ADDRESS ──────────────────────────────────────
    if (conv.state === STATE.AWAITING_ADDRESS || conv.state === STATE.AWAITING_DELIVERY_ADDRESS) {
      var address = text.trim();
      if (address.length < 5) {
        await send(sock, jid, 'Please type your full delivery address so we know exactly where to send your order. 📍');
        return;
      }

      var total = getOrderTotal(conv.cart);
      var orderData = {
        client_id:        clientId,
        customer_jid:     jid,
        customer_name:    custName || null,
        items:            conv.cart,
        total:            total,
        order_type:       'delivery',
        delivery_address: address,
        status:           'pending',
        payment_status:   'unpaid'
      };

      try {
        var newOrder = await db.createOrder(orderData);
        conv.orderId = newOrder.id;
      } catch (e) {
        console.error('[replyEngine] createOrder error:', e.message);
      }

      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(key, conv);

      var summary = conv.cart.map(function(i) { return '• ' + i.name + ' × ' + i.qty + ' — ' + fmt(i.price * i.qty); }).join('\n');
      await send(sock, jid,
        'Perfect! Here\'s your order summary:\n\n' + summary + '\n\n' +
        '*Total: ' + fmt(total) + '*\n' +
        '📍 Delivery to: ' + address + '\n\n' +
        'To complete your order, please make payment to:\n\n' +
        buildAccountMsg(client) + '\n' +
        'After payment, send your *receipt or screenshot* here so we can confirm. 📸'
      );

      if (ownerJid) {
        await send(sock, ownerJid,
          '🛒 *New Order — ' + bizName + '*\n\n' +
          'Customer: *' + (custName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          summary + '\n' +
          'Total: *' + fmt(total) + '*\n' +
          '📍 Delivery: ' + address + '\n\n' +
          '👉 View order: ' + buildDashLink()
        );
      }
      return;
    }

    // ── AWAITING APPOINTMENT ──────────────────────────────────
    if (conv.state === STATE.AWAITING_APPT) {
      var apptTime = text.trim();
      if (apptTime.length < 3) {
        await send(sock, jid, 'Please tell us your preferred date and time for the appointment. 📅');
        return;
      }

      var apptTotal    = getOrderTotal(conv.cart);
      var apptSummary  = conv.cart.map(function(i) { return '• ' + i.name + ' × ' + i.qty + ' — ' + fmt(i.price * i.qty); }).join('\n');
      var depositReq   = setup.deposit_required && !setup.deposit_required.toLowerCase().startsWith('no');

      var apptOrder = null;
      try {
        apptOrder = await db.createOrder({
          client_id:         clientId,
          customer_jid:      jid,
          customer_name:     custName || null,
          items:             conv.cart,
          total:             apptTotal,
          order_type:        'booking',
          appointment_time:  apptTime,
          status:            'pending',
          payment_status:    'unpaid'
        });
        conv.orderId = apptOrder.id;
      } catch (e) {
        console.error('[replyEngine] createOrder (appt) error:', e.message);
      }

      if (depositReq) {
        conv.state = STATE.AWAITING_RECEIPT;
        convStates.set(key, conv);
        var depositPct = parseInt(((setup.deposit_required.match(/\d+/) || [])[0]) || '50');
        var depositAmt = Math.round(apptTotal * depositPct / 100);
        await send(sock, jid,
          'Great! Here\'s your booking summary:\n\n' + apptSummary + '\n\n' +
          '📅 Preferred time: ' + apptTime + '\n*Total: ' + fmt(apptTotal) + '*\n\n' +
          'To secure your appointment, please pay a *deposit of ' + fmt(depositAmt) + '* (' + depositPct + '%) to:\n\n' +
          buildAccountMsg(client) + '\nSend your receipt here and we\'ll confirm your booking! 📸'
        );
      } else {
        conv.state = STATE.BROWSING;
        convStates.set(key, conv);
        await send(sock, jid,
          'Your booking has been received! 🎉\n\n' + apptSummary + '\n' +
          '📅 Preferred time: ' + apptTime + '\n\n' +
          'We\'ll confirm your appointment shortly. Is there anything else you need? 😊'
        );
      }

      if (ownerJid) {
        await send(sock, ownerJid,
          '📅 *New Booking — ' + bizName + '*\n\n' +
          'Customer: *' + (custName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          apptSummary + '\n' +
          'Total: *' + fmt(apptTotal) + '*\n' +
          '📅 Preferred: ' + apptTime + '\n\n' +
          '👉 View booking: ' + buildDashLink()
        );
      }
      return;
    }

    // ── ORDERING — adding more items to cart ──────────────────
    if (conv.state === STATE.ORDERING) {
      var orderIntent = detect(text);

      if (orderIntent === 'DONE_ORDER') {
        if (!conv.cart.length) {
          conv.state = STATE.BROWSING;
          convStates.set(key, conv);
          await send(sock, jid, 'Okay ' + (custName || '') + ', feel free to browse anytime! 😊');
          return;
        }
        var isService = bizType === 'service' || bizType === 'services';
        conv.state = isService ? STATE.AWAITING_APPT : STATE.AWAITING_ADDRESS;
        convStates.set(key, conv);
        if (isService) {
          await send(sock, jid, 'Great choices! What date and time works best for you? 📅');
        } else {
          await send(sock, jid, 'Great! What is your delivery address? 📍');
        }
        return;
      }

      var orderItems = await getClientItems(clientId, bizType);
      var foundItem  = findItem(text, orderItems);
      if (foundItem) {
        var isAvail = foundItem.in_stock !== false && foundItem.available !== false;
        if (!isAvail) {
          await send(sock, jid,
            'Sorry ' + (custName || '') + ', *' + foundItem.name + '* is currently ' +
            (bizType === 'services' ? 'fully booked' : 'out of stock') + '. ' +
            await suggestAlternatives(clientId, bizType, foundItem.id)
          );
          return;
        }
        addToCart(conv, foundItem);
        convStates.set(key, conv);
        var cartSummary = conv.cart.map(function(i) { return '• ' + i.name + ' × ' + i.qty + ' — ' + fmt(i.price * i.qty); }).join('\n');
        await send(sock, jid,
          'Added *' + foundItem.name + '* to your order! ✅\n\n' +
          '*Your cart:*\n' + cartSummary + '\n' +
          '*Total: ' + fmt(getOrderTotal(conv.cart)) + '*\n\n' +
          'Anything else? Or type *done* to proceed.'
        );
      } else {
        await send(sock, jid,
          'Hmm, I couldn\'t find that. Could you check the name? Type *catalog* to see everything we have. 😊'
        );
      }
      return;
    }

    // ════════════════════════════════════════════════════════════
    //  BROWSING — main intent routing
    // ════════════════════════════════════════════════════════════

    var intent   = detect(text);
    var allItems = await getClientItems(clientId, bizType);
    var matched  = findItem(text, allItems);

    // ── PAYMENT_CLAIM ─────────────────────────────────────────
    if (intent === 'PAYMENT_CLAIM') {
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(key, conv);
      await send(sock, jid,
        'Thank you ' + (custName || '') + '! Please send your *payment receipt or screenshot* here so we can verify it. 📸'
      );
      return;
    }

    // ── PRICE inquiry ─────────────────────────────────────────
    if (intent === 'PRICE' || (matched && intent !== 'ORDER' && intent !== 'DONE_ORDER')) {
      var priceItem = matched || findItem(text, allItems);
      if (priceItem) {
        var pAvail  = priceItem.in_stock !== false && priceItem.available !== false;
        var pStatus = pAvail
          ? (bizType === 'service' || bizType === 'services' ? '✅ Available' : '✅ In stock')
          : (bizType === 'service' || bizType === 'services' ? '❌ Fully booked' : '❌ Out of stock');
        await send(sock, jid,
          '*' + priceItem.name + '*\n' +
          '💰 Price: *' + fmt(priceItem.price) + '*' +
          (priceItem.duration ? '\n⏱ Duration: ' + priceItem.duration : '') + '\n' +
          (priceItem.description ? '📝 ' + priceItem.description + '\n' : '') +
          pStatus + '\n\n' +
          (pAvail ? 'To order, just say *"I want ' + priceItem.name + '"* 😊' : 'We\'ll notify you when it\'s back!')
        );

        // Log lead (price inquiry)
        await db.logPriceInquiry(clientId, jid, custName, priceItem.name, priceItem.price, priceItem._type || 'product');

        // Lead alert to owner
        if (ownerJid) {
          await send(sock, ownerJid,
            '👀 *Price Inquiry — ' + bizName + '*\n\n' +
            '*' + (custName || jid.replace('@s.whatsapp.net', '')) + '* asked about *' + priceItem.name + '* (' + fmt(priceItem.price) + ')\n\n' +
            'This could be a potential order! 🔥\n' +
            '👉 Dashboard: ' + buildDashLink()
          );
        }
        return;
      }
      // Price asked but no item identified — show catalog
      await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
      return;
    }

    // ── ORDER intent ──────────────────────────────────────────
    if (intent === 'ORDER') {
      if (matched) {
        var oAvail = matched.in_stock !== false && matched.available !== false;
        if (!oAvail) {
          await send(sock, jid,
            'Sorry ' + (custName || '') + ', *' + matched.name + '* is currently ' +
            (bizType === 'services' ? 'fully booked' : 'out of stock') + '. ' +
            await suggestAlternatives(clientId, bizType, matched.id)
          );
          return;
        }
        conv.state = STATE.ORDERING;
        addToCart(conv, matched);
        convStates.set(key, conv);
        await send(sock, jid,
          '*' + matched.name + '* has been added to your order! ✅\n' +
          'Price: *' + fmt(matched.price) + '*\n\n' +
          'Would you like to add anything else? Or type *done* to proceed to checkout. 😊'
        );
      } else {
        // No item identified — show catalog
        await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
      }
      return;
    }

    // ── MORE ITEMS (while browsing) ───────────────────────────
    if (intent === 'MORE_ITEMS') {
      conv.state = STATE.ORDERING;
      convStates.set(key, conv);
      await send(sock, jid, 'Sure! Just tell me what else you\'d like to add. 😊');
      return;
    }

    // ── CATALOG ───────────────────────────────────────────────
    if (intent === 'CATALOG') {
      await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
      return;
    }

    // ── GREETING ──────────────────────────────────────────────
    if (intent === 'GREETING_W') {
      await send(sock, jid,
        timeGreeting() + (custName ? ' ' + custName : '') + '! 😊 Welcome to *' + bizName + '*. How can we help you today?'
      );
      return;
    }

    // ── THANKS ────────────────────────────────────────────────
    if (intent === 'THANKS') {
      await send(sock, jid,
        'You\'re welcome ' + (custName || '') + '! 😊 If you need anything else, we\'re always here. Have a wonderful day! 🌟'
      );
      return;
    }

    // ── DELIVERY ──────────────────────────────────────────────
    if (intent === 'DELIVERY') {
      var delivAreas = setup.delivery_areas || setup.delivers_to;
      if (!delivAreas) {
        await send(sock, jid, 'For delivery information, please contact us directly. 😊');
        return;
      }
      await send(sock, jid,
        '📦 *Delivery Information — ' + bizName + '*\n\n' +
        '📍 We deliver to: *' + delivAreas + '*\n' +
        (setup.delivery_fee  ? '💰 Delivery fee: ' + setup.delivery_fee + '\n' : '') +
        (setup.delivery_time ? '⏱ Delivery time: ' + setup.delivery_time + '\n' : '') +
        (setup.minimum_order ? '🛒 Minimum order: ' + setup.minimum_order + '\n' : '') +
        '\nType *"I want to order"* to place your order now! 😊'
      );
      return;
    }

    // ── LOCATION ──────────────────────────────────────────────
    if (intent === 'LOCATION') {
      var loc = setup.studio_location || client.business_address || setup.location;
      if (loc) {
        await send(sock, jid,
          '📍 *Our Location*\n' + loc + '\n\n' +
          (client.business_hours ? '🕐 Hours: ' + client.business_hours + '\n\n' : '') +
          'Feel free to visit us anytime! 😊'
        );
      } else {
        await send(sock, jid, 'We are an online business and deliver to you. Type *delivery* to see delivery info. 😊');
      }
      return;
    }

    // ── HOURS ────────────────────────────────────────────────
    if (intent === 'HOURS') {
      var hrs = client.business_hours || setup.availability_days || setup.business_hours;
      if (hrs) {
        await send(sock, jid, '🕐 *Business Hours*\n' + hrs + '\n\nWe\'re happy to assist during these times! 😊');
      } else {
        await send(sock, jid, 'We\'re available daily. Message us and we\'ll respond as soon as possible! 😊');
      }
      return;
    }

    // ── SOCIAL MEDIA ─────────────────────────────────────────
    if (intent === 'SOCIAL') {
      var socials = [];
      if (setup.instagram)        socials.push('📸 Instagram: ' + setup.instagram);
      if (setup.facebook)         socials.push('👥 Facebook: ' + setup.facebook);
      if (setup.tiktok)           socials.push('🎵 TikTok: ' + setup.tiktok);
      if (setup.whatsapp_channel) socials.push('💬 WhatsApp Channel: ' + setup.whatsapp_channel);
      if (socials.length) {
        await send(sock, jid, '📲 *Follow us!*\n\n' + socials.join('\n') + '\n\nStay updated with our latest deals! 🔥');
      } else {
        await send(sock, jid, 'We\'ll be on social media soon! Stay tuned. 😊');
      }
      return;
    }

    // ── PAYMENT QUESTION ──────────────────────────────────────
    if (intent === 'PAYMENT_Q') {
      await send(sock, jid, buildAccountMsg(client));
      return;
    }

    // ── COMPLAINT ────────────────────────────────────────────
    if (intent === 'COMPLAINT') {
      var complaintPolicy = setup.complaint_handling || 'Please send us a photo or description of the issue and we will resolve it immediately.';
      await send(sock, jid,
        'We\'re so sorry to hear that ' + (custName || '') + '! 😔\n\n' + complaintPolicy + '\n\n' +
        'Our team will attend to this right away.'
      );
      if (ownerJid) {
        await send(sock, ownerJid,
          '⚠️ *Complaint — ' + bizName + '*\n\n' +
          'Customer *' + (custName || jid.replace('@s.whatsapp.net', '')) + '* reported an issue:\n"' + text.slice(0, 200) + '"\n\n' +
          'Please follow up!\n👉 ' + buildDashLink()
        );
      }
      return;
    }

    // ── RETURN ────────────────────────────────────────────────
    if (intent === 'RETURN') {
      var returnPolicy = setup.return_policy || 'Please contact us directly about returns and we\'ll be happy to assist.';
      await send(sock, jid, '📋 *Our Return Policy*\n\n' + returnPolicy + '\n\nFeel free to reach out if you have questions! 😊');
      return;
    }

    // ── BULK ORDER ────────────────────────────────────────────
    if (intent === 'BULK') {
      var bulkPolicy = setup.bulk_orders || 'Please contact us directly for bulk order pricing and availability.';
      await send(sock, jid, '📦 *Bulk Orders*\n\n' + bulkPolicy + '\n\nSend us what you need and we\'ll get back to you! 😊');
      return;
    }

    // ── PROMO / DISCOUNT ─────────────────────────────────────
    if (intent === 'PROMO') {
      var currentPromo = setup.promo || setup.current_promo || 'We don\'t have any active promotions right now. Follow our WhatsApp status for the latest deals!';
      await send(sock, jid, '🎉 *Current Promotions*\n\n' + currentPromo);
      return;
    }

    // ── FAQ matching (from business_faq table) ────────────────
    var faqAnswer = await matchFAQ(text, clientId);
    if (faqAnswer) {
      await send(sock, jid, faqAnswer);
      return;
    }

    // ── Custom auto-reply rules ───────────────────────────────
    try {
      var flows = await db.getFlows(clientId, true);
      if (flows && flows.length) {
        var tLow = text.toLowerCase();
        for (var fi = 0; fi < flows.length; fi++) {
          var flow = flows[fi];
          var kwList = (flow.keywords || '').split(',').map(function(k) { return k.trim().toLowerCase(); });
          if (kwList.some(function(kw) { return tLow.includes(kw); })) {
            await send(sock, jid, flow.response);
            return;
          }
        }
      }
    } catch (e) { /* non-fatal */ }

    // ── Item matched but intent ambiguous ─────────────────────
    if (matched) {
      var mAvail = matched.in_stock !== false && matched.available !== false;
      await send(sock, jid,
        '*' + matched.name + '*\n💰 *' + fmt(matched.price) + '*\n' +
        (matched.description ? '📝 ' + matched.description + '\n' : '') +
        (mAvail ? '\nTo order, say *"I want ' + matched.name + '"* 😊' : '\nCurrently ' + (bizType === 'services' ? 'fully booked' : 'out of stock') + '.')
      );
      return;
    }

    // ── Fallback ──────────────────────────────────────────────
    var fallbackMsg = client.fallback_message ||
      ('Thank you for your message' + (custName ? ' ' + custName : '') + '! 😊 I\'m not sure I understood that. You can:\n\n' +
      '• Type *catalog* to see what we offer\n' +
      '• Ask about price, delivery, or location\n' +
      '• Say *"I want to order"* to place an order\n' +
      '• Type *help* to speak to a person');
    await send(sock, jid, fallbackMsg);

  } catch (err) {
    console.error('[replyEngine] Unhandled error:', err.message, err.stack);
  }
}

module.exports = { handleMessage };
