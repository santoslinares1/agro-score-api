# SECOPS-AUDIT-1 — Auditoría DevOps y seguridad pre-deploy AWS

**Fecha:** 2026-08-03 (actualizado 2026-08-03 tras SEC-FIX-1 — ver [`sec-fix-1.md`](./sec-fix-1.md))
**Alcance:** `agro-score-web` (Angular), `agro-score-api` (NestJS), `agro-score-worker` (FastAPI/Python)
**Tipo:** auditoría de solo lectura. No se tocó lógica de negocio, DB schema, ni migrations. No se hizo deploy. Las únicas escrituras realizadas se listan en la sección "Archivos creados/modificados" al final.
**Metodología:** revisión manual de código (main.ts, guards, DTOs, entities, servicios, Dockerfiles/compose), `grep`/`find` dirigidos a secretos y patrones de riesgo, `npm audit` en web y api, `pip freeze` en worker, inspección de puertos/procesos locales, y ejecución de la suite de validación (tests, build, lint) de cada repo. Todos los hallazgos de código citan archivo:línea verificado directamente o por un segundo pase de spot-check sobre el hallazgo original.

---

## 1. Resumen ejecutivo

AgroScore **no está listo para el deploy a AWS planeado (EC2 + Docker Compose + Nginx + SSL) en su estado actual**. No porque el código de aplicación esté mal — el backend y el frontend muestran patrones de seguridad sólidos en las áreas centrales (ownership, hashing de passwords, CORS, validación de input, sanitización del PDF, sanitización del email de contacto) — sino porque:

1. **La infraestructura de despliegue directamente no existe todavía.** No hay Dockerfile de backend ni de worker, no hay `docker-compose` de producción, no hay configuración de Nginx/SSL en ningún repo. El único artefacto de infraestructura es un `docker-compose.yml` de desarrollo local con un solo servicio (Postgres).
2. **Hay un bloqueante funcional puro:** el build de producción del frontend apunta a una URL placeholder literal (no a un backend real), por lo que un deploy hoy dejaría la aplicación 100% inoperativa para cualquier usuario.
3. **Hay varios huecos de seguridad concretos y accionables** antes de exponer el sistema a internet: un fallback inseguro de `JWT_SECRET`, ausencia total de rate limiting en endpoints públicos (`/auth/login`, `/contact`), ausencia de SSL en la conexión a Postgres, un worker sin ninguna autenticación ni límites de input, y un patrón de `docker-compose.yml` que expone Postgres en todas las interfaces de red con una contraseña de desarrollo.

Ninguno de estos hallazgos requiere reescribir el producto. Son correcciones puntuales y bien delimitadas (ver Plan de remediación, sección 13). El código de negocio (ownership de fields/analysis/PDF, hashing bcrypt, sanitización de HTML/headers en el contacto, guards de rutas) está, en general, bien resuelto — incluso hay evidencia en el propio código (comentarios `AUTH-1` a `AUTH-5`, `PDF-1`) de que brechas anteriores ya fueron identificadas y corregidas en fichas previas.

**Veredicto original: NO LISTO para deploy.** Ver sección 11 para la lista acotada de acciones obligatorias antes de desplegar.

> **Actualización SEC-FIX-1 (2026-08-03):** se corrigieron los bloqueantes de código/config más graves — SEC-001, SEC-002, SEC-003, SEC-004, SEC-017 quedan **resueltos**; SEC-005/SEC-007 quedan **parcialmente mitigados** (límites de input agregados, auth interna del worker sigue pendiente como deuda de `SEC-FIX-2`); SEC-009 (leak de excepciones del worker) quedó resuelto como efecto colateral de la Parte 7. Detalle completo en [`sec-fix-1.md`](./sec-fix-1.md).
>
> **Actualización DEPLOY-AWS-1 (2026-08-03):** se construyó la infraestructura de deploy que faltaba — Dockerfiles de backend y worker (validados con `docker build` real), `docker-compose.prod.yml` (worker y Postgres sin publicar puerto al host), Nginx + guía de Certbot, y documentación completa de deploy a EC2 + actualización de la landing en S3. **SEC-008 y SEC-006 quedan resueltos.** SEC-005 queda mejor mitigado (aislamiento de red real) pero sigue sin auth interna (`SEC-FIX-2`). **Con esto, ya no queda ningún bloqueante de infraestructura pendiente de construir** — lo que resta es ejecutar el deploy real (fuera de alcance de esta ficha, que fue solo de preparación) y la deuda ya documentada. Detalle completo en [`deploy-aws-1.md`](./deploy-aws-1.md).

---

## 2. Alcance

Repos auditados:
- `/media/nuevo_vol/agro-score-web` — Angular 18, frontend público + panel autenticado.
- `/media/nuevo_vol/agro-score-api` — NestJS 11, backend REST, TypeORM/Postgres, JWT, Resend, generación de PDF.
- `/media/nuevo_vol/agro-score-worker` — FastAPI/Python, pipeline de Earth Engine (Sentinel-2), sin persistencia propia.

Fuera de alcance (explícito, según instrucciones de la ficha): cambios de lógica de negocio, cambios de DB schema, migrations, deploy real, llamadas a `/lots` (endpoint legacy deprecado, ver hallazgo SEC-030), comandos destructivos, instalación de herramientas de auditoría pesadas (`pip-audit` no se instaló).

---

## 3. Estado Git de los 3 repos

| Repo | Branch | Working tree | Último commit |
|---|---|---|---|
| `agro-score-web` | `master` | limpio | `cff2db1` chore: remove notebooks from public assets |
| `agro-score-api` | `main` | limpio (antes de esta ficha) | `1b72403` feat: add Resend contact email endpoint |
| `agro-score-worker` | `master` | limpio (antes de esta ficha) | `5a174ca` docs: document AgroScore worker methodology |

**Riesgo de deploy por cambios locales: ninguno.** Los tres working trees estaban limpios al iniciar la auditoría — no hay trabajo sin commitear que pudiera perderse o desplegarse por accidente. Los únicos cambios introducidos por esta ficha son los documentados en la sección "Archivos creados/modificados".

---

## 4. Hallazgos por severidad

Formato: `ID | Severidad | Componente | Resumen | Prioridad`. Detalle completo (evidencia, riesgo, recomendación) en las secciones 5-9.

### Crítico / Bloqueante

| ID | Componente | Resumen | Prioridad | Estado |
|---|---|---|---|---|
| SEC-001 | Frontend | `environment.prod.ts` apunta a una URL placeholder literal, no a un backend real — el build de producción queda 100% no funcional | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** |

### Alto

| ID | Componente | Resumen | Prioridad | Estado |
|---|---|---|---|---|
| SEC-002 | Backend | `JWT_SECRET` tiene fallback inseguro hardcodeado (`'dev-secret-change-me'`) en 2 archivos | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** — fail-fast |
| SEC-003 | Backend | Sin rate limiting en `/auth/login` ni `/contact` (sin `@nestjs/throttler`) | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** |
| SEC-004 | Backend/DB | Sin SSL/TLS configurado en la conexión TypeORM → Postgres | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** — configurable, ver deuda abajo |
| SEC-005 | Worker | Sin ninguna autenticación — `/analyze` es invocable por cualquiera con acceso de red | Antes de deploy | 🟡 **Mejor mitigado (DEPLOY-AWS-1)** — aislamiento de red real; auth interna sigue como deuda `SEC-FIX-2` |
| SEC-006 | Docker/Deploy | `docker-compose.yml` (dev) expone Postgres en `0.0.0.0:5434` con password de desarrollo hardcodeada | Antes de deploy | ✅ **Resuelto en el compose productivo (DEPLOY-AWS-1)** — el compose de dev no se tocó (sigue siendo solo para desarrollo local) |
| SEC-007 | Worker | Sin límites de input (`lots`, `zone_campaign_years`, `n_zones`, `zone_resolution`, dimensiones de imágenes) — riesgo de DoS y abuso de cuota de Earth Engine | Antes de deploy | 🟡 **Parcialmente mitigado (SEC-FIX-1)** — ver detalle |
| SEC-008 | Docker/Deploy | No existe ningún Dockerfile (backend ni worker), ni Nginx, ni SSL, ni compose de producción en ningún repo | Antes de deploy | ✅ **Resuelto (DEPLOY-AWS-1)** — ver `deploy-aws-1.md` |

### Medio

