// ============================================================
//  ForgeBot — Smart Reply Engine v3.0
//  Rule-based conversation engine with state machine,
//  product catalog matching, order flow & leads tracking.
// ============================================================

const supabase = require('./supabaseClient');  // adjust path if needed

// ── Conversation state machine ────────────────────────────────
// States per customer (key: "clientId:jid")
const convStates = new Map();
// { state, customerName, cart, orderId, expectingField }

const STATE = {
  GREETING:           'GREETING',
  AWAITING_NAME:      'AWAITING_NAME',
  BROWSING:           'BROWSING',
  ORDERING:           'ORDERING',
  AWAITING_ADDRESS:   'AWAITING_ADDRESS',
  AWAITING_APPT:      'AWAITING_APPT',
  AWAITING_DEPOSIT:   'AWAITING_DEPOSIT',
  AWAITING_RECEIPT:   'AWAITING_RECEIPT',
  HUMAN_PAUSED:       'HUMAN_PAUSED',
};

// Human handoff pause tracker { key → timeout handle }
const humanPaused = new Map();

// ── Intent keywords ───────────────────────────────────────────
const INTENT = {
  PRICE:       ['how much','price','cost','rate','fee','charge','how much is','what is the price','pricing','cost of','price of','how much for'],
  ORDER:       ['i want','i want to order','order','buy','get me','i need','i\'d like','i will take','i\'ll take','purchase','can i get','let me get','add to cart','i\'ll order','place order'],
  MORE_ITEMS:  ['and also','also add','add another','i also want','and i want','plus','what about'],
  DONE_ORDER:  ['that\'s all','that is all','nothing else','done','that\'s everything','checkout','proceed','confirm order','just that'],
  CATALOG:     ['what do you have','what do you sell','show me','your products','your services','what\'s available','catalog','list','menu','what can i order','what you get','all products','all services'],
  DELIVERY:    ['delivery','deliver','shipping','how long','when will i','how many days','when do i','dispatch','when will it arrive'],
  LOCATION:    ['where are you','your location','address','where to','how to get','come and pick','pickup','pick up','your office','your shop','your studio','where is your'],
  HOURS:       ['open','opening hours','business hours','working hours','available','what time','when do you close','when do you open','are you open','closed','office hours'],
  SOCIAL:      ['instagram','facebook','tiktok','twitter','social media','follow you','your page','online','your handle','whatsapp channel','your channel'],
  PAYMENT_Q:   ['how to pay','account number','bank details','where to transfer','payment details','send account','your account','bank account','which bank'],
  COMPLAINT:   ['damaged','wrong item','wrong product','broken','not what i ordered','issue','problem','bad','spoilt','received wrong','got wrong','defective'],
  RETURN:      ['return','exchange','refund','give back','change it','swap','money back'],
  BULK:        ['bulk','wholesale','large quantity','many units','lots of','mass order','large order'],
  REFERRAL:    ['referral','refer','referral bonus','refer a friend'],
  PROMO:       ['promo','discount','offer','sale','coupon','deal','promotion','any deal'],
  HUMAN:       ['speak to human','real person','talk to someone','agent','customer care','customer service','representative','call me','speak to someone','human please','real agent','i need help from'],
  PAYMENT_CLAIM:['i have paid','i\'ve paid','i sent','i transferred','payment done','i paid','done paying','just paid','already paid','sent the money'],
  GREETING_W:  ['hello','hi','good morning','good afternoon','good evening','hey','helo','hii','howdy','sup','whats up','what\'s up','greetings'],
  THANKS:      ['thank you','thanks','thank u','ok thank','ok thanks','perfect','great','alright','noted','okay','got it'],
};

function detect(text) {
  const t = text.toLowerCase().trim();
  for (const [intent, keywords] of Object.entries(INTENT)) {
    if (keywords.some(kw => t.includes(kw))) return intent;
  }
  return 'UNKNOWN';
}

