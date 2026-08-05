# PvP LAN — Servidor de relay

Servidor chiquito que **no** sabe nada de Digimon ni de batallas: solo junta a
dos dispositivos en una "sala" (código de 4 caracteres) y reenvía los mensajes
que se mandan entre sí. Toda la lógica del juego vive en la app.

## Cómo correrlo

1. Necesitás [Node.js](https://nodejs.org/) instalado en UNA PC conectada a la
   misma red wifi que van a usar los dos jugadores.
2. En esa PC:
   ```
   cd lan-relay-server
   npm install
   node server.js
   ```
   Deberías ver: `[LAN Relay] Escuchando en el puerto 8765.`

3. Anotá la IP local de esa PC:
   - Windows: `ipconfig` → buscá "Dirección IPv4" (algo como `192.168.1.34`)
   - Mac/Linux: `ifconfig` o `ip addr` → buscá `inet 192.168.x.x`

4. En la app (los dos dispositivos, ya sea en el navegador o la app
   instalada), en la pantalla de PvP LAN, escribí esa IP y el puerto `8765`
   para conectarte al relay.

5. Un jugador toca **"Crear sala"** → le va a aparecer un código (ej. `AB12`).
   Se lo dice al otro jugador, que toca **"Unirse a sala"** y lo escribe.

## Notas

- Esto **no** funciona si los dispositivos están en redes wifi distintas
  (por diseño: es específicamente para jugar en la misma red local).
- Si cerrás la terminal donde corre `node server.js`, se cortan todas las
  partidas en curso — tiene que quedar corriendo mientras juegan.
- El puerto se puede cambiar con la variable de entorno `PUERTO` (ej.
  `PUERTO=9000 node server.js`).
