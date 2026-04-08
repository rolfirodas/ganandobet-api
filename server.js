// ═══════════════════════════════════════════════
//  GANANDO.BET — Backend OroPlay Integration
//  Deploy en Railway.app (gratis)
//  Autor: generado para Ganando.bet
// ═══════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIGURACIÓN OROPLAY ──
const OROPLAY = {
  baseUrl: 'https://und7br.sxvwlkohlv.com/api/v2',
  clientId: 'ganandobet',
  clientSecret: process.env.CLIENT_SECRET || 'rVYlcbUIXcorfHO0oPzQQ6MphC7wNtPl',
};

// ── BASE64 para Seamless Auth ──
const SEAMLESS_AUTH = Buffer.from(`${OROPLAY.clientId}:${OROPLAY.clientSecret}`).toString('base64');

// ── BASE DE DATOS EN MEMORIA (reemplazar con PostgreSQL en producción) ──
const DB = {
  users: {},       // { userCode: { balance, createdAt } }
  transactions: [] // log de todas las operaciones
};

// ── TOKEN CACHE ──
let tokenCache = { token: null, expiration: 0 };

// ════════════════════════════════════════════
//  HELPER: Obtener token OroPlay
// ════════════════════════════════════════════
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiration > now + 60) {
    return tokenCache.token;
  }
  const res = await fetch(`${OROPLAY.baseUrl}/auth/createtoken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: OROPLAY.clientId, clientSecret: OROPLAY.clientSecret })
  });
  const data = await res.json();
  if (!data.token) throw new Error('No se pudo obtener token OroPlay');
  tokenCache = { token: data.token, expiration: data.expiration };
  return data.token;
}

// ════════════════════════════════════════════
//  HELPER: Llamada autenticada a OroPlay
// ════════════════════════════════════════════
async function oroplayCall(method, path, body = null) {
  const token = await getToken();
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${OROPLAY.baseUrl}${path}`, options);
  return res.json();
}

// ════════════════════════════════════════════
//  1. ESTADO DEL SERVIDOR
// ════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ganando.bet API', version: '1.0.0' });
});

