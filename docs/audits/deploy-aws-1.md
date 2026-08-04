# DEPLOY-AWS-1 — Preparación de deploy productivo (backend + worker en EC2)

**Fecha:** 2026-08-03
**Contexto:** [`secops-audit.md`](./secops-audit.md) (SECOPS-AUDIT-1) dejó como único bloqueante real de deploy la infraestructura inexistente (SEC-008/SEC-006). [`sec-fix-1.md`](./sec-fix-1.md) ya había corregido los bloqueantes de código/config. Esta ficha construye esa infraestructura: Dockerfiles, `docker-compose.prod.yml`, Nginx, guía de SSL, y documentación de deploy a EC2 — **sin hacer deploy real**.
**Alcance respetado:** no se tocó lógica de negocio, DB schema, ni migrations. No se hizo deploy. No se subió nada a S3. No se llamó a `/lots`. No se commiteó ningún secreto real. La landing sigue viviendo en S3 — no se preparó ningún deploy de frontend en EC2, no se sirve frontend desde Nginx.

---

## Resumen

Backend y worker ahora tienen Dockerfile productivo, validado con `docker build` real (ambas imágenes compilan y arrancan). `deploy/aws/` en el repo del backend tiene el compose productivo, los 3 archivos de entorno de ejemplo, la config de Nginx, y una guía paso a paso completa. La landing en S3 no se tocó — se documentó cómo actualizarla, en ambos repos (backend y frontend) para que sea encontrable desde cualquiera de los dos.

**Con esto, `SEC-008` y `SEC-006` quedan resueltos** (la infraestructura existe y no expone worker/Postgres). `SEC-005` queda **mejor mitigado** (aislamiento de red real vía `expose`/sin `ports`) pero **no completamente resuelto** — la autenticación interna backend↔worker sigue sin implementar (`SEC-FIX-2`).

---

## Hallazgos de más peso encontrados durante esta ficha

Ninguno de estos estaba en el alcance original de la ficha tal como estaba redactada — surgieron al validar contra el código real en vez de asumir que la plantilla propuesta encajaba tal cual.

1. **El build real del backend compila a `dist/src/main.js`, no a `dist/main.js`.** `nest-cli.json` tiene `sourceRoot: "src"`, y el `outDir` de `tsconfig.json` es `./dist` — la combinación hace que el compilado quede en `dist/src/main.js`. El script `start:prod` de `package.json` (`"node dist/main"`) está **roto/desactualizado** — si alguien lo corriera tal cual, fallaría con "Cannot find module". No se tocó `package.json` (fuera de alcance de esta ficha, es un cambio de código), pero el `Dockerfile` usa la ruta real (`CMD ["node", "dist/src/main.js"]`) y quedó documentado acá. Esto también explica un hallazgo suelto de `SECOPS-AUDIT-1`: un proceso `node dist/src/main.js` corriendo como root en el puerto 3000 de la máquina de desarrollo — evidentemente alguien lo arrancó a mano con la ruta correcta, no vía `npm run start:prod`.
2. **La ficha proponía variables `DATABASE_HOST`/`DATABASE_USER`/`DATABASE_PASSWORD`/`DATABASE_NAME` para `env.backend.example` — el código real lee `DB_HOST`/`DB_USER`/`DB_PASSWORD`/`DB_NAME`** (confirmado en `src/app.module.ts` y `src/data-source.ts`). Si se hubiera copiado la plantilla de la ficha tal cual, el backend en producción no se habría podido conectar a Postgres (variables `undefined`, probablemente error de conexión poco claro). `env.backend.example` quedó escrito con los nombres reales. Las únicas variables con prefijo `DATABASE_` que sí existen de verdad son `DATABASE_SSL`/`DATABASE_SSL_REJECT_UNAUTHORIZED` (de `SEC-FIX-1`).
3. **El backend no tenía endpoint `/health`** — solo `GET /` (que devuelve `"Hello World!"` desde el scaffold default de NestJS). Toda la guía de health checks de esta ficha (Docker, Nginx, smoke tests) necesitaba uno real. Se agregó `GET /health` → `{"status":"ok"}` en `AppController` (mismo patrón que ya tenía el worker). Cambio mínimo, sin tocar autenticación ni DB — un healthcheck no debe depender de la base de datos para no dar falsos negativos si Postgres tiene un blip transitorio.
4. **CORS solo soportaba un origin único** (`FRONTEND_URL`, una sola URL). La ficha pide que `CORS_ORIGIN` acepte una lista separada por comas (apex + `www`, o CloudFront). Se agregó `src/config/cors-origins.util.ts` (función pura, testeada) y se conectó en `main.ts`; si `CORS_ORIGIN` no está seteada, se mantiene el comportamiento previo (single-origin vía `FRONTEND_URL`) por compatibilidad con dev local.
5. **Gap real de `.gitignore` encontrado validando el compose:** `.gitignore` del backend NO tenía ningún patrón `.env.*` — solo nombres literales específicos (`.env.development.local`, etc.), ninguno de los cuales matchea `deploy/aws/.env.backend`/`.env.worker`/`.env.postgres` (los archivos que el propio `README.md` de esta ficha le pide crear al operador, con secretos reales). Confirmado con `git check-ignore -v`: **sin este fix, esos 3 archivos se hubieran podido commitear por accidente** con un `git add` amplio. Se agregó `.env.*` + `!.env.example` a `.gitignore`. Esto también protege contra cualquier futuro `.env.<lo-que-sea>` en cualquier carpeta del repo, no solo `deploy/aws/`.
6. **El output real de `ng build` es `dist/agro-score-web/browser`**, no `dist/agro-score-web/` directo — confirmado corriendo el build real y mirando la carpeta, no asumido de memoria ni de la documentación de Angular. Documentado en ambos repos (`deploy/aws/README.md` y `agro-score-web/docs/audits/s3-landing-update.md`).
7. **`POST /auth/register` sigue existiendo y sigue siendo público** en el backend, pese a que `ACCESS-REQUEST-1` ya reemplazó la UI de alta pública por "Solicitar acceso" (que solo manda un email, no crea usuarios). No se tocó — es un cambio de lógica/flujo de auth, fuera del alcance de "solo infraestructura de deploy" de esta ficha — pero queda anotado como deuda a evaluar (¿cerrar a admin-only? ¿eliminar?) en `deploy/aws/README.md`.

