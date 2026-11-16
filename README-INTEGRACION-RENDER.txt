INTEGRACION DE CUENTAS ONLINE Y RANKING — DIGI-GACHA RELAY

1. Mantén este servidor en el repositorio digi-gacha-relay. No copies estos
   archivos dentro de src/app del proyecto Ionic.

2. En digi-gacha-data (repositorio PRIVADO), crea una carpeta llamada data.
   Dentro crea estos tres archivos TXT con el contenido inicial indicado:

   data/users.txt
   []

   data/ranking.txt
   []

   data/historial_clasificatoria.txt
   []

   data/migration_codes.txt
   []

3. En Render, abre tu servicio del relay y entra en Environment. Añade:

   GITHUB_OWNER = dfvideogamesrb-collab
   GITHUB_REPO = digi-gacha-data
   GITHUB_BRANCH = main
   GITHUB_DATA_DIR = data
   GITHUB_TOKEN = (token fine-grained de GitHub)
   AUTH_TOKEN_SECRET = (cadena aleatoria de al menos 32 caracteres)
   MIGRATION_ADMIN_KEY = (otro secreto aleatorio, distinto de los anteriores)

   El token fine-grained debe tener acceso SOLO al repositorio privado
   digi-gacha-data y permiso Contents: Read and write. No lo pongas en Ionic,
   no lo subas a GitHub y no lo compartas por el chat.

   AUTH_TOKEN_SECRET debe ser un secreto independiente del token de GitHub.
   Puedes generar uno localmente con Node:
     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

4. En package.json conserva ws y usa Node 18 o superior (se usa fetch nativo).
   En Render configura Node 18+ si el servicio aún usa una versión anterior.

5. Después del deploy, abre:
   https://TU-SERVICIO.onrender.com/api/health
   Debe responder JSON con "auth": true y "storage": true.

ENDPOINTS DISPONIBLES

POST /api/auth/register
  JSON: { "usuario": "tamer01", "nombrePersonaje": "Tamer", "password": "..." }
  Crea la identidad online y un registro de ranking con 0 puntos, Madera 5.

POST /api/auth/login
  JSON: { "usuario": "tamer01", "password": "..." }
  Verifica la contraseña guardada con hash scrypt y entrega un token.

POST /api/auth/link
  JSON: { "usuario": "tamer01", "nombrePersonaje": "Tamer",
          "password": "...", "migrationCode": "..." }
  Migra una cuenta antigua con un código de un solo uso emitido por el admin.

POST /api/admin/migration-code
  Cabecera: X-Migration-Admin-Key: <MIGRATION_ADMIN_KEY>
  JSON: { "usuario": "tamer01" }
  Devuelve un código de migración válido por 7 días. Entrégalo al propietario
  de esa cuenta por un canal privado. No lo publiques.

GET /api/me
GET /api/ranking
  Ambos requieren cabecera Authorization: Bearer <token>.

WebSocket: después de conectar, la app envía { type: 'autenticar', token }.
El relay responde sesion_online. La cola clasificatoria rechaza conexiones
sin identidad online validada. PvP normal y salas privadas conservan el
comportamiento anterior.

SEGURIDAD / ALCANCE DE ESTA ENTREGA
- Las contraseñas online se guardan con salt aleatorio y scrypt, nunca en claro.
- El token de sesión se firma en el servidor y vence en 30 días.
- Los endpoints de autenticación tienen límite básico de intentos por IP.
- El ranking se lee desde el repositorio privado; nadie puede consultarlo sin
  una sesión online válida.
- Esta versión todavía NO registra victorias/derrotas ni modifica puntos:
  faltan por aprobar las reglas de puntuación y conectar el evento de fin de
  combate del cliente.
- Las cuentas antiguas solo existían en el dispositivo; el servidor no tiene
  una copia confiable de sus contraseñas. Por eso NO se permite reclamarlas
  solo indicando usuario/contraseña desde el cliente. Cada cuenta antigua
  necesita un código de migración de un solo uso emitido por el administrador.
- Las cuentas nuevas se registran directamente con /api/auth/register.
- Esta entrega prepara la API; los componentes Ionic de registro/ingreso aún
  deben conectarse a ella y guardar el token de sesión.