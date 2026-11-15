// Relay PvP compatible con LAN y hosting Node (Render/Railway/VPS).
// Mantiene salas privadas por código y separa las colas de matchmaking
// de PvP normal y Clasificatoria. No ejecuta ni valida lógica de batalla.
const http = require('http');
const WebSocket = require('ws');

const PUERTO = process.env.PORT || process.env.PUERTO || 8765;
const GRACIA_RECONEXION_MS = 45000;
const servidorHttp = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Relay de PvP activo. Conectate por WebSocket (wss://), no por HTTP.');
});
const wss = new WebSocket.Server({ server: servidorHttp });
const salas = new Map();
// Cada modalidad tiene su propia cola FIFO. Así no se cruzan los modos.
const colasMatchmaking = {
  normal: [],
  clasificatoria: []
};
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
  Object.keys(colasMatchmaking).forEach(modo => {
    const cola = colasMatchmaking[modo];
    const idx = cola.indexOf(ws);
    if (idx !== -1) cola.splice(idx, 1);
  });
  ws.enColaMatchmaking = false;
  ws.modoMatchmaking = null;
}
function manejarDesconexion(ws) {
  const sala = salas.get(ws.codigoSala);
  if (!sala) return;
  const rival = obtenerRival(ws);
  enviar(rival, { type: 'rival_desconectado' });
  if (sala.host === ws) sala.host = null;
  if (sala.guest === ws) sala.guest = null;
  if (sala.timeoutLimpieza) clearTimeout(sala.timeoutLimpieza);
  sala.timeoutLimpieza = setTimeout(() => {
    const salaActual = salas.get(ws.codigoSala);
    if (!salaActual) return;
    const restante = salaActual.host || salaActual.guest;
    if (restante) enviar(restante, { type: 'rival_desconectado_definitivo' });
    salas.delete(ws.codigoSala);
  }, GRACIA_RECONEXION_MS);
}

wss.on('connection', ws => {
  ws.codigoSala = null;
  ws.rol = null;
  ws.enColaMatchmaking = false;
  ws.modoMatchmaking = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (err) { enviar(ws, { type: 'error', mensaje: 'Mensaje mal formado (no es JSON válido).' }); return; }

    switch (msg.type) {
      case 'crear_sala': {
        if (ws.codigoSala) { enviar(ws, { type: 'error', mensaje: 'Ya estás dentro de una sala.' }); return; }
        const codigo = generarCodigoUnico();
        salas.set(codigo, { host: ws, guest: null, timeoutLimpieza: null, modoMatchmaking: null });
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
        ws.codigoSala = codigo;
        ws.rol = 'guest';
        enviar(ws, { type: 'unido', codigo });
        enviar(sala.host, { type: 'rival_conectado', codigo, rol: 'host' });
        enviar(sala.guest, { type: 'rival_conectado', codigo, rol: 'guest' });
        break;
      }

      case 'buscar_rival': {
        if (ws.enColaMatchmaking || ws.codigoSala) break;
        // Clientes antiguos que no envían `modo` siguen entrando a PvP normal.
        const modo = msg.modo === 'clasificatoria' ? 'clasificatoria' : 'normal';
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
          rival.enColaMatchmaking = false;
          rival.modoMatchmaking = null;
          const codigo = generarCodigoUnico();
          salas.set(codigo, { host: rival, guest: ws, timeoutLimpieza: null, modoMatchmaking: modo });
          rival.codigoSala = codigo;
          rival.rol = 'host';
          ws.codigoSala = codigo;
          ws.rol = 'guest';
          enviar(rival, { type: 'rival_conectado', codigo, rol: 'host', modo });
          enviar(ws, { type: 'rival_conectado', codigo, rol: 'guest', modo });
        } else {
          ws.enColaMatchmaking = true;
          ws.modoMatchmaking = modo;
          cola.push(ws);
          enviar(ws, { type: 'buscando_rival', modo });
        }
        break;
      }

      case 'cancelar_busqueda': {
        quitarDeColas(ws);
        break;
      }

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

      case 'mensaje': {
        const rival = obtenerRival(ws);
        if (rival) enviar(rival, { type: 'mensaje', payload: msg.payload });
        break;
      }

      default:
        enviar(ws, { type: 'error', mensaje: `Tipo de mensaje desconocido: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    quitarDeColas(ws);
    if (ws.codigoSala) manejarDesconexion(ws);
  });
});

servidorHttp.listen(PUERTO, '0.0.0.0', () => {
  console.log(`[Relay] Escuchando en el puerto ${PUERTO}.`);
  console.log('[Relay] LAN: ws://<IP-de-esta-PC>:' + PUERTO);
  console.log('[Relay] Internet: wss://<tu-dominio>, sin puerto.');
  console.log(`[Relay] Ventana de gracia para reconexión: ${GRACIA_RECONEXION_MS / 1000}s.`);
});
