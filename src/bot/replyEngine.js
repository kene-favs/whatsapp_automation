// ============================================================
//  ForgeBot — Smart Reply Engine v3.1
//  Full state machine: customer greeting, name capture,
//  catalog browsing, cart, order flow, receipt upload,
//  payment confirmation, delivery flow, lead tracking.
//
//  Called by sessionManager.js as:
//    replyEngine.handleMessage(sock, msg, clientId)
// ============================================================

const db = require('../db/supabase');
const { transcribeVoiceNote } = require('./voiceHandler');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

// ── Conversation state machine ────────────────────────────────
// Key: "clientId:jid"
const convStates = new Map();

const STATE = {
  GREETING:         'GREETING',
  AWAITING_NAME:    'AWAITING_NAME',
  BROWSING:         'BROWSING',
  ORDERING:         'ORDERING',
  AWAITING_ADDRESS: 'AWAITING_ADDRESS',
  AWAITING_APPT:    'AWAITING_APPT',
  AWAITING_RECEIPT: 'AWAITING_RECEIPT',
  AWAITING_DELIVERY_ADDRESS: 'AWAITING_DELIVERY_ADDRESS',
  HUMAN_PAUSED:     'HUMAN_PAUSED',
};

// Human handoff pause tracker
const humanPaused = new Map();

// ── Intent keyword lists ──────────────────────────────────────
const INTENT = {
  PRICE: [
    'how much','price','cost','rate','fee','charge',
    'how much is','what is the price','pricing','cost of','price of','how much for'
  ],
  ORDER: [
    'i want','i want to order','order','buy','get me','i need',
    "i'd like",'i will take',"i'll take",'purchase','can i get',
    'let me get','add to cart',"i'll order",'place order'
  ],
  MORE_ITEMS: [
    'and also','also add','add another','i also want','and i want',
    'plus','what about'
  ],
  DONE_ORDER: [
    "that's all",'that is all','nothing else','done',"that's everything",
    'checkout','proceed','confirm order','just that'
  ],
  CATALOG: [
    'what do you have','what do you sell','show me','your products',
    'your services',"what's available",'catalog','list','menu',
    'what can i order','what you get','all products','all services'
  ],
  DELIVERY: [
    'delivery','deliver','shipping','how long','when will i',
    'how many days','when do i','dispatch','when will it arrive'
  ],
  LOCATION: [
    'where are you','your location','address','where to','how to get',
    'come and pick','pickup','pick up','your office','your shop',
    'your studio','where is your'
  ],
  HOURS: [
    'open','opening hours','business hours','working hours','available',
    'what time','when do you close','when do you open','are you open',
    'closed','office hours'
  ],
  SOCIAL: [
    'instagram','facebook','tiktok','twitter','social media',
    'follow you','your page','online','your handle',
    'whatsapp channel','your channel'
  ],
  PAYMENT_Q: [
    'how to pay','account number','bank details','where to transfer',
    'payment details','send account','your account','bank account','which bank'
  ],
  COMPLAINT: [
    'damaged','wrong item','wrong product','broken',
    'not what i ordered','issue','problem','bad','spoilt',
    'received wrong','got wrong','defective'
  ],
  RETURN: ['return','exchange','refund','give back','change it','swap','money back'],
  BULK: ['bulk','wholesale','large quantity','many units','lots of','mass order','large order'],
  REFERRAL: ['referral','refer','referral bonus','refer a friend'],
  PROMO: ['promo','discount','offer','sale','coupon','deal','promotion','any deal'],
  HUMAN: [
    'speak to human','real person','talk to someone','agent',
    'customer care','customer service','representative','call me',
    'speak to someone','human please','real agent','i need help from'
  ],
  PAYMENT_CLAIM: [
    'i have paid',"i've paid",'i sent','i transferred','payment done',
    'i paid','done paying','just paid','already paid','sent the money',
    'i don pay','i don send','i don transfer','money sent',
    'payment sent','i don drop','alert sent','i pay am'
  ],
  GREETING_W: [
    'hello','hi','good morning','good afternoon','good evening',
    'hey','helo','hii','howdy','sup','whats up',"what's up",'greetings'
  ],
  THANKS: [
    'thank you','thanks','thank u','ok thank','ok thanks',
    'perfect','great','alright','noted','okay','got it'
  ],
};

function detect(text) {
  const t = text.toLowerCase().trim();
  for (const [intent, keywords] of Object.entries(INTENT)) {
    if (keywords.some(function(kw) { return t.includes(kw); })) return intent;
  }
  return 'UNKNOWN';
}

