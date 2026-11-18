// Relay PvP compatible con LAN y hosting Node (Render/Railway/VPS).
// Mantiene salas privadas por código y separa las colas de matchmaking
// de PvP normal y Clasificatoria. La API HTTP añade identidad online y
// lectura del ranking; la lógica y validación de batalla siguen en la app.
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { GitHubDataStore } = require('./github-data-store');
const { AuthApi } = require('./auth-api');

const PUERTO = process.env.PORT || process.env.PUERTO || 8765;
const GRACIA_RECONEXION_MS = 45000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const VENTANA_RATE_LIMIT_MS = 15 * 60 * 1000;
const MAX_AUTH_INTENTOS = 15;

let dataStore = null;
let authApi = null;
try {
  dataStore = new GitHubDataStore(process.env);
  if (process.env.AUTH_TOKEN_SECRET) authApi = new AuthApi(dataStore, process.env.AUTH_TOKEN_SECRET);
} catch (error) {
  console.warn('[API] Persistencia online no configurada:', error.message);
}

const intentosAuth = new Map();
const ticketsPartidaIA = new Map();
const GRACIA_TICKET_IA_MS = 2 * 60 * 60 * 1000;
const servidorHttp = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const allowedOrigins = (process.env.APP_ORIGINS || '*').split(',').map(v => v.trim()).filter(Boolean);
  if (allowedOrigins.indexOf('*') !== -1 || allowedOrigins.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.indexOf('*') !== -1 ? '*' : origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.indexOf('/api/') !== 0) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Relay de PvP activo. Conectate por WebSocket (wss://), no por HTTP.');
    return;
  }

  const sendJson = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  const requireApi = () => {
    if (!authApi || !dataStore) {
      sendJson(503, { ok: false, mensaje: 'La API online todavía no está configurada en Render.' });
      return false;
    }
    return true;
  };
  const readBody = () => new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Solicitud demasiado grande.'), { status: 413 }));
        req.destroy();
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
  const getBearer = () => {
    const header = String(req.headers.authorization || '');
    return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
  };
  const checkRateLimit = () => {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = intentosAuth.get(ip);
    if (!entry || now - entry.start > VENTANA_RATE_LIMIT_MS) {
      entry = { start: now, count: 0 };
      intentosAuth.set(ip, entry);
    }
    entry.count += 1;
    return entry.count <= MAX_AUTH_INTENTOS;
  };

  try {
    if (url.pathname === '/api/health' && req.method === 'GET') {
      sendJson(200, { ok: true, relay: true, auth: !!authApi, storage: !!dataStore });
      return;
    }
    if (url.pathname === '/api/admin/migration-code' && req.method === 'POST') {
      if (!authApi || !dataStore) { sendJson(503, { ok: false, mensaje: 'La API online todavía no está configurada en Render.' }); return; }
      const adminKey = String(req.headers['x-migration-admin-key'] || '');
      const configuredKey = String(process.env.MIGRATION_ADMIN_KEY || '');
      const supplied = Buffer.from(adminKey);
      const expected = Buffer.from(configuredKey);
      if (!configuredKey || supplied.length !== expected.length || !require('crypto').timingSafeEqual(supplied, expected)) {
        sendJson(403, { ok: false, mensaje: 'No autorizado.' }); return;
      }
      const body = await readBody();
      const code = await authApi.createMigrationCode(body.usuario);
      sendJson(201, { ok: true, usuario: String(body.usuario).trim(), migrationCode: code, expiresInDays: 7 });
      return;
    }
    if (url.pathname === '/api/auth/register' && req.method === 'POST') {
      if (!requireApi()) return;
      if (!checkRateLimit()) { sendJson(429, { ok: false, mensaje: 'Demasiados intentos. Inténtalo más tarde.' }); return; }
      const body = await readBody();
      const user = await authApi.createUser(body);
      sendJson(201, {
        ok: true,
        token: authApi.issueToken(user),
        usuario: user.usuario,
        nombrePersonaje: user.nombrePersonaje
      });
      return;
    }
    if (url.pathname === '/api/auth/migrate-local' && req.method === 'POST') {
      if (!requireApi()) return;
      if (!checkRateLimit()) { sendJson(429, { ok: false, mensaje: 'Demasiados intentos. Inténtalo más tarde.' }); return; }
      const body = await readBody();
      const result = await authApi.migrateLocalAccount(body);
      sendJson(200, Object.assign({ ok: true, migrated: true }, result));
      return;
    }
    if ((url.pathname === '/api/auth/login' || url.pathname === '/api/auth/link') && req.method === 'POST') {
      if (!requireApi()) return;
      if (!checkRateLimit()) { sendJson(429, { ok: false, mensaje: 'Demasiados intentos. Inténtalo más tarde.' }); return; }
      const body = await readBody();
      // Las cuentas locales antiguas requieren un código de migración de un solo uso,
      // emitido por el administrador. El servidor no confía en una validación hecha
      // únicamente por el cliente porque las cuentas antiguas solo existían localmente.
      const result = url.pathname === '/api/auth/link'
        ? await authApi.linkLegacyAccount(body)
        : await authApi.authenticate(body, false);
      sendJson(200, Object.assign({ ok: true }, result));
      return;
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Sesión online inválida o vencida.' }); return; }
      sendJson(200, { ok: true, usuario: user.usuario, nombrePersonaje: user.nombrePersonaje });
      return;
    }
    if (url.pathname === '/api/ranking/ai-match/cancel' && req.method === 'POST') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Debes iniciar sesión para cancelar esta autorización.' }); return; }
      const body = await readBody();
      const ticket = ticketsPartidaIA.get(String(body.matchId || ''));
      if (ticket && ticket.userId === user.id && !ticket.used) ticketsPartidaIA.delete(String(body.matchId));
      sendJson(200, { ok: true });
      return;
    }

    if (url.pathname === '/api/ranking/ai-match/result' && req.method === 'POST') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Debes iniciar sesión para registrar el resultado.' }); return; }
      const body = await readBody();
      const matchId = String(body.matchId || '');
      if (typeof body.ganaste !== 'boolean') { sendJson(400, { ok: false, mensaje: 'El resultado de la partida es inválido.' }); return; }
      const ticket = ticketsPartidaIA.get(matchId);
      if (!ticket || ticket.userId !== user.id || ticket.expiresAt < Date.now()) {
        sendJson(401, { ok: false, mensaje: 'La autorización de esta partida IA no existe, venció o ya fue utilizada.' }); return;
      }
      const resultado = await authApi.registrarResultadoIA(matchId, user.id, body.ganaste);
      ticket.used = true;
      sendJson(200, { ok: true, puntosDelta: resultado.puntosDelta, puntosActuales: resultado.puntosActuales });
      return;
    }

    if (url.pathname === '/api/player-data' && req.method === 'GET') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Debes iniciar sesión para descargar tus datos.' }); return; }
      const saved = await dataStore.read(`player_${user.id}.json`);
      sendJson(200, { ok: true, exists: !!saved.sha, data: saved.data && saved.data.snapshot ? saved.data.snapshot : {}, updatedAt: saved.data && saved.data.updatedAt || null });
      return;
    }
    if (url.pathname === '/api/player-data' && req.method === 'PUT') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Debes iniciar sesión para guardar tus datos.' }); return; }
      const body = await readBody();
      const snapshot = body && body.snapshot;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) { sendJson(400, { ok: false, mensaje: 'El respaldo de jugador no es válido.' }); return; }
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) { sendJson(413, { ok: false, mensaje: 'El respaldo supera el límite permitido de 2 MB.' }); return; }
      const allowedPrefix = `${user.usuario}_`;
      for (const key of Object.keys(snapshot)) {
        if (!key.startsWith(allowedPrefix) || typeof snapshot[key] !== 'string') { sendJson(400, { ok: false, mensaje: 'El respaldo contiene claves que no pertenecen a esta cuenta.' }); return; }
      }
      const saved = await dataStore.transaction(async () => {
        const file = `player_${user.id}.json`;
        const current = await dataStore.read(file);
        const next = { version: Number(current.data && current.data.version || 0) + 1, updatedAt: new Date().toISOString(), snapshot };
        await dataStore.write(file, next, current.sha);
        return next;
      });
      sendJson(200, { ok: true, version: saved.version, updatedAt: saved.updatedAt });
      return;
    }

    if (url.pathname === '/api/ranking' && req.method === 'GET') {
      if (!requireApi()) return;
      const user = await authApi.getAuthenticatedUser(getBearer());
      if (!user) { sendJson(401, { ok: false, mensaje: 'Debes iniciar sesión para consultar el ranking.' }); return; }
      const ranking = await authApi.getRanking();
      sendJson(200, { ok: true, ranking });
      return;
    }
    sendJson(404, { ok: false, mensaje: 'Ruta API no encontrada.' });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('[API]', error);
    sendJson(status, { ok: false, mensaje: status >= 500 ? 'Error interno al procesar la solicitud.' : error.message });
  }
});

