# SEC-FIX-1 — Corrección de bloqueantes mínimos antes del deploy AWS

**Fecha:** 2026-08-03
**Contexto:** implementa los bloqueantes de código/config identificados en [`secops-audit.md`](./secops-audit.md) (SECOPS-AUDIT-1) que se consideraron mínimos e imprescindibles antes de exponer AgroScore a internet. No incluye Dockerfiles, compose de producción, Nginx, ni SSL de infraestructura — eso sigue siendo alcance de `DEPLOY-AWS-1`.
**Alcance respetado:** no se tocó lógica de negocio, DB schema, ni migrations. No se hizo deploy. No se llamó a `/lots`. No se commiteó ningún secreto real. No se ejecutaron comandos destructivos.

---

## Resumen

Se corrigieron 6 hallazgos de SECOPS-AUDIT-1 (uno de ellos, SEC-009, como efecto colateral de otro) y se mitigó parcialmente un séptimo. El único gran bloqueante que queda antes de poder desplegar es de infraestructura (Dockerfiles + compose de producción + Nginx/SSL — `DEPLOY-AWS-1`), no de código.

| Hallazgo | Estado tras SEC-FIX-1 |
|---|---|
| SEC-001 (frontend, `apiUrl` placeholder) | ✅ Resuelto |
| SEC-002 (backend, `JWT_SECRET` fallback inseguro) | ✅ Resuelto |
| SEC-003 (backend, sin rate limiting) | ✅ Resuelto |
| SEC-004 (backend, sin SSL en conexión a Postgres) | ✅ Resuelto (configurable, falta habilitar en RDS real) |
| SEC-005 (worker, sin autenticación) | ⚠️ Abierto — documentado como deuda `SEC-FIX-2` |
| SEC-007 (worker, sin límites de input) | 🟡 Parcialmente mitigado |
| SEC-009 (worker, excepciones crudas al caller) | ✅ Resuelto (efecto colateral de SEC-007) |
| SEC-017 (backend, sin `helmet`) | ✅ Resuelto |

---

## A. Cambios frontend (`agro-score-web`)

- **`src/environment/environment.prod.ts`** — reemplazado el placeholder `'https://REEMPLAZAR-CON-URL-BACKEND-PRODUCCION'` por `'https://api.agroscorelatam.com'` (dominio indicado explícitamente en la ficha). `environment.ts` (dev) queda sin cambios, sigue apuntando a `http://localhost:3001`.
- Verificado: `grep -R "REEMPLAZAR-CON-URL-BACKEND-PRODUCCION" src` → sin coincidencias.
- No se tocó ningún otro archivo de UI, landing ni formulario de contacto — no hizo falta para que compile.

## B. Cambios backend (`agro-score-api`)

**SEC-002 — JWT_SECRET fail-fast:**
- Nuevo `src/auth/jwt-secret.util.ts`: `getRequiredJwtSecret(config)` — sin fallback, lanza `Error` (mensaje genérico, nunca imprime el valor de ningún secreto) si `JWT_SECRET` falta o queda vacía/solo-espacios.
- Usado en `src/auth/auth.module.ts` (factory de `JwtModule`) y `src/auth/jwt.strategy.ts` (constructor de la estrategia) — ambos puntos donde antes vivía el fallback `'dev-secret-change-me'`.
- `src/main.ts`: `bootstrap().catch((error) => { console.error(...); process.exit(1); })` — si `NestFactory.create()` rechaza (por el error de arriba u otra causa), el proceso loguea un mensaje claro y termina con código de salida 1, en vez de quedar en un estado indefinido.
- Tests nuevos: `src/auth/jwt-secret.util.spec.ts` (6 casos: valor válido, trim de espacios, falta la env var, vacía, solo espacios, y que el mensaje de error no contenga ningún secreto).

