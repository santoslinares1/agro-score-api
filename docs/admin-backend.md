# ADMIN-1 — Backend admin (`/admin/*`)

**Fecha:** 2026-08-04
**Contexto:** soporte backend para un futuro panel de administración interno (frontend separado, `agro-score-admin`, FASE 2 — todavía no existe). Esta ficha es solo backend: roles, guards, endpoints de lectura/gestión bajo `/admin/*`, timing de diagnósticos y persistencia de solicitudes de acceso.

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
| GET | `/admin/metrics` | Métricas generales (ver abajo) |
| GET | `/admin/users?page=&limit=&search=` | Lista usuarios (sin `passwordHash`) |
| POST | `/admin/users` | Crea usuario (`fullName`, `email`, `password`, `role`, `isActive?`) |
| PATCH | `/admin/users/:id` | Edita `fullName`/`email`/`role`/`isActive` |
| DELETE | `/admin/users/:id` | Soft delete (`isActive = false`), nunca hard delete |
| GET | `/admin/fields?page=&limit=&search=` | Lista campos con dueño y cantidad de lotes |
| GET | `/admin/lots?page=&limit=&search=` | Lista lotes internos con campo y dueño |
| GET | `/admin/analysis?page=&limit=&status=` | Lista diagnósticos con timing/error |
| GET | `/admin/access-requests?page=&limit=&status=` | Lista solicitudes de acceso de la landing |

Paginación: `page`/`limit` (default 1/20, `limit` máx 100) en todos los listados; `search` donde aplica (email/nombre, nombre de campo/lote, nombre/email/organización); `status` en `analysis` (`Procesando`/`Finalizado`/`Error` — **se mantienen los valores en español ya existentes**, no se migró a `running`/`completed`/`failed` para no romper compatibilidad) y en `access-requests` (`new`/`contacted`/`discarded`).

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
  "latestAccessRequests": []
}
```

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

## Solicitudes de acceso: persistencia nueva

Hasta esta ficha, `POST /access-request` solo enviaba un email (ver `docs/audits/access-request-flow.md`, que dejaba la persistencia explícitamente fuera de alcance). Ahora `AccessRequestService` también guarda cada solicitud en la tabla nueva `access_requests` (entity `src/access-request/entities/access-request.entity.ts`) **antes** de intentar el envío del mail — así queda visible en `/admin/access-requests` aunque Resend falle después. El envío de mail no cambió.

Se agregó `status` (`new` por default, valores `new`/`contacted`/`discarded`) para uso futuro; esta fase solo expone lectura (`GET`), no hay endpoint para cambiarlo todavía.

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

Las 3 migraciones de esta ficha ya se corrieron y verificaron contra la DB local:

1. `1785848336701-AddUserRolesAndActive.ts`
2. `1785848336702-AddAnalysisTimingFields.ts`
3. `1785848336703-CreateAccessRequests.ts`

**Nunca se corrieron contra producción.** Para aplicarlas en producción: mismo `npm run migration:run` con las variables de entorno (`DB_*`, `DATABASE_SSL=true`) apuntando a la DB productiva, como parte del proceso de deploy documentado en `agro-score-api/deploy/aws/README.md` — coordinar el timing con el equipo antes de correrlo ahí.

## CORS para el futuro frontend admin (FASE 2)

No se tocó `.env` real. Cuando `agro-score-admin` tenga dominio (`https://admin.agroscorelatam.com`), sumarlo a `CORS_ORIGIN` en el `.env` de producción **sin sacar los orígenes existentes**:

```
CORS_ORIGIN=https://agroscorelatam.com,https://www.agroscorelatam.com,https://admin.agroscorelatam.com
```

Ver comentario agregado en `.env.example`.

## Tests

- `src/auth/roles.guard.spec.ts` — lógica de `RolesGuard` en aislamiento (sin roles requeridos, sin `request.user`, role `user`/`admin`/`owner`).
- `src/auth/jwt.strategy.spec.ts` — rechaza usuarios con `isActive=false`; el rol devuelto siempre viene de la DB, no del JWT viejo.
- `src/admin/admin.guards.spec.ts` — comportamiento end-to-end de `/admin/metrics` vía supertest sobre un `INestApplication` real, con `JwtAuthGuard` reemplazado por un doble de test (mismo contrato: puebla `request.user` o deniega) y `RolesGuard` real: sin header de test → 403, role `user` → 403, role `admin`/`owner` → 200.
- `src/admin/admin.controller.spec.ts` — metadata: `@UseGuards`/`@Roles` están efectivamente declarados en el controller.
- `src/admin/admin.service.spec.ts` — `createUser` hashea la password y nunca devuelve `passwordHash`; rechaza email duplicado; `listUsers` nunca devuelve `passwordHash`; protección de último owner (degradar rol / desactivar).
- `src/admin/dto/create-admin-user.dto.spec.ts` — acepta payload válido; rechaza rol inválido, email inválido, password corta, `fullName` vacío.

## Qué no se tocó / deuda conocida

- `POST /auth/register` sigue público, sin cambios (deuda ya documentada en `docs/audits/access-request-flow.md`, `AUTH-POLICY-1`). Con el nuevo default `role='user'`, ya no es un vector para crear admins.
- No hay endpoint para cambiar `access_requests.status` todavía (solo lectura, a propósito — "priorizar lectura segura primero").
- No hay reseteo de contraseña desde el admin (`UpdateAdminUserDto` no incluye `password`).
- `agro-score-admin` (frontend) no existe todavía — es FASE 2, explícitamente fuera de esta ficha.
