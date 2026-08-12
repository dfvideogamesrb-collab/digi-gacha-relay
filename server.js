// ============================================================================
// Servidor de relay para PvP — sirve tanto para red local (LAN) como para
// internet "de verdad": es el MISMO código en los dos casos. La única
// diferencia es dónde lo corrés:
//   - LAN: en una PC de la wifi de los jugadores (ver README.md).
//   - Internet: subido a un hosting con Node (Render, Railway, un VPS, etc.).
//     Ahí los jugadores no necesitan estar en la misma red ni saber la IP
//     de nadie — la app apunta directo a la URL pública del servidor.
//
// Qué hace: NADA de lógica de batalla. Es un "cartero": agrupa a dos
// dispositivos en una "sala" (por código manual o por matchmaking
// automático) y reenvía los mensajes entre sí. La lógica real de la batalla
// vive en la app (battle-engine.service.ts), no acá.
//
// Reconexión: si a alguien se le corta el WebSocket (wifi que titila, la app
// pasa a segundo plano, etc.), la sala NO se borra de una — queda
// "reservada" GRACIA_RECONEXION_MS por si ese jugador vuelve a conectar con
// el mismo código y rol (ver mensaje 'reconectar'). Si nadie reclama ese
// lugar a tiempo, ahí sí se borra la sala y se avisa al que quedó.
//
// Cómo correrlo:
//   1. cd lan-relay-server
//   2. npm install
//   3. node server.js
//   4a. Para LAN: anotá la IP local de esta PC (ipconfig / ifconfig) y
//       escribila en la app junto con el puerto (8765 por defecto).
//   4b. Para internet: desplegá esta carpeta en un hosting con soporte de
//       Node + WebSockets (Render, Railway, Fly.io, un VPS propio, etc.) y
//       usá la URL pública que te den en vez de una IP local.
// ============================================================================

const http = require('http');
const WebSocket = require('ws');

// Plataformas como Render/Railway asignan el puerto ellas mismas vía la
// variable de entorno estándar PORT — hay que respetarla si está presente.
// PUERTO queda como alternativa para cuando lo corrés vos a mano en LAN.
const PUERTO = process.env.PORT || process.env.PUERTO || 8765;

// Cuánto tiempo se reserva el lugar de un jugador desconectado antes de
// darlo por perdido y borrar la sala.
const GRACIA_RECONEXION_MS = 45000;

// Servidor HTTP "de cortesía": el WebSocket real se cuelga de este mismo
// servidor. Sin esto, un pedido HTTP normal (el health check de Render, o
// alguien abriendo la URL en el navegador) se queda colgado sin respuesta,
// y Render puede terminar marcando el servicio como caído y reiniciándolo.
const servidorHttp = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Relay de PvP activo. Conectate por WebSocket (wss://), no por HTTP.');
});

const wss = new WebSocket.Server({ server: servidorHttp });

// codigoSala (string) -> { host: WebSocket|null, guest: WebSocket|null, timeoutLimpieza: Timeout|null }
const salas = new Map();

// Jugadores esperando matchmaking automático (cola FIFO simple: el primero
// que llega, el primero que se empareja). Sin ranking ni nivel de poder por
// ahora — eso es la extensión natural del día que haya cuentas/persistencia.
const colaMatchmaking = [];

// Caracteres sin ambigüedad visual (sin 0/O, sin 1/I) para que el código sea
// fácil de leer en voz alta o escribir a mano.
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generarCodigoUnico() {
  let codigo;
  do {
    codigo = '';
    for (let i = 0; i < 4; i++) {
      codigo += ALFABETO_CODIGO[Math.floor(Math.random() * ALFABETO_CODIGO.length)];
    }
  } while (salas.has(codigo));
  return codigo;
}

function enviar(ws, mensaje) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(mensaje));
  }
}

/** Devuelve el WebSocket del RIVAL de `ws` dentro de su sala (o null). */
function obtenerRival(ws) {
  const sala = salas.get(ws.codigoSala);
  if (!sala) return null;
  if (sala.host === ws) return sala.guest;
  if (sala.guest === ws) return sala.host;
  return null;
}

/**
 * Se llama cuando un socket se cierra (por el motivo que sea). En vez de
 * borrar la sala de una, deja ese lugar vacío y arranca un cronómetro de
 * gracia — si el jugador vuelve a conectar con 'reconectar' antes de que
 * se cumpla, retoma justo donde estaba. Si no, recién ahí se borra todo.
 */
function manejarDesconexion(ws) {
  const sala = salas.get(ws.codigoSala);
  if (!sala) return;

  const rival = obtenerRival(ws);
  enviar(rival, { type: 'rival_desconectado' });

  if (sala.host === ws) sala.host = null;
  if (sala.guest === ws) sala.guest = null;

  // Si ya había un cronómetro corriendo (por ejemplo, el otro jugador
  // también se había caído antes), lo reiniciamos — total, mientras haya
  // UN solo cronómetro activo por sala alcanza.
  if (sala.timeoutLimpieza) clearTimeout(sala.timeoutLimpieza);

  sala.timeoutLimpieza = setTimeout(() => {
    const salaActual = salas.get(ws.codigoSala);
    if (!salaActual) return;

    const restante = salaActual.host || salaActual.guest;
    if (restante) {
      // Alguien se quedó esperando y el otro nunca volvió — le avisamos
      // que ya no tiene sentido seguir esperando.
      enviar(restante, { type: 'rival_desconectado_definitivo' });
    }
    salas.delete(ws.codigoSala);
  }, GRACIA_RECONEXION_MS);
}