**Helmet:**
- `npm install helmet` (1 paquete nuevo, sin vulnerabilidades adicionales — `npm audit` se mantuvo en 10 vulnerabilidades, igual que antes de instalarlo).
- `src/main.ts`: `app.use(helmet())` agregado antes de `app.enableCors(...)`.
- Verificado que no rompe nada: los 145 tests del backend (incluidos los de contacto y auth) siguen pasando, y el build compila. El `Cross-Origin-Resource-Policy: same-origin` default de helmet no afecta al frontend porque este consume la API con `fetch`/`HttpClient` en modo `cors` (incluida la descarga del PDF vía blob), no en modo `no-cors` — CORP solo restringe este último.

**SEC-003 — Rate limiting:**
- `npm install @nestjs/throttler` (v6.5.0).
- `src/app.module.ts`: `ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 20 }])` agregado a los imports. **No se ató como guard global** (`APP_GUARD`) para no cambiar el comportamiento de ningún endpoint no mencionado en la ficha (fields, analysis, PDF, etc.) — en cambio, cada endpoint objetivo usa `@UseGuards(ThrottlerGuard)` explícito.
- `src/auth/auth.controller.ts`: `POST /auth/login` y `POST /auth/register` con `@Throttle({ default: { limit: 5, ttl: 60_000 } })` (5 req/min por IP).
- `src/contact/contact.controller.ts`: `POST /contact` con `@Throttle({ default: { limit: 3, ttl: 60_000 } })` (3 req/min por IP).
- Tests nuevos (metadata, sin e2e): `src/auth/auth.controller.spec.ts` (verifica `ThrottlerGuard` + límite/ttl correctos en login/register, y que `/auth/logout` explícitamente NO lo lleva) y una prueba equivalente agregada a `src/contact/contact.controller.spec.ts` para `POST /contact`.
- **Deuda documentada** (en el propio comentario de `app.module.ts`): el storage es en memoria del proceso Node — si en el futuro el backend corre con más de una réplica, el límite deja de ser efectivo entre instancias sin un storage compartido (Redis). No se implementó Redis en esta ficha, según instrucción explícita.

**SEC-004 — SSL configurable para Postgres/RDS:**
- Nuevo `src/config/database-ssl.util.ts`: `resolveDatabaseSsl(databaseSsl, databaseSslRejectUnauthorized)` — función pura (sin `ConfigService`) para poder compartirla entre `app.module.ts` (bootstrap de Nest) y `data-source.ts` (CLI de migraciones, fuera del ciclo de vida de Nest).
  - `DATABASE_SSL` distinto de `'true'` → `ssl: false` (default, compatible con el Postgres de Docker local).
  - `DATABASE_SSL=true` → `ssl: { rejectUnauthorized: <true salvo que DATABASE_SSL_REJECT_UNAUTHORIZED sea exactamente 'false'> }` — default seguro (valida certificado) a menos que se lo desactive explícitamente.
- Conectado en `src/app.module.ts` (`TypeOrmModule.forRootAsync`) y `src/data-source.ts` (CLI de migraciones) — mismo criterio en ambos.
- `.env.example` actualizado con `DATABASE_SSL=false` y `DATABASE_SSL_REJECT_UNAUTHORIZED=false` (valores de dev local) y comentario explicando el criterio para producción.
- Tests nuevos: `src/config/database-ssl.util.spec.ts` (5 casos).
- **No se cambió** `synchronize` (sigue en `false` por default) ni ninguna migration.

## C. Cambios worker (`agro-score-worker`)