// Fuzzy product/service name matcher
function findItem(text, items) {
  if (!items || !items.length) return null;
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  // Exact match first
  for (const item of items) {
    if (t.includes(item.name.toLowerCase())) return item;
  }
  // Word overlap match
  for (const item of items) {
    const words = item.name.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(w => w.length > 2);
    const hits = words.filter(w => t.includes(w));
    if (words.length > 0 && hits.length >= Math.ceil(words.length * 0.6)) return item;
  }
  return null;
}

// Greeting based on current time (client's server timezone)
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmt(price) { return '₦' + Number(price).toLocaleString(); }

// ── Main handler ──────────────────────────────────────────────
async function handleMessage(clientId, jid, text, imageMsg, sock) {
  const key = `${clientId}:${jid}`;

  // ── 0. Load client data (cached per-process is fine for low traffic) ──
  const { data: client } = await supabase
    .from('clients')
    .select('*, bot_setup(*)')
    .eq('id', clientId)
    .single();

  if (!client) return;
  const setup = client.bot_setup?.[0] || {};
  const bizType = client.business_type || 'products';
  const bizName = client.business_name || 'our business';
  const ownerJid = client.notification_number ? `${client.notification_number}@s.whatsapp.net` : null;

  // ── 1. Initialise conversation state ──────────────────────────
  if (!convStates.has(key)) {
    convStates.set(key, { state: STATE.GREETING, customerName: null, cart: [], orderId: null });
  }
  const conv = convStates.get(key);

  // ── 2. Human paused — do nothing ──────────────────────────────
  if (conv.state === STATE.HUMAN_PAUSED) return;

  // ── 3. Human handoff check (any state) ────────────────────────
  if (detect(text) === 'HUMAN') {
    conv.state = STATE.HUMAN_PAUSED;
    convStates.set(key, conv);
    await send(sock, jid, `Please hold on ${conv.customerName ? conv.customerName : ''}! 🙏 Let me get someone to assist you right away. Someone will be with you shortly.`);
    if (ownerJid) {
      await send(sock, ownerJid,
        `🙋 *Human Handoff Alert* — ${bizName}\n\n` +
        `Customer: *${conv.customerName || jid}*\n` +
        `They want to speak to a real person. Please respond on WhatsApp now.\n\n` +
        `👉 View dashboard: ${buildDashLink(client)}`
      );
    }
    // Resume bot after 30 minutes
    const handle = setTimeout(() => {
      const c = convStates.get(key);
      if (c) { c.state = STATE.BROWSING; convStates.set(key, c); }
      humanPaused.delete(key);
    }, 30 * 60 * 1000);
    humanPaused.set(key, handle);
    return;
  }

  // ── 4. OWNER reply to notification (1/2/3 fallback) ───────────
  if (jid === ownerJid && /^[123]$/.test(text.trim())) {
    // find the most recent pending order
    const { data: pendingOrders } = await supabase
      .from('orders')
      .select('*')
      .eq('client_id', clientId)
      .eq('payment_status', 'unpaid')
      .not('receipt_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (pendingOrders && pendingOrders[0]) {
      const order = pendingOrders[0];
      const custJid = order.customer_jid;
      const custName = order.customer_name || 'Customer';
      const choice = text.trim();
      if (choice === '1') {
        await supabase.from('orders').update({ payment_status: 'confirmed', status: 'accepted' }).eq('id', order.id);
        await send(sock, custJid, `✅ Great news ${custName}! Your payment has been confirmed and your order is now being processed. We'll keep you updated! 🎉`);
        await send(sock, ownerJid, `✅ Payment confirmed for ${custName}'s order.`);
      } else if (choice === '2') {
        await send(sock, custJid, `Hi ${custName}, we're still verifying your payment. Please give us a few more minutes. Thank you for your patience! 🙏`);
      } else if (choice === '3') {
        await supabase.from('orders').update({ payment_status: 'rejected' }).eq('id', order.id);
        await send(sock, custJid, `Hi ${custName}, we couldn't confirm your payment. Please resend your receipt or contact us if you believe this is an error. 🙏`);
        await send(sock, ownerJid, `❌ Payment rejected for ${custName}'s order.`);
      }
    }
    return;
  }

  // ── 5. State machine ──────────────────────────────────────────

  // ────── GREETING ─────────────────────────────────────────────
  if (conv.state === STATE.GREETING) {
    // Check if we already know this customer
    const { data: existing } = await supabase
      .from('customers')
      .select('name')
      .eq('client_id', clientId)
      .eq('jid', jid)
      .single();

    if (existing && existing.name) {
      conv.customerName = existing.name;
      conv.state = STATE.BROWSING;
      convStates.set(key, conv);
      await send(sock, jid,
        `${timeGreeting()} ${existing.name}! 👋 Welcome back to *${bizName}*. How can we help you today?`
      );
      return;
    }

    // First time — introduce and ask name
    conv.state = STATE.AWAITING_NAME;
    convStates.set(key, conv);
    await send(sock, jid,
      `${timeGreeting()}! 👋\n\n` +
      `Welcome to *${bizName}*. We're happy to have you here!\n\n` +
      `Before we continue, may we know your name please? 😊`
    );
    return;
  }

  // ────── AWAITING NAME ────────────────────────────────────────
  if (conv.state === STATE.AWAITING_NAME) {
    const name = text.trim().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    conv.customerName = name;
    conv.state = STATE.BROWSING;
    convStates.set(key, conv);

    // Save to customers table
    await supabase.from('customers').upsert({
      client_id: clientId, jid, name,
      phone: jid.replace('@s.whatsapp.net',''),
      last_contact: new Date().toISOString()
    }, { onConflict: 'client_id,jid' });

    await send(sock, jid,
      `Nice to meet you, *${name}*! 😊\n\n` +
      `How can we help you today? You can:\n` +
      `• Ask about our products or services\n` +
      `• Place an order\n` +
      `• Ask about delivery, prices, or anything else\n\n` +
      `Just type your question! 👇`
    );
    return;
  }

  const name = conv.customerName || '';

  // ────── AWAITING RECEIPT (image) ─────────────────────────────
  if (conv.state === STATE.AWAITING_RECEIPT) {
    if (imageMsg) {
      // Download and upload receipt image
      const receiptUrl = await saveReceiptImage(sock, imageMsg, clientId, jid);

      // Link to pending order
      if (conv.orderId) {
        await supabase.from('orders')
          .update({ receipt_url: receiptUrl })
          .eq('id', conv.orderId);
      }

      await send(sock, jid,
        `Thank you ${name}! 🙏 We've received your payment receipt and it's been submitted for verification.\n\n` +
        `Please give us a few minutes to confirm. We'll notify you as soon as it's done! ⏳`
      );

      // Alert owner with dashboard link
      if (ownerJid) {
        await send(sock, ownerJid,
          `💰 *Payment Receipt — ${bizName}*\n\n` +
          `Customer: *${name || jid}*\n` +
          `Order total: ${fmt(getOrderTotal(conv.cart))}\n\n` +
          `Receipt has been uploaded. Please log in to confirm:\n` +
          `👉 ${buildDashLink(client)}\n\n` +
          `Or reply:\n*1* — Confirm payment ✅\n*2* — Ask to wait ⏳\n*3* — Payment not received ❌`
        );
      }
      conv.state = STATE.BROWSING;
      convStates.set(key, conv);
    } else {
      await send(sock, jid,
        `${name ? name + ', please' : 'Please'} send your payment receipt as an *image or screenshot* so we can verify it. 📸`
      );
    }
    return;
  }

  // ────── AWAITING ADDRESS ─────────────────────────────────────
  if (conv.state === STATE.AWAITING_ADDRESS) {
    const address = text.trim();
    if (address.length < 5) {
      await send(sock, jid, `Please type your full delivery address so we know exactly where to send your order. 📍`);
      return;
    }

    // Save order to DB
    const total = getOrderTotal(conv.cart);
    const { data: order } = await supabase.from('orders').insert({
      client_id: clientId,
      customer_jid: jid,
      customer_name: name,
      items: conv.cart,
      total,
      order_type: 'delivery',
      delivery_address: address,
      status: 'pending',
      dashboard_token: client.token || '',
    }).select().single();

    conv.orderId = order?.id;
    conv.state = STATE.AWAITING_RECEIPT;
    convStates.set(key, conv);

    const summary = conv.cart.map(i => `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}`).join('\n');
    await send(sock, jid,
      `Perfect! Here's your order summary:\n\n${summary}\n\n` +
      `*Total: ${fmt(total)}*\n` +
      `📍 Delivery to: ${address}\n\n` +
      `To complete your order, please make payment to:\n\n` +
      buildAccountMsg(client) +
      `\nAfter payment, send your *receipt or screenshot* here so we can confirm. 📸`
    );

    // Alert owner
    if (ownerJid) {
      await send(sock, ownerJid,
        `🛒 *New Order — ${bizName}*\n\n` +
        `Customer: *${name || jid}*\n${summary}\n` +
        `Total: *${fmt(total)}*\n` +
        `📍 Delivery: ${address}\n\n` +
        `👉 View order: ${buildDashLink(client)}`
      );
    }
    return;
  }

  // ────── AWAITING APPOINTMENT ──────────────────────────────────
  if (conv.state === STATE.AWAITING_APPT) {
    const apptTime = text.trim();
    if (apptTime.length < 3) {
      await send(sock, jid, `Please tell us your preferred date and time for the appointment. 📅`);
      return;
    }

    const total = getOrderTotal(conv.cart);
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
      dashboard_token: client.token || '',
    }).select().single();

    conv.orderId = order?.id;

    const summary = conv.cart.map(i => `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}`).join('\n');

    if (depositRequired) {
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(key, conv);
      const depositPct = parseInt((setup.deposit_required.match(/\d+/) || ['50'])[0]);
      const depositAmt = Math.round(total * depositPct / 100);
      await send(sock, jid,
        `Great! Here's your booking summary:\n\n${summary}\n\n` +
        `📅 Preferred time: ${apptTime}\n*Total: ${fmt(total)}*\n\n` +
        `To secure your appointment, please pay a *deposit of ${fmt(depositAmt)}* (${depositPct}%) to:\n\n` +
        buildAccountMsg(client) +
        `\nSend your receipt here and we'll confirm your booking! 📸`
      );
    } else {
      conv.state = STATE.BROWSING;
      convStates.set(key, conv);
      await send(sock, jid,
        `Your booking has been received! 🎉\n\n${summary}\n📅 Preferred time: ${apptTime}\n\n` +
        `We'll confirm your appointment shortly. Is there anything else you need? 😊`
      );
    }

    // Alert owner
    if (ownerJid) {
      await send(sock, ownerJid,
        `📅 *New Booking — ${bizName}*\n\n` +
        `Customer: *${name || jid}*\n${summary}\n` +
        `Total: *${fmt(total)}*\n` +
        `📅 Preferred: ${apptTime}\n\n` +
        `👉 View booking: ${buildDashLink(client)}`
      );
    }
    return;
  }

  // ────── ORDERING — adding to cart ────────────────────────────
  if (conv.state === STATE.ORDERING) {
    const intent = detect(text);

    if (intent === 'DONE_ORDER') {
      // Proceed to checkout
      if (!conv.cart.length) {
        conv.state = STATE.BROWSING;
        convStates.set(key, conv);
        await send(sock, jid, `Okay ${name}, feel free to browse anytime! 😊`);
        return;
      }
      conv.state = bizType === 'services' ? STATE.AWAITING_APPT : STATE.AWAITING_ADDRESS;
      convStates.set(key, conv);
      if (bizType === 'services') {
        await send(sock, jid, `Great choices! What date and time works for you? 📅`);
      } else {
        await send(sock, jid, `Great! What is your delivery address? 📍`);
      }
      return;
    }

    // Try to add another item
    const allItems = await getClientItems(clientId, bizType);
    const found = findItem(text, allItems);
    if (found) {
      const available = found.in_stock !== false && found.available !== false;
      if (!available) {
        await send(sock, jid,
          `Sorry ${name}, *${found.name}* is currently ${bizType==='services'?'fully booked':'out of stock'}. ` +
          `${await suggestAlternatives(clientId, bizType, found.id)}`
        );
        return;
      }
      addToCart(conv, found);
      convStates.set(key, conv);
      const summary = conv.cart.map(i => `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}`).join('\n');
      await send(sock, jid,
        `Added *${found.name}* to your order! ✅\n\n` +
        `*Your cart:*\n${summary}\n` +
        `*Total: ${fmt(getOrderTotal(conv.cart))}*\n\n` +
        `Anything else? Or type *done* to proceed.`
      );
    } else {
      await send(sock, jid,
        `Hmm, I couldn't find that item. Could you check the name or browse what we have?\n\n` +
        `Type *catalog* to see all available ${bizType === 'services' ? 'services' : 'products'}.`
      );
    }
    return;
  }

  // ────── BROWSING — main intent routing ───────────────────────
  const intent = detect(text);
  const allItems = await getClientItems(clientId, bizType);

  // Try product/service name match regardless of intent
  const matchedItem = findItem(text, allItems);

  // PAYMENT_CLAIM
  if (intent === 'PAYMENT_CLAIM') {
    if (conv.orderId) {
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(key, conv);
      await send(sock, jid,
        `Thank you ${name}! Please send your *payment receipt or screenshot* here so we can verify it quickly. 📸`
      );
    } else {
      await send(sock, jid,
        `Thank you for letting us know ${name}! Please send your *payment receipt or screenshot* here so we can confirm. 📸`
      );
      conv.state = STATE.AWAITING_RECEIPT;
      convStates.set(key, conv);
    }
    return;
  }

  // PRICE inquiry
  if (intent === 'PRICE' || (matchedItem && !intent.startsWith('ORDER'))) {
    const item = matchedItem || findItemFromContext(text, allItems);
    if (item) {
      const available = item.in_stock !== false && item.available !== false;
      const status = available
        ? (bizType==='services' ? '✅ Available' : '✅ In stock')
        : (bizType==='services' ? '❌ Fully booked' : '❌ Out of stock');
      const durStr = item.duration ? `\n⏱ Duration: ${item.duration}` : '';
      await send(sock, jid,
        `*${item.name}*\n` +
        `💰 Price: *${fmt(item.price)}*` + durStr + `\n` +
        (item.description ? `📝 ${item.description}\n` : '') +
        `${status}\n\n` +
        (available ? `To order, just say *"I want ${item.name}"* 😊` : `We'll notify you when it's back!`)
      );

      // Log price inquiry
      await supabase.from('price_inquiries').insert({
        client_id: clientId,
        customer_jid: jid,
        customer_name: name,
        product_name: item.name,
        product_price: item.price,
        item_type: item._type || 'product',
      }).catch(() => {});

      // Alert owner (lead alert)
      if (ownerJid) {
        await send(sock, ownerJid,
          `👀 *Price Inquiry — ${bizName}*\n\n` +
          `*${name || jid}* just asked about *${item.name}* (${fmt(item.price)})\n\n` +
          `This could be a potential order! 🔥`
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
          `Sorry ${name}, *${item.name}* is currently ${bizType==='services'?'fully booked':'out of stock'}. ` +
          `${await suggestAlternatives(clientId, bizType, item.id)}`
        );
        return;
      }
      conv.state = STATE.ORDERING;
      addToCart(conv, item);
      convStates.set(key, conv);
      await send(sock, jid,
        `*${item.name}* has been added to your order! ✅\n` +
        `Price: *${fmt(item.price)}*\n\n` +
        `Would you like to add anything else? Or type *done* to proceed to checkout. 😊`
      );
    } else {
      // No specific item found — show catalog
      await send(sock, jid, await buildCatalogMsg(allItems, bizType, bizName));
    }
    return;
  }

  // MORE ITEMS (while browsing, not in ordering state)
  if (intent === 'MORE_ITEMS') {
    conv.state = STATE.ORDERING;
    convStates.set(key, conv);
    await send(sock, jid, `Sure! Just tell me what else you'd like to add. 😊`);
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
      `${timeGreeting()} ${name ? name + '!' : '!'} 😊 Welcome to *${bizName}*. How can we help you today?`
    );
    return;
  }

  // THANKS
  if (intent === 'THANKS') {
    await send(sock, jid, `You're welcome ${name}! 😊 If you need anything else, we're always here. Have a wonderful day! 🌟`);
    return;
  }

  // DELIVERY
  if (intent === 'DELIVERY') {
    if (!setup.delivers_to) {
      await send(sock, jid, `For delivery information, please contact us directly. 😊`);
      return;
    }
    await send(sock, jid,
      `📦 *Delivery Information — ${bizName}*\n\n` +
      `📍 We deliver to: *${setup.delivers_to}*\n\n` +
      `🏙 Within the city:\n• Fee: ${setup.delivery_fee_local}\n• Time: ${setup.delivery_time_local}\n\n` +
      `🌍 Outside the city:\n• Fee: ${setup.delivery_fee_outside}\n• Time: ${setup.delivery_time_outside}\n\n` +
      (setup.payment_on_delivery ? `💳 Payment on delivery: ${setup.payment_on_delivery}\n` : '') +
      (setup.minimum_order ? `🛒 Minimum order: ${setup.minimum_order}` : '')
    );
    return;
  }

  // LOCATION
  if (intent === 'LOCATION') {
    const loc = setup.studio_location || client.business_address;
    if (loc) {
      await send(sock, jid,
        `📍 *Our Location*\n${loc}\n\n` +
        (setup.availability_days ? `🕐 Hours: ${setup.availability_days}\n\n` : '') +
        `Feel free to visit us anytime! 😊`
      );
    } else {
      await send(sock, jid,
        `We are an online business and deliver to you. Type *delivery* to see our delivery info. 😊`
      );
    }
    return;
  }

  // HOURS
  if (intent === 'HOURS') {
    const hours = client.business_hours || setup.availability_days;
    if (hours) {
      await send(sock, jid, `🕐 *Our Business Hours*\n${hours}\n\nWe're happy to assist you during these times! 😊`);
    } else {
      await send(sock, jid, `We operate daily. Feel free to message us and we'll respond as soon as possible! 😊`);
    }
    return;
  }

  // SOCIAL
  if (intent === 'SOCIAL') {
    const socials = [];
    if (setup.instagram)       socials.push(`📸 Instagram: ${setup.instagram}`);
    if (setup.facebook)        socials.push(`👥 Facebook: ${setup.facebook}`);
    if (setup.tiktok)          socials.push(`🎵 TikTok: ${setup.tiktok}`);
    if (setup.whatsapp_channel) socials.push(`💬 WhatsApp Channel: ${setup.whatsapp_channel}`);
    if (socials.length) {
      await send(sock, jid,
        `📲 *Follow us on social media!*\n\n${socials.join('\n')}\n\n` +
        `Stay updated with our latest products and deals! 🔥`
      );
    } else {
      await send(sock, jid, `We'll be on social media soon! Stay tuned. 😊`);
    }
    return;
  }

  // PAYMENT QUESTION
  if (intent === 'PAYMENT_Q') {
    await send(sock, jid, buildAccountMsg(client));
    return;
  }

  // COMPLAINT
  if (intent === 'COMPLAINT') {
    const policy = setup.complaint_handling || 'Please send us a photo or description of the issue and we will resolve it as soon as possible.';
    await send(sock, jid,
      `We're so sorry to hear that ${name}! 😔\n\n${policy}\n\n` +
      `Our team will attend to this immediately.`
    );
    if (ownerJid) {
      await send(sock, ownerJid,
        `⚠️ *Complaint — ${bizName}*\n\nCustomer *${name || jid}* reported an issue:\n"${text}"\n\nPlease follow up!\n👉 ${buildDashLink(client)}`
      );
    }
    return;
  }

  // RETURN
  if (intent === 'RETURN') {
    const policy = setup.return_policy || 'Please contact us directly about returns and we will be happy to assist you.';
    await send(sock, jid, `📋 *Our Return Policy*\n\n${policy}\n\nFeel free to reach out if you have any questions! 😊`);
    return;
  }

  // BULK
  if (intent === 'BULK') {
    const policy = setup.bulk_orders || 'Please contact us directly for bulk order pricing.';
    await send(sock, jid, `📦 *Bulk Orders*\n\n${policy}\n\nSend us the details of what you need and we'll get back to you! 😊`);
    return;
  }

  // REFERRAL
  if (intent === 'REFERRAL') {
    const policy = setup.referral_reward || 'We don\'t have a referral programme at the moment, but stay tuned!';
    await send(sock, jid, `🎁 *Referral Programme*\n\n${policy} 😊`);
    return;
  }

  // PROMO
  if (intent === 'PROMO') {
    const promo = setup.current_promo || 'We don\'t have any active promotions right now. Follow our WhatsApp status for the latest deals!';
    await send(sock, jid, `🎉 *Current Promotions*\n\n${promo}`);
    return;
  }

  // ── Custom FAQ matching (from bot_setup questions) ────────────
  const customMatch = matchCustomFAQ(text, setup);
  if (customMatch) {
    await send(sock, jid, customMatch);
    return;
  }

  // ── Custom auto-reply rules ───────────────────────────────────
  const { data: flows } = await supabase.from('flows').select('*').eq('client_id', clientId);
  if (flows && flows.length) {
    const t = text.toLowerCase();
    for (const flow of flows) {
      const keywords = flow.keywords.split(',').map(k => k.trim().toLowerCase());
      if (keywords.some(kw => t.includes(kw))) {
        await send(sock, jid, flow.response);
        return;
      }
    }
  }

  // ── Product name matched but intent unknown — show product ────
  if (matchedItem) {
    const available = matchedItem.in_stock !== false && matchedItem.available !== false;
    await send(sock, jid,
      `*${matchedItem.name}*\n💰 *${fmt(matchedItem.price)}*\n` +
      (matchedItem.description ? `📝 ${matchedItem.description}\n` : '') +
      (available ? `\nTo order, just say *"I want ${matchedItem.name}"* 😊` : `\nCurrently ${bizType==='services'?'fully booked':'out of stock'}.`)
    );
    return;
  }

  // ── Fallback ──────────────────────────────────────────────────
  const fallback = client.fallback_message ||
    `Thank you for your message ${name ? name : ''}! 😊 I'm not sure I understood that. You can:\n\n` +
    `• Type *catalog* to see what we offer\n` +
    `• Ask about price, delivery, or location\n` +
    `• Say *"I want to order"* to place an order`;
  await send(sock, jid, fallback);
}