// Fuzzy product/service name matcher
function findItem(text, items) {
  if (!items || !items.length) return null;
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  for (const item of items) {
    if (t.includes(item.name.toLowerCase())) return item;
  }
  for (const item of items) {
    const words = item.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(function(w) { return w.length > 2; });
    const hits = words.filter(function(w) { return t.includes(w); });
    if (words.length > 0 && hits.length >= Math.ceil(words.length * 0.6)) return item;
  }
  return null;
}

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmt(price) {
  return '₦' + Number(price).toLocaleString();
}

function buildDashLink(client) {
  const base = process.env.APP_URL || 'https://yourapp.railway.app';
  return base + '/dashboard';
}

function buildAccountMsg(client) {
  if (!client.bank_name) {
    return 'Please contact us for payment details. 😊';
  }
  return (
    '🏦 *Payment Details*\n\n' +
    'Bank: *' + client.bank_name + '*\n' +
    'Account Number: *' + client.account_number + '*\n' +
    'Account Name: *' + (client.account_name || client.business_name) + '*\n\n' +
    'After payment, please send your *receipt or screenshot* here so we can confirm quickly. 📸'
  );
}

function addToCart(conv, item) {
  const existing = conv.cart.find(function(c) { return c.id === item.id; });
  if (existing) {
    existing.qty += 1;
  } else {
    conv.cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, type: item._type || 'product' });
  }
}

function getOrderTotal(cart) {
  return cart.reduce(function(sum, i) { return sum + i.price * i.qty; }, 0);
}

async function getClientItems(clientId, bizType) {
  const items = [];
  if (bizType === 'products' || bizType === 'both') {
    const products = await db.getProducts(clientId);
    products.forEach(function(p) { items.push(p); });
  }
  if (bizType === 'services' || bizType === 'both') {
    const services = await db.getServices(clientId);
    services.forEach(function(s) { items.push(s); });
  }
  return items;
}

async function buildCatalogMsg(items, bizType, bizName) {
  if (!items || !items.length) {
    return 'We’re currently updating our ' + (bizType === 'services' ? 'services' : 'products') + '. Please check back soon! 😊';
  }
  const available = items.filter(function(i) { return i.in_stock !== false && i.available !== false; });
  if (!available.length) {
    return 'All our ' + (bizType === 'services' ? 'services' : 'products') + ' are currently sold out. We’ll restock soon! 😊';
  }
  const lines = available.map(function(i) {
    return '• *' + i.name + '* — ' + fmt(i.price) +
      (i.duration ? ' (' + i.duration + ')' : '') +
      (i.description ? '\n  ' + i.description : '');
  }).join('\n\n');
  return (
    '📋 *' + bizName + ' — ' + (bizType === 'services' ? 'Our Services' : 'Our Products') + '*\n\n' +
    lines + '\n\n' +
    'To order, just say *"I want [item name]"* 😊'
  );
}

async function suggestAlternatives(clientId, bizType, excludeId) {
  const supabase = db.getSupabase();
  let data;
  if (bizType === 'services') {
    const r = await supabase.from('services').select('*').eq('client_id', clientId).eq('available', true).neq('id', excludeId).limit(3);
    data = r.data;
  } else {
    const r = await supabase.from('products').select('*').eq('client_id', clientId).eq('in_stock', true).neq('id', excludeId).limit(3);
    data = r.data;
  }
  if (!data || !data.length) return 'We’ll let you know when it’s available again! 😊';
  const names = data.map(function(i) { return '*' + i.name + '* (' + fmt(i.price) + ')'; }).join(', ');
  return 'You might also like: ' + names + '. 😊';
}

function matchCustomFAQ(text, setup) {
  const t = text.toLowerCase();
  const pairs = [
    [setup.custom_service_1_q, setup.custom_service_1_a],
    [setup.custom_service_2_q, setup.custom_service_2_a],
    [setup.custom_service_3_q, setup.custom_service_3_a],
  ];
  for (const [q, a] of pairs) {
    if (!q || !a) continue;
    const qWords = q.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(function(w) { return w.length > 3; });
    const hits = qWords.filter(function(w) { return t.includes(w); });
    if (hits.length >= Math.ceil(qWords.length * 0.5)) return a;
  }
  return null;
}

