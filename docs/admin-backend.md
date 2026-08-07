# ADMIN-1 / ADMIN-2 / ADMIN-3 — Backend admin (`/admin/*`)

**ADMIN-1 (2026-08-04):** soporte backend para un futuro panel de administración interno (frontend separado, `agro-score-admin`, FASE 2). Roles, guards, endpoints de lectura/gestión bajo `/admin/*`, timing de diagnósticos y persistencia de solicitudes de acceso.

**ADMIN-2 (2026-08-06):** segunda iteración — convierte el panel en herramienta operativa real. Agrega: flujo completo de solicitudes de acceso (status ampliado, notas, asignación, conversión a usuario), invitaciones + reset de contraseña (tokens hasheados, nunca passwords en claro), auditoría de acciones admin, operación sobre diagnósticos fallidos (marcar revisado / pedir reintento), `GET /admin/system/health`, y métricas extendidas (altas 7/30 días, tasa de fallo, etc.). `agro-score-admin` (frontend) **ya existe** desde la FASE 2 anterior — esta ficha es de nuevo solo backend; el frontend se actualiza en una ficha separada.

**ADMIN-3 (2026-08-07):** cierra las dos deudas explícitas que dejó ADMIN-2 — envío real de email para invitaciones/password-reset (`EmailService`, Resend, ver `docs/invitation-password-reset-email.md`) y el endpoint público `POST /auth/reset-password` para canjear el token. Suma auditoría del lado de `/auth` (`auth.invitation.accepted`, `auth.password_reset.completed` — antes `AuthModule` no auditaba nada, ver más abajo) y las páginas públicas de accept-invitation/reset-password, que viven en **agro-score-web** (no en agro-score-admin — ver sección "Dónde viven las páginas públicas").

---

## Roles

`User.role` (`src/users/user-role.enum.ts`): `owner` | `admin` | `user`.

- **`owner`**: acceso total, incluido `/admin/*`.
- **`admin`**: acceso a `/admin/*`.
- **`user`**: sin acceso a `/admin/*` (403).
- Default para usuarios nuevos (`POST /auth/register` y cualquier alta sin rol explícito): `user`.

**Nota importante sobre la migración `AddUserRolesAndActive`:** la columna `role` ya existía desde el scaffold inicial del proyecto con `DEFAULT 'owner'`, pero nunca tuvo efecto de autorización — no había ningún guard que la leyera. Antes de esta ficha, **todos** los usuarios reales tenían `role='owner'` solo porque nunca se seteó nada distinto (verificado: 9/9 en la DB local). La migración baja a `'user'` únicamente las filas que estaban en ese default nunca-usado, para que activar `/admin/*` no le dé acceso admin automático a cada cuenta existente. Ver el comentario completo en `src/migrations/1785848336701-AddUserRolesAndActive.ts`.

## Cómo crear/promover el primer owner o admin

No existe ningún endpoint HTTP público para auto-promoverse un rol — es intencional (consigna explícita: "no abrir ningún endpoint público para convertir usuarios en admin").

1. El usuario ya debe existir (registrado vía `POST /auth/register`, o creado por otro admin una vez que exista al menos uno).
2. Promoverlo desde el servidor/DB, con el script dedicado (dry-run por default, mismo patrón que `scripts/backfill-fields-user.ts`):

   ```bash
   # Ver qué haría, sin tocar nada:
   npm run promote:user-role -- --email owner@agroscorelatam.com --role owner

   # Aplicar de verdad:
   npm run promote:user-role -- --email owner@agroscorelatam.com --role owner --apply
   ```

3. Alternativa manual (si no se puede correr el script): SQL directo contra la DB, nunca vía HTTP:

   ```sql
   UPDATE users SET role = 'owner' WHERE email = 'owner@agroscorelatam.com';
   ```

El cambio de rol tiene efecto inmediato en el siguiente request del usuario (no hay que esperar a que expire su JWT — ver "Desactivación de usuarios" abajo, mismo mecanismo).

## Guards