| ID | Componente | Resumen | Prioridad | Estado |
|---|---|---|---|---|
| SEC-009 | Worker | Excepciones internas devueltas crudas al caller (`HTTPException(detail=str(exc))`) | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** |
| SEC-010 | Backend | `POST /fields` no valida el `geojson` de los lotes al crear (sí al editar) | Después de deploy | Abierto |
| SEC-011 | Backend | Sin índices en `fields.userId`, `field_lots.fieldId`, `analysis.fieldId`/`lotId` | Después de deploy | Abierto |
| SEC-012 | Backend | `/auth/logout` no invalida el JWT (sin blacklist); TTL default 7 días | Después de deploy | Abierto (diseño aceptado) |
| SEC-013 | Backend | `CONTACT_EMAIL_DRY_RUN` puede quedar en `true` en producción sin ninguna señal visible | Antes de deploy | Abierto — smoke test post-deploy |
| SEC-014 | Backend | Sin límite de concurrencia de análisis por usuario contra el worker | Después de deploy | Abierto |
| SEC-015 | Worker | `requirements.txt`: 4 paquetes sin pin de versión (`scipy`, `matplotlib`, `scikit-learn`, `pillow`) | Antes de deploy | Abierto |
| SEC-016 | Worker | Faltaba `.env.example` y no había documentación de `GOOGLE_APPLICATION_CREDENTIALS` para producción | Antes de deploy | ✅ Resuelto (SECOPS-AUDIT-1); ampliado en SEC-FIX-1 con los límites nuevos |
| SEC-017 | Backend | Sin `helmet` (cabeceras de seguridad HTTP) | Antes de deploy | ✅ **Resuelto (SEC-FIX-1)** |
| SEC-018 | Frontend | Angular 18.2.x vs 21.x disponible (2 majors); vulnerabilidades High en `npm audit` sobre el framework, sin ruta de explotación confirmada hoy | Después de deploy | Abierto (roadmap) |

### Bajo / Informativo

| ID | Componente | Resumen | Prioridad |
|---|---|---|---|
| SEC-019 | Backend | Endpoints legacy de reporte HTML leen un path de filesystem no saneado (`resultJson.report.htmlPath`) — hoy código inalcanzable | Después de deploy |
| SEC-020 | Backend | CVEs transitivos (`form-data`, `multer`, CLI de `typeorm`) sin ruta de ejecución explotable actual | Después de deploy |
| SEC-021 | Worker | `app/pipeline/report.py` (Playwright + Chromium) es código muerto, no invocado desde el pipeline activo | Después de deploy |
| SEC-022 | Worker | `requiremnts.txt` (typo) es un duplicado desactualizado, trackeado en git | Después de deploy |
| SEC-023 | Docs | `agro-score-web/docs/demo-agroscore.md` tenía una referencia desactualizada a `synchronize: true` | **Resuelto en esta ficha** |
| SEC-024 | Backend | Sin `app.set('trust proxy', ...)` de cara a un ALB/Nginx delante | Después de deploy |
| SEC-025 | Backend | `CONTACT_FROM_EMAIL`/`CONTACT_TO_EMAIL` sin validación de "no vacío" al bootstrap | Después de deploy |
| SEC-026 | Todos | Sin documentación real de deploy (los READMEs son boilerplate) | Antes de deploy (ligado a SEC-008) |
| SEC-027 | Frontend | JWT en `localStorage` — trade-off XSS conocido y documentado, sin XSS explotable hoy | Roadmap |
| SEC-028 | Backend | Fallback silencioso de `FRONTEND_URL`/`PYTHON_WORKER_URL` a `localhost` si falta la env var | Antes de deploy |
| SEC-029 | Frontend | Llamadas de browser a terceros (Google Fonts, ArcGIS, OSM, `apis.datos.gob.ar`) exponen IP del usuario — estándar, informativo | Roadmap |
| SEC-030 | Backend | `/lots` legacy correctamente deprecado (410 Gone antes de tocar datos) — **buena práctica confirmada, no es un hallazgo negativo** | Resuelto |

---

## 5. Backend (NestJS)

### 5.1 Auth / JWT

**SEC-002 [Alto] — Fallback inseguro de `JWT_SECRET`**
- Evidencia: `src/auth/auth.module.ts:19` y `src/auth/jwt.strategy.ts:29` — `secret: config.get<string>('JWT_SECRET') || 'dev-secret-change-me'`.
- Riesgo: si en AWS la variable `JWT_SECRET` no llega a estar seteada (typo en el nombre, error en el manifiesto de secrets, etc.), el backend arranca igual y firma/valida tokens con un secreto público conocido (está en el código fuente del repo). Cualquiera podría forjar un JWT válido para cualquier usuario — bypass total de autenticación. No es explotable sin esa condición previa, pero el fallback no debería existir en el flujo de arranque.
- Recomendación: validar `JWT_SECRET` en el bootstrap (`main.ts`) y abortar el arranque (`process.exit(1)`) si falta, en vez de usar `||` con un valor por defecto.
- **Estado: ✅ resuelto (SEC-FIX-1).** `src/auth/jwt-secret.util.ts` centraliza la resolución (sin fallback) y la usan tanto `auth.module.ts` como `jwt.strategy.ts`; `main.ts` hace `bootstrap().catch(...)` + `process.exit(1)` con un mensaje que nunca imprime el valor del secreto. Cubierto por `jwt-secret.util.spec.ts` (6 tests, incluido uno que verifica que el mensaje de error no contiene ningún valor de secreto).

**SEC-012 [Medio] — Logout no invalida el JWT; TTL default 7 días**
- Evidencia: `src/auth/auth.controller.ts:30-33` (`logout()` solo devuelve `{message:'ok'}`, sin tocar el token); `auth.module.ts:22` `expiresIn: ... || '7d'`.
- Riesgo: es el comportamiento esperado en un esquema JWT stateless sin blacklist — pero un token robado (XSS futuro, laptop comprometida, log accidental) sigue siendo válido hasta por 7 días después del logout.
- Recomendación: documentar esto como decisión de diseño aceptada, o evaluar TTL más corto + refresh token, o blacklist en Redis si el producto lo justifica.
- Estado: abierto (aceptable como está, a decisión de negocio).

**Ownership (`fields`, `analysis`, PDF) — OK, sin hallazgos nuevos.**
`FieldsService.findOne(id, userId)` (`src/fields/fields.service.ts:83-100`) y `AnalysisService.findOneOwned`/`findByField` (`src/analysis/analysis.service.ts:92-122`) validan ownership por `userId` de forma consistente, con default-deny explícito para casos legacy sin Field asociado. Las 3 rutas de reporte (`/analysis/:id/report`, `/report/download`, `/report/pdf`) pasan todas por `findOneOwned` antes de tocar filesystem o generar el PDF. Los comentarios `AUTH-3`/`AUTH-4` en el propio código documentan que hubo una brecha de ownership real en una versión anterior de `findByField`, ya corregida — buena señal de proceso.

**Password hashing — OK.** `bcryptjs`, `SALT_ROUNDS = 10` (`src/auth/auth.service.ts:14,37`) — estándar razonable.

**Logs — OK.** No se encontró ningún `console.log`/`Logger` que incluya passwords o tokens.

**`/auth/me` — OK.** Resuelve por `req.user.sub` (del JWT validado, no de un param manipulable), y `UsersService.toPublicUser` excluye `passwordHash` de la respuesta.

### 5.2 CORS

**OK, sin hallazgos de severidad.**
`src/main.ts:10-20`: `origin: frontendUrl` (desde `FRONTEND_URL`, no `"*"`), `credentials: true`, `exposedHeaders: ['Content-Disposition']` (necesario para que el frontend lea el nombre de archivo del PDF descargado). La combinación origin-único + credentials es la forma correcta; no hay wildcard combinado con credentials.

Ver SEC-028 (informativo) sobre el fallback silencioso a `localhost:4200` si falta `FRONTEND_URL` en producción.

### 5.3 Validación

**ValidationPipe global — OK.** `src/main.ts:22-28`: `whitelist: true, forbidNonWhitelisted: true, transform: true`.

**DTOs — en general bien acotados.** `CreateContactDto` valida email, longitudes máximas (120/160/160/80/2000 caracteres) y `@IsEnum` en `profile`. `CreateFieldDto` valida fechas y `maxCloudiness` (0-100).

**SEC-010 [Medio] — `POST /fields` no valida el `geojson` de los lotes al crear**
- Evidencia: `src/fields/fields.service.ts`, método `create()` (líneas 35-69) guarda `lot.geojson` directo sin llamar a `validateLotGeojson`, a diferencia de `createLot()` (línea 195) y `updateLot()` (línea 161), que sí la invocan. Confirmado por lectura directa del método.
- Riesgo: un `POST /fields` con un `geojson` malformado en algún lote se persiste sin error 400. El problema recién se manifiesta al correr un análisis, donde `PythonWorkerService.extractPolygonCoordinates` lanza un error genérico que se traduce en un `503` engañoso ("no se pudo conectar con el worker") para lo que en realidad es un dato mal cargado. No es una vulnerabilidad de inyección (`geojson` es una columna `jsonb` parametrizada por TypeORM) — es un gap de integridad de datos y calidad de error.
- Recomendación: llamar `validateLotGeojson` también dentro de `create()`, por cada lote, antes de persistir.
- Estado: abierto.