wss.on('connection', (ws) => {
  ws.codigoSala = null;
  ws.rol = null; // 'host' | 'guest'
  ws.enColaMatchmaking = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      enviar(ws, { type: 'error', mensaje: 'Mensaje mal formado (no es JSON válido).' });
      return;
    }

    switch (msg.type) {

      case 'crear_sala': {
        const codigo = generarCodigoUnico();
        salas.set(codigo, { host: ws, guest: null, timeoutLimpieza: null });
        ws.codigoSala = codigo;
        ws.rol = 'host';
        enviar(ws, { type: 'sala_creada', codigo });
        break;
      }

      case 'unirse_sala': {
        const codigo = (msg.codigo || '').toUpperCase().trim();
        const sala = salas.get(codigo);

        if (!sala) {
          enviar(ws, { type: 'error', mensaje: 'No existe una sala con ese código.' });
          return;
        }
        if (sala.guest) {
          enviar(ws, { type: 'error', mensaje: 'Esa sala ya tiene dos jugadores.' });
          return;
        }

        sala.guest = ws;
        ws.codigoSala = codigo;
        ws.rol = 'guest';

        enviar(ws, { type: 'unido', codigo });
        // Avisamos a AMBOS lados que el rival ya está — simplifica el cliente,
        // que solo tiene que escuchar 'rival_conectado' sin importar su rol.
        // Incluimos `rol` para que el cliente no tenga que adivinarlo (hace
        // falta sobre todo para el matchmaking automático, ver más abajo).
        enviar(sala.host, { type: 'rival_conectado', codigo, rol: 'host' });
        enviar(sala.guest, { type: 'rival_conectado', codigo, rol: 'guest' });
        break;
      }

      case 'buscar_rival': {
        // Matchmaking automático: cola FIFO simple, sin ranking. El primero
        // que ya estaba esperando queda de "host" (autoridad de la batalla),
        // el que llega y lo empareja queda de "guest" — es una asignación
        // arbitraria, no implica ninguna ventaja de juego.
        if (ws.enColaMatchmaking || ws.codigoSala) break; // ya está buscando o ya está en una sala

        // Puede haber sockets viejos en la cola que ya se desconectaron sin
        // avisar a tiempo; los descartamos hasta encontrar uno vivo.
        let rival = null;
        while (colaMatchmaking.length > 0) {
          const candidato = colaMatchmaking.shift();
          if (candidato.readyState === WebSocket.OPEN) {
            rival = candidato;
            break;
          }
        }

        if (rival) {
          const codigo = generarCodigoUnico();
          salas.set(codigo, { host: rival, guest: ws, timeoutLimpieza: null });
          rival.codigoSala = codigo;
          rival.rol = 'host';
          rival.enColaMatchmaking = false;
          ws.codigoSala = codigo;
          ws.rol = 'guest';

          enviar(rival, { type: 'rival_conectado', codigo, rol: 'host' });
          enviar(ws, { type: 'rival_conectado', codigo, rol: 'guest' });
        } else {
          ws.enColaMatchmaking = true;
          colaMatchmaking.push(ws);
          enviar(ws, { type: 'buscando_rival' });
        }
        break;
      }

      case 'cancelar_busqueda': {
        ws.enColaMatchmaking = false;
        const idx = colaMatchmaking.indexOf(ws);
        if (idx !== -1) colaMatchmaking.splice(idx, 1);
        break;
      }

      case 'reconectar': {
        const codigo = (msg.codigo || '').toUpperCase().trim();
        const sala = salas.get(codigo);

        if (!sala) {
          enviar(ws, { type: 'error', mensaje: 'La sala ya no existe (pasó demasiado tiempo sin reconectar).' });
          return;
        }

        const rol = msg.rol === 'host' ? 'host' : 'guest';
        if (sala[rol]) {
          enviar(ws, { type: 'error', mensaje: 'Ese lugar ya está ocupado.' });
          return;
        }

        sala[rol] = ws;
        ws.codigoSala = codigo;
        ws.rol = rol;

        // Si el otro lugar también estaba vacío (los dos se cayeron a la
        // vez), dejamos el cronómetro corriendo por si el otro también
        // vuelve. Si ya está el rival, cancelamos el cronómetro: la sala
        // está completa de nuevo.
        const salaCompleta = sala.host && sala.guest;
        if (salaCompleta && sala.timeoutLimpieza) {
          clearTimeout(sala.timeoutLimpieza);
          sala.timeoutLimpieza = null;
        }

        enviar(ws, { type: 'reconectado', codigo, rol });
        const rival = obtenerRival(ws);
        enviar(rival, { type: 'rival_reconectado' });
        break;
      }

      case 'mensaje': {
        const rival = obtenerRival(ws);
        if (rival) {
          enviar(rival, { type: 'mensaje', payload: msg.payload });
        }
        break;
      }

      default:
        enviar(ws, { type: 'error', mensaje: `Tipo de mensaje desconocido: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    ws.enColaMatchmaking = false;
    const idx = colaMatchmaking.indexOf(ws);
    if (idx !== -1) colaMatchmaking.splice(idx, 1);

    if (ws.codigoSala) {
      manejarDesconexion(ws);
    }
  });
});

servidorHttp.listen(PUERTO, '0.0.0.0', () => {
  console.log(`[Relay] Escuchando en el puerto ${PUERTO}.`);
  console.log('[Relay] LAN: los dispositivos se conectan a ws://<IP-de-esta-PC>:' + PUERTO);
  console.log('[Relay] Internet: los dispositivos se conectan a wss://<tu-dominio>, sin puerto.');
  console.log(`[Relay] Ventana de gracia para reconexión: ${GRACIA_RECONEXION_MS / 1000}s.`);
});