- `JwtAuthGuard` (`src/auth/jwt-auth.guard.ts`, sin cambios): valida el JWT y puebla `request.user`.
- `RolesGuard` (`src/auth/roles.guard.ts`, nuevo): genérico y reutilizable, no específico de `/admin/*`. Lee los roles permitidos desde `@Roles(...)` (`src/auth/roles.decorator.ts`) vía `Reflector` y los compara contra `request.user.role`. Deniega por default si no hay `request.user` (o sea, si corre sin `JwtAuthGuard` antes).
- `AdminController` aplica ambos a nivel de clase: `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(UserRole.OWNER, UserRole.ADMIN)`. Cualquier endpoint nuevo que se agregue al controller queda protegido automáticamente.

No se creó un `AdminGuard` separado: hubiera sido una envoltura fina sobre la misma lógica de `RolesGuard` con la lista de roles hardcodeada — se prefirió el guard único, reutilizable con `@Roles(...)`, siguiendo el patrón idiomático de Nest (mismo criterio ya usado en el repo para `ThrottlerGuard` + `@Throttle(...)`).

### Desactivación de usuarios (`isActive`)

`JwtStrategy.validate` (`src/auth/jwt.strategy.ts`) ahora rechaza con 401 si `user.isActive === false`. Sin esto, desactivar a alguien desde el panel admin no tendría efecto hasta que expirara su JWT (hasta 7 días, `JWT_EXPIRES_IN`). Como `validate` ya reconsultaba la DB en cada request (no solo en el login), el chequeo de rol y de `isActive` quedan siempre al día.

## Endpoints

Todos bajo `/admin`, todos protegidos por `JwtAuthGuard + RolesGuard` (`owner`/`admin`).

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/metrics` | Métricas generales, ver abajo (ADMIN-2: extendidas) |
| GET | `/admin/system/health` | *(ADMIN-2)* Estado de api/db/worker/EE + último diagnóstico OK/fallido |
| GET | `/admin/audit-logs?actorUserId=&action=&targetType=&targetId=&page=&limit=` | *(ADMIN-2)* Ledger de acciones admin |
| GET | `/admin/users?page=&limit=&search=` | Lista usuarios (sin `passwordHash`) |
| POST | `/admin/users` | Crea usuario (`fullName`, `email`, `password`, `role`, `isActive?`) |
| PATCH | `/admin/users/:id` | Edita `fullName`/`email`/`role`/`isActive` |
| DELETE | `/admin/users/:id` | Soft delete (`isActive = false`), nunca hard delete |
| POST | `/admin/users/:id/password-reset` | *(ADMIN-2)* Genera token de reset (hasheado en DB) |
| POST | `/admin/invitations` | *(ADMIN-2)* Crea invitación de alta (`email`, `role`) |
| GET | `/admin/fields?page=&limit=&search=` | Lista campos con dueño y cantidad de lotes |
| GET | `/admin/lots?page=&limit=&search=` | Lista lotes internos con campo y dueño |
| GET | `/admin/analysis?page=&limit=&status=&fieldId=&userId=&from=&to=&onlyFailed=&onlyUnreviewed=` | Lista diagnósticos con timing/error/revisión (ADMIN-2: filtros nuevos) |
| PATCH | `/admin/analysis/:id/mark-reviewed` | *(ADMIN-2)* Marca un diagnóstico `Error` como revisado |
| POST | `/admin/analysis/:id/retry` | *(ADMIN-2)* "Retry requested" — ver sección Diagnósticos abajo |
| GET | `/admin/access-requests?page=&limit=&status=&search=` | Lista solicitudes de acceso de la landing |
| PATCH | `/admin/access-requests/:id` | *(ADMIN-2)* Edita `status`/`internalNotes`/`assignedToUserId` |
| POST | `/admin/access-requests/:id/create-user` | *(ADMIN-2)* Convierte una solicitud en invitación de usuario |

Público (fuera de `/admin`, sin auth):

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/accept-invitation` | *(ADMIN-2)* `{token, password, fullName}` → crea la cuenta y hace login |
| POST | `/auth/reset-password` | *(ADMIN-3)* `{token, password}` → cambia la password, marca el token usado, **no** hace login |

Paginación: `page`/`limit` (default 1/20, `limit` máx 100) en todos los listados; `search` donde aplica (email/nombre, nombre de campo/lote, nombre/email/organización); `status` en `analysis` (`Procesando`/`Finalizado`/`Error` — **se mantienen los valores en español ya existentes**, no se migró a `running`/`completed`/`failed` para no romper compatibilidad) y en `access-requests` (`new`/`contacted`/`interested`/`discarded`/`converted`, ampliado en ADMIN-2).