### 5.4 Rate limiting

**SEC-003 [Alto] — Ausencia total de rate limiting**
- Evidencia: sin `@nestjs/throttler` en `package.json`, sin `ThrottlerModule` en `app.module.ts`, sin ningún decorador `@Throttle` en el código (confirmado por `grep`). El propio repo ya lo documenta como deuda pendiente en `docs/contact-email.md:170-176`.
- Riesgo: `POST /auth/login` permite fuerza bruta de credenciales sin fricción (más allá de la latencia de bcrypt). `POST /contact` (público, sin auth) es vulnerable a spam/flood que agote la cuota de envíos de Resend.
- Recomendación: agregar `@nestjs/throttler` (o un rate-limit a nivel de ALB/API Gateway/WAF en AWS) antes de exponer la landing pública, priorizando `/auth/login` y `/contact`.
- **Estado: ✅ resuelto (SEC-FIX-1).** `@nestjs/throttler@6.5.0` instalado; `ThrottlerModule.forRoot(...)` registrado en `app.module.ts` (global, sin `APP_GUARD` — no cambia el comportamiento del resto de la API). `/auth/login` y `/auth/register` con `@UseGuards(ThrottlerGuard)` + `@Throttle({default:{limit:5, ttl:60_000}})`; `POST /contact` con límite de 3/min. Cubierto por tests de metadata en `auth.controller.spec.ts` y `contact.controller.spec.ts`. **Deuda conocida:** storage en memoria del proceso — si el backend corre con más de una réplica en producción, el límite no es efectivo entre instancias sin un storage compartido (Redis); documentado en el comentario de `app.module.ts`.

**SEC-014 [Medio] — Sin límite de concurrencia de análisis por usuario**
- Evidencia: `AnalysisService.runFieldAnalysis` (`src/analysis/analysis.service.ts:186-280`) solo evita duplicar un análisis para el mismo `fieldId` mientras hay uno en estado `'Procesando'`; no hay límite global ni por-usuario de análisis simultáneos contra distintos campos.
- Riesgo: un usuario autenticado con varios campos podría disparar múltiples análisis en paralelo, cada uno reteniendo una conexión HTTP saliente hasta 10 minutos (timeout configurado) contra el worker — no explotable por un atacante externo no autenticado, pero sí un vector de agotamiento de recursos por un usuario legítimo.
- Estado: abierto.

### 5.5 Errores / logs

**OK en general.** No hay `ExceptionFilter` custom, pero el manejador default de NestJS no filtra stack traces al cliente (confirmado — no hay evidencia de fuga, y `NODE_ENV` ni siquiera se referencia en el código, así que el comportamiento no depende de él). `ContactService` responde siempre un mensaje genérico ante error de Resend (`src/contact/contact.service.ts:60-82`), sin exponer detalle interno. `PythonWorkerService.postToWorker` (`src/python-worker/python-worker.service.ts:104-148`) traduce cualquier error del worker a `ServiceUnavailableException` genérica hacia el caller.

Recomendación (Bajo/Informativo, no bloqueante): agregar un `ExceptionFilter` global propio para tener control explícito sobre el formato de error y loguear un ID de correlación por request 5xx.

### 5.6 DB / TypeORM

**`synchronize` — OK, en `false` por default.** `src/app.module.ts:32`: `synchronize: config.get<string>('TYPEORM_SYNCHRONIZE') === 'true'` — solo se activa con opt-in explícito. `src/data-source.ts:33` (usado por el CLI de migraciones) tiene `synchronize: false` hardcodeado.

**Migrations — OK, coherentes.** `src/migrations/1785445140411-InitialSchema.ts` y `1785445240864-FieldsUserIdNotNull.ts` corresponden al esquema actual. La tabla legacy `lots` sigue viva en la DB sin entidad TypeORM asociada — el propio `data-source.ts` (líneas 16-21) ya advierte sobre el riesgo de que un futuro `migration:generate` proponga un `DROP TABLE lots` no intencional. Buena práctica ya documentada en el código; solo hace falta tenerlo presente antes de correr `migration:generate` contra producción.

**SEC-004 [Alto] — Sin SSL en la conexión a Postgres**
- Evidencia: ni `src/app.module.ts` (líneas 18-34) ni `src/data-source.ts` (líneas 23-34) definen `ssl` o `extra.ssl`/`rejectUnauthorized` (confirmado por `grep`, sin resultados).
- Riesgo: si el backend y RDS no quedan en la misma VPC/subred con tráfico garantizado interno, o si la conexión cruza fuera de la red privada en algún escenario, el tráfico Postgres (incluyendo credenciales y datos de usuarios/campos) viaja sin cifrar. Muchas configuraciones de RDS además exigen o recomiendan `sslmode=require`.
- Recomendación: agregar `ssl: { rejectUnauthorized: true, ca: <RDS CA bundle> }` condicionado por env (ej. `DB_SSL=true`), antes de apuntar a RDS.
- **Estado: ✅ resuelto (SEC-FIX-1), configurable.** `src/config/database-ssl.util.ts` (función pura, compartida entre `app.module.ts` y `data-source.ts`) implementa `DATABASE_SSL` (default `false`, compatible con el Postgres de Docker local que no habla TLS) y `DATABASE_SSL_REJECT_UNAUTHORIZED` (default `true` en cuanto `DATABASE_SSL=true`, solo se relaja explícitamente). Cubierto por `database-ssl.util.spec.ts` (5 tests). **Deuda conocida:** no incluye el bundle de CA de RDS (`ca: <...>`) — con `rejectUnauthorized: true` sin `ca` explícito, Node valida contra su trust store por default, que en versiones recientes suele incluir las root CA de Amazon Trust Services, pero conviene confirmarlo contra la instancia RDS real antes de depender de esto en `DEPLOY-AWS-1`.

**SEC-011 [Medio] — Sin índices en columnas de filtrado frecuente**
- Evidencia: sin ningún `@Index` en ninguna entidad (`grep -rn "@Index" src` sin resultados). `Field.userId`, `FieldLot.fieldId`, `Analysis.fieldId`/`Analysis.lotId` (estas últimas `varchar` sueltos, ni siquiera FK) se usan en casi todos los queries de `FieldsService`/`AnalysisService` sin índice de soporte.
- Riesgo: no es un problema de seguridad directo, sino de escalabilidad — con volumen bajo de datos hoy no es perceptible, pero cada query hace sequential scan a medida que crecen las tablas.
- Recomendación: agregar índices sobre `fields.userId`, `field_lots.fieldId`, `analysis.fieldId`, `analysis.lotId` vía una migración nueva (no incluida en esta ficha, según instrucción de no tocar migrations).
- Estado: abierto.

### 5.7 PDF

**OK — implementación sólida, sin hallazgos de severidad relevante.**
- Ownership: doble gate — `analysis.controller.ts:107-125` valida `findOneOwned` antes de invocar `buildReportPdf`, que a su vez vuelve a resolver y validar el Field dueño.
- Generación: `src/analysis/report-pdf/report-pdf.service.ts` usa `pdfmake` con un `docDefinition` **programático** (no HTML-to-PDF) — los valores de usuario se insertan como texto plano, no interpolados en un template HTML, así que no hay superficie de XSS/inyección HTML vía este mecanismo. Además el servicio deniega explícitamente acceso a URLs remotas y a paths locales fuera de un allowlist de 4 fuentes: `pdfMake.setUrlAccessPolicy(() => false)` y `setLocalAccessPolicy(...)` (líneas 97-100) — buena práctica explícita contra SSRF/LFI vía la librería de PDF.

**SEC-019 [Bajo/Informativo] — Endpoints legacy de reporte HTML con path de filesystem no saneado**
- Evidencia: `AnalysisService.getReportPath` (`src/analysis/analysis.service.ts:155-163`) usa `analysis.resultJson?.report?.htmlPath` tal cual en `existsSync`/`createReadStream` (usado por `analysis.controller.ts` en `getReport`/`downloadReport`, líneas 58-102), sin `path.resolve` ni allowlist de directorio base.
- Mitigante confirmado: el worker actual (`app/main.py`, endpoint `/analyze` vigente) **nunca** setea la clave `report` en su respuesta — esa lógica solo existe en `app/pipeline/report.py::generate_report`, que hoy es código muerto (ver SEC-021). Es decir, con el pipeline actual, `resultJson.report` siempre es `undefined` y estos dos endpoints devuelven 404 — inalcanzables en la práctica hoy.
- Riesgo residual: si en el futuro se reactiva ese campo (compatibilidad con análisis migrados, o se reintroduce en el worker) sin sanear el path, un valor con `../` permitiría lectura arbitraria de archivos del filesystem del contenedor backend. El *ownership* del análisis está bien controlado; el *path* en sí no.
- Recomendación: si se mantienen estos endpoints legacy (ya reemplazados funcionalmente por `/analysis/:id/report/pdf`), resolver `reportPath` contra un directorio base fijo y verificar que el resultado quede dentro de ese directorio, o eliminarlos.
- Estado: abierto (riesgo bajo hoy, dead code).