---

## Validación real (no solo redactada)

- `docker build -t agro-score-api-prod .` → ✅ build exitoso. Smoke test: `docker run --rm agro-score-api-prod` sin `JWT_SECRET` → falla limpio con el mensaje de `getRequiredJwtSecret` (confirma que el fail-fast de `SEC-FIX-1` funciona igual dentro del contenedor, y que `dist/src/main.js` es la ruta correcta).
- `docker build -t agro-score-worker-prod .` → ✅ build exitoso (python:3.12-slim, sin necesidad de compilar nada desde fuente — numpy/scipy/pandas/scikit-learn/pillow tienen wheels manylinux para glibc). Smoke test: contenedor arrancado con `-p 18001:8000`, `curl http://127.0.0.1:18001/health` → `{"status":"ok"}` en `200`, sin necesitar credenciales de Earth Engine (la librería `ee` solo se inicializa dentro del handler de `/analyze`, no al importar el módulo).
- `docker compose -f deploy/aws/docker-compose.prod.yml config` → ✅ válido. Se copiaron temporalmente los 3 `.example` a `.env.backend`/`.env.worker`/`.env.postgres` (sin secretos reales, mismos valores placeholder de los ejemplos) solo para que Compose pudiera resolver `env_file`, y se borraron después de validar — no quedaron en el repo. La config resuelta confirma: el `context: ../../../agro-score-worker` de la definición de `agro-score-worker` resuelve correctamente al repo hermano; `agro-score-api` publica `127.0.0.1:3001` únicamente; `agro-score-worker` y `postgres` solo tienen `expose`, ningún `ports:`.
- Backend: `npm test` → 172/172. `npm run build` → sin errores.
- Frontend: `npx tsc --noEmit` → sin errores. `npm run build` → OK (mismo warning preexistente de `leaflet`, no relacionado). `ng test` → 173/173. `ng lint` → "All files pass linting".
- No se corrió `npm run lint` del backend en esta ficha — ya se sabe por `SEC-FIX-1` que ese script corre `eslint --fix` sobre **todo** el repo (efecto colateral real, ver `feedback_api_lint_fix_repowide` en memoria de sesión), y el `Parte 12` de esta ficha no lo pedía explícitamente.

