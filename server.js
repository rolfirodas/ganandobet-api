// ═══════════════════════════════════════════════
//  GANANDO.BET — Backend OroPlay Integration
//  Deploy en Railway.app
// ═══════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIGURACIÓN OROPLAY ──
const OROPLAY = {
  // Si sigue fallando, cambiá OROPLAY_BASE_URL en Railway Variables
  baseUrl      : process.env.OROPLAY_BASE_URL    || 'https://und7br.sxvwlkohlv.com',
  clientId     : process.env.OROPLAY_CLIENT_ID   || 'ganandobet',
  clientSecret : process.env.OROPLAY_CLIENT_SECRET || 'rVYlcbUIXcorfHO0oPzQQ6MphC7wNtPl',
};

// ── SEAMLESS AUTH (Basic) ──
const SEAMLESS_AUTH = Buffer.from(`${OROPLAY.clientId}:${OROPLAY.clientSecret}`).toString('base64');

// ── BASE DE DATOS EN MEMORIA ──
// ⚠️  Esto se resetea con cada deploy — reemplazar con PostgreSQL en producción
const DB = {
  users        : {},  // { userCode: { balance, createdAt } }
  transactions : [],  // log de operaciones
};

// ── TOKEN CACHE ──
let tokenCache = { token: null, expiration: 0 };

// ════════════════════════════════════════════
//  HELPER: JSON seguro (evita "Unexpected end of JSON")
// ════════════════════════════════════════════
async function safeJson(res) {
  const ct  = res.headers.get('content-type') || '';
  const raw = await res.text();

  if (!raw || raw.trim() === '') {
    throw new Error(`Respuesta vacía del servidor OroPlay (HTTP ${res.status}). Verificá que la IP esté en whitelist.`);
  }
  if (!ct.includes('application/json') && raw.trim().startsWith('<')) {
    throw new Error(`OroPlay devolvió HTML (HTTP ${res.status}). IP bloqueada — verificá whitelist.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`JSON inválido de OroPlay: ${raw.slice(0, 120)}`);
  }
}

// ════════════════════════════════════════════
//  HELPER: Obtener Bearer Token de OroPlay
//  Prueba múltiples rutas porque varía por versión
// ════════════════════════════════════════════
async function getToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.expiration > now + 60) return tokenCache.token;

  // Combinaciones base + ruta a probar (el 404 en todas indica base incorrecta)
  const HOST = 'https://und7br.sxvwlkohlv.com';
  const COMBOS = [
    `${HOST}/api/v2/auth/token`,
    `${HOST}/api/v2/auth/createtoken`,
    `${HOST}/api/v1/auth/token`,
    `${HOST}/api/v1/auth/createtoken`,
    `${HOST}/api/auth/token`,
    `${HOST}/api/auth/createtoken`,
    `${HOST}/api/token`,
    `${HOST}/auth/token`,
    `${HOST}/auth/createtoken`,
    `${HOST}/v2/auth/token`,
    `${HOST}/v1/auth/token`,
  ];

  const body = JSON.stringify({
    clientId: OROPLAY.clientId, clientSecret: OROPLAY.clientSecret,
    client_id: OROPLAY.clientId, client_secret: OROPLAY.clientSecret,
    grant_type: 'client_credentials',
  });

  let lastError = 'Sin rutas disponibles';
  for (const url of COMBOS) {
    try {
      console.log(`🔑 Probando: ${url}`);
      const res = await fetch(url, {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (res.status === 404) { console.log(`   ↳ 404`); continue; }
      if (res.status === 405) { console.log(`   ↳ 405 Method Not Allowed`); continue; }

      const raw = await res.text();
      if (!raw || raw.trim() === '') { console.log(`   ↳ cuerpo vacío (${res.status})`); continue; }

      let data;
      try { data = JSON.parse(raw); } catch { console.log(`   ↳ no-JSON: ${raw.slice(0,60)}`); continue; }

      const token = data.token || data.access_token || data.accessToken
                 || data.Bearer || data.bearer
                 || (data.data && (data.data.token || data.data.access_token));

      if (token) {
        const exp = data.expiration || (data.expires_in ? now + parseInt(data.expires_in) : now + 3600);
        tokenCache = { token, expiration: exp };
        // Actualizar baseUrl para que el resto de llamadas usen la ruta correcta
        OROPLAY.baseUrl = url.replace(/\/(auth|token)[^/]*$/, '');
        console.log(`✅ Token OK en: ${url}`);
        console.log(`✅ BaseUrl actualizado a: ${OROPLAY.baseUrl}`);
        return token;
      }
      lastError = `Sin campo token en ${url}: ${JSON.stringify(data).slice(0,150)}`;
      console.log(`   ↳ respuesta sin token: ${lastError}`);

    } catch (e) {
      lastError = e.message;
      console.warn(`⚠️  Error en ${url}:`, e.message);
    }
  }
  throw new Error(`Token OroPlay no encontrado. Revisá credenciales o contactá soporte OroPlay. Último: ${lastError}`);
}

// ════════════════════════════════════════════
//  HELPER: Llamada autenticada a OroPlay
// ════════════════════════════════════════════
async function oroplayCall(method, path, body = null) {
  const token   = await getToken();
  const options = {
    method,
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${OROPLAY.baseUrl}${path}`, options);
  return safeJson(res); // ← JSON SEGURO EN TODAS LAS LLAMADAS
}

// ════════════════════════════════════════════
//  1. ESTADO Y DEBUG
// ════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Ganando.bet API', version: '1.1.0' });
});

