# Cola durable de análisis (ADR-001)

Reemplaza la ejecución fire-and-forget de análisis satelitales por una entrega durable basada en
PostgreSQL + [pg-boss](https://github.com/timgit/pg-boss) 12.35.0, con outbox transaccional y un
proceso consumidor separado. Este documento cubre únicamente lo necesario para operar: variables,
procesos, migraciones, rollout, rollback y jobs fallidos.

## Cómo funciona

1. **API HTTP** (`POST /analysis/field/:fieldId`, y el scheduler semanal si está habilitado): valida
   igual que antes y, en **una sola transacción**, crea `Analysis` con `status='Queued'` +
   `inputSnapshot` (snapshot inmutable de lotes/GeoJSON y parámetros pedidos) + la asociación de
   `clientRequestId` + una fila en `analysis_job_outbox`. Responde sin llamar al Worker.
2. **Job runner** (`node dist/src/job-runner.main.js`, misma imagen, otro comando, sin puertos):
   - *dispatcher*: publica filas pendientes del outbox en pg-boss (`FOR UPDATE SKIP LOCKED`,
     id de job determinista = id de la fila de outbox → publicación idempotente);
   - *consumidor* de `analysis.execute.v1`: reclama un intento (`Queued → Procesando` +
     `analysis_attempt` en `running`), llama al Worker con el input del **snapshot**, persiste el
     resultado una sola vez (`Procesando → Finalizado`, guardado) y genera el veredicto técnico
     (best-effort, después de `Finalizado`);
   - *reconciliador durable*: cierra como `Error` un Analysis activo cuyo job pg-boss ya no se va a
     ejecutar (`failed`/`cancelled`/inexistente).
3. El scheduler semanal sigue detectando schedules vencidos en la API; la corrida queda
   `processing` mientras el Analysis esté `Queued` o `Procesando`. Snapshot semanal, veredicto
   semanal y email siguen ocurriendo solo tras `Finalizado`.

Garantía: entrega **at-least-once** con efectos idempotentes. Si el runner muere después de que el
Worker respondió y antes de persistir, el reintento vuelve a llamar al Worker (el resultado se
persiste una sola vez). No hay "exactly once".

Estados: `Queued → Procesando → Finalizado | Error`, y `Queued → Error`. Entre reintentos un
Analysis durable queda `Procesando` con su último intento en `failed_retryable`.

## Variables de entorno

Todas con defaults seguros (ver `.env.example` / `deploy/aws/env.backend.example`):

| Variable | Default | Uso |
| --- | --- | --- |
| `ANALYSIS_QUEUE_ENABLED` | `false` | Productor manual: encola en vez de fire-and-forget. |
| `ANALYSIS_QUEUE_WEEKLY_ENABLED` | `false` | Productor semanal (requiere también el anterior). |
| `ANALYSIS_JOB_RUNNER_ENABLED` | `false` | El runner arranca inactivo si no es `true`. |
| `ANALYSIS_QUEUE_PGBOSS_SCHEMA` | `pgboss` | Schema propio de pg-boss. |
| `ANALYSIS_JOB_CONCURRENCY` | `1` | Jobs simultáneos por runner (una réplica ⇒ global 1). |
| `ANALYSIS_JOB_MAX_ATTEMPTS` | `3` | Intentos totales (pg-boss `retryLimit = N-1`). |
| `ANALYSIS_JOB_RETRY_DELAY_SECONDS` / `_MAX_SECONDS` | `60` / `1200` | Backoff exponencial con jitter de pg-boss (aprox. 1 min → 2-4 min → tope 20 min). pg-boss no soporta una escalera fija 1/5/20. |
| `ANALYSIS_JOB_EXPIRE_SECONDS` | `900` | Lease del job activo (el Worker corta a los 600 s). |
| `ANALYSIS_JOB_HEARTBEAT_SECONDS` | `30` | Heartbeat de pg-boss (≥ 10); el intento refresca `heartbeatAt` cada la mitad. |
| `ANALYSIS_JOB_POLLING_INTERVAL_SECONDS` | `2` | Polling de pg-boss. |
| `ANALYSIS_OUTBOX_DISPATCH_INTERVAL_MS` / `_BATCH_SIZE` | `5000` / `20` | Dispatcher del outbox. |
| `ANALYSIS_JOB_RECONCILE_INTERVAL_MS` | `60000` | Reconciliador durable. |
| `ANALYSIS_JOB_FAILED_RETENTION_SECONDS` | `2592000` | Retención de jobs terminados/fallidos y del DLQ (30 días). |
| `ANALYSIS_JOB_SHUTDOWN_TIMEOUT_MS` | `60000` | Espera del job activo ante SIGTERM (`stop_grace_period` del compose: 90 s). |

## Procesos

```bash
# API (sin cambios)
node dist/src/main.js
# Job runner (misma imagen) — también: npm run start:job-runner
node dist/src/job-runner.main.js
# Chequeo de invariantes (solo lectura; exit 1 si hay violaciones)
node dist/src/analysis-queue/check-invariants.main.js   # o npm run queue:check-invariants
```

En `deploy/aws/docker-compose.prod.yml` el servicio es `agro-score-job-runner` (una réplica, sin
`ports`/`expose`). Al arrancar por primera vez con `ANALYSIS_JOB_RUNNER_ENABLED=true`, pg-boss crea
su propio schema (`pgboss`) y las colas `analysis.execute.v1` y `analysis.execute.v1.dlq`; el
schema de la aplicación solo cambia por migraciones TypeORM.

## Migración `1789200000000-AddDurableAnalysisQueue`

Aditiva: `analysis."inputSnapshot"` (sin backfill), tablas `analysis_job_outbox` y
`analysis_attempt`, y `UQ_analysis_running_per_field` pasa a cubrir `Queued` + `Procesando` (swap
dentro de la transacción, sin ventana sin unicidad; toma un lock de escritura corto sobre
`analysis` mientras construye el índice). Aborta —sin tocar datos— si ya hubiera más de un análisis
activo por campo. No convierte `Procesando` históricos en `Queued` ni inventa intentos.

La versión anterior de la API tolera el esquema expandido (su `ON CONFLICT ... WHERE status =
'Procesando'` sigue infiriendo el índice nuevo; verificado en `test/analysis-queue.integration-spec.ts`).

`down()`: se niega si existe trabajo durable pendiente (`Queued`, o `Procesando` con snapshot). Si
pasa el guard, borra outbox/intentos (historial de entrega: irreversible) y `inputSnapshot`
(input auditado: irreversible). **No usarlo como rollback de producción.**

```bash
npm run migration:show
npm run migration:run      # solo después de backup + restore verificado
```

## Rollout (orden obligatorio)

1. Backup y restore verificado (o confirmación operacional explícita).
2. `npm run migration:run` (migración aditiva).
3. Deploy de la API con `ANALYSIS_QUEUE_ENABLED=false` (comportamiento legacy, esquema nuevo).
4. Deploy del runner con `ANALYSIS_JOB_RUNNER_ENABLED=true` (sin productores habilitados no hay
   nada que consumir; crea el schema de pg-boss).
5. Habilitar `ANALYSIS_QUEUE_ENABLED=true` en una ventana controlada y lanzar **un** análisis
   manual de prueba.
6. Verificar el ciclo completo: `Queued → Procesando → Finalizado`, fila en `analysis_attempt`
   (`succeeded`), outbox con `dispatchedAt`/`jobId`, veredicto técnico, y
   `queue:check-invariants` sin violaciones.
7. Dejar habilitadas las solicitudes manuales.
8. Habilitar `ANALYSIS_QUEUE_WEEKLY_ENABLED=true`.
9. Drenar el trabajo legacy: esperar que no queden `Procesando` sin `inputSnapshot`
   (`SELECT count(*) FROM analysis WHERE status='Procesando' AND "inputSnapshot" IS NULL`); el
   reconciliador legacy los cierra por edad.
10. Remover el camino fire-and-forget del código en un cambio posterior (fuera de este ticket).
11. El reconciliador legacy queda activo solo para filas sin metadata durable.

## Rollback de aplicación

1. `ANALYSIS_QUEUE_ENABLED=false` y `ANALYSIS_QUEUE_WEEKLY_ENABLED=false` (no se encola nada nuevo;
   la API vuelve al camino legacy para solicitudes nuevas).
2. Detener el runner de forma ordenada (`docker compose stop agro-score-job-runner`: SIGTERM, deja
   de tomar jobs y espera el activo hasta el timeout).
3. Identificar trabajo pendiente:
   ```sql
   SELECT a.id, a.status, o."dispatchedAt", o."jobId"
   FROM analysis a JOIN analysis_job_outbox o ON o."analysisId" = a.id
   WHERE a.status IN ('Queued', 'Procesando');
   ```
4. No volver a consumir esos jobs con otro camino. Opciones explícitas: **drenar** (volver a
   levantar el runner hasta que no queden activos durables) o **cancelar**: cancelar el job en
   pg-boss (`UPDATE pgboss.job SET state='cancelled', completed_on=now() WHERE name='analysis.execute.v1'
   AND id = '<jobId>' AND state < 'active'`) y cerrar el Analysis como `Error`. Un Analysis
   durable nunca se marca `Error` por edad automáticamente.
5. Mantener tablas, columnas y el schema `pgboss`: la versión anterior de la API funciona con el
   esquema expandido. **No** correr `migration:revert` en producción.

## Jobs fallidos / dead-letter

- Falla reintentable (timeout, red, 429, 5xx, lease perdido): pg-boss reintenta con backoff. Al
  agotar los intentos el job queda `failed` en `analysis.execute.v1` y se copia a
  `analysis.execute.v1.dlq`; el Analysis queda `Error` con `errorCode` en su último intento.
- Falla no reintentable (400/422, geometría/input inválido, versión de contrato o snapshot
  desconocidos, campo/usuario no disponible): `Error` inmediato y el job va directo al DLQ.
- El DLQ no tiene consumidor: los jobs quedan inspeccionables durante la retención configurada.

```sql
-- Jobs en el dead-letter queue
SELECT id, data->>'analysisId' AS analysis_id, created_on, source_output
FROM pgboss.job WHERE name = 'analysis.execute.v1.dlq' ORDER BY created_on DESC;
-- Historial de intentos de un análisis
SELECT "attemptNumber", outcome, "errorCode", "errorMessage", "startedAt", "finishedAt"
FROM analysis_attempt WHERE "analysisId" = '<id>' ORDER BY "attemptNumber";
```

Redrive: fuera de alcance de este ticket (no hay pantalla ni endpoint). Para reintentar un
análisis fallido se crea uno nuevo desde la UI.

## Tests

```bash
npm test                      # unitarios (sin DB)
TEST_DB_HOST=… TEST_DB_PORT=… TEST_DB_USER=… TEST_DB_PASSWORD=… npm run test:integration
```

`test:integration` crea y borra su propia base aislada, usa PostgreSQL y pg-boss reales, y simula
solo el Worker (sin Earth Engine, SMTP ni AWS). Necesita `--experimental-vm-modules` (lo agrega el
script) porque pg-boss 12 es ESM-only.