const wss = new WebSocket.Server({ server: servidorHttp });
const salas = new Map();
const conexionesPorUsuario = new Map();
const colasMatchmaking = { normal: [], clasificatoria: [] };
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarCodigoUnico() {
  let codigo;
  do {
    codigo = '';
    for (let i = 0; i < 4; i++) codigo += ALFABETO_CODIGO[Math.floor(Math.random() * ALFABETO_CODIGO.length)];
  } while (salas.has(codigo));
  return codigo;
}
function enviar(ws, mensaje) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(mensaje));
}
function obtenerRival(ws) {
  const sala = salas.get(ws.codigoSala);
  if (!sala) return null;
  if (sala.host === ws) return sala.guest;
  if (sala.guest === ws) return sala.host;
  return null;
}
function quitarDeColas(ws) {
  if (ws.timeoutIA) { clearTimeout(ws.timeoutIA); ws.timeoutIA = null; }
  Object.keys(colasMatchmaking).forEach(modo => {
    const cola = colasMatchmaking[modo];
    const idx = cola.indexOf(ws);
    if (idx !== -1) cola.splice(idx, 1);
  });
  ws.enColaMatchmaking = false;
  ws.modoMatchmaking = null;
}
async function cerrarSalaConResultado(sala, ganadorRol, tipo) {
  if (!sala || sala.resultadoRegistrado || sala.resultadoEnProceso) return;
  sala.resultadoEnProceso = true;
  const esClasificatoria = sala.modoMatchmaking === 'clasificatoria';
  const ganador = ganadorRol === 'host' ? sala.hostUser : sala.guestUser;
  const perdedor = ganadorRol === 'host' ? sala.guestUser : sala.hostUser;
  if (esClasificatoria && (!ganador || !perdedor)) {
    sala.resultadoEnProceso = false;
    throw new Error('La partida clasificatoria no tiene ambas identidades online verificadas.');
  }

  let resultadoPersistido = null;
  if (esClasificatoria) {
    if (!authApi) { sala.resultadoEnProceso = false; throw new Error('La persistencia del ranking no está configurada.'); }
    try {
      resultadoPersistido = await authApi.registrarResultadoClasificatoria(
        sala.matchId, ganador.id, perdedor.id, tipo
      );
    } catch (error) { sala.resultadoEnProceso = false; throw error; }
  }

  sala.resultadoRegistrado = true;
  sala.resultadoEnProceso = false;
  const payloadResultado = {
    type: 'resultado_partida',
    clasificatoria: esClasificatoria,
    resultado: tipo,
    ganaste: true,
    puntosGanados: esClasificatoria ? 20 : 0,
    puntosActuales: esClasificatoria && resultadoPersistido ? resultadoPersistido.resultado.puntosActualesGanador : null
  };
  const payloadDerrota = {
    type: 'resultado_partida',
    clasificatoria: esClasificatoria,
    resultado: tipo,
    ganaste: false,
    puntosPerdidos: esClasificatoria ? -10 : 0,
    puntosActuales: esClasificatoria && resultadoPersistido ? resultadoPersistido.resultado.puntosActualesPerdedor : null
  };
  const ganadorWs = ganadorRol === 'host' ? sala.host : sala.guest;
  const perdedorWs = ganadorRol === 'host' ? sala.guest : sala.host;
  enviar(ganadorWs, payloadResultado);
  enviar(perdedorWs, payloadDerrota);
  if (sala.timeoutLimpieza) clearTimeout(sala.timeoutLimpieza);
  salas.delete(sala.codigo);
}

