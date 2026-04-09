const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
app.use(cors());
app.use(express.json());

const OROPLAY = {
  baseUrl      : process.env.OROPLAY_BASE_URL      || 'https://bs.sxvwlkohlv.com/api/v2',
  clientId     : process.env.OROPLAY_CLIENT_ID     || 'ganandobet',
  clientSecret : process.env.OROPLAY_CLIENT_SECRET || 'NrZXISM6BXoEEZ8wtcgKAhBXp2Emyk6k',
};

const FIXIE_URL     = process.env.FIXIE_URL || '';
const proxyAgent    = FIXIE_URL ? new HttpsProxyAgent(FIXIE_URL) : null;
const SEAMLESS_AUTH = Buffer.from(`${OROPLAY.clientId}:${OROPLAY.clientSecret}`).toString('base64');
const DB            = { users: {}, transactions: [] };
let tokenCache      = { token: null, expiration: 0 };

// Axios instance con proxy
const api = axios.create({
  baseURL: OROPLAY.baseUrl,
  timeout: 15000,
  ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
});

async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiration > now + 60) return tokenCache.token;

  console.log(`🔑 Obteniendo token → ${OROPLAY.baseUrl}/auth/createtoken`);
  const res = await api.post('/auth/createtoken', {
    clientId    : OROPLAY.clientId,
    clientSecret: OROPLAY.clientSecret,
  });

  const data  = res.data;
  const token = data.token || data.access_token;
  if (!token) throw new Error(`Token no encontrado: ${JSON.stringify(data)}`);

  tokenCache = { token, expiration: data.expiration || (now + 3600) };
  console.log('✅ Token OK');
  return token;
}

async function oroplayCall(method, path, body = null) {
  const token = await getToken();
  const config = {
    method,
    url: path,
    headers: { 'Authorization': `Bearer ${token}` },
  };
  if (body) config.data = body;
  const res = await api(config);
  return res.data;
}

app.get('/', (req, res) => res.json({ status: 'ok', version: '1.1.4', baseUrl: OROPLAY.baseUrl, proxy: !!proxyAgent }));

app.get('/mi-ip', (req, res) => {
  const agent = proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {};
  axios.get('https://ifconfig.me/ip', { responseType: 'text', ...agent })
    .then(r => { console.log('🌐 IP:', r.data.trim()); res.json({ ip: r.data.trim() }); })
    .catch(e => res.json({ error: e.message }));
});

app.get('/test-token', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ success: true, baseUrl: OROPLAY.baseUrl, proxy: !!proxyAgent, token: token.slice(0,25)+'…' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/vendors', async (req, res) => {
  try { res.json(await oroplayCall('GET', '/vendors/list')); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/games/list', async (req, res) => {
  try {
    const { vendorCode, language = 'es' } = req.body;
    res.json(await oroplayCall('POST', '/games/list', { vendorCode, language }));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/game/launch', async (req, res) => {
  try {
    const { vendorCode, gameCode, userCode, language = 'es' } = req.body;
    if (!vendorCode || !gameCode || !userCode)
      return res.json({ success: false, message: 'Faltan parámetros' });
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});
    const result = await oroplayCall('POST', '/game/launch-url', {
      vendorCode, gameCode, userCode, language,
      lobbyUrl: process.env.LOBBY_URL || 'https://ganando.bet', theme: 1,
    });
    if (result.success && result.message)
      return res.json({ success: true, message: result.message });
    throw new Error(result.message || JSON.stringify(result));
  } catch (e) {
    console.error('❌ Launch:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

app.post('/api/user/create', async (req, res) => {
  try {
    const { userCode } = req.body;
    const result = await oroplayCall('POST', '/user/create', { userCode });
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
    res.json({ success: true, data: result });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/user/balance', async (req, res) => {
  try { res.json(await oroplayCall('POST', '/user/balance', { userCode: req.body.userCode })); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/user/deposit', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});
    const orderRef = orderNo || `DEP-${Date.now()}-${userCode}`;
    const result   = await oroplayCall('POST', '/user/deposit', { userCode, balance: parseFloat(balance), orderNo: orderRef });
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
    DB.users[userCode].balance += parseFloat(balance);
    res.json({ success: true, message: result.message, errorCode: result.errorCode || 0 });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/api/user/withdraw', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    const orderRef = orderNo || `WIT-${Date.now()}-${userCode}`;
    const result   = await oroplayCall('POST', '/user/withdraw', { userCode, balance: parseFloat(balance), orderNo: orderRef });
    res.json({ success: true, message: result.message, errorCode: result.errorCode || 0 });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get('/api/agent/balance', async (req, res) => {
  try { res.json(await oroplayCall('GET', '/agent/balance')); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post('/actualizar-saldo', (req, res) => {
  const bal = DB.users[req.body.userCode]?.balance ?? 0;
  res.json({ success: true, message: bal });
});

// SEAMLESS WALLET
app.post('/api/balance', (req, res) => {
  const { userCode } = req.body;
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  res.json({ success: true, message: DB.users[userCode].balance, errorCode: 0 });
});

app.post('/api/transaction', (req, res) => {
  const { userCode, transactionCode, amount, isFinished, isCanceled } = req.body;
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  const user = DB.users[userCode];
  const dup  = DB.transactions.find(t => t.transactionCode === transactionCode);
  if (dup) return res.json({ success: false, message: dup.balanceAfter, errorCode: 6 });
  const amt        = parseFloat(amount || 0);
  const newBalance = parseFloat((user.balance + amt).toFixed(2));
  if (newBalance < 0) return res.json({ success: false, message: user.balance, errorCode: 4 });
  user.balance = newBalance;
  DB.transactions.push({ transactionCode, userCode, amount: amt, balanceAfter: newBalance, isFinished, isCanceled, createdAt: new Date().toISOString() });
  res.json({ success: true, message: newBalance, errorCode: 0 });
});

app.post('/api/batch-transactions', (req, res) => {
  const { userCode, transactions = [] } = req.body;
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0 };
  let cur = DB.users[userCode].balance;
  for (const tx of transactions) {
    if (DB.transactions.find(t => t.transactionCode === tx.transactionCode)) continue;
    const nb = parseFloat((cur + parseFloat(tx.amount || 0)).toFixed(2));
    if (nb < 0) return res.json({ success: false, message: cur, errorCode: 4 });
    DB.transactions.push({ ...tx, userCode, balanceAfter: nb, createdAt: new Date().toISOString() });
    cur = nb;
  }
  DB.users[userCode].balance = cur;
  res.json({ success: true, message: cur, errorCode: 0 });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Ganando.bet API en puerto ${PORT}`);
  console.log(`🎰 OroPlay: ${OROPLAY.baseUrl}`);
  console.log(`🔒 Proxy Fixie: ${proxyAgent ? 'ACTIVO' : 'INACTIVO'}`);
});