### 5.8 Contact / Resend

**OK — sin hallazgos de severidad relevante.** Revisión completa de `src/contact/contact.service.ts`:
- `RESEND_API_KEY` solo se lee server-side vía `ConfigService`, nunca expuesta al cliente.
- `from` siempre viene de `CONTACT_FROM_EMAIL` (env, no controlable por el usuario); `replyTo` es el email del usuario, saneado. Previene spoofing del remitente.
- `escapeHtml` (líneas 25-32) aplicado a todos los campos de usuario interpolados en el cuerpo HTML del email — previene inyección de markup.
- `sanitizeHeaderValue` (líneas 34-38) quita `\r`/`\n` del `subject` y del `replyTo` — previene CRLF/header injection (ej. inyección de `Bcc:` adicional).

**SEC-013 [Medio] — `CONTACT_EMAIL_DRY_RUN` puede quedar activo en producción sin ninguna señal visible**
- Evidencia: `isDryRun()` (línea 84-86): `return this.config.get<string>('CONTACT_EMAIL_DRY_RUN') !== 'false'` — si la env var falta o tiene cualquier valor distinto del string literal `'false'`, el dry-run queda **activado** (fail-safe: nunca manda un email real por accidente si falta configuración — correcto desde seguridad).
- Riesgo operacional (no de seguridad): si en el deploy de AWS se olvida setear `CONTACT_EMAIL_DRY_RUN=false`, el endpoint `POST /contact` seguirá respondiendo `{ ok: true }` sin haber enviado ningún email real, y nada en la respuesta al usuario lo delata — solo se ve en logs del backend. El formulario de contacto "funcionaría" para el usuario pero nunca llegarían leads al equipo.
- Recomendación: agregar un smoke test post-deploy que confirme `CONTACT_EMAIL_DRY_RUN=false` y `RESEND_API_KEY` seteada; considerar loguear un warning visible al bootstrap si arranca en modo dry-run.
- Estado: abierto.

**SEC-025 [Bajo] — `CONTACT_FROM_EMAIL`/`CONTACT_TO_EMAIL` sin validación de "no vacío" al bootstrap.** Si quedan vacíos, el error recién aparece en el primer request real (logueado server-side, sin exponerse al cliente). Recomendación cosmética: validar al bootstrap para fallar rápido.

### 5.9 Worker calls

**Timeout y manejo de error — OK.** `src/python-worker/python-worker.service.ts:116-125`: `timeout: 600_000` (10 min) en la llamada Axios. `postToWorker` distingue timeout/HTTP-error/red inalcanzable, loguea detalle server-side y traduce siempre a `ServiceUnavailableException` genérica hacia el caller. El flujo async (`processFieldAnalysisInBackground`, fire-and-forget sin `await`) contiene cualquier excepción en su propio `try/catch` y actualiza el análisis a estado `'Error'` — no hay excepciones no capturadas que puedan tumbar el proceso.

**Validación de geometrías — mayormente OK.** `extractPolygonCoordinates`/`closeRing` (`python-worker.service.ts:214-299`) validan forma del GeoJSON y mínimo de coordenadas del anillo antes de mandar al worker. Ver SEC-010 para la excepción puntual (alta inicial de campo).

**SEC-028 [Informativo] — `PYTHON_WORKER_URL` con fallback silencioso a `localhost:8000`.** Mismo patrón que `FRONTEND_URL` en CORS: si falta la env var en AWS, el backend apuntará a un host que no existe en el contenedor de producción — falla de forma visible/logueada (503), no silenciosa, pero vale la pena un warning explícito al bootstrap.

### 5.10 Adicionales (fuera del checklist numerado, relevantes igual)

**SEC-017 [Medio] — Sin `helmet`.** No hay middleware de cabeceras de seguridad HTTP (`grep -rn "helmet" package.json src/main.ts` sin resultados). Mitigación barata y estándar antes del deploy; su ausencia no es explotable por sí sola en esta API JSON pura. **Estado: ✅ resuelto (SEC-FIX-1).** `helmet` instalado y `app.use(helmet())` agregado en `main.ts` antes de `enableCors`. Validado que no rompe CORS/preflight/PDF: 145 tests backend siguen pasando y el frontend (que consume `/analysis/:id/report/pdf` vía `HttpClient` en modo `cors`, no `no-cors`) no se ve afectado por el `Cross-Origin-Resource-Policy: same-origin` default de helmet.

**SEC-024 [Bajo/Informativo] — Sin `app.set('trust proxy', ...)`.** Relevante cuando el backend quede detrás de un ALB/Nginx en AWS: sin esto, `req.ip` reflejará la IP del proxy, no la del cliente real — impacta a futuras implementaciones de rate-limit por IP y a logs de auditoría.

**SEC-030 [Informativo, resuelto/buena práctica] — `/lots` legacy correctamente deprecado.** Los 6 endpoints de `LotsController` (`src/lots/lots.controller.ts`) exigen `JwtAuthGuard` y devuelven `410 Gone` **antes** de tocar cualquier dato (ni siquiera consultan si el id existe). El comentario `AUTH-5` documenta la razón: el modelo `Lot` top-level no tiene relación con Field/User, así que no había forma de validar ownership, y se decidió deprecar en vez de mantener dos modelos de datos paralelos. Esto explica por qué la ficha instruye no llamar a `/lots` — es un endpoint intencionalmente muerto, no algo a arreglar.

**Scripts de `package.json` — sin hallazgos.** Ningún script ejecuta comandos remotos ni con flags destructivos por default. `scripts/backfill-fields-user.ts` tiene dry-run por default (requiere `--apply` explícito) — buen patrón defensivo.

---

## 6. Worker (FastAPI / Python)

### 6.1 Exposición

**SEC-005 [Alto] — Sin ninguna autenticación**
- Evidencia: `app/main.py` no define ningún middleware de auth, API key, ni verificación de origen en el endpoint `POST /analyze`. Tampoco hay CORS configurado (ni abierto ni cerrado — simplemente no existe `CORSMiddleware`), lo cual no es un riesgo de CORS en sí, pero tampoco aporta ninguna barrera.
- Riesgo: cualquiera con acceso de red al puerto 8000 puede invocar `/analyze` directamente, saltándose el backend (y por lo tanto el rate limiting, la autenticación de usuario y el control de ownership que sí existen del lado de NestJS), disparando cómputo de Earth Engine potencialmente costoso.
- Mitigación disponible: si en producción el worker queda 100% en la red interna de Docker Compose sin ningún puerto publicado al host ni a internet, este riesgo queda contenido por aislamiento de red. **Pero hoy no hay ninguna capa de defensa en profundidad adicional si ese aislamiento fallara** (un error de configuración en el compose de producción, por ejemplo).
- Recomendación: (a) garantizar que el worker no publique puerto al host en el compose de producción (`expose` en vez de `ports`), y (b) considerar una capa mínima de autenticación interna (API key compartida entre backend y worker vía env) como defensa en profundidad, ya que es barata de implementar.
- **Estado: 🟡 mejor mitigado (DEPLOY-AWS-1), auth interna sigue sin implementar.** `SEC-FIX-1` solo había documentado la variable `WORKER_INTERNAL_TOKEN=` como deuda. `DEPLOY-AWS-1` implementó la mitigación (a) real: en `deploy/aws/docker-compose.prod.yml` el worker usa `expose: ["8000"]` (nunca `ports:`), así que no hay forma de alcanzarlo desde fuera de la red interna de Docker, ni siquiera con el Security Group mal configurado (el puerto ni siquiera está publicado al host). Sigue sin existir la mitigación (b) — auth interna en sí — documentada como `SEC-FIX-2` en ambos `env.worker.example`.

`/health` sin auth — correcto, es lo esperado para un healthcheck interno de Docker/orquestador.

### 6.2 Input validation

