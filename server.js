// ═══════════════════════════════════════════════
//  GANANDO.BET — Backend OroPlay v1.1.3
//  Basado en documentación oficial OroPlay marzo 2026
// ═══════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

const OROPLAY = {
  baseUrl      : process.env.OROPLAY_BASE_URL     || 'https://bs.sxvwlkohlv.com/api/v2',
  clientId     : process.env.OROPLAY_CLIENT_ID    || 'ganandobet',
  clientSecret : process.env.OROPLAY_CLIENT_SECRET || 'rVYlcbUIXcorfHO0oPzQQ6MphC7wNtPl',
};

const SEAMLESS_AUTH = Buffer.from(`${OROPLAY.clientId}:${OROPLAY.clientSecret}`).toString('base64');
const DB = { users: {}, transactions: [] };
let tokenCache = { token: null, expiration: 0 };

async function safeJson(res) {
  const raw = await res.text();
  const ct  = res.headers.get('content-type') || '';
  if (!raw || raw.trim() === '') throw new Error(`HTTP ${res.status} — respuesta vacía. Verificá OROPLAY_BASE_URL.`);
  if (raw.trim().startsWith('<')) throw new Error(`HTTP ${res.status} — OroPlay devolvió HTML. URL de API incorrecta.`);
  try { return JSON.parse(raw); } catch { throw new Error(`JSON inválido: ${raw.slice(0,150)}`); }
}

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiration > now + 60) return tokenCache.token;
  console.log(`🔑 Obteniendo token → ${OROPLAY.baseUrl}/auth/createtoken`);
  const res = await fetch(`${OROPLAY.baseUrl}/auth/createtoken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: OROPLAY.clientId, clientSecret: OROPLAY.clientSecret }),
  });
  const data = await safeJson(res);
  if (!data.token) throw new Error(`Token no encontrado. Respuesta: ${JSON.stringify(data)}`);
  tokenCache = { token: data.token, expiration: data.expiration || (now + 3600) };
  console.log('✅ Token OK');
  return data.token;
}

async function oroplayCall(method, path, body = null) {
  const token = await getToken();
  const options = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${OROPLAY.baseUrl}${path}`, options);
  return safeJson(res);
}

// STATUS
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Ganando.bet API', version: '1.1.3', baseUrl: OROPLAY.baseUrl }));

app.get('/mi-ip', (req, res) => {
  require('https').get('https://ifconfig.me', r => {
    let ip = '';
    r.on('data', d => ip += d);
    r.on('end', () => { console.log('🌐 IP:', ip.trim()); res.json({ ip: ip.trim() }); });
  }).on('error', e => res.json({ error: e.message }));
});

app.get('/test-token', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ success: true, baseUrl: OROPLAY.baseUrl, token: token.slice(0,25)+'…', expiration: tokenCache.expiration });
  } catch (e) { res.json({ success: false, baseUrl: OROPLAY.baseUrl, error: e.message }); }
});

