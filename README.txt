CORRECCIÓN DE SINCRONIZACIÓN COMPLETA DEL PROGRESO

Este parche complementa los parches anteriores de autenticación.
No reemplaza package.json ni archivos Android.

1) En digi-gacha-relay, reemplazar server.js por relay/server.js y desplegar Render.
   Añade GET/PUT /api/player-data, CORS para PUT y límite de 2 MB.
2) En digi-gacha, copiar los archivos dentro de ionic/ respetando las rutas.
   PlayerCloudSyncService se incorpora al inicio de sesión antes de abrir el lobby.
3) El primer inicio de sesión en el dispositivo que conserva el progreso local
   sube todas las claves usuario_* a data/player_<UUID>.json. En otro dispositivo
   descarga ese respaldo y restaura las claves. Si el respaldo remoto está parcial,
   combina las claves faltantes locales y remotas en vez de borrar datos.

El respaldo incluye todos los datos persistidos en localStorage cuyas claves
comienzan con el usuario_: mochila, equipos, Bits, items, Plugins, torre, dungeon,
historia, tutorial, recompensas y cualquier otro dato por cuenta con ese prefijo.
No incluye preferencias globales de audio ni usuarios_terminal.txt.