**SEC-007 [Alto] — Sin límites de input**
- Evidencia (`app/main.py`, clase `AnalyzePayload`, y `app/pipeline/schemas.py`, `app/pipeline/analysis.py` — confirmado con `grep` de los campos relevantes en `analysis.py`):
  - `lots: list[LotPayload]` sin máximo de elementos.
  - `zone_campaign_years: list[int]` sin cap — coincide con un hallazgo ya conocido de una auditoría de performance previa (causa raíz de análisis lentos).
  - `n_zones`, `zone_resolution`, `scale`, `map_dimensions`, `index_image_dimensions` son ints controlados por el cliente sin ningún bounds-checking visible.
- Riesgo: superficie de resource-exhaustion/DoS — un caller (autenticado o, si SEC-005 no se mitiga, no autenticado) podría pedir resoluciones/dimensiones enormes o listas de lotes/años enormes y consumir CPU/memoria/cuota de Earth Engine sin límite. Sin timeout configurado en el propio endpoint del worker (el timeout de 10 min está del lado del backend que lo llama, no del worker en sí).
- Recomendación: agregar validadores Pydantic con máximos razonables (`max_length` en listas, rangos en ints) antes del deploy.
- **Estado: 🟡 parcialmente mitigado (SEC-FIX-1).** `app/limits.py` (nuevo) valida, antes de tocar Earth Engine: `lots` no vacío y `len(lots) <= AGROSCORE_MAX_LOTS` (default 50); coordenadas totales `<= AGROSCORE_MAX_GEOMETRY_COORDINATES` (default 5000) con validación básica de forma (mínimo 3 puntos por lote, `[lon, lat]` numéricos en rango geográfico válido); `len(zone_campaign_years) <= AGROSCORE_MAX_CAMPAIGNS` (default 8); rango de fechas válido y `<= AGROSCORE_MAX_DATE_RANGE_DAYS` (default 366); `0 <= max_cloud_pct <= AGROSCORE_MAX_CLOUDINESS` (default 80). Violaciones devuelven `HTTP 400` con mensaje claro (antes cualquier error terminaba en `500`). **Sigue sin acotar** `n_zones`, `zone_resolution`, `map_dimensions`, `index_image_dimensions` (fuera del alcance explícito de SEC-FIX-1) — evaluar en una ficha posterior si hace falta. Verificado manualmente con 12 casos (payload válido, cada límite violado individualmente, geometría inválida) corriendo `app/limits.py` directo con el intérprete del venv — no se instalaron `pytest`/`httpx` (no estaban ya presentes, y la ficha no autorizaba instalarlos), así que no quedaron tests automatizados en el repo del worker.

### 6.3 Earth Engine credentials

`init_earth_engine()` (`app/pipeline/gee_indices.py:8-21`) usa `ee.Initialize(project=...)` con `EARTH_ENGINE_PROJECT`/`EE_PROJECT_ID` desde env — no hay ningún path a un JSON de service account hardcodeado en el código (bien). No se loguean credenciales en ningún punto (confirmado por el grep de secretos general, sin hits reales en el worker).

**SEC-016 [Medio, resuelto en esta ficha] — Faltaba documentación operacional.** El worker no tenía `.env.example`, y `GOOGLE_APPLICATION_CREDENTIALS` (la variable estándar que consume la librería `google-auth` internamente) no estaba documentada en ningún lado del repo. Se creó `agro-score-worker/.env.example` documentando `EARTH_ENGINE_PROJECT`, `EE_PROJECT_ID` y `GOOGLE_APPLICATION_CREDENTIALS` con guía de montaje como secreto de solo lectura (ver sección "Archivos creados/modificados"). Pendiente real para antes de deploy: decidir e implementar el mecanismo de montaje del service account JSON en el contenedor de producción (no se implementó en esta ficha, es un cambio de infraestructura).

### 6.4 Performance / DoS

Ver SEC-007. Adicional: no hay timeout propio configurado dentro del worker para la llamada a Earth Engine — si una consulta a EE se cuelga, la request puede quedar atascada hasta que el timeout de 10 minutos del lado del backend la corte, reteniendo recursos del worker mientras tanto.

### 6.5 Logs

**OK.** `logging.basicConfig(level=INFO)` + logs `[PERF]` con métricas de tiempo (`init_ee`, `timeseries`, `zones`, `rgb` — `app/pipeline/analysis.py:85-99`). No se encontró logging de payloads completos ni de secretos.

### 6.6 Docker

**SEC-008 [Alto] — Sin Dockerfile, sin `.dockerignore`.** Ver sección 7 (Docker/Compose/Deploy) para el detalle consolidado — este gap aplica igual a backend y worker.

### 6.7 Hallazgos adicionales del worker

**SEC-009 [Medio] — Excepciones internas expuestas crudas al caller**
- Evidencia: `app/main.py`, endpoint `/analyze`: `except Exception as exc: raise HTTPException(status_code=500, detail=str(exc)) from exc`.
- Riesgo: cualquier excepción (incluyendo mensajes internos de Earth Engine, paths de archivos, detalles de librerías) se devuelve tal cual en el body de la respuesta HTTP. Mitigado parcialmente si el worker queda estrictamente interno (SEC-005), pero sigue siendo una violación del principio de no exponer internals — relevante también para el propio backend, que hoy recibe ese `detail` y lo loguea (no lo reenvía al cliente final, ver sección 5.9), pero conviene corregirlo en origen.
- Recomendación: capturar la excepción, loguearla completa server-side, y devolver un mensaje genérico al caller.
- **Estado: ✅ resuelto (SEC-FIX-1)**, como efecto colateral de la Parte 7. El bloque `except Exception` en `/analyze` ahora hace `logger.exception(...)` (log completo server-side, con traceback) y responde `HTTPException(500, "No se pudo completar el análisis...")` — mensaje genérico, sin `str(exc)` crudo.

**SEC-015 [Medio] — Dependencias sin pin de versión.** `requirements.txt`: `scipy`, `matplotlib`, `scikit-learn`, `pillow` no tienen versión fijada, a diferencia de todo el resto del archivo. Riesgo de build no reproducible entre entornos/tiempos. Recomendación: pinear las 4 antes del deploy (`pip freeze` ya capturó las versiones actualmente instaladas — ver sección 9).

**SEC-021 [Bajo] — Código muerto: `app/pipeline/report.py`.** Usa `playwright.sync_api` (Chromium headless) para generar un PDF vía HTML-to-PDF, pero `generate_report`/`build_html_report` no son importados desde ningún otro punto del pipeline activo (confirmado por `grep` — sin resultados fuera del propio archivo). El PDF real del producto se genera del lado del backend NestJS con `pdfmake` (ver sección 5.7, `PDF-1`). Esto es un remanente de una arquitectura anterior que mantiene una dependencia pesada (Playwright + Chromium) sin uso, aumentando innecesariamente el tamaño de imagen Docker futura y la superficie de ataque. Recomendación: eliminar `report.py` y la dependencia `playwright` de `requirements.txt` en una ficha de limpieza (no se tocó en esta auditoría por ser un cambio funcional, aunque de riesgo bajo).

**SEC-022 [Bajo] — `requiremnts.txt` (typo) duplicado desactualizado.** Archivo trackeado en git, le faltan `scipy`/`matplotlib`/`scikit-learn`/`pillow` respecto a `requirements.txt`. Puede confundir a quien arme el Dockerfile de producción si usa el archivo equivocado por el nombre similar. Recomendación: eliminarlo (no se hizo en esta ficha por ser una eliminación de archivo, fuera del set de cambios "riesgo cero" definido para esta auditoría).

---

## 7. Frontend (Angular)

### 7.1 Secrets

**SEC-001 [Crítico] — `apiUrl` de producción es un placeholder literal**
- Evidencia: `src/environment/environment.prod.ts:4` — `apiUrl: 'https://REEMPLAZAR-CON-URL-BACKEND-PRODUCCION'` (con un comentario `TODO` explícito en la línea anterior). `angular.json` reemplaza `environment.ts` por este archivo en la config `production` vía `fileReplacements`.
- Riesgo: si se despliega el build de producción tal cual, login, registro, fields, analysis y el formulario de contacto intentarán pegarle a un host que no existe — la aplicación queda completamente no funcional. No es una fuga de secreto ni una vulnerabilidad de seguridad; es un bloqueante operacional puro. Se clasifica como Crítico por su efecto (app 100% caída), no por explotabilidad.
- Recomendación: reemplazar por la URL real del backend en AWS antes de generar el build de producción que se despliegue.
- Estado: abierto.

**Resto de la sección — OK.** `apiUrl` es el único punto de configuración pública, usado consistentemente por los 4 servicios que llaman al backend (`auth.service.ts`, `contact.service.ts`, `analysis.service.ts`, `fields.service.ts`). Sin API keys, credenciales de Resend, ni URLs internas de DB/worker en ningún archivo de `src/`. `public/` contiene únicamente 5 archivos legítimos (favicon + 4 assets de marca), todos referenciados desde `index.html` — confirma que la limpieza de notebooks de la ficha anterior (`PUBLIC-CLEANUP-1`) se mantiene vigente.