app.get('/test-status', async (req, res) => {
  try { res.json({ success: true, oroplay: await oroplayCall('GET', '/status') }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

// VENDORS
app.get('/api/vendors', async (req, res) => {
  try { res.json(await oroplayCall('GET', '/vendors/list')); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// GAMES LIST
app.post('/api/games/list', async (req, res) => {
  try {
    const { vendorCode, language = 'es' } = req.body;
    if (!vendorCode) return res.json({ success: false, message: 'vendorCode requerido' });
    res.json(await oroplayCall('POST', '/games/list', { vendorCode, language }));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// LAUNCH URL
app.post('/api/game/launch', async (req, res) => {
  try {
    const { vendorCode, gameCode, userCode, language = 'es' } = req.body;
    if (!vendorCode || !gameCode || !userCode)
      return res.json({ success: false, message: 'Faltan vendorCode, gameCode o userCode' });
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});
    const result = await oroplayCall('POST', '/game/launch-url', {
      vendorCode, gameCode, userCode, language,
      lobbyUrl: process.env.LOBBY_URL || 'https://ganando.bet', theme: 1,
    });
    if (result.success && result.message) return res.json({ success: true, message: result.message });
    throw new Error(result.message || JSON.stringify(result));
  } catch (e) {
    console.error('❌ Launch:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// USER CREATE
app.post('/api/user/create', async (req, res) => {
  try {
    const { userCode } = req.body;
    if (!userCode) return res.json({ success: false, message: 'userCode requerido' });
    const result = await oroplayCall('POST', '/user/create', { userCode });
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// USER BALANCE
app.post('/api/user/balance', async (req, res) => {
  try { res.json(await oroplayCall('POST', '/user/balance', { userCode: req.body.userCode })); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// DEPOSIT
app.post('/api/user/deposit', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    if (!userCode || !balance) return res.json({ success: false, message: 'userCode y balance requeridos' });
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});
    const orderRef = orderNo || `DEP-${Date.now()}-${userCode}`;
    const result = await oroplayCall('POST', '/user/deposit', { userCode, balance: parseFloat(balance), orderNo: orderRef });
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
    DB.users[userCode].balance += parseFloat(balance);
    res.json({ success: true, message: result.message, errorCode: result.errorCode || 0 });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// WITHDRAW
app.post('/api/user/withdraw', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    if (!userCode || !balance) return res.json({ success: false, message: 'userCode y balance requeridos' });
    const orderRef = orderNo || `WIT-${Date.now()}-${userCode}`;
    const result = await oroplayCall('POST', '/user/withdraw', { userCode, balance: parseFloat(balance), orderNo: orderRef });
    if (DB.users[userCode]) DB.users[userCode].balance = Math.max(0, DB.users[userCode].balance - parseFloat(balance));
    res.json({ success: true, message: result.message, errorCode: result.errorCode || 0 });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// AGENT BALANCE
app.get('/api/agent/balance', async (req, res) => {
  try { res.json(await oroplayCall('GET', '/agent/balance')); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// BETTING HISTORY
app.post('/api/betting/history', async (req, res) => {
  try {
    const { startDate, limit = 100 } = req.body;
    res.json(await oroplayCall('POST', '/betting/history/by-date-v2', {
      startDate: startDate || new Date(Date.now()-86400000).toISOString().split('T')[0], limit,
    }));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// SET RTP
app.post('/api/user/set-rtp', async (req, res) => {
  try { res.json(await oroplayCall('POST', '/game/user/set-rtp', req.body)); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ACTIVE USERS
app.get('/api/active-users', async (req, res) => {
  try { res.json(await oroplayCall('GET', '/call/active-users')); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// SALDO FRONTEND
app.post('/actualizar-saldo', (req, res) => {
  const bal = DB.users[req.body.userCode]?.balance ?? 0;
  res.json({ success: true, message: bal });
});

// ════════════════════════════════════════════
//  SEAMLESS WALLET — OroPlay llama aquí
//
//  ⚠️  En OroPlay panel → "URL de devolución de llamada":
//  https://ganandobet-api-production.up.railway.app
//  (SIN /callback al final — OroPlay agrega /api/balance
//  y /api/transaction automáticamente)
// ════════════════════════════════════════════

// 3.1 BALANCE — OroPlay pregunta el saldo antes de cada apuesta
app.post('/api/balance', (req, res) => {
  console.log('📡 /api/balance ←', req.body.userCode);
  const { userCode } = req.body;
  if (!userCode) return res.json({ success: false, message: 0, errorCode: 2 });
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  const balance = DB.users[userCode].balance;
  console.log(`💰 ${userCode}: ${balance}`);
  res.json({ success: true, message: balance, errorCode: 0 });
});

// 3.2 TRANSACTION — apuesta (amount negativo) o premio (amount positivo)
app.post('/api/transaction', (req, res) => {
  console.log('📡 /api/transaction ←', req.body.userCode, 'amount:', req.body.amount);
  const { userCode, transactionCode, amount, isFinished, isCanceled } = req.body;

  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  const user = DB.users[userCode];

  const dup = DB.transactions.find(t => t.transactionCode === transactionCode);
  if (dup) return res.json({ success: false, message: dup.balanceAfter, errorCode: 6 });

  const amt        = parseFloat(amount || 0);
  const balBefore  = user.balance;
  const newBalance = parseFloat((balBefore + amt).toFixed(2));

  if (newBalance < 0) {
    console.warn(`❌ Saldo insuficiente — ${userCode}: ${balBefore} + ${amt}`);
    return res.json({ success: false, message: balBefore, errorCode: 4 });
  }

  user.balance = newBalance;
  DB.transactions.push({ transactionCode, userCode, amount: amt, balanceBefore: balBefore, balanceAfter: newBalance, isFinished, isCanceled, createdAt: new Date().toISOString(), ...req.body });
  console.log(`✅ ${userCode}: ${balBefore} → ${newBalance}`);
  res.json({ success: true, message: newBalance, errorCode: 0 });
});

// 3.3 BATCH TRANSACTIONS — fishing games
app.post('/api/batch-transactions', (req, res) => {
  console.log('📡 /api/batch-transactions ←', req.body.userCode);
  const { userCode, transactions = [] } = req.body;
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  const user = DB.users[userCode];
  let cur = user.balance;

  for (const tx of transactions) {
    if (DB.transactions.find(t => t.transactionCode === tx.transactionCode)) continue;
    const amt = parseFloat(tx.amount || 0);
    const nb  = parseFloat((cur + amt).toFixed(2));
    if (nb < 0) return res.json({ success: false, message: cur, errorCode: 4 });
    DB.transactions.push({ ...tx, userCode, balanceBefore: cur, balanceAfter: nb, createdAt: new Date().toISOString() });
    cur = nb;
  }
  user.balance = cur;
  console.log(`✅ Batch ${userCode}: saldo final ${cur}`);
  res.json({ success: true, message: cur, errorCode: 0 });
});

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Ganando.bet API en puerto ${PORT}`);
  console.log(`🎰 OroPlay baseUrl: ${OROPLAY.baseUrl}`);
  console.log(`📡 Seamless: /api/balance | /api/transaction | /api/batch-transactions`);
  console.log(`⚠️  Callback URL en OroPlay: https://ganandobet-api-production.up.railway.app`);
});