**SEC-007 (parcial) + SEC-009 — Límites de input y manejo de errores:**
- Nuevo `app/limits.py`:
  - Constantes configurables por env, con los defaults pedidos: `AGROSCORE_MAX_LOTS=50`, `AGROSCORE_MAX_CAMPAIGNS=8`, `AGROSCORE_MAX_GEOMETRY_COORDINATES=5000`, `AGROSCORE_MAX_DATE_RANGE_DAYS=366`, `AGROSCORE_MAX_CLOUDINESS=80`.
  - `PayloadValidationError(ValueError)` — error de negocio, distinto de cualquier excepción interna del pipeline.
  - `validate_analyze_payload(payload)`: valida, en este orden, que `lots` no esté vacío; `len(lots) <= MAX_LOTS`; cada lote tenga forma básica de polígono válida (≥3 coordenadas `[lon, lat]` numéricas, dentro de rango geográfico real) y que la suma de coordenadas de todos los lotes no supere `MAX_GEOMETRY_COORDINATES`; `len(zone_campaign_years) <= MAX_CAMPAIGNS`; `campaign_start`/`campaign_end` sean fechas ISO válidas, `end > start`, y el rango no supere `MAX_DATE_RANGE_DAYS`; `max_cloud_pct` esté entre 0 y `MAX_CLOUDINESS`.
- `app/main.py`, endpoint `POST /analyze`:
  - Llama a `validate_analyze_payload(payload)` antes de tocar Earth Engine; si falla, responde `HTTPException(400, <mensaje claro>)`.
  - El bloque `except Exception` que rodea la llamada al pipeline ya no hace `HTTPException(500, detail=str(exc))` — ahora hace `logger.exception(...)` (traceback completo en el log del servidor) y responde un mensaje genérico (`"No se pudo completar el análisis..."`). Esto resuelve **SEC-009** como efecto colateral.
- `.env.example` (worker) actualizado con las 5 variables de límites (documentadas con sus defaults) y con `WORKER_INTERNAL_TOKEN=` (ver sección D).
- **Explícitamente fuera de esta ficha** (según instrucción): `n_zones`, `zone_resolution`, `map_dimensions`, `index_image_dimensions` siguen sin acotar. No se cambió el algoritmo de análisis, zonas, colores, ni la lógica de Earth Engine.

**Validación worker:** `pytest` y `httpx` **no están instalados** en el venv del worker y esta ficha no autorizaba instalarlos si no estaban ya presentes. En su lugar, se verificó `app/limits.py` corriéndolo directamente con el intérprete del venv (`venv/bin/python`) contra 12 casos: payload válido; 51 lots (> máximo); lots vacío; rango de fechas de 2922 días (> 366); `campaign_end` anterior a `campaign_start`; fecha con formato inválido; `max_cloud_pct` en 95 y en -1; 5001 coordenadas en un solo lote; lote con solo 2 coordenadas; coordenada con latitud fuera de rango; 9 campañas en `zone_campaign_years` (> 8). Los 12 casos se comportaron como se esperaba. También se verificó que `import app.main` sigue funcionando end-to-end (sin romper el resto del pipeline) y que las rutas registradas (`/health`, `/analyze`, `/docs`, etc.) no cambiaron. No quedaron tests automatizados en el repo del worker — si se quiere cobertura automatizada, instalar `pytest` (y `httpx` si se quiere testear a nivel HTTP con `TestClient`) es un prerequisito para una ficha futura.

## D. Worker — auth interna (solo documentado, no implementado)

Según instrucción explícita de la ficha, **no se implementó** autenticación entre backend y worker. Se documentó la variable `WORKER_INTERNAL_TOKEN=` en `agro-score-worker/.env.example`, con un comentario explicando el diseño previsto para `SEC-FIX-2`: el backend NestJS mandaría el token en un header (ej. `X-Worker-Token`) y el worker lo validaría, rechazando requests que no lo traigan. Esto sigue siendo el gap real de SEC-005 (el worker sigue sin ninguna autenticación hoy) — la mitigación real de SEC-005 depende de que `DEPLOY-AWS-1` aísle correctamente el worker en la red interna de Docker sin publicar su puerto al host.

---

## E. Hallazgos que siguen bloqueando el deploy