### `GET /admin/metrics` — forma de la respuesta

```json
{
  "totalUsers": 0,
  "activeUsers": 0,
  "totalFields": 0,
  "totalLots": 0,
  "totalAnalysis": 0,
  "completedAnalysis": 0,
  "failedAnalysis": 0,
  "averageAnalysisDurationMs": 0,
  "latestAnalysis": [],
  "latestAccessRequests": [],

  "usersCreatedLast7Days": 0,
  "usersCreatedLast30Days": 0,
  "fieldsCreatedLast7Days": 0,
  "fieldsCreatedLast30Days": 0,
  "analysisCreatedLast7Days": 0,
  "analysisCreatedLast30Days": 0,
  "failedAnalysisLast7Days": 0,
  "failedAnalysisLast30Days": 0,
  "usersWithNoAnalysis": 0,
  "fieldsWithNoAnalysis": 0,
  "accessRequestsByStatus": { "new": 0, "contacted": 0, "interested": 0, "discarded": 0, "converted": 0 },
  "analysisFailureRateLast7Days": 0,
  "averageAnalysisDurationMsLast7Days": 0
}
```

Los campos originales de ADMIN-1 no cambiaron de forma — todo lo de ADMIN-2 es aditivo, así que un frontend viejo que solo lea los campos de ADMIN-1 sigue funcionando sin cambios. `analysisFailureRateLast7Days` es una fracción 0–1 (no porcentaje) — formatear en el frontend. `usersWithNoAnalysis`/`fieldsWithNoAnalysis` cuentan usuarios/campos que nunca tuvieron ni un solo `Analysis` asociado (mismo join manual que usa `AnalysisService.findAll`, porque `Analysis.fieldId` es texto libre sin FK — ver `AdminService.countUsersWithNoAnalysis`/`countFieldsWithNoAnalysis`).

### Reglas de `PATCH /admin/users/:id` y `DELETE /admin/users/:id`

- Nunca devuelven `passwordHash`.
- `ValidationPipe` global (`whitelist` + `forbidNonWhitelisted`) rechaza cualquier campo fuera de `fullName`/`email`/`role`/`isActive` — no hay forma de mandar `password`/`passwordHash` por acá.
- **Protección de último owner**: si la operación (degradar el rol o desactivar) dejaría al sistema sin ningún `owner` activo, se rechaza con 400. Se cuenta contra *otros* owners activos (excluyendo al usuario objetivo), así que aplica tanto si un owner se lo hace a sí mismo como si otro admin/owner se lo hace a él.
- `DELETE` es siempre soft delete (`isActive = false`) — nunca borra la fila, por las relaciones con fields/analysis.

## Diagnósticos: timing y errores

`Analysis` (sin cambiar `status`, que sigue en español) suma columnas nullable: `startedAt`, `completedAt`, `failedAt`, `durationMs`, `errorMessage`. Enganchadas en `AnalysisService`:

- Al crear el análisis (`runFieldAnalysis`): `status='Procesando'`, `startedAt=now()`.
- Al terminar bien (`processFieldAnalysisInBackground`, rama éxito): `status='Finalizado'`, `completedAt=now()`, `durationMs = completedAt - startedAt`, `errorMessage=null`.
- Al fallar (rama catch): `status='Error'`, `failedAt=now()`, `durationMs = failedAt - startedAt`, `errorMessage` = `error.message` truncado a 500 caracteres (nunca el stack trace completo ni datos sensibles).
- Análisis viejos (previos a esta migración) quedan con estos campos en `null` — no hay backfill posible, el dato no se guardaba antes.

## Solicitudes de acceso: de persistencia a flujo operativo

**ADMIN-1**: `POST /access-request` (antes solo mandaba un email, ver `docs/audits/access-request-flow.md`) ahora también guarda cada solicitud en `access_requests` **antes** de intentar el envío del mail — así queda visible en el admin aunque Resend falle después. El envío de mail no cambió.

**ADMIN-2**: la tabla suma `internalNotes` (texto libre, nunca se manda al solicitante), `assignedToUserId` (FK a `users`, `ON DELETE SET NULL`), y timestamps `contactedAt`/`convertedAt`/`discardedAt`. `status` pasa de 3 a 5 valores: `new` → `contacted` → `interested` → `discarded` | `converted`.

