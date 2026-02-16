# mordecai-workers

Workers + scheduler for Mordecai. Este repo tiene los **consumidores de colas** (BullMQ) y el scheduler. La API (mordecai-api) encola jobs; el worker los procesa. Modelos, config y logger se importan del repo de la API (una sola fuente de verdad).

## Cómo funciona

1. **API (mordecai-api)**  
   Cuando el usuario hace "Sync" en Connectors, la API llama a `addPmsSyncJob(connectionId, tenantId)` y pone un job en la cola **`pms-sync`** de Redis.

2. **Worker (este repo)**  
   Un proceso Node (`npm run worker`) conecta a **Redis** y a la **misma base Postgres** que la API, y escucha dos colas:
   - **`pms-sync`**: jobs de tipo `sync`; ejecuta `runSync(connectionId)` del API (connector → syncFull() → upsert en `pms_debtors`, `pms_leases`, `ar_charges`, etc.).
   - **`case-actions`**: jobs como `CALL_CASE` (Twilio, etc.).

3. **Flujo para cargar `pms_debtors`**  
   Sync desde UI/API → job en Redis → worker toma el job → `runSync` → connector (Buildium/Rentvine) devuelve debtors/leases/charges/payments → el runner hace upsert en las tablas canónicas. Ahí se rellenan `pms_debtors` y el resto.

## Cómo probar el worker y cargar pms_debtors

### 1. Requisitos

- **Redis** corriendo (local: `redis-server` o Docker; o Upstash con `REDIS_URL`). Con Upstash hay un límite de requests (p. ej. 500k/mes en plan free); el worker está configurado con `stalledInterval: 120000` para reducir llamadas.
- **Misma base de datos** que la API (mismas env `DB_*`).
- **API** con al menos una conexión PMS en estado **connected** (Buildium o Rentvine con credenciales válidas).

### 2. Variables de entorno

En `mordecai-workers` necesitas las mismas que la API para DB (y opcionalmente Redis si no usas default):

```bash
# Base de datos (misma que la API)
DB_ENABLED=true
DB_HOST=localhost
DB_PORT=5432
DB_NAME=tu_base
DB_USER=tu_usuario
DB_PASSWORD=tu_password

# Redis (la API también debe usar la misma URL para encolar)
REDIS_URL=redis://127.0.0.1:6379

# Misma clave que la API para desencriptar credenciales de pms_connections (obligatorio si la API encripta)
CREDENTIALS_ENCRYPTION_KEY=<mismo valor que en mordecai-api, ej. base64 32 bytes: openssl rand -base64 32>
```

Puedes copiar el `.env` de la API o enlazarlo.

**Desarrollo local con API en el mismo repo (monorepo):** para que el worker use el API local y no Git, en `package.json` pon `"mordcai-api": "file:../mordecai-api"` y luego `npm install`. Así no dependes del branch remoto.

### 3. Levantar servicios

**Terminal 1 – API**

```bash
cd mordecai-api
npm run dev
```

**Terminal 2 – Worker**

```bash
cd mordecai-workers
npm install
npm run worker
```

Deberías ver en el worker algo como: `Redis connected`, `Database connected`, `Models initialized`, y que queda escuchando.

### 4. Disparar un sync (y cargar pms_debtors)

- **Desde la UI**: Entra a Connectors, abre una conexión que esté **Connected** (Buildium o Rentvine) y lanza el sync desde la opción de la conexión (o el botón que dispare sync).
- **Desde la API** (misma red/token):

```bash
# Sustituye tenantId y connectionId por IDs reales de tu BD
curl -X POST "http://localhost:3000/api/v1/tenants/<tenantId>/pms-connections/<connectionId>/sync" \
  -H "Content-Type: application/json" \
  -H "Cookie: access_token=...; csrf_token=..." \
  -H "x-csrf-token: <csrf_token>"
```

Si la API tiene `REDIS_URL` configurada, encolará el job. En la terminal del **worker** deberías ver que procesa el job y logs del sync (pasos debtors, leases, charges, etc.). Tras un sync exitoso, en Postgres deberías tener filas en `pms_debtors` (y en `pms_leases`, `ar_charges`, etc., según lo que devuelva el connector).

### 5. Si no tienes connector real (Buildium/Rentvine)

El sync llama a `connector.syncFull()`; si no hay credenciales o el connector no está configurado, el job fallará. Para probar solo la cola y el worker sin PMS real, puedes encolar un job a mano (mismo payload que la API) y ver que el worker lo toma; el run fallará en `runSync` al no tener connector/credenciales, pero confirmarás que Redis + worker están bien.

---

## Job model (current)

### Cola `pms-sync`

- **`sync`**: `runSync(connectionId)` — trae datos del PMS y llena `pms_debtors`, `pms_leases`, `ar_charges`, `ar_payments`, etc.

### Cola `case-actions`

1. **`CALL_CASE`**  
   Encodado por el scheduler cuando un debt case está due. El worker inicia una llamada Twilio al teléfono del debtor usando `TWILIO_VOICE_URL` y guarda el `callSid` en `interaction_logs.provider_ref`.

2. **`SYNC_CALL_SUMMARY`** (reservado)  
   Futuro: leer resumen de llamada desde S3 y actualizar BD.

## Roles

