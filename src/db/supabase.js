const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── CLIENTS ───────────────────────────────────────────────────

async function createClient_(data) {
  const { data: row, error } = await supabase
    .from('clients')
    .insert([data])
    .select()
    .single();
  if (error) throw error;
  return row;
}

async function getClientByEmail(email) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

async function getClientById(id) {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code === 'PGRST116') return null;
  if (error) throw error;
  return data;
}

async function getAllClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function updateClient(id, updates) {
  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getActiveClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('status', 'active')
    .eq('subscription_active', true);
  if (error) throw error;
  return data;
}

// ── FLOWS ─────────────────────────────────────────────────────

async function getFlows(clientId, activeOnly = true) {
  let q = supabase.from('flows').select('*').eq('client_id', clientId);
  if (activeOnly) q = q.eq('active', true);
  const { data, error } = await q.order('priority', { ascending: false });
  if (error) throw error;
  return data;
}

async function addFlow(clientId, flowName, keywords, responseType, response, mediaUrl, priority = 0) {
  const { data, error } = await supabase
    .from('flows')
    .insert([{ client_id: clientId, flow_name: flowName, keywords, response_type: responseType, response, media_url: mediaUrl, priority }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteFlow(id) {
  const { error } = await supabase.from('flows').delete().eq('id', id);
  if (error) throw error;
}

// ── STATUS POSTS ──────────────────────────────────────────────

async function getStatusPosts(clientId) {
  const { data, error } = await supabase
    .from('status_posts')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data;
}

async function addStatusPost(clientId, caption, mediaUrl, postTime, repeatDaily = true) {
  const { data, error } = await supabase
    .from('status_posts')
    .insert([{ client_id: clientId, caption, media_url: mediaUrl, post_time: postTime, repeat_daily: repeatDaily }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getDueStatusPosts(currentTime, today) {
  const { data, error } = await supabase
    .from('status_posts')
    .select('*, clients(*)')
    .eq('active', true)
    .eq('post_time', currentTime)
    .or(`last_posted.is.null,last_posted.lt.${today}`);
  if (error) throw error;
  return data;
}

async function markStatusPosted(id, date) {
  const { error } = await supabase
    .from('status_posts')
    .update({ last_posted: date })
    .eq('id', id);
  if (error) throw error;
}

async function deleteStatusPost(id) {
  const { error } = await supabase.from('status_posts').delete().eq('id', id);
  if (error) throw error;
}

// ── PAYMENTS ──────────────────────────────────────────────────

async function createPayment(clientId, paymentType, amount, currency, provider, reference) {
  const { data, error } = await supabase
    .from('payments')
    .insert([{ client_id: clientId, payment_type: paymentType, amount, currency, provider, reference }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updatePaymentStatus(reference, status) {
  const { error } = await supabase
    .from('payments')
    .update({ status })
    .eq('reference', reference);
  if (error) throw error;
}

async function getPaymentByReference(reference) {
  const { data, error } = await supabase
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
  const { error } = await supabase
    .from('broadcast_logs')
    .insert([{ client_id: clientId, message, recipients }]);
  if (error) throw error;
}

async function getBroadcastLogs(clientId) {
  const { data, error } = await supabase
    .from('broadcast_logs')
    .select('*')
    .eq('client_id', clientId)
    .order('sent_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data;
}

module.exports = {
  createClient_, getClientByEmail, getClientById, getAllClients, updateClient, getActiveClients,
  getFlows, addFlow, deleteFlow,
  getStatusPosts, addStatusPost, getDueStatusPosts, markStatusPosted, deleteStatusPost,
  createPayment, updatePaymentStatus, getPaymentByReference,
  logBroadcast, getBroadcastLogs
};
