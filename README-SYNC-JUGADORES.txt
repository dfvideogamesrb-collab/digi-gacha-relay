SINCRONIZACION DE PROGRESO POR JUGADOR

El relay agrega GET y PUT /api/player-data, autenticados con el mismo Bearer token de /api/auth/login.
Cada jugador se guarda en un archivo independiente dentro del repositorio privado: data/player_<UUID>.json.
No se necesitan nuevas variables de entorno: se reutilizan GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, GITHUB_DATA_DIR, GITHUB_TOKEN y AUTH_TOKEN_SECRET.
El cuerpo de guardado contiene únicamente claves de localStorage que comienzan con el nombre de usuario autenticado seguido de "_". El servidor valida ese prefijo y limita el respaldo a 2 MB.

Despliegue: reemplazar server.js, auth-api.js y github-data-store.js en digi-gacha-relay. README-SYNC-JUGADORES.txt es documentación.