// ── Helpers ───────────────────────────────────────────────────

async function send(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text });
  } catch(e) {
    console.error(`[replyEngine] send error to ${jid}:`, e.message);
  }
}

function buildAccountMsg(client) {
  if (!client.bank_name) {
    return `Please contact us for payment details. 😊`;
  }
  return (
    `🏦 *Payment Details*\n\n` +
    `Bank: *${client.bank_name}*\n` +
    `Account Number: *${client.account_number}*\n` +
    `Account Name: *${client.account_name || client.business_name}*\n\n` +
    `After payment, please send your *receipt or screenshot* here so we can confirm quickly. 📸`
  );
}

function buildDashLink(client) {
  const base = process.env.APP_URL || 'https://yourapp.railway.app';
  return `${base}/dashboard?token=${client.token || ''}`;
}

function addToCart(conv, item) {
  const existing = conv.cart.find(c => c.id === item.id);
  if (existing) { existing.qty += 1; }
  else { conv.cart.push({ id: item.id, name: item.name, price: item.price, qty: 1, type: item._type || 'product' }); }
}

function getOrderTotal(cart) {
  return cart.reduce((sum, i) => sum + i.price * i.qty, 0);
}

async function getClientItems(clientId, bizType) {
  const items = [];
  if (bizType === 'products' || bizType === 'both') {
    const { data } = await supabase.from('products').select('*').eq('client_id', clientId);
    (data || []).forEach(i => { i._type = 'product'; items.push(i); });
  }
  if (bizType === 'services' || bizType === 'both') {
    const { data } = await supabase.from('services').select('*').eq('client_id', clientId);
    (data || []).forEach(i => { i._type = 'service'; items.push(i); });
  }
  return items;
}