- `PATCH /admin/access-requests/:id`: cambia `status`/`internalNotes`/`assignedToUserId`. Al pasar a `contacted`/`converted`/`discarded`, setea el timestamp correspondiente **solo si todavía estaba vacío** — un segundo PATCH al mismo status no pisa la fecha real del primer cambio.
- `POST /admin/access-requests/:id/create-user`: convierte la solicitud en una `UserInvitation` para el email de la solicitud (rol elegible, default `user`), marca la solicitud como `converted` y audita `admin.invitation.created` + `admin.access_request.converted`. **No crea el `User` directamente con una password temporal** — ver la sección siguiente, es la misma razón por la que existen las invitaciones: el admin nunca debe ver/comunicar una password. Rechaza con 409 si ya existe una cuenta con ese email.

## Invitaciones y reset de contraseña — nunca passwords en claro

**Principio:** el panel admin nunca genera ni muestra una password. Todo lo que un humano necesita comunicarle a otro humano es un **token de un solo uso** con expiración corta, y solo el hash del token (`src/auth/token.util.ts`, `sha256`) se persiste — igual que un password hasheado, pero de un solo uso.

Dos entidades nuevas, ambas con `tokenHash` indexado único:

- **`UserInvitation`** (`src/users/entities/user-invitation.entity.ts`): `email`, `role`, `invitedByUserId`, `tokenHash`, `expiresAt` (7 días), `acceptedAt`.
- **`PasswordResetToken`** (`src/users/entities/password-reset-token.entity.ts`): `userId` (FK `ON DELETE CASCADE` — a diferencia del resto de las FKs de esta ficha, acá sí tiene sentido: un token sin usuario dueño no significa nada), `tokenHash`, `expiresAt` (2 horas), `usedAt`.

### `POST /admin/invitations` y `POST /admin/access-requests/:id/create-user`

Ambos crean una `UserInvitation` (comparten `AdminService.issueInvitation` internamente) **y ahora envían el email de verdad** (ADMIN-3 — `EmailService`, ver `docs/invitation-password-reset-email.md`). Respuesta:

```json
{
  "id": "...", "email": "...", "role": "user", "expiresAt": "...",
  "emailSent": true, "dryRun": false, "provider": "resend"
}
```

- `emailSent` / `dryRun` / `provider` viajan **siempre**, en cualquier entorno — reemplazan el viejo campo `message` de ADMIN-2 ("el envío de email no está integrado"), que ya no aplica.
- **Fuera de producción** (`NODE_ENV != 'production'`): suma `invitationToken` (el token crudo) e `invitationUrl` ya armada con `APP_PUBLIC_URL`/`FRONTEND_URL`.
- **En producción** (`NODE_ENV=production'`): **no devuelve ningún token** — el email es el único canal de entrega del link.
- Un fallo de envío (`emailSent: false`) **no revierte la creación** de la invitación — ya se persistió antes de intentar el email.

### `POST /admin/users/:id/password-reset`

Mismo criterio: genera y persiste (solo el hash) un `PasswordResetToken` de 2 horas, envía el email, y responde `{ userId, email, expiresAt, emailSent, dryRun, provider, resetToken?, resetUrl? }` (token/url solo fuera de producción). **Ya existe el endpoint público para consumirlo** — `POST /auth/reset-password` (ver abajo), cerrado en ADMIN-3. Antes de esto, era deuda explícita: el token se generaba pero no había forma de canjearlo.

### `POST /auth/accept-invitation` (público)

`{ token, password, fullName }` → busca la invitación por `hashToken(token)` (no vencida, no aceptada), verifica que no exista ya un usuario con ese email, crea el `User` con el `role` de la invitación (`isActive: true`) y marca `acceptedAt`. Devuelve `{ user, accessToken }` igual que `/auth/login` (login automático). Mismo rate limit que `/auth/register`/`/auth/login` (5 req/min, SEC-003). Mensajes de error genéricos (token inválido/vencido/usado dan el mismo mensaje) para no filtrar información a un atacante. *(ADMIN-3)* audita `auth.invitation.accepted` — el actor es el propio usuario recién creado.