- **Scheduler** (`npm run scheduler`): selecciona casos due y encola `CALL_CASE`.
- **Worker** (`npm run worker`): consume jobs de `pms-sync` y `case-actions` y ejecuta sync / llamadas Twilio / actualizaciones en BD.

## Despliegue: Worker en EC2, API en App Runner

Son proyectos desplegados por separado. El worker **no** comparte código con el API en runtime; en EC2 haces `npm install` y la dependencia `mordcai-api` se resuelve desde **Git** (`git+https://github.com/Cristobal1002/mordecai-api.git#qa`).

Para que eso funcione:

1. El **repo del API en GitHub** (el que usa la dependencia) debe tener en el branch que uses (ej. `qa`) **todo el código**, incluido `src/queues/pms-sync.queue.js`, `src/loaders/`, `src/models/`, etc. El worker importa rutas internas (`mordcai-api/src/...`).
2. Si el API vive en un monorepo (carpeta `mordecai-api` dentro de otro repo), hay que tener ese código sincronizado en el repo **mordecai-api** de GitHub (pushes, submodules o build que copie los archivos).
3. Misma **REDIS_URL** en App Runner (API) y en EC2 (worker) para que ambos usen la misma cola.
4. Misma **base de datos** (mismas `DB_*` en el worker que las que use el API) para que el worker escriba en las mismas tablas.

Si al hacer `npm run worker` en EC2 ves `Cannot find module '.../mordcai-api/src/queues/pms-sync.queue.js'`, el branch del API en GitHub no tiene ese archivo: sube los cambios del API a ese repo/branch o despliega el worker usando una dependencia que sí incluya el código (por ejemplo `file:` en un build que empaquete el API dentro de la imagen del worker).

## Upstash / límite de requests

Si usas **Upstash** como Redis, el plan free tiene un límite de requests (p. ej. 500k/mes). El worker **no** hace polling cada segundo: usa comandos de bloqueo y solo revisa jobs “stalled” cada cierto intervalo. Para gastar menos:

- En el worker está configurado **`stalledInterval: 120000`** (2 min) en lugar del default 30 s.
- Evita levantar **varias instancias** del mismo worker (cada una suma tráfico).
- Si te sale `ERR max requests limit exceeded`, espera al reset del periodo o sube de plan en Upstash.

Si el sync falla con **ServiceUnavailableError (503)** en los logs del worker, suele ser porque el worker no tiene **CREDENTIALS_ENCRYPTION_KEY** (o es distinta a la de la API). El worker necesita desencriptar las credenciales de la conexión PMS; sin esa variable no puede y devuelve 503. Pon en el `.env` del worker el mismo valor que en la API.

## Requirements

- Node >= 18
- Postgres (misma instancia que la API)
- Redis (misma URL que la API para que vea los mismos jobs)
- Twilio credentials (solo para `CALL_CASE`)
- Dependencia del API: `mordcai-api` desde Git (producción) o `file:../mordecai-api` (desarrollo local)

## Probar localmente

Sin tocar EC2 ni el modelo de despliegue. En tu máquina:

1. **Redis** accesible (local o remoto). Si no tienes: `docker run -d -p 6379:6379 redis` o usa una Redis en la nube y su URL.
2. **Misma base** que use tu API (mismas `DB_*`). Puedes copiar el `.env` del API o crear uno en `mordecai-workers` con al menos `DB_*` y `REDIS_URL`.
3. **Dependencia del API**  
   Para no depender del branch en GitHub, en `package.json` pon `"mordcai-api": "file:../mordecai-api"` (ruta relativa a donde tengas el API). Luego `npm install`.
4. **Arrancar** (en una terminal):

```bash
cd mordecai-workers
npm install
npm run worker
```

5. Con la **API** y el **front** corriendo, dispara un sync (Connectors → Sync). En la terminal del worker deberías ver el job y los logs del sync.

No usa ningún puerto; solo Redis + Postgres. No choca con el back ni el front.

---

## Ejecutar en contenedor (Docker)

Útil para probar “como en EC2” en tu máquina o para desplegar el worker en un contenedor.

**Dockerfile de ejemplo** (crear en la raíz de `mordecai-workers`):

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
CMD ["node", "src/jobs/worker.js"]
```

**Construir y ejecutar** (Redis y DB deben ser accesibles desde el contenedor):

```bash
docker build -t mordecai-worker .
docker run --env-file .env mordecai-worker
```

Si Redis/Postgres están en `localhost`, en Linux usa `--network host` o en Mac/Windows asegúrate de que `DB_HOST` y `REDIS_URL` apunten a la IP del host (no `localhost`). Para desarrollo local suele ser más simple correr el worker con `npm run worker` y `.env` como arriba.

---

## Despliegue en EC2 con pm2

En EC2 el worker se despliega y se deja corriendo con pm2 (tu modelo actual).

1. En la instancia: clonar/actualizar el repo, `npm ci`, configurar `.env` (o variables de entorno) con `DB_*` y `REDIS_URL` (misma Redis que usa la API en App Runner).
2. Arrancar y mantenerlo vivo con pm2:

```bash
pm2 start src/jobs/worker.js --name mordecai-worker
pm2 save
pm2 startup
```

Para el scheduler (si lo usas):

```bash
pm2 start src/jobs/scheduler.js --name mordecai-scheduler
pm2 save
```

`pm2 logs mordecai-worker` para ver logs.

---

## Env

Ver `.env.example`. Mínimo para sync: `DB_*`, `REDIS_URL`.