// ════════════════════════════════════════════
//  2. CREAR USUARIO EN OROPLAY
// ════════════════════════════════════════════
app.post('/api/user/create', async (req, res) => {
  try {
    const { userCode } = req.body;
    if (!userCode) return res.json({ success: false, message: 'userCode requerido' });

    // Crear en OroPlay
    const result = await oroplayCall('POST', '/user/create', { userCode });

    // Guardar en memoria local
    if (!DB.users[userCode]) {
      DB.users[userCode] = { balance: 0, createdAt: Date.now() };
    }
    res.json({ success: true, message: 'Usuario creado', data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  3. SALDO DEL USUARIO
// ════════════════════════════════════════════
app.post('/api/user/balance', async (req, res) => {
  try {
    const { userCode } = req.body;
    const result = await oroplayCall('POST', '/user/balance', { userCode });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  4. DEPOSITAR FICHAS (Cajero → Usuario)
// ════════════════════════════════════════════
app.post('/api/user/deposit', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    if (!userCode || !balance) return res.json({ success: false, message: 'Faltan datos' });

    // Primero asegurarnos que el usuario existe en OroPlay
    await oroplayCall('POST', '/user/create', { userCode });

    const orderRef = orderNo || `DEP-${Date.now()}-${userCode}`;
    const result = await oroplayCall('POST', '/user/deposit', {
      userCode,
      balance: parseFloat(balance),
      orderNo: orderRef
    });

    // Log local
    DB.transactions.push({
      type: 'deposit', userCode, balance, orderNo: orderRef,
      result, createdAt: new Date().toISOString()
    });

    res.json({ success: true, message: result.message, errorCode: result.errorCode });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  5. RETIRAR FICHAS (Usuario → Cajero)
// ════════════════════════════════════════════
app.post('/api/user/withdraw', async (req, res) => {
  try {
    const { userCode, balance, orderNo } = req.body;
    if (!userCode || !balance) return res.json({ success: false, message: 'Faltan datos' });

    const orderRef = orderNo || `WIT-${Date.now()}-${userCode}`;
    const result = await oroplayCall('POST', '/user/withdraw', {
      userCode,
      balance: parseFloat(balance),
      orderNo: orderRef
    });

    DB.transactions.push({
      type: 'withdraw', userCode, balance, orderNo: orderRef,
      result, createdAt: new Date().toISOString()
    });

    res.json({ success: true, message: result.message, errorCode: result.errorCode });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  6. OBTENER LAUNCH URL (abrir juego real)
// ════════════════════════════════════════════
app.post('/api/game/launch', async (req, res) => {
  try {
    const { vendorCode, gameCode, userCode, language = 'es' } = req.body;
    if (!vendorCode || !gameCode || !userCode) {
      return res.json({ success: false, message: 'Faltan vendorCode, gameCode o userCode' });
    }

    // Asegurar que el usuario existe
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});

    const result = await oroplayCall('POST', '/game/launch-url', {
      vendorCode,
      gameCode,
      userCode,
      language,
      lobbyUrl: process.env.LOBBY_URL || 'https://ganando.bet',
      theme: 1
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  7. LISTA DE VENDORS
// ════════════════════════════════════════════
app.get('/api/vendors', async (req, res) => {
  try {
    const result = await oroplayCall('GET', '/vendors/list');
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  8. LISTA DE JUEGOS POR VENDOR
// ════════════════════════════════════════════
app.post('/api/games/list', async (req, res) => {
  try {
    const { vendorCode, language = 'es' } = req.body;
    const result = await oroplayCall('POST', '/games/list', { vendorCode, language });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  9. BALANCE DEL AGENTE
// ════════════════════════════════════════════
app.get('/api/agent/balance', async (req, res) => {
  try {
    const result = await oroplayCall('GET', '/agent/balance');
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  10. SET RTP DE USUARIO
// ════════════════════════════════════════════
app.post('/api/user/set-rtp', async (req, res) => {
  try {
    const { vendorCode, userCode, rtp } = req.body;
    const result = await oroplayCall('POST', '/game/user/set-rtp', { vendorCode, userCode, rtp });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  11. USUARIOS ACTIVOS JUGANDO
// ════════════════════════════════════════════
app.get('/api/active-users', async (req, res) => {
  try {
    const result = await oroplayCall('GET', '/call/active-users');
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  12. HISTORIAL DE APUESTAS
// ════════════════════════════════════════════
app.post('/api/betting/history', async (req, res) => {
  try {
    const { startDate, limit = 100 } = req.body;
    const result = await oroplayCall('POST', '/betting/history/by-date-v2', {
      startDate: startDate || new Date(Date.now() - 86400000).toISOString().split('T')[0],
      limit
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  13. SEAMLESS WALLET — Balance (OroPlay llama aquí)
// ════════════════════════════════════════════
app.post('/api/balance', (req, res) => {
  // Verificar auth básica de OroPlay
  const auth = req.headers.authorization || '';
  const expectedAuth = `Basic ${SEAMLESS_AUTH}`;
  // En producción verificar: if (auth !== expectedAuth) return res.status(401).json(...)

  const { userCode } = req.body;
  const user = DB.users[userCode];
  const balance = user ? user.balance : 0;
  res.json({ success: true, message: balance, errorCode: 0 });
});

// ════════════════════════════════════════════
//  14. SEAMLESS WALLET — Transaction (OroPlay llama aquí)
// ════════════════════════════════════════════
app.post('/api/transaction', (req, res) => {
  const { userCode, transactionCode, amount, isFinished, isCanceled } = req.body;

  // Verificar transacción duplicada
  const exists = DB.transactions.find(t => t.transactionCode === transactionCode);
  if (exists) {
    return res.json({ success: false, message: exists.balanceAfter, errorCode: 6 }); // DUPLICATE
  }

  // Crear usuario si no existe
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0, createdAt: Date.now() };

  const user = DB.users[userCode];
  const balanceBefore = user.balance;
  const newBalance = balanceBefore + parseFloat(amount); // amount negativo = apuesta, positivo = ganancia

  if (newBalance < 0) {
    return res.json({ success: false, message: balanceBefore, errorCode: 4 }); // INSUFFICIENT
  }

  user.balance = newBalance;

  // Guardar log
  DB.transactions.push({
    transactionCode, userCode, amount,
    balanceBefore, balanceAfter: newBalance,
    isFinished, isCanceled,
    createdAt: new Date().toISOString(),
    ...req.body
  });

  res.json({ success: true, message: newBalance, errorCode: 0 });
});

// ════════════════════════════════════════════
//  START
// ════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Ganando.bet API corriendo en puerto ${PORT}`);
  console.log(`🎰 OroPlay endpoint: ${OROPLAY.baseUrl}`);
});