`UserInvitation` **no guarda `fullName`** a propósito — la persona invitada lo completa al aceptar, como un signup normal. Esto evita necesitar ese dato en `POST /admin/invitations` y mantiene la entidad exactamente con la forma sugerida en la consigna.

### `POST /auth/reset-password` (público, ADMIN-3)

`{ token, password }` → busca el `PasswordResetToken` por `hashToken(token)` (no vencido, no usado — mismo criterio que accept-invitation), actualiza `User.passwordHash` (`UsersService.updatePassword`, dedicado y separado de `update()` para que ningún DTO admin pueda colarlo) y marca `usedAt`. Devuelve `{ message }` — **a diferencia de accept-invitation, no hace login automático** (el frontend redirige a `/login`). Mismo rate limit (5 req/min, SEC-003), mismo mensaje de error genérico. Audita `auth.password_reset.completed`.

## Dónde viven las páginas públicas (ADMIN-3)

`/accept-invitation` y `/reset-password` son pantallas de **agro-score-web**
(`features/public/accept-invitation`, `features/public/reset-password`), no
de agro-score-admin — viven junto al login real de usuarios `user`
(`features/public/login`). agro-score-admin es el panel interno para
`owner`/`admin`; los usuarios invitados (mayormente `role=user`, vía
solicitudes de acceso convertidas) inician sesión en agro-score-web, así que
ahí es donde tiene que completarse el flujo. Si se invita a alguien con rol
`admin`/`owner`, igual acepta la invitación en agro-score-web (login
automático ahí) y por separado puede iniciar sesión en agro-score-admin con
el mismo email/password una vez que los tiene.

## Auditoría de acciones

`AdminAuditLog` + `AuditLogService` — extraídos en ADMIN-3 a su propio módulo, `src/audit-log/` (antes vivían en `src/admin/`, provider directo de `AdminModule`). El motivo: `AuthModule` también necesita auditar ahora (`accept-invitation`/`reset-password` sí generan auditoría — el comentario de ADMIN-2 que decía lo contrario quedó desactualizado). Importar `AdminModule` completo en `AuthModule` hubiera traído de arrastre `Field`/`Analysis`/`AccessRequest`; `AuditLogModule` es liviano y lo importan ambos. Ledger append-only — ningún endpoint lo edita ni lo borra.

Acciones auditadas (`AdminAuditAction`, `src/audit-log/audit-log.service.ts`): `admin.user.created`, `admin.user.updated`, `admin.user.role_changed`, `admin.user.deactivated`, `admin.access_request.updated`, `admin.access_request.converted`, `admin.invitation.created`, `admin.invitation.email_sent` *(ADMIN-3)*, `admin.password_reset.created`, `admin.password_reset.email_sent` *(ADMIN-3)*, `admin.analysis.marked_reviewed`, `admin.analysis.retry_requested`, `auth.invitation.accepted` *(ADMIN-3)*, `auth.password_reset.completed` *(ADMIN-3)*. Las últimas dos son las únicas dos acciones cuyo actor es el propio usuario final, no un admin — disparadas desde endpoints públicos de `/auth`.

`GET /admin/audit-logs?actorUserId=&action=&targetType=&targetId=&page=&limit=` — filtros exactos, no hay `search` de texto libre (a propósito: son campos estructurados, no texto).

**Sanitización defensiva**: `AuditLogService.record()` recorre `before`/`after` recursivamente (arrays y objetos anidados incluidos) y omite cualquier key que matchee `password`/`passwordhash`/`token`/`tokenhash`/`accesstoken`/`resettoken`/`secret`/`jwtsecret` (case-insensitive) — **incluso si el caller pasara por error una entidad cruda**. Todos los callers actuales ya arman objetos "limpios" a mano (solo campos públicos), esto es una segunda capa, no la única.

`actorUserId` tiene FK real a `users` (`ON DELETE SET NULL`) — igual que `assignedToUserId`/`reviewedByUserId`; `targetType`/`targetId` son polimórficos (`user`/`access_request`/`analysis`/`invitation`) y no pueden tener FK.

## Diagnósticos: operación sobre fallidos

Además de `startedAt`/`completedAt`/`failedAt`/`durationMs`/`errorMessage` (ADMIN-1), `Analysis` suma `reviewedAt`, `reviewedByUserId` (FK a `users`), `retryCount` (default 0), `lastRetriedAt`.