Tests nuevos de esta ficha: `src/app.controller.spec.ts` (+1, `/health`), `src/config/cors-origins.util.spec.ts` (+6, casos de `resolveCorsOrigins`) — 7 en total. El conteo pasó de 145 (al cierre de `SEC-FIX-1`) a 172 al arrancar esta ficha porque, entre medio, `ACCESS-REQUEST-1` ya se había implementado y commiteado (con sus propios tests) — no es parte del trabajo de esta ficha, solo contexto de por qué el número base no es 145.

---

## Hallazgos de SECOPS-AUDIT-1 actualizados

| ID | Antes | Ahora |
|---|---|---|
| SEC-008 (sin Dockerfiles/compose/Nginx/SSL) | Abierto | ✅ **Resuelto.** Dockerfiles + compose + Nginx + guía de Certbot listos y validados en esta ficha. |
| SEC-006 (compose exponía Postgres en `0.0.0.0`) | Abierto | ✅ **Resuelto** en el compose productivo (`expose`, nunca `ports`, para worker y Postgres). El `docker-compose.yml` de desarrollo local (fuera de `deploy/aws/`) no se tocó — sigue siendo solo para dev, documentado como tal desde `SECOPS-AUDIT-1`. |
| SEC-005 (worker sin autenticación) | Abierto | 🟡 **Mejor mitigado, no resuelto.** El worker queda aislado de red (sin puerto publicado al host, sin ruta desde Nginx) — la mitigación real de hoy. La autenticación interna (`WORKER_INTERNAL_TOKEN`) sigue sin implementar, documentada como deuda `SEC-FIX-2`. |

Ver `secops-audit.md` (tabla de severidad y secciones 6/8, actualizadas con referencias a esta ficha) y `sec-fix-1.md` (sin cambios de contenido — sigue describiendo exactamente lo que hizo esa ficha; esta ficha es la continuación, no una corrección de esa).

---

## Qué sigue abierto después de esta ficha

- **`SEC-FIX-2`** — autenticación interna backend↔worker (`WORKER_INTERNAL_TOKEN` / header `X-Worker-Token`), documentada en ambos `.env.worker.example` (el de `agro-score-worker` y el de `deploy/aws/`) pero no implementada.
- **Deploy real** — esta ficha prepara todo pero no ejecuta nada contra una EC2 real. `deploy/aws/README.md` tiene la guía paso a paso completa.
- **RDS, backups automáticos, CloudWatch, CI/CD, WAF/rate-limit distribuido, monitoreo de disco, versioning del bucket S3, invalidación de CloudFront automatizada, cierre de `/auth/register` público** — todo listado explícitamente como deuda al final de `deploy/aws/README.md`, no repetido acá para no duplicar y desincronizarse.
- **`start:prod` roto** (`dist/main` en vez de `dist/src/main.js`) — no se tocó `package.json` en esta ficha (cambio de código fuera del alcance "solo infraestructura de deploy"); el `Dockerfile` usa la ruta correcta directamente, así que no bloquea el deploy en sí, pero conviene corregir el script en una ficha de código para que `npm run start:prod` funcione fuera de Docker también.

---

## Archivos creados/modificados

**Backend (`agro-score-api`):**
- Nuevo: `Dockerfile`, `.dockerignore`
- Nuevo: `deploy/aws/docker-compose.prod.yml`, `env.backend.example`, `env.worker.example`, `env.postgres.example`, `nginx/agroscore-api.conf`, `README.md`
- Nuevo: `src/config/cors-origins.util.ts` + `.spec.ts`
- Modificado: `src/main.ts` (helmet ya estaba de `SEC-FIX-1`; se agregó `resolveCorsOrigins`), `src/app.controller.ts` + `.spec.ts` (nuevo `GET /health`), `.env.example` (agregado `CORS_ORIGIN`), `.gitignore` (agregado `.env.*` + `!.env.example` — hallazgo #5 arriba)
- Nuevo: `docs/audits/deploy-aws-1.md` (este documento)

**Worker (`agro-score-worker`):**
- Nuevo: `Dockerfile`, `.dockerignore`
- Sin cambios de código Python (no hizo falta — `app/limits.py` y `app/main.py` ya estaban listos desde `SEC-FIX-1`)

**Frontend (`agro-score-web`):**
- Nuevo: `docs/audits/s3-landing-update.md`
- Sin cambios de código (no hizo falta — `environment.prod.ts` ya apuntaba a `https://api.agroscorelatam.com` desde `SEC-FIX-1`)