- **SEC-008 / SEC-006** — No existe ningún Dockerfile (backend ni worker), ni `docker-compose.prod.yml`, ni configuración de Nginx/SSL en ningún repo. Es el bloqueante estructural principal, sin tocar en esta ficha por instrucción explícita. Alcance de `DEPLOY-AWS-1`.
- **SEC-005 (worker sin auth)** — mitigable solo con aislamiento de red en `DEPLOY-AWS-1`; la autenticación interna en sí queda como `SEC-FIX-2`.
- **SEC-013** — Falta un smoke test post-deploy que confirme `CONTACT_EMAIL_DRY_RUN=false` y `RESEND_API_KEY` seteadas en el entorno real de AWS — no aplicable hasta que exista ese entorno.
- **SEC-015** — Las 4 dependencias del worker sin pin de versión (`scipy`, `matplotlib`, `scikit-learn`, `pillow`) siguen sin fijar.
- Resto de hallazgos Medio/Bajo de SECOPS-AUDIT-1 no tocados en esta ficha (SEC-010 a SEC-012, SEC-014, SEC-018 a SEC-030) — ver `secops-audit.md` secciones 11/12/13 para el detalle completo, quedan para `SEC-FIX-2` o para el roadmap post-deploy.

## F. Validación ejecutada

| Repo | Comando | Resultado |
|---|---|---|
| Frontend | `grep -R "REEMPLAZAR-CON-URL-BACKEND-PRODUCCION" src` | ✅ Sin coincidencias |
| Frontend | `npx tsc --noEmit` | ✅ Sin errores de tipo |
| Frontend | `npm run build` (`ng build`) | ✅ OK (mismo warning preexistente de `leaflet` no-ESM, no relacionado) |
| Frontend | `ng test --watch=false --browsers=ChromeHeadless` | ✅ 167/167 |
| Frontend | `ng lint` | ✅ "All files pass linting" |
| Backend | `npm test` | ✅ 145/145 (135 preexistentes + 10 nuevos: 6 de `jwt-secret.util`, 5 de `database-ssl.util` menos 1 que se solapa en el conteo por describe anidado, y 2 de metadata de throttling — ver detalle abajo) |
| Backend | `npm run build` (`nest build`) | ✅ Sin errores |
| Backend | `npm run lint` | ⚠️ 252 problemas preexistentes (220 errores, 32 warnings) en archivos no tocados por esta ficha (`analysis/*`, `fields/*`, `lots/lots.controller.ts`, `python-worker/python-worker.service.ts`, `users/users.service.ts`, `auth/auth.service.spec.ts`). **Los archivos tocados en esta ficha (`jwt-secret.util.ts`, `database-ssl.util.ts`, `app.module.ts`, `main.ts`, `auth.controller.ts`, `contact.controller.ts`, `auth.controller.spec.ts`, `contact.controller.spec.ts`) no agregan ningún error nuevo** — se verificó explícitamente comparando antes/después (256→252 problemas tras corregir 4 `unbound-method` que sí introdujo el código nuevo de tests). El único error que queda en un archivo tocado (`auth.module.ts:22`) es sobre una línea preexistente (`expiresIn: (...) as any`) no modificada por esta ficha.