- `PATCH /admin/analysis/:id/mark-reviewed`: exige `status='Error'` (400 si no), setea `reviewedAt=now()` + `reviewedByUserId=<actor>`, audita `admin.analysis.marked_reviewed`.
- `POST /admin/analysis/:id/retry`: **"retry requested", no reintento real.** Exige `status='Error'`, incrementa `retryCount`, setea `lastRetriedAt=now()`, audita `admin.analysis.retry_requested`. **No vuelve a llamar al worker/Earth Engine.** Reconstruir con confianza el input original (índices elegidos, `maxZoneCampaigns`, lotes incluidos en la clasificación) y volver a dispararlo desde un endpoint admin implica riesgo real: llamadas duplicadas a Earth Engine (costo), falta de garantías de idempotencia, y ningún mecanismo de rate-limit para evitar que alguien reintente en loop. Se prefirió dejar constancia operativa (cuántas veces se pidió, cuándo, quién) para que el equipo lo dispare a mano o para que una ficha futura lo automatice con las guardas correspondientes.
- `GET /admin/analysis` suma filtros: `fieldId`, `userId` (dueño del field, vía join — `Analysis` no tiene ownership propio), `from`/`to` (rango de `createdAt`, `ISO date`), `onlyFailed` (equivalente a `status=Error`, combinable), `onlyUnreviewed` (`reviewedAt IS NULL`).

## Sistema / health

`GET /admin/system/health` — pensado para un vistazo operativo rápido, no para monitoreo automatizado de alta frecuencia:

```json
{
  "api": { "status": "ok" },
  "db": { "status": "ok" },
  "worker": { "status": "ok" },
  "earthEngine": { "status": "not_checked", "note": "..." },
  "lastSuccessfulAnalysis": { "id": "...", "fieldId": "...", "lotName": "...", "completedAt": "...", "createdAt": "..." },
  "lastFailedAnalysis": { "id": "...", "fieldId": "...", "lotName": "...", "failedAt": "...", "errorMessage": "...", "createdAt": "..." },
  "currentBackendCommit": "50468af",
  "uptimeSeconds": 41,
  "timestamp": "2026-08-06T14:41:33.201Z"
}
```

- `db`: `SELECT 1` contra la conexión activa. `error` (mensaje) si falla.
- `worker`: `PythonWorkerService.checkHealth()` — `GET {PYTHON_WORKER_URL}/health` con timeout de 3s (el worker ya tenía este endpoint, no se tocó `agro-score-worker`). `unreachable` + `error` si falla/timeoutea.
- `earthEngine`: **siempre `not_checked`**, a propósito — el backend nunca llama a Earth Engine directamente (solo el worker lo hace), y verificar el estado real de EE implicaría una llamada costosa/lenta desde el worker que este health check no dispara. Documentado en la respuesta misma (`note`), no silencioso.
- `currentBackendCommit`: intenta `GIT_COMMIT`/`SOURCE_COMMIT` (env) y si no están, `git rev-parse --short HEAD` (falla silenciosamente a `null` — esperable en el contenedor de producción, que no incluye `.git`, ver `Dockerfile`).
- `uptimeSeconds`: `process.uptime()` del proceso Node actual (se resetea en cada deploy/restart).

## Gotcha encontrado: `user` es palabra reservada en Postgres

Al escribir el query builder de `usersCreatedLast7Days`/`30Days` (`UsersService.countCreatedSince`), un `WHERE` armado a mano como `'user."createdAt" >= :since'` sobre `.createQueryBuilder('user')` tira `syntax error at or near "."` **en runtime, no en compilación** — porque `user` (sin comillas) es una palabra reservada de SQL/Postgres (equivalente a `CURRENT_USER`), así que `user."createdAt"` no parsea como `alias.columna`. Se manifestó recién probando `/admin/metrics` contra la DB real (los tests con repos mockeados no lo detectan). Fix: citar el alias a mano (`'"user"."createdAt" >= :since'`) cuando se arma SQL crudo con ese alias en particular — otros alias usados en este módulo (`field`, `analysis`, `accessRequest`, `entity`) no tienen este problema. Si se agrega código nuevo con `createQueryBuilder('user')` + condiciones crudas, tenerlo presente.