**SEC-029 [Informativo]** — el navegador del usuario final hace requests directos a Google Fonts, tiles de ArcGIS/OpenStreetMap, y `apis.datos.gob.ar` (georreferenciación) — exposición estándar de IP a terceros por el uso de esas librerías/APIs, sin acción requerida.

### 7.2 Auth

**OK, sin hallazgos de severidad.**
- Token en `localStorage` bajo `TOKEN_KEY = 'agroscore_access_token'` (`src/app/core/services/auth.service.ts:12`), agregado al header `Authorization: Bearer` por el interceptor (`auth.interceptor.ts:18-22`) — nunca viaja por query string ni body.
- `logout()` limpia la sesión del lado cliente aunque la llamada al backend falle (`auth.service.ts:81-93`).
- El interceptor maneja `401` explícitamente: limpia el token y redirige a `/login` (`auth.interceptor.ts:24-33`) — cubre el caso de recarga con token inválido/expirado.
- El guard de rutas (`src/app/core/guards/auth.guard.ts`) es correctamente solo una barrera de UX/routing en el cliente — toda autorización real ocurre en el backend vía el Bearer token. Esto es el diseño esperado, no un hallazgo.

**SEC-027 [Informativo] — JWT en `localStorage`.** Riesgo teórico de robo vía XSS (a diferencia de una cookie `httpOnly`). No se encontró ningún vector de XSS explotable en el código actual (ver 7.3), así que hoy es un trade-off latente, no explotado. Mejora futura de roadmap: cookie `httpOnly` + `SameSite`.

### 7.3 XSS

**OK, sin hallazgos.** Cero usos de `[innerHTML]`/`bypassSecurityTrust*` en templates o componentes reales (los únicos usos de `innerHTML` en el repo están en tests, como lectura de snapshot, nunca como escritura). El formulario de contacto tiene validación de longitud/formato/campos requeridos en el template (`maxlength` entre 80 y 2000 caracteres según campo, `type="email"`, `required`), con `.trim()` antes de armar el payload — la sanitización de fondo recae correctamente en el backend (ver 5.8), que ya la implementa.

### 7.4 Routing

**OK, sin hallazgos.** `src/app/app.routes.ts`: guard aplicado a nivel del padre `path: 'app'` (protege automáticamente dashboard/fields/analysis y sus hijos), rutas públicas (`login`, `register`, landing) sin guard, wildcard `{ path: '**', redirectTo: '' }` presente. Las rutas legacy `lots/*` quedan bajo el mismo guard antes de redirigir a `fields`.

### 7.5 SEO / public assets

**OK, sin hallazgos.** `index.html` con title/description/OG/Twitter Card completos y coherentes con los assets reales en `public/brand/`, favicon presente, `lang="es-AR"`. Confirma el trabajo de la ficha `SEO-OG-1` sigue vigente.

### 7.6 Dependencies

Clasificación runtime/dev correcta en `package.json` — ninguna librería de testing (jasmine/karma) ni tooling de build está mal ubicada en `dependencies`.

**SEC-018 [Medio] — Angular 18.2.x vs 21.x disponible.** Todo el stack `@angular/*` (core, common, forms, router, platform-browser, animations, compiler) está 2 majors detrás. `npm audit` reporta vulnerabilidades **High** sobre estos paquetes directos de producción. El propio repo ya tiene un análisis detallado y fechado de esto en `docs/audits/npm-audit-frontend.md` (2026-08-02), que concluye — y esta auditoría lo confirma de forma independiente vía la sección 7.3 (sin `[innerHTML]`/`bypassSecurityTrust*` en el código) — que **ninguna de esas vulnerabilidades tiene ruta de explotación directa confirmada** contra el código actual de AgroScore, dado que no usa SSR/hydration ni renderiza HTML dinámico desde datos de usuario. Es deuda técnica real que requiere planificación de upgrade mayor, no un bloqueante de seguridad inmediato. Ver sección 9 para el detalle numérico actualizado de esta ficha.

Sourcemaps de producción: confirmado que **no** están activos en el build de producción (`angular.json`, config `production`, sin `sourceMap` explícito → default `false` del builder) — sin riesgo de filtrar código fuente vía sourcemaps.

---

## 8. Docker / Deploy AWS

Este es el hallazgo estructural más importante de la auditoría: **la infraestructura de despliegue todavía no existe**, en ningún repo. No se trata de config existente insegura que haya que corregir — es trabajo de cero que hay que construir con seguridad incorporada desde el inicio.

**SEC-008 [Alto] — Sin Dockerfiles, sin Nginx, sin SSL, sin compose de producción**
- Evidencia: `find` recursivo (excluyendo `node_modules`/`.git`/`venv`) no encontró ningún `Dockerfile` en `agro-score-api`, `agro-score-worker` ni `agro-score-web`. El único artefacto de infraestructura en los 3 repos es `agro-score-api/docker-compose.yml`, y solo define el servicio `postgres` (para desarrollo local) — no define backend, no define worker, no define Nginx. No hay `.dockerignore` en ningún repo. No hay `nginx.conf`, ni configuración de Certbot/SSL en ningún lugar. Los README de los 3 repos no contienen un plan de deploy real (el de `agro-score-api` es el boilerplate default de NestJS, mencionando la plataforma comercial "Mau" de NestJS, no AWS EC2; `agro-score-worker` no tiene README).
- Implicación directa: el plan de deploy (EC2 + Docker Compose + Nginx + SSL) descrito en la ficha **no tiene ningún artefacto construido todavía**. Es el prerequisito bloqueante número uno antes de cualquier otro paso de deploy.
- Recomendación: ficha dedicada (`DEPLOY-AWS-1`, propuesta en sección 14) para construir Dockerfile de backend (multi-stage, `npm ci --omit=dev`, usuario no-root, sin copiar `.env`), Dockerfile de worker (idealmente basado en una imagen con dependencias geoespaciales ya optimizadas, usuario no-root, sin `report.py`/Playwright si se limpia primero — ver SEC-021), `docker-compose.prod.yml` con los 4 servicios (postgres, backend, worker, nginx) y networking interno, y configuración de Nginx + Certbot.
- **Estado: ✅ resuelto (DEPLOY-AWS-1).** `Dockerfile` multi-stage en backend (Node 24, `npm ci --omit=dev` en runtime, usuario no-root `agroscore`, sin copiar `.env`) y en worker (Python 3.12-slim, usuario no-root, sin copiar `.env` ni credenciales JSON) — ambos con `.dockerignore`, ambos validados con `docker build` real y smoke test de arranque. `deploy/aws/docker-compose.prod.yml` con backend + worker + Postgres (Opción B) y red interna Docker; Nginx solo proxyea al backend (`deploy/aws/nginx/agroscore-api.conf`), nunca al worker ni a Postgres. Guía de Certbot en `deploy/aws/README.md`. Detalle completo, incluidos varios hallazgos nuevos encontrados al construir esto (ruta real del build compilado, nombres reales de env vars, gap de `.gitignore`), en [`deploy-aws-1.md`](./deploy-aws-1.md).

**SEC-006 [Alto] — Patrón de exposición de Postgres en el compose existente**
- Evidencia: `docker-compose.yml:6-12` — `POSTGRES_PASSWORD: agro_password` hardcodeada, puerto publicado como `"5434:5432"`. Confirmado en el entorno de desarrollo actual: `ss -ltn` muestra el puerto escuchando en `0.0.0.0:5434` y `[::]:5434` (todas las interfaces), no solo `127.0.0.1`, que es el comportamiento default de Docker Compose para `ports:` a menos que se especifique el bind explícitamente (`"127.0.0.1:5434:5432"`).
- Riesgo: es el único compose existente en el repo, y el más probable candidato a copiarse/extenderse para producción. Si se reutiliza tal cual en el EC2 de producción sin ajustar el bind y sin que el Security Group bloquee el puerto 5432/5434 desde internet, Postgres quedaría expuesto públicamente con una contraseña de desarrollo conocida.
- Recomendación: en el compose de producción, Postgres no debe publicar puerto al host en absoluto (los otros servicios lo alcanzan por la red interna de Docker); si se necesita acceso puntual para debug, bindear explícitamente a `127.0.0.1` y nunca reusar la password de dev. Evaluar RDS en vez de Postgres en contenedor para producción (ver checklist DB abajo).
- **Estado: ✅ resuelto en el compose productivo (DEPLOY-AWS-1).** `deploy/aws/docker-compose.prod.yml` define Postgres (Opción B, temporal) con `expose: ["5432"]` únicamente — sin `ports:`, sin exposición a `0.0.0.0` ni a `127.0.0.1`. La Opción A (recomendada) es RDS externo, documentada en `deploy/aws/README.md`. El `docker-compose.yml` de desarrollo local (raíz del repo, no `deploy/aws/`) sigue igual — sigue siendo explícitamente solo para dev, nunca pensado para reutilizarse en prod.

