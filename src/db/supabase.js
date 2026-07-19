// ============================================================
//  ForgeBot — Supabase client (lazy initialization)
//  Lazy init prevents Railway startup crash when env vars
//  aren't loaded yet at require() time.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
    );
  }
  return _supabase;
}

// ── CLIENTS ───────────────────────────────────────────────────

async function createClient_(data) {
  const { data: row, error } = await getSupabase()
    .from('clients')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function getClientByEmail(email) {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

async function getClientById(id) {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

// Fetches client + bot_setup joined — used by replyEngine for full context
async function getClientWithSetup(id) {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('*, bot_setup(*)')
    .eq('id', id)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

async function getAllClients() {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function updateClient(id, updates) {
  const { data, error } = await getSupabase()
    .from('clients')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getActiveClients() {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('*')
    .eq('status', 'active')
    .eq('subscription_active', true);
  if (error) throw error;
  return data;
}

// ── FLOWS ─────────────────────────────────────────────────────

async function getFlows(clientId, activeOnly = true) {
  let q = getSupabase().from('flows').select('*').eq('client_id', clientId);
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q.order('priority', { ascending: false });
  if (error) throw error;
  return data;
}

async function addFlow(clientId, flowName, keywords, responseType, response, mediaUrl, priority) {
  if (priority === undefined) priority = 0;
  const { data, error } = await getSupabase()
    .from('flows')
    .insert([{
      client_id: clientId,
      flow_name: flowName,
      keywords,
      response_type: responseType,
      response,
      media_url: mediaUrl,
      priority
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteFlow(id) {
  const { error } = await getSupabase().from('flows').delete().eq('id', id);
  if (error) throw error;
}

// ── STATUS POSTS ──────────────────────────────────────────────

async function getStatusPosts(clientId) {
  const { data, error } = await getSupabase()
    .from('status_posts')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addStatusPost(clientId, caption, mediaUrl, postTime, repeatDaily) {
  if (repeatDaily === undefined) repeatDaily = true;
  const { data, error } = await getSupabase()
    .from('status_posts')
    .insert([{
      client_id: clientId,
      caption,
      media_url: mediaUrl,
      post_time: postTime,
      repeat_daily: repeatDaily
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDueStatusPosts(currentTime, today) {
  const { data, error } = await getSupabase()
    .from('status_posts')
    .select('*, clients(*)')
    .eq('active', true)
    .eq('post_time', currentTime)
    .or('last_posted.is.null,last_posted.lt.' + today);
  if (error) throw error;
  return data;
}

async function markStatusPosted(id, date) {
  const { error } = await getSupabase()
    .from('status_posts')
    .update({ last_posted: date })
    .eq('id', id);
  if (error) throw error;
}

async function deleteStatusPost(id) {
  const { error } = await getSupabase().from('status_posts').delete().eq('id', id);
  if (error) throw error;
}

// ── PAYMENTS (Flutterwave subscription payments) ───────────────

async function createPayment(clientId, paymentType, amount, currency, provider, reference) {
  const { data, error } = await getSupabase()
    .from('payments')
    .insert([{
      client_id: clientId,
      payment_type: paymentType,
      amount,
      currency,
      provider,
      reference
    }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updatePaymentStatus(reference, status) {
  const { error } = await getSupabase()
    .from('payments')
    .update({ status })
    .eq('reference', reference);
  if (error) throw error;
}

async function getPaymentByReference(reference) {
  const { data, error } = await getSupabase()
    .from('payments')
    .select('*')
    .eq('reference', reference)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

// ── BROADCASTS ────────────────────────────────────────────────

async function logBroadcast(clientId, message, recipients) {
  const { error } = await getSupabase()
    .from('broadcast_logs')
    .insert([{ client_id: clientId, message, recipients }]);
  if (error) throw error;
}

async function getBroadcastLogs(clientId) {
  const { data, error } = await getSupabase()
    .from('broadcast_logs')
    .select('*')
    .eq('client_id', clientId)
    .order('sent_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

// ── CUSTOMERS (WhatsApp contacts the bot has served) ──────────

async function getCustomer(clientId, jid) {
  const { data, error } = await getSupabase()
    .from('customers')
    .select('*')
    .eq('client_id', clientId)
    .eq('jid', jid)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

async function upsertCustomer(clientId, jid, name, phone) {
  const { error } = await getSupabase()
    .from('customers')
    .upsert({
      client_id: clientId,
      jid,
      name: name || null,
      phone: phone || jid.replace('@s.whatsapp.net', ''),
      last_contact: new Date().toISOString()
    }, { onConflict: 'client_id,jid' });
  if (error) throw error;
}

// ── PRODUCTS & SERVICES ───────────────────────────────────────

async function getProducts(clientId) {
  const { data, error } = await getSupabase()
    .from('products')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(function(p) { p._type = 'product'; return p; });
}

async function getServices(clientId) {
  const { data, error } = await getSupabase()
    .from('services')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(function(s) { s._type = 'service'; return s; });
}

async function addProduct(clientId, name, price, description, imageUrl) {
  const { data, error } = await getSupabase()
    .from('products')
    .insert([{ client_id: clientId, name, price, description, image_url: imageUrl }])
    .select().single();
  if (error) throw error;
  return data;
}

async function updateProduct(id, updates) {
  const { data, error } = await getSupabase()
    .from('products')
    .update(updates)
    .eq('id', id)
    .select().single();
  if (error) throw error;
  return data;
}

async function deleteProduct(id) {
  const { error } = await getSupabase().from('products').delete().eq('id', id);
  if (error) throw error;
}

async function addService(clientId, name, price, description, duration) {
  const { data, error } = await getSupabase()
    .from('services')
    .insert([{ client_id: clientId, name, price, description, duration }])
    .select().single();
  if (error) throw error;
  return data;
}

async function deleteService(id) {
  const { error } = await getSupabase().from('services').delete().eq('id', id);
  if (error) throw error;
}

// ── ORDERS ────────────────────────────────────────────────────

async function createOrder(orderData) {
  const { data, error } = await getSupabase()
    .from('orders')
    .insert([orderData])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateOrder(id, updates) {
  updates.updated_at = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('orders')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getOrders(clientId, status) {
  let q = getSupabase()
    .from('orders')
    .select('*')
    .eq('client_id', clientId);
  if (status) q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return data || [];
}

async function getOrderById(id) {
  const { data, error } = await getSupabase()
    .from('orders')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

// Get the most recent unpaid order with a receipt for a customer
async function getPendingOrderForCustomer(clientId, customerJid) {
  const { data, error } = await getSupabase()
    .from('orders')
    .select('*')
    .eq('client_id', clientId)
    .eq('customer_jid', customerJid)
    .eq('payment_status', 'unpaid')
    .not('receipt_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// ── PRICE INQUIRIES (LEADS) ───────────────────────────────────

async function logPriceInquiry(clientId, customerJid, customerName, productName, productPrice, itemType) {
  await getSupabase()
    .from('price_inquiries')
    .insert([{
      client_id: clientId,
      customer_jid: customerJid,
      customer_name: customerName || null,
      product_name: productName,
      product_price: productPrice || null,
      item_type: itemType || 'product'
    }]);
  // Intentionally not throwing — analytics logging should never break the bot
}

// ── ANALYTICS ────────────────────────────────────────────────

// Returns aggregated monthly stats for a client
// month = 'YYYY-MM' e.g. '2025-06'
async function getMonthlyStats(clientId, month) {
  const start = month + '-01T00:00:00.000Z';
  const d = new Date(start);
  d.setMonth(d.getMonth() + 1);
  const end = d.toISOString().slice(0, 10) + 'T00:00:00.000Z';

  const supabase = getSupabase();

  // New customers this month
  const { count: newCustomers } = await supabase
    .from('customers')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('first_contact', start)
    .lt('first_contact', end);

  // Price inquiries (leads)
  const { count: leads } = await supabase
    .from('price_inquiries')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('created_at', start)
    .lt('created_at', end);

  // Orders placed this month
  const { count: ordersPlaced } = await supabase
    .from('orders')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('created_at', start)
    .lt('created_at', end);

  // Confirmed orders + revenue
  const { data: confirmedOrders } = await supabase
    .from('orders')
    .select('total')
    .eq('client_id', clientId)
    .eq('payment_status', 'confirmed')
    .gte('created_at', start)
    .lt('created_at', end);

  const confirmedCount = (confirmedOrders || []).length;
  const totalRevenue = (confirmedOrders || []).reduce(function(sum, o) {
    return sum + (parseFloat(o.total) || 0);
  }, 0);

  return {
    month,
    new_customers: newCustomers || 0,
    leads: leads || 0,
    orders_placed: ordersPlaced || 0,
    orders_confirmed: confirmedCount,
    total_revenue: totalRevenue
  };
}

// ── BOT SETUP ─────────────────────────────────────────────────

async function upsertBotSetup(clientId, setupData) {
  setupData.client_id = clientId;
  setupData.updated_at = new Date().toISOString();
  // Remove undefined/empty keys
  Object.keys(setupData).forEach(function(k) {
    if (setupData[k] === undefined || setupData[k] === '') delete setupData[k];
  });
  const { error } = await getSupabase()
    .from('bot_setup')
    .upsert(setupData, { onConflict: 'client_id' });
  if (error) throw error;
}

async function getBotSetup(clientId) {
  const { data, error } = await getSupabase()
    .from('bot_setup')
    .select('*')
    .eq('client_id', clientId)
    .single();
  if (error && error.code === 'PGRST116') return {};
  if (error) throw error;
  return data || {};
}

// ── PUSH SUBSCRIPTIONS ────────────────────────────────────────

async function savePushSubscription(clientId, endpoint, p256dh, auth) {
  const { error } = await getSupabase()
    .from('push_subscriptions')
    .upsert({ client_id: clientId, endpoint, p256dh, auth }, { onConflict: 'client_id,endpoint' });
  if (error) throw error;
}

async function getPushSubscriptions(clientId) {
  const { data, error } = await getSupabase()
    .from('push_subscriptions')
    .select('*')
    .eq('client_id', clientId);
  if (error) throw error;
  return data || [];
}

// ── EXPORTS ───────────────────────────────────────────────────

module.exports = {
  // Raw client access for direct queries in replyEngine
  getSupabase,

  // Clients
  createClient_, getClientByEmail, getClientById, getClientWithSetup,
  getAllClients, updateClient, getActiveClients,

  // Flows (auto-reply rules)
  getFlows, addFlow, deleteFlow,

  // Status posts
  getStatusPosts, addStatusPost, getDueStatusPosts, markStatusPosted, deleteStatusPost,

  // Subscription payments (Flutterwave)
  createPayment, updatePaymentStatus, getPaymentByReference,

  // Broadcasts
  logBroadcast, getBroadcastLogs,

  // Customers (WhatsApp contacts)
  getCustomer, upsertCustomer,

  // Products & services
  getProducts, getServices, addProduct, updateProduct, deleteProduct,
  addService, deleteService,

  // Orders
  createOrder, updateOrder, getOrders, getOrderById, getPendingOrderForCustomer,

  // Leads / analytics
  logPriceInquiry, getMonthlyStats,

  // Bot setup (questionnaire answers)
  upsertBotSetup, getBotSetup,

  // Push notifications
  savePushSubscription, getPushSubscriptions
};