## Migraciones

```bash
# Generar (compara entities vs DB — revisar el diff antes de commitear):
npm run migration:generate -- src/migrations/NombreDescriptivo

# Correr localmente (contra el Postgres de docker-compose.yml, puerto 5434):
npm run migration:run

# Revertir la última:
npm run migration:revert

# Ver estado:
npm run migration:show
```

Las 3 migraciones de ADMIN-1 y las 5 de ADMIN-2 ya se corrieron y verificaron contra la DB local (`npm run migration:generate` post-run no encuentra diff pendiente — entities y schema están en sync):

**ADMIN-1:**
1. `1785848336701-AddUserRolesAndActive.ts`
2. `1785848336702-AddAnalysisTimingFields.ts`
3. `1785848336703-CreateAccessRequests.ts`

**ADMIN-2:**
4. `1786026385135-ExtendAccessRequestWorkflow.ts` — columnas nuevas en `access_requests` + FK `assignedToUserId`.
5. `1786026385136-AddAnalysisReviewFields.ts` — columnas nuevas en `analysis` + FK `reviewedByUserId`.
6. `1786026385137-CreateAdminAuditLogs.ts` — tabla `admin_audit_logs` + FK `actorUserId`.
7. `1786026385138-CreateUserInvitations.ts` — tabla `user_invitations` + índice único `tokenHash` + FK `invitedByUserId`.
8. `1786026385139-CreatePasswordResetTokens.ts` — tabla `password_reset_tokens` + índice único `tokenHash` + FK `userId` (`CASCADE`).

Todas nullable/con default seguro donde correspondía — ninguna requirió backfill de datos existentes salvo la ya documentada de ADMIN-1 (reset de `role='owner'` a `'user'`).

**Nunca se corrieron contra producción.** Para aplicarlas en producción: mismo `npm run migration:run` con las variables de entorno (`DB_*`, `DATABASE_SSL=true`) apuntando a la DB productiva, como parte del proceso de deploy documentado en `agro-score-api/deploy/aws/README.md` — coordinar el timing con el equipo antes de correrlo ahí.

**ADMIN-3 no agregó migraciones.** `UserInvitation`/`PasswordResetToken` ya existían completas desde ADMIN-2 — todo lo nuevo (`EmailService`, `POST /auth/reset-password`, extracción de `AuditLogService`, `UsersService.updatePassword`) es capa de servicio/routing, no schema. `npm run migration:generate` post-cambios no encuentra diff pendiente.

## CORS para el futuro frontend admin (FASE 2)

No se tocó `.env` real. Cuando `agro-score-admin` tenga dominio (`https://admin.agroscorelatam.com`), sumarlo a `CORS_ORIGIN` en el `.env` de producción **sin sacar los orígenes existentes**:

```
CORS_ORIGIN=https://agroscorelatam.com,https://www.agroscorelatam.com,https://admin.agroscorelatam.com
```

Ver comentario agregado en `.env.example`.

## Tests

**ADMIN-1:**
- `src/auth/roles.guard.spec.ts`, `src/auth/jwt.strategy.spec.ts` — guard de roles aislado; rechazo de usuarios `isActive=false`.
- `src/admin/admin.guards.spec.ts` — end-to-end vía supertest sobre `INestApplication` real (JwtAuthGuard con doble de test, RolesGuard real).
- `src/admin/admin.controller.spec.ts` — metadata `@UseGuards`/`@Roles` en el controller.
- `src/admin/dto/create-admin-user.dto.spec.ts`.