### Checklist de producción EC2 (a implementar, no existe todavía — ninguno de estos puntos tiene código/config hoy)

1. **Security Group:** 22 solo desde IP propia; 80/443 públicos; 3001 (backend), 8000 (worker) y 5432/5434 (Postgres) **no públicos** — deben quedar accesibles solo vía la red interna de Docker/Nginx.
2. **Nginx:** proxy reverso solo hacia el backend (nunca directo al worker), `client_max_body_size` acorde al payload más grande esperado (ej. GeoJSON de campos grandes), headers `X-Forwarded-*`, SSL vía Certbot, redirect HTTP→HTTPS forzado.
3. **Docker:** backend publicado solo en `127.0.0.1:3001` (Nginx hace el proxy desde ahí), worker con `expose` interno (sin `ports`), Postgres sin puerto publicado (o RDS), `restart: unless-stopped`, sin secretos copiados dentro de las imágenes (todo por env/secrets montados).
4. **DB:** se recomienda RDS para producción antes que Postgres en contenedor. Si se mantiene Postgres en Docker como paso intermedio: volumen persistente (ya existe: `agro_score_postgres_data`), backup periódico, sin puerto expuesto, password fuerte distinta de la de desarrollo, plan de migración a RDS documentado.
5. **Backups:** dump periódico de Postgres, política de retención, prueba de restore — nada de esto existe todavía; a definir en la ficha de deploy o una ficha `BACKUP-1` dedicada.
6. **Observabilidad:** logs de Docker gestionables (rotación), healthchecks (`/health` ya existe en el worker; falta confirmar/agregar uno equivalente en el backend), alertas básicas, monitoreo de disco/memoria — no implementado, CloudWatch queda como mejora futura (`OBSERVABILITY-1`).

---

## 9. Dependencias

### Frontend (`agro-score-web`)
`npm audit` (ejecutado hoy, solo lectura, sin `--fix`): **65 vulnerabilidades** (3 critical, 37 high, 17 moderate, 8 low). `metadata.dependencies`: **15 de producción** vs. **1227 de desarrollo** (más 100 optional, 6 peer) — el 98% del árbol resuelto es tooling de build/test (`webpack-dev-server`, `karma`, `@angular/cli` y su cadena de firma de paquetes), no código que llega al navegador. Las vulnerabilidades **critical/high** puntuales inspeccionadas (`websocket-driver`, `ws`, `engine.io`, `socket.io-adapter`, `webpack`) están todas bajo `webpack-dev-server` — dev-only. El repo ya tiene un análisis dedicado y más detallado en `docs/audits/npm-audit-frontend.md` (fechado 2026-08-02, 63 vulnerabilidades en esa fecha — la diferencia de 2 hoy es esperable por advisories nuevos entre esa fecha y esta auditoría); ver SEC-018 para el hallazgo real de esa categoría (Angular framework 2 majors detrás).

Clasificación:
- **Alto/runtime real:** `@angular/*` (framework, en `dependencies`) — SEC-018, requiere upgrade mayor planificado.
- **Alto/dev-only:** todo el resto (websocket-driver, ws, webpack, cadena de `@angular/cli`) — no llega a producción.
- **No se ejecutó `npm audit fix`** (ni `--force`), según instrucción explícita de la ficha.

### Backend (`agro-score-api`)
`npm audit`: **10 vulnerabilidades** (0 critical, 7 high, 1 moderate, 2 low). `metadata.dependencies`: 239 prod, 576 dev.
- `form-data@4.0.0-4.0.5` (high, CRLF injection en multipart) — transitiva de `axios` (sí es runtime), pero `axios` en este código solo se usa para enviar JSON (`httpService.post`), nunca multipart — vulnerabilidad presente pero fuera del camino de ejecución actual.
- `multer` (high, DoS) — transitiva de `@nestjs/platform-express` (runtime), pero confirmado que no hay ningún `FileInterceptor`/`UploadedFile` en el código — no hay endpoint de upload que la dispare.
- `typeorm >=1.0.0 <1.1.0` (moderate, code injection en `migration:generate`) — confirmado que `typeorm@1.0.0` es el paquete legítimo (`repository: github.com/typeorm/typeorm`, autor "TypeORM", no un typosquat). El bug afecta solo al CLI de generación de migraciones corrido manualmente por un dev, no al runtime de la API.
- `fast-uri`, `brace-expansion`, `js-yaml` — transitivas de devDependencies (`@nestjs/cli`, `jest`, `eslint`), no se empaquetan en `dist/`.
- **Ninguna vulnerabilidad crítica; las de mayor severidad (`form-data`, `multer`) están en el árbol de producción pero no en un path de código alcanzable hoy.** Recomendación: correr `npm audit fix` en una ficha aparte (no en esta auditoría) y fijar un proceso de actualización periódica.

### Worker (`agro-score-worker`)
`pip freeze` ejecutado sobre el venv existente (49 paquetes, todos con versión pineada salvo los 4 ya señalados en SEC-015). **`pip-audit` no está instalado y no se instaló** (instrucción explícita de no instalar herramientas pesadas sin permiso) — no se pudo correr un scan automático de CVEs de Python. Limitación a documentar: antes de producción, correr `pip-audit` o `safety` (con autorización expresa) contra `requirements.txt`, idealmente integrado a CI.

Paquetes de mayor superficie a vigilar manualmente por su naturaleza (sin que esto sea un hallazgo de CVE confirmado, solo una nota de atención): `earthengine-api`, `google-cloud-storage`, `cryptography`, `playwright` (este último candidato a eliminarse por SEC-021).

---

## 10. Secretos

Resumen (detalle de cada punto ya cubierto en las secciones anteriores):

- **Ningún `.env` real está trackeado en git en ninguno de los 3 repos** — confirmado con `git ls-files` en cada uno; solo `.env.example` aparece trackeado en `agro-score-api` y `agro-score-worker` (este último, agregado en esta ficha — ver SEC-016). `agro-score-web` no usa `.env` (usa `src/environment/*.ts`).
- `.gitignore` de `agro-score-api` y `agro-score-worker` cubren correctamente `.env`, `.env.*` y (en worker) `venv/`/`.venv/`.
- **No se encontró ningún secreto real hardcodeado** en código trackeado en ningún repo (grep de `SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY|RESEND|GOOGLE_APPLICATION_CREDENTIALS|JWT|DATABASE_URL|DB_PASSWORD|smtp|key.json|service_account|BEGIN PRIVATE KEY` sobre los 3 repos). Las coincidencias fueron todas: nombres de variables de entorno referenciadas vía `config.get()`/`os.getenv()` (correcto), contenido de `.env.example` (sin valores reales, `RESEND_API_KEY=` vacío), y documentación (`docs/contact-email.md`) que explícitamente advierte no commitear el secreto real.
- **Único hallazgo real de esta categoría: SEC-002** (JWT_SECRET con fallback hardcodeado — no es un secreto *real* filtrado, es un secreto *de repuesto* públicamente conocido que podría terminar siendo el real por omisión).
- `docker-compose.yml` tiene una password de Postgres hardcodeada, pero es explícitamente de desarrollo local (coincide con `.env.example`) — el riesgo real está en que ese mismo patrón se reutilice en producción sin cambios (ver SEC-006), no en que la password en sí esté "filtrada" (es una password de dev conocida a propósito).
- No se encontraron archivos `.pem`, `.key`, `*service*account*.json`, `*credentials*.json` ni `*secret*.json` trackeados ni presentes fuera de git en ningún repo, salvo los `.env` reales (correctamente gitignored, no trackeados).

**Clasificación final de secretos: sin hallazgos Crítico. SEC-002 (JWT fallback) es Alto y ya está contabilizado en la sección 4/5.1.**

---

## 11. Recomendaciones antes de producción (obligatorias)

Lista acotada — resolver estas antes de desplegar a AWS. Estado actualizado tras `SEC-FIX-1` (2026-08-03):