// ─── Obtener IP pública de salida de Railway ───
app.get('/mi-ip', (req, res) => {
  require('https').get('https://ifconfig.me', r => {
    let ip = '';
    r.on('data', d => ip += d);
    r.on('end', () => {
      console.log('🌐 IP pública de salida:', ip.trim());
      res.json({ ip: ip.trim() });
    });
  }).on('error', e => res.json({ error: e.message }));
});

// ─── Test de token ───
app.get('/test-token', async (req, res) => {
  try {
    const token = await getToken();
    res.json({ success: true, token: token.slice(0, 20) + '…', baseUrl: OROPLAY.baseUrl, expiration: tokenCache.expiration });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ─── Debug: descubrir rutas disponibles en OroPlay ───
app.get('/debug-api', async (req, res) => {
  const HOST  = 'https://und7br.sxvwlkohlv.com';
  const PATHS = ['/', '/api', '/api/v1', '/api/v2', '/api/v3', '/docs', '/swagger'];
  const results = [];
  for (const p of PATHS) {
    try {
      const r = await fetch(HOST + p, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
      const raw = await r.text();
      results.push({ path: p, status: r.status, preview: raw.slice(0, 200) });
    } catch (e) {
      results.push({ path: p, error: e.message });
    }
  }
  res.json({ host: HOST, results });
});

// ════════════════════════════════════════════
//  2. CREAR USUARIO
// ════════════════════════════════════════════
app.post('/api/user/create', async (req, res) => {
  try {
    const { userCode } = req.body;
    if (!userCode) return res.json({ success: false, message: 'userCode requerido' });

    const result = await oroplayCall('POST', '/user/create', { userCode });
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0, createdAt: Date.now() };

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

    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});

    const orderRef = orderNo || `DEP-${Date.now()}-${userCode}`;
    const result   = await oroplayCall('POST', '/user/deposit', {
      userCode, balance: parseFloat(balance), orderNo: orderRef,
    });

    // Actualizar balance local
    if (!DB.users[userCode]) DB.users[userCode] = { balance: 0, createdAt: Date.now() };
    DB.users[userCode].balance += parseFloat(balance);

    DB.transactions.push({ type:'deposit', userCode, balance, orderNo:orderRef, result, createdAt:new Date().toISOString() });
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
    const result   = await oroplayCall('POST', '/user/withdraw', {
      userCode, balance: parseFloat(balance), orderNo: orderRef,
    });

    if (DB.users[userCode]) DB.users[userCode].balance -= parseFloat(balance);
    DB.transactions.push({ type:'withdraw', userCode, balance, orderNo:orderRef, result, createdAt:new Date().toISOString() });

    res.json({ success: true, message: result.message, errorCode: result.errorCode });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  6. LAUNCH URL (abrir juego real)
// ════════════════════════════════════════════
app.post('/api/game/launch', async (req, res) => {
  try {
    const { vendorCode, gameCode, userCode, language = 'es' } = req.body;
    if (!vendorCode || !gameCode || !userCode) {
      return res.json({ success: false, message: 'Faltan vendorCode, gameCode o userCode' });
    }

    // Asegurar que el usuario existe antes de lanzar
    await oroplayCall('POST', '/user/create', { userCode }).catch(() => {});

    const result = await oroplayCall('POST', '/game/launch-url', {
      vendorCode,
      gameCode,
      userCode,
      language,
      lobbyUrl : process.env.LOBBY_URL || 'https://ganando.bet',
      theme    : 1,
    });

    // Normalizar campo de URL
    const launchUrl = result.message || result.launchUrl || result.url;
    if (!launchUrl) throw new Error(`OroPlay no devolvió launchUrl: ${JSON.stringify(result)}`);

    res.json({ success: true, message: launchUrl });
  } catch (e) {
    console.error('❌ Error launch:', e.message);
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
//  11. USUARIOS ACTIVOS
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
      limit,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ════════════════════════════════════════════
//  13. ACTUALIZAR SALDO (usado por el frontend)
// ════════════════════════════════════════════
app.post('/actualizar-saldo', (req, res) => {
  const { userCode } = req.body;
  const user    = DB.users[userCode];
  const balance = user ? user.balance : 0;
  res.json({ success: true, message: balance });
});

// ════════════════════════════════════════════
//  14. SEAMLESS WALLET — /callback
//  ⚠️  ESTE ES EL ENDPOINT QUE FALTABA
//  OroPlay llama aquí con: balance / debit / credit / rollback
//  URL registrada en OroPlay: https://ganandobet-api-production.up.railway.app/callback
// ════════════════════════════════════════════
app.post('/callback', (req, res) => {
  console.log('📡 Callback OroPlay recibido:', JSON.stringify(req.body));

  const { action, userCode, transactionCode, amount, isCanceled } = req.body;

  // ─ Verificar auth Basic de OroPlay ─
  const auth         = req.headers.authorization || '';
  const expectedAuth = `Basic ${SEAMLESS_AUTH}`;
  if (auth && auth !== expectedAuth) {
    console.warn('⚠️  Auth inválido en callback:', auth);
    // No cortamos aquí para facilitar debug inicial — activar en producción:
    // return res.status(401).json({ success: false, errorCode: 2 });
  }

  // ─ Crear usuario si no existe ─
  if (!DB.users[userCode]) DB.users[userCode] = { balance: 0, createdAt: Date.now() };
  const user = DB.users[userCode];

  // ─ BALANCE: OroPlay consulta el saldo antes de cada apuesta ─
  if (action === 'balance' || action === 'getBalance' || !action) {
    console.log(`💰 Balance request — ${userCode}: ${user.balance}`);
    return res.json({ success: true, message: user.balance, errorCode: 0 });
  }

  // ─ DEBIT: Apuesta del jugador (descuenta saldo) ─
  if (action === 'debit' || action === 'bet') {
    // Duplicado
    const dup = DB.transactions.find(t => t.transactionCode === transactionCode);
    if (dup) return res.json({ success: false, message: dup.balanceAfter, errorCode: 6 });

    const amt = Math.abs(parseFloat(amount || 0));
    if (user.balance < amt) {
      console.warn(`❌ Saldo insuficiente — ${userCode}: ${user.balance} < ${amt}`);
      return res.json({ success: false, message: user.balance, errorCode: 4 });
    }

    const balanceBefore = user.balance;
    user.balance        = parseFloat((user.balance - amt).toFixed(2));

    DB.transactions.push({
      transactionCode, userCode, action, amount: -amt,
      balanceBefore, balanceAfter: user.balance,
      createdAt: new Date().toISOString(), ...req.body,
    });

    console.log(`🎰 Debit — ${userCode}: ${balanceBefore} → ${user.balance}`);
    return res.json({ success: true, message: user.balance, errorCode: 0 });
  }

  // ─ CREDIT: Premio al jugador (suma saldo) ─
  if (action === 'credit' || action === 'win') {
    // Duplicado
    const dup = DB.transactions.find(t => t.transactionCode === transactionCode);
    if (dup) return res.json({ success: false, message: dup.balanceAfter, errorCode: 6 });

    const amt           = Math.abs(parseFloat(amount || 0));
    const balanceBefore = user.balance;
    user.balance        = parseFloat((user.balance + amt).toFixed(2));

    DB.transactions.push({
      transactionCode, userCode, action, amount: amt,
      balanceBefore, balanceAfter: user.balance,
      createdAt: new Date().toISOString(), ...req.body,
    });

    console.log(`🏆 Credit — ${userCode}: ${balanceBefore} → ${user.balance}`);
    return res.json({ success: true, message: user.balance, errorCode: 0 });
  }

  // ─ ROLLBACK: Cancelar apuesta ─
  if (action === 'rollback' || action === 'cancel' || isCanceled) {
    const original = DB.transactions.find(t => t.transactionCode === transactionCode);
    if (original) {
      user.balance = parseFloat((user.balance - original.amount).toFixed(2));
      original.isCanceled = true;
      console.log(`↩️  Rollback — ${userCode}: saldo restaurado a ${user.balance}`);
    }
    return res.json({ success: true, message: user.balance, errorCode: 0 });
  }

  // ─ Acción desconocida ─
  console.warn('⚠️  Acción desconocida en callback:', action);
  res.json({ success: false, message: user.balance, errorCode: 1 });
});

// Alias por si OroPlay usa estas rutas alternativas
app.post('/api/balance',     (req, res) => { req.body.action = 'balance';  app._router.handle({ ...req, url: '/callback', path: '/callback' }, res, () => {}); });
app.post('/api/transaction', (req, res) => { req.body.action = req.body.action || 'debit'; app._router.handle({ ...req, url: '/callback', path: '/callback' }, res, () => {}); });

// ════════════════════════════════════════════
//  START
// ════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Ganando.bet API corriendo en puerto ${PORT}`);
  console.log(`🎰 OroPlay endpoint: ${OROPLAY.baseUrl}`);
  console.log(`📡 Callback URL: ${process.env.RAILWAY_STATIC_URL || 'https://ganandobet-api-production.up.railway.app'}/callback`);
  console.log(`🔑 Client ID: ${OROPLAY.clientId}`);
});