function manejarDesconexion(ws) {
  const sala = salas.get(ws.codigoSala);
  if (!sala || (sala.host !== ws && sala.guest !== ws)) return;
  const rival = obtenerRival(ws);
  enviar(rival, { type: 'rival_desconectado' });
  if (sala.host === ws) sala.host = null;
  if (sala.guest === ws) sala.guest = null;
  if (sala.timeoutLimpieza) clearTimeout(sala.timeoutLimpieza);
  sala.timeoutLimpieza = setTimeout(() => {
    const salaActual = salas.get(ws.codigoSala);
    if (!salaActual) return;
    const restante = salaActual.host || salaActual.guest;
    const rolPerdedor = ws.rol === 'host' ? 'host' : 'guest';
    const rolGanador = rolPerdedor === 'host' ? 'guest' : 'host';
    if (salaActual.modoMatchmaking === 'clasificatoria' && !salaActual.resultadoRegistrado) {
      cerrarSalaConResultado(salaActual, rolGanador, 'desconexion').catch(error => {
        console.error('[Ranking] No se pudo registrar la desconexión:', error);
        enviar(restante, { type: 'error', mensaje: 'No se pudo guardar el resultado de clasificatoria. No cierres esta pantalla e inténtalo de nuevo.' });
      });
    } else {
      if (restante) enviar(restante, { type: 'rival_desconectado_definitivo' });
      salas.delete(ws.codigoSala);
    }
  }, GRACIA_RECONEXION_MS);
}