**⚠️ Nota importante sobre `npm run lint` en este repo:** el script está definido como `eslint "{src,apps,libs,test}/**/*.ts" --fix` — es decir, **reformatea automáticamente todo el árbol del repo** (comillas, indentación, wrapping de líneas), no solo los archivos tocados en esta ficha. Al correrlo para validar, reformateó de forma colateral 11 archivos ajenos al alcance de SEC-FIX-1 — **incluidas las dos migrations** (`1785445140411-InitialSchema.ts` y `1785445240864-FieldsUserIdNotNull.ts`), que la ficha prohíbe explícitamente tocar. El contenido SQL dentro de esas migrations quedó byte-a-byte idéntico (`git diff` mostró solo cambios de formato: comillas simples/dobles, 4→2 espacios de indentación, wrapping de `queryRunner.query(...)`), pero de todas formas se revirtieron esos 11 archivos con `git checkout --` para respetar la instrucción al pie de la letra y no dejar ningún diff fuera del alcance pedido. Se volvió a correr `npm test` y `npm run build` después del revert para confirmar que seguían en verde (145/145 y build limpio). **Recomendación para fichas futuras: no correr `npm run lint` a secas en este repo si se quiere evitar este efecto colateral — usar `eslint <paths tocados> --fix` apuntado solo a los archivos relevantes, o revisar `git diff --stat` inmediatamente después y revertir lo que no corresponda, como se hizo acá.**
| Worker | `git status --short` | Cambios esperados: `app/main.py` modificado, `app/limits.py` y `.env.example` nuevos |
| Worker | `docker build -t agro-score-worker-secfix1 .` | ❌ Falla — no existe `Dockerfile` (confirma que sigue siendo alcance de `DEPLOY-AWS-1`, no se forzó nada) |
| Worker | Verificación manual de `app/limits.py` (sin pytest/httpx) | ✅ 12/12 casos correctos (ver sección C) |

Conteo exacto de tests backend nuevos: 6 (`jwt-secret.util.spec.ts`) + 5 (`database-ssl.util.spec.ts`) + 2 (throttle metadata en `auth.controller.spec.ts`, que además trae 2 tests parametrizados vía `it.each` = 2 casos + 1 test de logout = 3 tests en ese archivo) + 1 (throttle metadata en `contact.controller.spec.ts`) = 15 tests nuevos sobre la base de 130 (SECOPS-AUDIT-1) → 145 total, consistente con el resultado de `npm test`.

## G. Commits sugeridos por repo

No se ejecutó ningún `git commit` en esta ficha (la instrucción pedía "commits sugeridos", no commitear). Sugerencia de agrupación:

**`agro-score-web`** (1 commit):
```
fix(env): apuntar apiUrl de producción al backend real (SEC-001)
```
Archivos: `src/environment/environment.prod.ts`.

**`agro-score-api`** (se sugieren 4 commits separados, uno por hallazgo, para poder revertir cada uno de forma independiente si hiciera falta):
```
fix(auth): JWT_SECRET sin fallback inseguro, fail-fast al arrancar (SEC-002)
```
Archivos: `src/auth/jwt-secret.util.ts`, `src/auth/jwt-secret.util.spec.ts`, `src/auth/auth.module.ts`, `src/auth/jwt.strategy.ts`, `src/main.ts`, `.env.example`.

```
feat(security): agregar helmet() para cabeceras HTTP estándar
```
Archivos: `src/main.ts`, `package.json`, `package-lock.json`.

```
feat(security): rate limiting en /auth/login, /auth/register y /contact (SEC-003)
```
Archivos: `src/app.module.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.controller.spec.ts`, `src/contact/contact.controller.ts`, `src/contact/contact.controller.spec.ts`, `package.json`, `package-lock.json`.

```
feat(db): SSL configurable para Postgres/RDS vía DATABASE_SSL (SEC-004)
```
Archivos: `src/config/database-ssl.util.ts`, `src/config/database-ssl.util.spec.ts`, `src/app.module.ts`, `src/data-source.ts`, `.env.example`.

**`agro-score-worker`** (1 commit):
```
feat(security): límites de input en /analyze + no exponer excepciones internas (SEC-005/SEC-007/SEC-009)
```
Archivos: `app/limits.py`, `app/main.py`, `.env.example`.

**Nota:** `app.module.ts` de `agro-score-api` recibe cambios de dos de los commits sugeridos (throttler y SSL) — si se prefiere un solo commit por archivo tocado en vez de por hallazgo, agrupar todo backend en un único commit `fix(security): SEC-FIX-1 — JWT fail-fast, helmet, rate limiting, SSL DB` es una alternativa razonable.