1. ~~**SEC-001** — Reemplazar el placeholder de `environment.prod.ts`...~~ ✅ **Resuelto (SEC-FIX-1).**
2. ~~**SEC-002** — Eliminar el fallback `'dev-secret-change-me'` de `JWT_SECRET`...~~ ✅ **Resuelto (SEC-FIX-1).**
3. **SEC-008 + SEC-006** — Construir Dockerfile de backend, Dockerfile de worker, `docker-compose.prod.yml` (sin exponer Postgres/worker al host) y configuración de Nginx + SSL. **Sigue abierto — es el prerequisito de infraestructura completo y el único gran bloqueante restante, alcance de `DEPLOY-AWS-1`.**
4. ~~**SEC-003** — Agregar rate limiting...~~ ✅ **Resuelto (SEC-FIX-1).**
5. ~~**SEC-004** — Configurar SSL en la conexión TypeORM → Postgres...~~ ✅ **Resuelto (SEC-FIX-1)**, configurable vía `DATABASE_SSL`; falta habilitarlo (`DATABASE_SSL=true`) recién cuando exista la RDS real.
6. **SEC-005 + SEC-007** — Aislar el worker de la red pública y agregar límites de input. 🟡 **Parcialmente resuelto:** los límites de input están (SEC-FIX-1); el aislamiento de red depende de `DEPLOY-AWS-1` y la autenticación interna queda como deuda explícita `SEC-FIX-2`.
7. ~~**SEC-009** — Que el worker no devuelva `str(exc)` crudo al caller...~~ ✅ **Resuelto (SEC-FIX-1)**, como parte de la Parte 7.
8. **SEC-013** — Verificar explícitamente en el smoke test post-deploy que `CONTACT_EMAIL_DRY_RUN=false` y `RESEND_API_KEY` estén seteadas correctamente. **Sigue abierto** (es un smoke test post-deploy, no aplicable todavía).
9. **SEC-015 + SEC-016** — Pinear las 4 dependencias sueltas del worker (sigue abierto) y decidir/documentar el mecanismo de montaje del service account de Earth Engine (documentado en `.env.example`, falta implementar el montaje real en `DEPLOY-AWS-1`).
10. ~~**SEC-017** — Agregar `helmet()` en el backend...~~ ✅ **Resuelto (SEC-FIX-1).**

**Quedan como únicos bloqueantes reales antes de deploy: el punto 3 (infraestructura, `DEPLOY-AWS-1`) y, en menor medida, 6/8/9 (deuda documentada, no bloqueante de por sí si el worker queda correctamente aislado de red en `DEPLOY-AWS-1`).**

## 12. Recomendaciones post-producción (no bloqueantes)

- SEC-010 (validar geojson también en alta de campo), SEC-011 (índices DB), SEC-012 (revisar TTL/blacklist de JWT), SEC-014 (límite de concurrencia de análisis), SEC-018 (upgrade mayor de Angular, planificado), SEC-019 (sanear o eliminar endpoints legacy de reporte HTML), SEC-020 (actualizar dependencias con CVE transitivo cuando haya ventana), SEC-021/SEC-022 (limpieza de código muerto en el worker), SEC-024 (`trust proxy`), SEC-025 (validar env de contacto al bootstrap), SEC-028 (warnings de bootstrap si faltan `FRONTEND_URL`/`PYTHON_WORKER_URL`).
- Roadmap de mejora (sin urgencia): SEC-027 (evaluar cookie `httpOnly` para el JWT del frontend), backups automatizados y prueba de restore, observabilidad con CloudWatch, migración de Postgres en Docker a RDS.

## 13. Plan de remediación por fases

**Fase 0 — Bloqueante de infraestructura (antes de cualquier otra cosa):** SEC-008 (Dockerfiles + compose de producción + Nginx/SSL). Sin esto no hay dónde desplegar.

**Fase 1 — Bloqueantes de seguridad y funcionalidad (previo a exponer a internet):** SEC-001, SEC-002, SEC-003, SEC-004, SEC-005, SEC-006, SEC-007, SEC-009, SEC-013, SEC-015, SEC-016, SEC-017.

**Fase 2 — Endurecimiento post-deploy inmediato (primeras semanas):** SEC-010, SEC-011, SEC-014, SEC-024, SEC-025, SEC-028, backups (checklist sección 8), observabilidad básica.

**Fase 3 — Deuda técnica y roadmap:** SEC-012 (revisión de diseño JWT), SEC-018 (upgrade Angular), SEC-019/SEC-020/SEC-021/SEC-022 (limpieza), SEC-027 (cookie httpOnly), migración a RDS.

---

## 14. Próximas fichas propuestas

- ~~**SEC-FIX-1**~~ — ✅ Implementado 2026-08-03 (JWT fail-fast, throttler, SSL DB configurable, límites del worker, helmet, manejo de excepciones del worker). Ver [`sec-fix-1.md`](./sec-fix-1.md).
- ~~**DEPLOY-AWS-1**~~ — ✅ Preparación completa 2026-08-03 (Dockerfiles, `docker-compose.prod.yml`, Nginx + guía Certbot, doc de deploy a EC2 y de actualización de landing S3). **No incluyó el deploy real** — eso es el próximo paso operativo, no una ficha de código. Ver [`deploy-aws-1.md`](./deploy-aws-1.md).
- **SEC-FIX-2** — Autenticación interna backend↔worker (`WORKER_INTERNAL_TOKEN` / header `X-Worker-Token`, documentado pero no implementado) + resto de hallazgos Medio no bloqueantes (SEC-010, SEC-011, SEC-012, SEC-014, SEC-015).
- **OBSERVABILITY-1** — Healthchecks del backend (ya existe `/health` desde `DEPLOY-AWS-1`), logs gestionables, alertas básicas, CloudWatch.
- **BACKUP-1** — Estrategia de backup de Postgres (dump periódico, retención, prueba de restore) y evaluación de migración a RDS.

---

## Archivos creados/modificados en esta ficha

Todos de riesgo cero (documentación / `.env.example`), según lo autorizado explícitamente en el alcance de esta auditoría:

- **Creado:** `agro-score-worker/.env.example` — documenta `EARTH_ENGINE_PROJECT`, `EE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` (sin valores reales). Antes no existía ningún `.env.example` en ese repo (SEC-016).
- **Modificado:** `agro-score-web/docs/demo-agroscore.md` — corregida una línea desactualizada que decía `synchronize: true crea las tablas solo con levantar el backend`; el código actual usa migrations con `TYPEORM_SYNCHRONIZE` en `false` por default (SEC-023).
- **Creado:** `agro-score-api/docs/audits/secops-audit.md` — este documento.

No se modificó ningún archivo de código de negocio, DTO, entidad, guard, servicio, DB schema, ni migration. No se instaló ningún paquete nuevo en ningún repo (ni `pip-audit`, ni `@nestjs/throttler`, ni `helmet` — todos quedan como recomendación para `SEC-FIX-1`).

---

## Validación ejecutada

| Repo | Comando | Resultado |
|---|---|---|
| Backend | `npm test` | ✅ 12 test suites, 130 tests — todos pasaron |
| Backend | `npm run build` (`nest build`) | ✅ sin errores |
| Frontend | `npx tsc --noEmit` | ✅ sin errores de tipo |
| Frontend | `npm run build` (`ng build`) | ✅ build de producción generado (1 warning no relacionado a seguridad: `leaflet` no es ESM puro, causa optimization bailout menor) |
| Frontend | `ng test --watch=false --browsers=ChromeHeadless` | ✅ 167/167 tests — todos pasaron |
| Frontend | `ng lint` | ✅ "All files pass linting" |
| Worker | `git status --short` | ✅ limpio (solo el `.env.example` nuevo de esta ficha) |
| Worker | `docker build -t agro-score-worker-audit .` | ❌ falla — no existe `Dockerfile` en el repo (confirma SEC-008, no se forzó ni se creó uno) |

**Nota sobre pruebas manuales en vivo (Parte 8 de la ficha):** el frontend (`ng serve`) estaba corriendo localmente en `127.0.0.1:4200` (HTTP 200 confirmado) y se auditó por código (routing guard, interceptor 401). El backend no estaba escuchando en su puerto documentado (3001); había un proceso Node en el puerto 3000 corriendo como usuario `root`, pero no se pudo confirmar que fuera `agro-score-api` (usuario sin permisos para inspeccionarlo, puerto no coincide con el default de este backend) — deliberadamente no se investigó más para no interferir con un proceso ajeno no identificado en una máquina compartida con otros servicios (n8n, etc.). El worker no estaba corriendo (puerto 8000 cerrado). Por lo tanto, **las pruebas manuales de request/response en vivo contra backend y worker (401 sin token, 400 en contacto inválido, etc.) no se pudieron ejecutar** en esta sesión — los hallazgos de auth/validación de esas secciones están basados en lectura de código, no en interacción HTTP en vivo. Recomendación: repetir esas pruebas manuales puntuales en un entorno de staging antes del deploy final.