**ADMIN-2 (nuevos):**
- `src/admin/admin.guards.spec.ts` (extendido) — `GET /admin/system/health` y `GET /admin/audit-logs`: role `user` → 403, role `admin`/`owner` → 200 (mismos endpoints nuevos, misma composición de guards a nivel controller).
- `src/admin/admin.service.spec.ts` (extendido): `updateAccessRequest` (timestamps se setean solo la primera vez, 404 si no existe), `createUserFromAccessRequest` (crea invitación, marca `converted`, audita ambas acciones, rechaza email duplicado), `createInvitation`/`createPasswordResetToken` (no exponen ningún token en `NODE_ENV=production`), `markAnalysisReviewed`/`retryAnalysis` (exigen `status=Error`, auditan), `getSystemHealth` (estructura esperada, `db.status=error` si la query falla sin tirar la request abajo), auditoría en `createUser`/`updateUser` (role_changed vs. updated)/`deactivateUser`.
- `src/admin/audit-log.service.spec.ts` — sanitización: omite `password`/`passwordHash`/`token`/`tokenHash`/etc. en objetos planos **y anidados** (objetos/arrays), guarda `null` en vez de `{}` vacío cuando no hay `before`/`after`.
- `src/admin/dto/update-access-request.dto.spec.ts`, `create-invitation.dto.spec.ts`, `list-analysis-query.dto.spec.ts` (filtros nuevos, incluida la trampa de `@Type(() => Boolean)` con `'false'` como string), `list-access-requests-query.dto.spec.ts` (status ampliado).
- `src/auth/auth.service.spec.ts` (extendido): `acceptInvitation` — crea el usuario con el rol de la invitación, nunca devuelve `passwordHash`, rechaza token inválido/vencido y email ya registrado.
- `src/auth/dto/accept-invitation.dto.spec.ts`.

**ADMIN-3 (nuevos):**
- `src/email/email.service.spec.ts` — dry-run (no llama a Resend, nunca loguea el link/token completo), envío real con provider mockeado (éxito/error), precedencia `EMAIL_FROM`→`CONTACT_FROM_EMAIL` y `EMAIL_DRY_RUN`→`CONTACT_EMAIL_DRY_RUN` (default `true` sin ninguna seteada).
- `src/admin/admin.service.spec.ts` (extendido): `createInvitation`/`createPasswordResetToken`/`createUserFromAccessRequest` llaman a `EmailService`, auditan `*_created` + `*_email_sent`, `emailSent`/`dryRun`/`provider` viajan en cualquier entorno, un fallo de envío no revierte la creación del token.
- `src/auth/auth.service.spec.ts` (extendido): `acceptInvitation` audita `auth.invitation.accepted`; `resetPassword` — actualiza `passwordHash`, marca `usedAt`, rechaza token inválido/vencido/usado con el mismo mensaje genérico, nunca devuelve `passwordHash`/`tokenHash`, audita `auth.password_reset.completed`.
- `src/auth/dto/reset-password.dto.spec.ts`.
- `src/audit-log/audit-log.service.spec.ts` (movido de `src/admin/`, sin cambios de contenido).

Suite completa: **277/277** (`npm test`).

## Qué no se tocó / deuda conocida

**Resuelto en ADMIN-2** (ya no es deuda): endpoint para cambiar `access_requests.status`, reseteo de contraseña desde el admin (generación del token — ver siguiente punto), auditoría de acciones admin.

**Resuelto en ADMIN-3** (ya no es deuda): envío real de email para invitaciones/password-reset (`EmailService`, Resend — ver `docs/invitation-password-reset-email.md`), endpoint público `POST /auth/reset-password` para canjear el token, auditoría del lado de `/auth` (`auth.invitation.accepted`, `auth.password_reset.completed`), `agro-score-admin` ya consume los campos nuevos (`emailSent`/`dryRun`/`provider`), páginas públicas de accept-invitation/reset-password (en agro-score-web).

**Deuda nueva/actualizada:**
- **`POST /admin/analysis/:id/retry` no re-ejecuta el pipeline** — solo deja constancia ("retry requested"). Automatizar el reintento real requiere reconstruir con confianza el input original y agregar guardas de idempotencia/costo — ver sección "Diagnósticos" arriba.
- **No hay "olvidé mi contraseña" autoservicio.** El reset lo sigue disparando un admin (`POST /admin/users/:id/password-reset`) — no existe un endpoint público donde un usuario pida su propio reset por email. Ver `docs/invitation-password-reset-email.md`.
- **No hay endpoint de reenvío** de invitación/reset. Si `emailSent: false` o el email se pierde, la única opción hoy es generar una invitación/token nuevo desde cero.
- `earthEngine` en `/admin/system/health` siempre `not_checked` (documentado, no un bug — ver sección Sistema/health).
- `POST /auth/register` sigue público, sin cambios (deuda ya documentada en `docs/audits/access-request-flow.md`, `AUTH-POLICY-1`). Con el default `role='user'`, no es vector para crear admins.