async function buildCatalogMsg(items, bizType, bizName) {
  if (!items || !items.length) {
    return `We're currently updating our ${bizType === 'services' ? 'services' : 'products'}. Please check back soon! 😊`;
  }
  const available = items.filter(i => i.in_stock !== false && i.available !== false);
  if (!available.length) {
    return `All our ${bizType === 'services' ? 'services' : 'products'} are currently sold out. We'll restock soon! 😊`;
  }
  const lines = available.map(i =>
    `• *${i.name}* — ${fmt(i.price)}${i.duration ? ' ('+i.duration+')' : ''}${i.description ? '\n  '+i.description : ''}`
  ).join('\n\n');
  return (
    `📋 *${bizName} — ${bizType === 'services' ? 'Our Services' : 'Our Products'}*\n\n` +
    `${lines}\n\n` +
    `To order, just say *"I want [item name]"* 😊`
  );
}

async function suggestAlternatives(clientId, bizType, excludeId) {
  const { data } = bizType === 'services'
    ? await supabase.from('services').select('*').eq('client_id', clientId).eq('available', true).neq('id', excludeId).limit(3)
    : await supabase.from('products').select('*').eq('client_id', clientId).eq('in_stock', true).neq('id', excludeId).limit(3);

  if (!data || !data.length) return `We'll let you know when it's available again! 😊`;
  const names = data.map(i => `*${i.name}* (${fmt(i.price)})`).join(', ');
  return `You might also like: ${names}. 😊`;
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
    const qWords = q.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(w => w.length > 3);
    const hits = qWords.filter(w => t.includes(w));
    if (hits.length >= Math.ceil(qWords.length * 0.5)) return a;
  }
  return null;
}

function findItemFromContext(text, items) {
  return findItem(text, items);
}

async function saveReceiptImage(sock, imageMsg, clientId, jid) {
  // Download image buffer from WhatsApp
  try {
    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    // Upload to Supabase Storage
    const filename = `receipts/${clientId}/${jid.replace('@s.whatsapp.net','')}/${Date.now()}.jpg`;
    const { data, error } = await supabase.storage
      .from('forgebot-receipts')
      .upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });

    if (!error) {
      const { data: urlData } = supabase.storage.from('forgebot-receipts').getPublicUrl(filename);
      return urlData?.publicUrl || null;
    }
  } catch(e) {
    console.error('[replyEngine] receipt upload failed:', e.message);
  }
  return null;
}

module.exports = { handleMessage };