wss.on('connection', ws => {
  ws.codigoSala = null;
  ws.rol = null;
  ws.enColaMatchmaking = false;
  ws.modoMatchmaking = null;
  ws.usuarioOnline = null;
  ws.timeoutIA = null;
  ws.inicioCola = 0;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (_) { enviar(ws, { type: 'error', mensaje: 'Mensaje mal formado (no es JSON válido).' }); return; }
    switch (msg.type) {
      case 'autenticar': {
        if (!authApi) { enviar(ws, { type: 'error', mensaje: 'La autenticación online no está configurada.' }); return; }
        if (ws.codigoSala || ws.enColaMatchmaking) { enviar(ws, { type: 'error', mensaje: 'No puedes cambiar de cuenta durante una partida o búsqueda.' }); return; }
        authApi.getAuthenticatedUser(String(msg.token || '')).then(user => {
          if (!user) { enviar(ws, { type: 'error', mensaje: 'La sesión online no es válida. Inicia sesión nuevamente.' }); return; }
          const anterior = conexionesPorUsuario.get(user.id);
          if (anterior && anterior !== ws && anterior.readyState === WebSocket.OPEN) {
            enviar(ws, { type: 'error', mensaje: 'Esta cuenta ya tiene una conexión online activa.' });
            return;
          }
          ws.usuarioOnline = { id: user.id, usuario: user.usuario, nombrePersonaje: user.nombrePersonaje };
          conexionesPorUsuario.set(user.id, ws);
          enviar(ws, { type: 'sesion_online', usuario: user.usuario, nombrePersonaje: user.nombrePersonaje });
        }).catch(error => {
          console.error('[WS auth]', error);
          enviar(ws, { type: 'error', mensaje: 'No se pudo verificar la sesión online.' });
        });
        break;
      }
      case 'crear_sala': {
        if (ws.codigoSala) { enviar(ws, { type: 'error', mensaje: 'Ya estás dentro de una sala.' }); return; }
        const codigo = generarCodigoUnico();
        salas.set(codigo, { codigo, host: ws, guest: null, hostUser: ws.usuarioOnline, guestUser: null, timeoutLimpieza: null, modoMatchmaking: null, matchId: require('crypto').randomUUID(), resultadoRegistrado: false, resultadoEnProceso: false });
        ws.codigoSala = codigo;
        ws.rol = 'host';
        enviar(ws, { type: 'sala_creada', codigo });
        break;
      }
      case 'unirse_sala': {
        const codigo = (msg.codigo || '').toUpperCase().trim();
        const sala = salas.get(codigo);
        if (!sala) { enviar(ws, { type: 'error', mensaje: 'No existe una sala con ese código.' }); return; }
        if (sala.guest) { enviar(ws, { type: 'error', mensaje: 'Esa sala ya tiene dos jugadores.' }); return; }
        if (ws.codigoSala) { enviar(ws, { type: 'error', mensaje: 'Ya estás dentro de una sala.' }); return; }
        sala.guest = ws;
        sala.guestUser = ws.usuarioOnline;
        ws.codigoSala = codigo;
        ws.rol = 'guest';
        enviar(ws, { type: 'unido', codigo });
        enviar(sala.host, { type: 'rival_conectado', codigo, rol: 'host' });
        enviar(sala.guest, { type: 'rival_conectado', codigo, rol: 'guest' });
        break;
      }
      case 'buscar_rival': {
        if (ws.enColaMatchmaking || ws.codigoSala) break;
        const modo = msg.modo === 'clasificatoria' ? 'clasificatoria' : 'normal';
        if (modo === 'clasificatoria' && !ws.usuarioOnline) {
          enviar(ws, { type: 'error', mensaje: 'Debes iniciar sesión online para jugar Clasificatoria.' });
          return;
        }
        const cola = colasMatchmaking[modo];
        let rival = null;
        while (cola.length > 0) {
          const candidato = cola.shift();
          if (candidato && candidato.readyState === WebSocket.OPEN && candidato.enColaMatchmaking) {
            rival = candidato;
            break;
          }
        }
        if (rival) {
          if (rival.timeoutIA) { clearTimeout(rival.timeoutIA); rival.timeoutIA = null; }
          rival.enColaMatchmaking = false;
          rival.modoMatchmaking = null;
          const codigo = generarCodigoUnico();
          salas.set(codigo, { codigo, host: rival, guest: ws, hostUser: rival.usuarioOnline, guestUser: ws.usuarioOnline, timeoutLimpieza: null, modoMatchmaking: modo, matchId: require('crypto').randomUUID(), resultadoRegistrado: false, resultadoEnProceso: false });
          rival.codigoSala = codigo;
          rival.rol = 'host';
          ws.codigoSala = codigo;
          ws.rol = 'guest';
          enviar(rival, { type: 'rival_conectado', codigo, rol: 'host', modo });
          enviar(ws, { type: 'rival_conectado', codigo, rol: 'guest', modo });
        } else {
          ws.enColaMatchmaking = true;
          ws.modoMatchmaking = modo;
          ws.inicioCola = Date.now();
          cola.push(ws);
          enviar(ws, { type: 'buscando_rival', modo });
          if (modo === 'clasificatoria') {
            ws.timeoutIA = setTimeout(() => {
              if (!ws.enColaMatchmaking || ws.modoMatchmaking !== 'clasificatoria' || ws.readyState !== WebSocket.OPEN) return;
              quitarDeColas(ws);
              const yaTieneTicket = Array.from(ticketsPartidaIA.values()).some(t => t.userId === (ws.usuarioOnline && ws.usuarioOnline.id) && !t.used && t.expiresAt > Date.now());
              if (yaTieneTicket) { enviar(ws, { type: 'error', mensaje: 'Ya tienes una partida clasificatoria contra IA pendiente de resultado.' }); return; }
              const matchId = require('crypto').randomUUID();
              ticketsPartidaIA.set(matchId, { userId: ws.usuarioOnline.id, expiresAt: Date.now() + GRACIA_TICKET_IA_MS, used: false });
              enviar(ws, { type: 'ai_match_ticket', matchId, modo: 'clasificatoria' });
            }, 30000);
          }
        }
        break;
      }
      case 'cancelar_busqueda':
        quitarDeColas(ws);
        break;
      case 'reconectar': {
        const codigo = (msg.codigo || '').toUpperCase().trim();
        const sala = salas.get(codigo);
        if (!sala) { enviar(ws, { type: 'error', mensaje: 'La sala ya no existe (pasó demasiado tiempo sin reconectar).' }); return; }
        const rol = msg.rol === 'host' ? 'host' : 'guest';
        if (sala[rol]) { enviar(ws, { type: 'error', mensaje: 'Ese lugar ya está ocupado.' }); return; }
        sala[rol] = ws;
        ws.codigoSala = codigo;
        ws.rol = rol;
        const salaCompleta = sala.host && sala.guest;
        if (salaCompleta && sala.timeoutLimpieza) {
          clearTimeout(sala.timeoutLimpieza);
          sala.timeoutLimpieza = null;
        }
        enviar(ws, { type: 'reconectado', codigo, rol, modo: sala.modoMatchmaking || undefined });
        enviar(obtenerRival(ws), { type: 'rival_reconectado' });
        break;
      }
      case 'rendirse': {
        const sala = salas.get(ws.codigoSala);
        if (!sala || !sala.host || !sala.guest) { enviar(ws, { type: 'error', mensaje: 'No hay una partida activa para rendirse.' }); return; }
        const ganadorRol = ws.rol === 'host' ? 'guest' : 'host';
        cerrarSalaConResultado(sala, ganadorRol, 'rendicion').catch(error => {
          console.error('[Ranking] No se pudo registrar la rendición:', error);
          enviar(ws, { type: 'error', mensaje: 'No se pudo registrar el resultado. Inténtalo nuevamente.' });
        });
        break;
      }
      case 'mensaje': {
        const sala = salas.get(ws.codigoSala);
        const rival = obtenerRival(ws);
        const payload = msg.payload;
        // El HOST es la autoridad actual del motor de batalla. Cuando anuncia
        // un estado terminal, el relay registra el resultado clasificatorio.
        if (sala && sala.modoMatchmaking === 'clasificatoria' && ws.rol === 'host' &&
            payload && payload.tipo === 'estado_actualizado' && payload.estado && payload.estado.terminada &&
            !sala.resultadoRegistrado) {
          const ganadorRol = payload.estado.ganador === 'JUGADOR' ? 'host' :
            payload.estado.ganador === 'MAQUINA' ? 'guest' : null;
          if (ganadorRol) {
            cerrarSalaConResultado(sala, ganadorRol, 'normal').catch(error => {
              console.error('[Ranking] No se pudo registrar el resultado:', error);
              enviar(ws, { type: 'error', mensaje: 'No se pudo guardar el resultado de clasificatoria.' });
            });
          }
        }
        if (rival) enviar(rival, { type: 'mensaje', payload });
        break;
      }
      default:
        enviar(ws, { type: 'error', mensaje: `Tipo de mensaje desconocido: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    if (ws.usuarioOnline && conexionesPorUsuario.get(ws.usuarioOnline.id) === ws) {
      conexionesPorUsuario.delete(ws.usuarioOnline.id);
    }
    quitarDeColas(ws);
    if (ws.codigoSala) manejarDesconexion(ws);
  });
});

servidorHttp.listen(PUERTO, '0.0.0.0', () => {
  console.log(`[Relay] Escuchando en el puerto ${PUERTO}.`);
  console.log('[Relay] LAN: ws://<IP-de-esta-PC>:' + PUERTO);
  console.log('[Relay] Internet: wss://<tu-dominio>, sin puerto.');
  console.log(`[Relay] Ventana de gracia para reconexión: ${GRACIA_RECONEXION_MS / 1000}s.`);
  console.log(`[API] Autenticación online: ${authApi ? 'configurada' : 'pendiente de variables de entorno'}.`);
});