async function saveReceiptImage(sock, imageMsg, clientId, jid) {
  try {
    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const supabase = db.getSupabase();
    const filename = 'receipts/' + clientId + '/' + jid.replace('@s.whatsapp.net', '') + '/' + Date.now() + '.jpg';
    const { data, error } = await supabase.storage
      .from('forgebot-receipts')
      .upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });

    if (!error) {
      const { data: urlData } = supabase.storage.from('forgebot-receipts').getPublicUrl(filename);
      return urlData ? urlData.publicUrl : null;
    }
  } catch (e) {
    console.error('[ReplyEngine] Receipt upload failed:', e.message);
  }
  return null;
}

async function send(sock, jid, text) {
  try {
    await sock.sendPresenceUpdate('composing', jid);
    await new Promise(function(r) { setTimeout(r, 800 + Math.random() * 1200); });
    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: text });
  } catch (e) {
    console.error('[ReplyEngine] Send error to ' + jid + ':', e.message);
  }
}

// ── Main message handler ──────────────────────────────────────
// Called by sessionManager.js as: handleMessage(sock, msg, clientId)
async function handleMessage(sock, msg, clientId) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    if (msg.key.fromMe) return;

    const msgContent = msg.message;
    if (!msgContent) return;

    const isVoice = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
    const isAudio = !!(msgContent.audioMessage);
    const imageMsg = msgContent.imageMessage || null;

    let text = msgContent.conversation ||
               (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    // ── Voice note handling ────────────────────────────────────
    if (isVoice || isAudio) {
      const transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await send(sock, jid, 'I received your voice note! Could you please type your message so I can help you faster? 😊');
        return;
      }
      text = transcribed;
      await send(sock, jid, 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...');
    }

    // ── Load client with bot setup ────────────────────────────
    const client = await db.getClientWithSetup(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    const setup = (client.bot_setup && client.bot_setup[0]) ? client.bot_setup[0] : {};
    const bizType = client.business_type || 'products';
    const bizName = client.business_name || 'our business';
    const ownerJid = client.notification_number ? client.notification_number + '@s.whatsapp.net' : null;

    const stateKey = clientId + ':' + jid;

    // ── Ignore messages from the owner’s own number ──────────
    // Payment confirmations are handled via the dashboard Orders tab.
    if (ownerJid && jid === ownerJid) return;

    // ── Get/init conversation state ───────────────────────────
    if (!convStates.has(stateKey)) {
      convStates.set(stateKey, { state: STATE.GREETING, customerName: null, cart: [], orderId: null });
    }
    const conv = convStates.get(stateKey);

    // ── Human paused — owner is handling this customer ────────
    if (conv.state === STATE.HUMAN_PAUSED) return;

    // ── Human handoff check (any state) ──────────────────────
    if (detect(text) === 'HUMAN') {
      conv.state = STATE.HUMAN_PAUSED;
      convStates.set(stateKey, conv);
      await send(sock, jid,
        'Please hold on' + (conv.customerName ? ' *' + conv.customerName + '*' : '') + '! 🙏 ' +
        'Let me connect you with the owner right away. They’ll be with you shortly.'
      );
      if (ownerJid) {
        await sock.sendMessage(ownerJid,
          '👋 *Human Handoff — ' + bizName + '*\n\n' +
          'Customer: *' + (conv.customerName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          'Number: ' + jid.replace('@s.whatsapp.net', '') + '\n\n' +
          'They want to speak to a real person. Please reply to them directly.\n\n' +
          '👉 Dashboard: ' + buildDashLink(client)
        );
      }
      // Resume bot after 30 minutes
      setTimeout(function() {
        const c = convStates.get(stateKey);
        if (c && c.state === STATE.HUMAN_PAUSED) {
          c.state = STATE.BROWSING;
          convStates.set(stateKey, c);
        }
        humanPaused.delete(stateKey);
      }, 30 * 60 * 1000);
      humanPaused.set(stateKey, true);
      return;
    }

    // ── STATE: AWAITING DELIVERY ADDRESS (after payment confirmed) ──
    if (conv.state === STATE.AWAITING_DELIVERY_ADDRESS) {
      const addressText = text.trim().toLowerCase();
      if (addressText === 'pickup' || addressText.includes('pick up') || addressText.includes('pickup')) {
        if (conv.orderId) {
          await db.updateOrder(conv.orderId, { order_type: 'pickup' });
        }
        conv.state = STATE.BROWSING;
        convStates.set(stateKey, conv);
        await send(sock, jid,
          'Perfect! Your order is marked for *pickup*. 📦\n\n' +
          'We’ll notify you when it’s ready for collection. Is there anything else we can help you with?'
        );
        if (ownerJid) {
          await sock.sendMessage(ownerJid,
            '📦 *Pickup Order — ' + bizName + '*\n\n' +
            'Customer *' + (conv.customerName || jid.replace('@s.whatsapp.net', '')) + '* chose pickup.\n' +
            '👉 Dashboard: ' + buildDashLink(client)
          );
        }
        return;
      }

      if (text.trim().length < 5) {
        await send(sock, jid, 'Please type your *full delivery address* so we know exactly where to send your order. 📍');
        return;
      }

      const address = text.trim();
      if (conv.orderId) {
        await db.updateOrder(conv.orderId, { delivery_address: address, status: 'processing' });
      }
      conv.state = STATE.BROWSING;
      convStates.set(stateKey, conv);

      await send(sock, jid,
        'Perfect! We’ve got your delivery address:\n📍 *' + address + '*\n\n' +
        'We’re now preparing your order! We’ll notify you as soon as it’s on its way. 📦'
      );

      if (ownerJid) {
        await sock.sendMessage(ownerJid,
          '📍 *Delivery Address Received — ' + bizName + '*\n\n' +
          'Customer: *' + (conv.customerName || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          'Address: *' + address + '*\n\n' +
          '👉 Confirm & manage order: ' + buildDashLink(client)
        );
      }
      return;
    }

    // ── STATE: AWAITING RECEIPT (image upload) ────────────────
    if (conv.state === STATE.AWAITING_RECEIPT) {
      if (imageMsg) {
        const receiptUrl = await saveReceiptImage(sock, imageMsg, clientId, jid);
        const name = conv.customerName || '';

        // Update order with receipt
        if (conv.orderId) {
          await db.updateOrder(conv.orderId, { receipt_url: receiptUrl || 'forwarded' });
        }

        await send(sock, jid,
          'Thank you *' + (name || '') + '*! 🙏 We’ve received your payment receipt and it’s been submitted for verification.\n\n' +
          'Please give us a few minutes to confirm. We’ll notify you right away! ⏳'
        );

        // Alert owner with forwarded receipt + dashboard link
        if (ownerJid) {
          await sock.sendMessage(ownerJid, {
            text: '💰 *New Payment Receipt — ' + bizName + '*\n\n' +
              'Customer: *' + (name || jid.replace('@s.whatsapp.net', '')) + '*\n' +
              'Number: ' + jid.replace('@s.whatsapp.net', '') + '\n' +
              (conv.cart && conv.cart.length ? 'Order total: *' + fmt(getOrderTotal(conv.cart)) + '*\n' : '') +
              '\n👉 *Confirm or reject on your dashboard:*\n' + buildDashLink(client)
          });
          // Forward the actual receipt image to owner
          try {
            await sock.sendMessage(ownerJid, {
              image: imageMsg,
              caption: 'Receipt from ' + (name || jid.replace('@s.whatsapp.net', ''))
            });
          } catch (e) {
            console.error('[ReplyEngine] Could not forward receipt image:', e.message);
          }
        }

        conv.state = STATE.BROWSING;
        convStates.set(stateKey, conv);
        return;
      } else if (text.trim()) {
        // Customer sent text while waiting for receipt — remind them
        await send(sock, jid,
          (conv.customerName ? '*' + conv.customerName + '*, please' : 'Please') +
          ' send your payment receipt as an *image or screenshot* so we can verify it. 📸'
        );
        return;
      }
    }

    // ── STATE: GREETING (first contact) ──────────────────────
    if (conv.state === STATE.GREETING) {
      const existing = await db.getCustomer(clientId, jid);
      if (existing && existing.name) {
        conv.customerName = existing.name;
        conv.state = STATE.BROWSING;
        convStates.set(stateKey, conv);
        await send(sock, jid,
          timeGreeting() + ' *' + existing.name + '*! 👋 Welcome back to *' + bizName + '*. How can we help you today?'
        );
        return;
      }

      // First time — welcome and ask name
      const welcomeMsg = client.welcome_message ||
        (timeGreeting() + '! 👋\n\nWelcome to *' + bizName + '*. We’re happy to have you here!\n\nBefore we continue, may we know your name please? 😊');

      conv.state = STATE.AWAITING_NAME;
      convStates.set(stateKey, conv);
      await send(sock, jid, welcomeMsg);
      return;
    }

    // ── STATE: AWAITING NAME ──────────────────────────────────
    if (conv.state === STATE.AWAITING_NAME) {
      const name = text.trim().split(' ').map(function(w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(' ');
      conv.customerName = name;
      conv.state = STATE.BROWSING;
      convStates.set(stateKey, conv);

      // Save customer to DB
      await db.upsertCustomer(clientId, jid, name, jid.replace('@s.whatsapp.net', ''));

      await send(sock, jid,
        'Nice to meet you, *' + name + '*! 😊\n\n' +
        'How can we help you today? You can:\n' +
        '• Ask about our products or services\n' +
        '• Place an order\n' +
        '• Ask about delivery, prices, or anything else\n\n' +
        'Just type your question! 👇'
      );
      return;
    }

    const name = conv.customerName || '';

    // ── STATE: AWAITING ADDRESS (order checkout) ──────────────
    if (conv.state === STATE.AWAITING_ADDRESS) {
      const address = text.trim();
      if (address.length < 5) {
        await send(sock, jid, 'Please type your *full delivery address* so we know exactly where to send your order. 📍');
        return;
      }

      const total = getOrderTotal(conv.cart);
      const supabase = db.getSupabase();
      const { data: order } = await supabase.from('orders').insert({
        client_id: clientId,
        customer_jid: jid,
        customer_name: name,
        items: conv.cart,
        total,
        order_type: 'delivery',
        delivery_address: address,
        status: 'pending',
        payment_status: 'unpaid'
      }).select().single();

      conv.orderId = order ? order.id : null;
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(stateKey, conv);

      const summary = conv.cart.map(function(i) {
        return '• *' + i.name + '* \xd7 ' + i.qty + ' — ' + fmt(i.price * i.qty);
      }).join('\n');

      await send(sock, jid,
        'Perfect! Here’s your order summary:\n\n' + summary + '\n\n' +
        '*Total: ' + fmt(total) + '*\n' +
        '📍 Delivery to: ' + address + '\n\n' +
        'To complete your order, please make payment to:\n\n' +
        buildAccountMsg(client)
      );

      if (ownerJid) {
        await sock.sendMessage(ownerJid,
          '🛒 *New Order — ' + bizName + '*\n\n' +
          'Customer: *' + (name || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          summary + '\n' +
          'Total: *' + fmt(total) + '*\n' +
          '📍 Delivery: ' + address + '\n\n' +
          '👉 View order: ' + buildDashLink(client)
        );
      }
      return;
    }

    // ── STATE: AWAITING APPOINTMENT ───────────────────────────
    if (conv.state === STATE.AWAITING_APPT) {
      const apptTime = text.trim();
      if (apptTime.length < 3) {
        await send(sock, jid, 'Please tell us your preferred *date and time* for the appointment. 📅');
        return;
      }

      const total = getOrderTotal(conv.cart);
      const supabase = db.getSupabase();
      const depositRequired = setup.deposit_required && !setup.deposit_required.toLowerCase().startsWith('no');

      const { data: order } = await supabase.from('orders').insert({
        client_id: clientId,
        customer_jid: jid,
        customer_name: name,
        items: conv.cart,
        total,
        order_type: 'booking',
        appointment_time: apptTime,
        status: 'pending',
        payment_status: depositRequired ? 'unpaid' : 'na'
      }).select().single();

      conv.orderId = order ? order.id : null;
      const summary = conv.cart.map(function(i) {
        return '• *' + i.name + '* \xd7 ' + i.qty + ' — ' + fmt(i.price * i.qty);
      }).join('\n');

      if (depositRequired) {
        conv.state = STATE.AWAITING_RECEIPT;
        convStates.set(stateKey, conv);
        const depositPct = parseInt((setup.deposit_required.match(/\d+/) || ['50'])[0]);
        const depositAmt = Math.round(total * depositPct / 100);
        await send(sock, jid,
          'Great! Here’s your booking summary:\n\n' + summary + '\n\n' +
          '📅 Preferred time: ' + apptTime + '\n*Total: ' + fmt(total) + '*\n\n' +
          'To secure your appointment, please pay a *deposit of ' + fmt(depositAmt) + '* (' + depositPct + '%) to:\n\n' +
          buildAccountMsg(client) +
          '\nSend your receipt here and we’ll confirm your booking! 📸'
        );
      } else {
        conv.state = STATE.BROWSING;
        convStates.set(stateKey, conv);
        await send(sock, jid,
          'Your booking has been received! 🎉\n\n' + summary +
          '\n📅 Preferred time: ' + apptTime + '\n\n' +
          'We’ll confirm your appointment shortly. Is there anything else you need? 😊'
        );
      }

      if (ownerJid) {
        await sock.sendMessage(ownerJid,
          '📅 *New Booking — ' + bizName + '*\n\n' +
          'Customer: *' + (name || jid.replace('@s.whatsapp.net', '')) + '*\n' +
          summary + '\nTotal: *' + fmt(total) + '*\n' +
          '📅 Preferred: ' + apptTime + '\n\n' +
          '👉 View booking: ' + buildDashLink(client)
        );
      }
      return;
    }

    // ── STATE: ORDERING (adding items to cart) ────────────────
    if (conv.state === STATE.ORDERING) {
      const intentNow = detect(text);

      if (intentNow === 'DONE_ORDER') {
        if (!conv.cart.length) {
          conv.state = STATE.BROWSING;
          convStates.set(stateKey, conv);
          await send(sock, jid, 'Okay ' + (name || '') + ', feel free to browse anytime! 😊');
          return;
        }
        conv.state = bizType === 'services' ? STATE.AWAITING_APPT : STATE.AWAITING_ADDRESS;
        convStates.set(stateKey, conv);
        if (bizType === 'services') {
          await send(sock, jid, 'Great choices! What *date and time* works for you? 📅');
        } else {
          await send(sock, jid, 'Great! What is your *delivery address*? 📍');
        }
        return;
      }

      const allItems = await getClientItems(clientId, bizType);
      const found = findItem(text, allItems);
      if (found) {
        const available = found.in_stock !== false && found.available !== false;
        if (!available) {
          await send(sock, jid,
            'Sorry ' + (name || '') + ', *' + found.name + '* is currently ' +
            (bizType === 'services' ? 'fully booked' : 'out of stock') + '. ' +
            await suggestAlternatives(clientId, bizType, found.id)
          );
          return;
        }
        addToCart(conv, found);
        convStates.set(stateKey, conv);
        const summary = conv.cart.map(function(i) {
          return '• *' + i.name + '* \xd7 ' + i.qty + ' — ' + fmt(i.price * i.qty);
        }).join('\n');
        await send(sock, jid,
          'Added *' + found.name + '* to your order! ✅\n\n' +
          '*Your cart:*\n' + summary + '\n' +
          '*Total: ' + fmt(getOrderTotal(conv.cart)) + '*\n\n' +
          'Anything else? Or type *done* to proceed to checkout.'
        );
      } else {
        await send(sock, jid,
          'Hmm, I couldn’t find that item. Could you check the name?\n\n' +
          'Type *catalog* to see all available ' + (bizType === 'services' ? 'services' : 'products') + '.'
        );
      }
      return;
    }

    // ── BROWSING — main intent routing ────────────────────────
    const intent = detect(text);
    const allItems = await getClientItems(clientId, bizType);
    const matchedItem = findItem(text, allItems);

    // Check if image is sent while browsing (could be an unsolicited receipt)
    if (imageMsg && !text.trim()) {
      // Customer sent image while not in AWAITING_RECEIPT — could be spontaneous receipt
      const isLikelyReceipt = detect('i paid') === 'PAYMENT_CLAIM'; // heuristic
      if (conv.orderId) {
        // Treat as receipt for existing order
        conv.state = STATE.AWAITING_RECEIPT;
        convStates.set(stateKey, conv);
        // Re-invoke with the image
        await handleMessage(sock, msg, clientId);
        return;
      }
    }

    // PAYMENT CLAIM
    if (intent === 'PAYMENT_CLAIM') {
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(stateKey, conv);
      if (imageMsg) {
        // They sent receipt at same time as payment claim text — process it directly
        await handleMessage(sock, msg, clientId);
        return;
      }
      await send(sock, jid,
        'Thank you *' + (name || '') + '*! Please send your *payment receipt or screenshot* here so we can verify it quickly. 📸'
      );
      return;
    }

    // PRICE INQUIRY
    if (intent === 'PRICE' || (matchedItem && intent !== 'ORDER')) {
      const item = matchedItem;
      if (item) {
        const available = item.in_stock !== false && item.available !== false;
        const status = available
          ? (bizType === 'services' ? '✅ Available' : '✅ In stock')
          : (bizType === 'services' ? '❌ Fully booked' : '❌ Out of stock');
        const durStr = item.duration ? '\n⏱ Duration: ' + item.duration : '';
        await send(sock, jid,
          '*' + item.name + '*\n' +
          '💰 Price: *' + fmt(item.price) + '*' + durStr + '\n' +
          (item.description ? '📝 ' + item.description + '\n' : '') +
          status + '\n\n' +
          (available ? 'To order, just say *"I want ' + item.name + '"* 😊' : 'We’ll notify you when it’s back!')
        );

        // Log lead
        await db.logPriceInquiry(clientId, jid, name, item.name, item.price, item._type || 'product');

        // Alert owner
        if (ownerJid) {
          await sock.sendMessage(ownerJid,
            '🔥 *Price Inquiry — ' + bizName + '*\n\n' +
            '*' + (name || jid.replace('@s.whatsapp.net', '')) + '* just asked about *' + item.name + '* (' + fmt(item.price) + ')\n\n' +
            'This could be a potential order! 💰\n\n' +
            '👉 Dashboard: ' + buildDashLink(client)
          );
        }
        return;
      }
    }

    // ORDER intent
    if (intent === 'ORDER') {
      const item = matchedItem;
      if (item) {
        const available = item.in_stock !== false && item.available !== false;
        if (!available) {
          await send(sock, jid,
            'Sorry *' + (name || '') + '*, *' + item.name + '* is currently ' +
            (bizType === 'services' ? 'fully booked' : 'out of stock') + '. ' +
            await suggestAlternatives(clientId, bizType, item.id)
          );
          return;
        }
        conv.state = STATE.ORDERING;
        addToCart(conv, item);
        convStates.set(stateKey, conv);
        await send(sock, jid,
          '*' + item.name + '* has been added to your order! ✅\n' +
          'Price: *' + fmt(item.price) + '*\n\n' +
          'Would you like to add anything else? Or type *done* to proceed to checkout. 😊'
        );
      } else {
        // No specific item — show catalog
        await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
      }
      return;
    }

    // PAYMENT QUESTION (how to pay)
    if (intent === 'PAYMENT_Q') {
      await send(sock, jid, buildAccountMsg(client));
      return;
    }

    // CATALOG
    if (intent === 'CATALOG') {
      await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
      return;
    }

    // GREETING
    if (intent === 'GREETING_W') {
      await send(sock, jid,
        timeGreeting() + (name ? ' *' + name + '*' : '') + '! 😊 Welcome to *' + bizName + '*. How can we help you today?'
      );
      return;
    }

    // THANKS
    if (intent === 'THANKS') {
      await send(sock, jid,
        'You’re welcome' + (name ? ' *' + name + '*' : '') + '! 😊 If you need anything else, we’re always here. Have a wonderful day! 🌟'
      );
      return;
    }

    // DELIVERY info
    if (intent === 'DELIVERY') {
      if (!setup.delivers_to) {
        await send(sock, jid, 'For delivery information, please contact us directly. 😊');
        return;
      }
      await send(sock, jid,
        '📦 *Delivery Information — ' + bizName + '*\n\n' +
        '📍 We deliver to: *' + setup.delivers_to + '*\n\n' +
        '🏙 Within the city:\n• Fee: ' + (setup.delivery_fee_local || 'Contact us') +
        '\n• Time: ' + (setup.delivery_time_local || 'Contact us') + '\n\n' +
        (setup.delivery_fee_outside ? '🌍 Outside the city:\n• Fee: ' + setup.delivery_fee_outside + '\n• Time: ' + (setup.delivery_time_outside || 'Varies') + '\n\n' : '') +
        (setup.payment_on_delivery ? '💳 Payment on delivery: ' + setup.payment_on_delivery + '\n' : '') +
        (setup.minimum_order ? '🛒 Minimum order: ' + setup.minimum_order : '')
      );
      return;
    }

    // LOCATION
    if (intent === 'LOCATION') {
      const loc = setup.studio_location || client.location_address;
      if (loc) {
        await send(sock, jid,
          '📍 *Our Location*\n' + loc + '\n\n' +
          (setup.availability_days ? '🕐 Hours: ' + setup.availability_days + '\n\n' : '') +
          'Feel free to visit us anytime! 😊'
        );
      } else {
        await send(sock, jid,
          'We are an online business and deliver to you. Type *delivery* to see our delivery info. 😊'
        );
      }
      return;
    }

    // HOURS
    if (intent === 'HOURS') {
      const hours = client.business_hours || setup.availability_days;
      if (hours) {
        await send(sock, jid, '🕐 *Our Business Hours*\n' + hours + '\n\nWe’re happy to assist you during these times! 😊');
      } else {
        await send(sock, jid, 'We operate daily. Feel free to message us and we’ll respond as soon as possible! 😊');
      }
      return;
    }

    // SOCIAL MEDIA
    if (intent === 'SOCIAL') {
      const socials = [];
      if (setup.instagram)        socials.push('📸 Instagram: ' + setup.instagram);
      if (setup.facebook)         socials.push('👥 Facebook: ' + setup.facebook);
      if (setup.tiktok)           socials.push('🎵 TikTok: ' + setup.tiktok);
      if (setup.whatsapp_channel) socials.push('💬 WhatsApp Channel: ' + setup.whatsapp_channel);
      if (socials.length) {
        await send(sock, jid,
          '📲 *Follow us on social media!*\n\n' + socials.join('\n') + '\n\n' +
          'Stay updated with our latest products and deals! 🔥'
        );
      } else {
        await send(sock, jid, 'We’ll be on social media soon! Stay tuned. 😊');
      }
      return;
    }

    // COMPLAINT
    if (intent === 'COMPLAINT') {
      const policy = setup.complaint_handling ||
        'Please send us a photo or description of the issue and we will resolve it as soon as possible.';
      await send(sock, jid,
        'We’re so sorry to hear that' + (name ? ' *' + name + '*' : '') + '! 😔\n\n' +
        policy + '\n\nOur team will attend to this immediately.'
      );
      if (ownerJid) {
        await sock.sendMessage(ownerJid,
          '⚠️ *Complaint — ' + bizName + '*\n\nCustomer *' + (name || jid.replace('@s.whatsapp.net', '')) +
          '* reported an issue:\n"' + text + '"\n\nPlease follow up!\n👉 ' + buildDashLink(client)
        );
      }
      return;
    }

    // RETURN
    if (intent === 'RETURN') {
      const policy = setup.return_policy || 'Please contact us directly about returns and we will be happy to assist you.';
      await send(sock, jid, '📋 *Our Return Policy*\n\n' + policy + '\n\nFeel free to reach out if you have any questions! 😊');
      return;
    }

    // BULK
    if (intent === 'BULK') {
      const policy = setup.bulk_orders || 'Please contact us directly for bulk order pricing.';
      await send(sock, jid, '📦 *Bulk Orders*\n\n' + policy + '\n\nSend us the details of what you need and we’ll get back to you! 😊');
      return;
    }

    // REFERRAL
    if (intent === 'REFERRAL') {
      const policy = setup.referral_reward || "We don't have a referral programme at the moment, but stay tuned!";
      await send(sock, jid, '🎁 *Referral Programme*\n\n' + policy + ' 😊');
      return;
    }

    // PROMO
    if (intent === 'PROMO') {
      const promo = setup.current_promo || 'We don’t have any active promotions right now. Follow our WhatsApp status for the latest deals!';
      await send(sock, jid, '🎉 *Current Promotions*\n\n' + promo);
      return;
    }

    // ── Custom FAQ matching ────────────────────────────────────
    const customMatch = matchCustomFAQ(text, setup);
    if (customMatch) {
      await send(sock, jid, customMatch);
      return;
    }

    // ── Custom flows (auto-reply rules from dashboard) ─────────
    const flows = await db.getFlows(clientId, true);
    if (flows && flows.length) {
      const textLower = text.toLowerCase();
      for (const flow of flows) {
        const kws = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
        if (kws.some(function(kw) { return textLower.includes(kw); })) {
          if (flow.response_type === 'image' && flow.media_url) {
            await sock.sendMessage(jid, { image: { url: flow.media_url }, caption: flow.response });
          } else {
            await send(sock, jid, flow.response);
          }
          return;
        }
      }
    }

    // ── Product name matched but no clear intent ───────────────
    if (matchedItem) {
      const available = matchedItem.in_stock !== false && matchedItem.available !== false;
      await send(sock, jid,
        '*' + matchedItem.name + '*\n💰 *' + fmt(matchedItem.price) + '*\n' +
        (matchedItem.description ? '📝 ' + matchedItem.description + '\n' : '') +
        (available
          ? '\nTo order, just say *"I want ' + matchedItem.name + '"* 😊'
          : '\nCurrently ' + (bizType === 'services' ? 'fully booked' : 'out of stock') + '.')
      );
      return;
    }

    // ── Fallback ──────────────────────────────────────────────
    const fallback = client.fallback_message ||
      'Thank you for your message' + (name ? ' *' + name + '*' : '') + '! 😊 I’m not sure I understood that. You can:\n\n' +
      '• Type *catalog* to see what we offer\n' +
      '• Ask about *price*, *delivery*, or *location*\n' +
      '• Say *"I want to order"* to place an order\n' +
      '• Say *"speak to human"* to connect with the owner';
    await send(sock, jid, fallback);

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
