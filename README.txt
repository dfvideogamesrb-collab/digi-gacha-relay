CORRECCION: MIGRACION AUTOMATICA DE CUENTAS LOCALES

Archivos incluidos (solo modificados):
- server.js
- auth-api.js

Esta correccion se basa en el relay completo con matchmaking PvP/Clasificatoria,
ranking y endpoints /api/player-data. Conserva esa implementacion y agrega:
- POST /api/auth/migrate-local
- AuthApi.migrateLocalAccount()
- CORS PUT para el guardado de progreso en /api/player-data

Reemplaza estos dos archivos en el repositorio digi-gacha-relay y despliega Render.
No reemplaces el server.js por el ZIP reducido de migracion de cuentas: este ZIP
conserva la version completa del relay y sus rutas de clasificatoria.
