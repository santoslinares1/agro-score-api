# DEPLOY-AWS-1 — Backend + worker en EC2 (Docker Compose + Nginx + SSL)

Esta carpeta prepara el deploy productivo de **backend (NestJS) + worker (FastAPI)** en una EC2 Ubuntu. **La landing Angular NO se despliega desde acá** — ya está publicada en AWS S3 (ver sección final de este documento, "Actualizar la landing en S3").

Arquitectura:

```
Usuario
  ↓
Landing Angular en S3 / CloudFront / dominio propio
  ↓ HTTPS a
https://api.agroscorelatam.com
  ↓
Nginx 80/443 en EC2 (único punto público)
  ↓ proxy_pass
Backend NestJS — 127.0.0.1:3001 (Docker, publicado solo en localhost)
  ↓ red interna de Docker (agroscore_internal)
Worker FastAPI — sin puerto publicado al host, solo alcanzable desde la red interna

Postgres: RDS externo (recomendado) o contenedor Docker sin puerto publicado (temporal)
```

Nada salvo Nginx (80/443) queda expuesto a internet. Ni el worker (8000) ni Postgres (5432) publican puerto al host en ningún escenario de esta guía.

---

## 0. Prerequisitos que asume esta guía

- Dominio `api.agroscorelatam.com` con DNS administrable (para apuntar el registro A a la EC2).
- El origin real de la landing en S3/CloudFront confirmado (ver sección "Confirmar el origin real de la landing" más abajo) — hace falta para `CORS_ORIGIN`.
- Credenciales de Earth Engine (service account JSON) disponibles fuera de este repo.
- Acceso a `RESEND_API_KEY` real si se va a habilitar el envío de emails (`CONTACT_EMAIL_DRY_RUN=false`).

---

## 1. Crear la EC2

Ubuntu 22.04 o 24.04 LTS. Tamaño según carga esperada (t3.small/t3.medium para arrancar es razonable; el worker es lo más pesado en CPU/memoria durante un análisis).

## 2. Security Group

| Puerto | Origen | Motivo |
|---|---|---|
| 22 (SSH) | Solo tu IP propia (`x.x.x.x/32`) | Administración |
| 80 (HTTP) | `0.0.0.0/0` | Certbot + redirect a HTTPS |
| 443 (HTTPS) | `0.0.0.0/0` | Tráfico real de la API |
| 3001 | **Nadie** | El backend nunca se expone directo — siempre detrás de Nginx |
| 8000 | **Nadie** | El worker nunca se expone — solo red interna de Docker |
| 5432 | **Nadie** | Postgres nunca se expone — solo red interna de Docker (u opción RDS, que tiene su propio SG separado) |

## 3. Instalar dependencias en la EC2

```bash
sudo apt-get update
sudo apt-get install -y git nginx certbot python3-certbot-nginx

# Docker Engine + plugin de compose (ver docs.docker.com/engine/install/ubuntu
# para la versión más nueva de estos pasos si cambia)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# cerrar sesión y volver a entrar para que el grupo docker tome efecto

docker compose version   # confirma que el plugin quedó instalado
```

AWS CLI — **solo si desde esta misma EC2 se va a actualizar S3/CloudFront** (lo más común es hacerlo desde tu máquina local o desde CI, no desde la EC2 de la API; instalar acá solo si el flujo elegido lo requiere):

```bash
sudo apt-get install -y awscli
aws configure   # o usar un IAM role adjunto a la instancia, más seguro que credenciales locales
```

## 4. Clonar los repos

Esta guía asume ambos repos clonados como hermanos en `/opt/agroscore/` — **`docker-compose.prod.yml` usa paths relativos que dependen de este layout exacto** (`context: ../../../agro-score-worker` para el worker). Si se clonan en otro lugar, ajustar esos paths en el compose.

```bash
sudo mkdir -p /opt/agroscore
sudo chown $USER:$USER /opt/agroscore
cd /opt/agroscore

git clone <URL_REPO_BACKEND> agro-score-api
git clone <URL_REPO_WORKER> agro-score-worker
```

## 5. Crear los archivos de entorno

```bash
cd /opt/agroscore/agro-score-api
cp deploy/aws/env.backend.example deploy/aws/.env.backend
cp deploy/aws/env.worker.example deploy/aws/.env.worker
cp deploy/aws/env.postgres.example deploy/aws/.env.postgres
```

## 6. Completar los secretos reales

Editar `deploy/aws/.env.backend`, `.env.worker` y `.env.postgres` con `nano`/`vim` y completar (nunca commitear estos 3 archivos — ya están fuera de git por patrón `.env.*` en `.gitignore`):

- `deploy/aws/.env.backend`: `DB_PASSWORD` (misma que `.env.postgres` si se usa Opción B), `JWT_SECRET` real (`openssl rand -base64 48`), `CORS_ORIGIN` con el origin real confirmado de la landing (ver sección dedicada más abajo), `RESEND_API_KEY` real, y si se usa RDS, `DB_HOST`/`DB_PORT` apuntando al endpoint de RDS + `DATABASE_SSL=true`.
- `deploy/aws/.env.worker`: confirmar `EARTH_ENGINE_PROJECT`/`EE_PROJECT_ID` (ya vienen precargados con `digimat-434101` en el `.example` — confirmar que es el proyecto correcto).
- `deploy/aws/.env.postgres`: `POSTGRES_PASSWORD` fuerte, **igual** a `DB_PASSWORD` de `.env.backend` (solo si se usa Opción B).

**Base de datos — elegir una opción:**
- **Opción A (recomendada): RDS Postgres.** Crear la instancia RDS por separado (fuera del alcance de esta ficha), apuntar `DB_HOST`/`DB_PORT` de `.env.backend` al endpoint de RDS, `DATABASE_SSL=true`. Borrar (o comentar) el servicio `postgres` de `docker-compose.prod.yml` y su entrada en `depends_on` de `agro-score-api`; no hace falta `.env.postgres`.
- **Opción B (temporal): Postgres en Docker.** Dejar el compose tal cual viene. El volumen `agro_score_postgres_data` persiste los datos entre reinicios del contenedor, pero sigue siendo un solo disco de la EC2 — sin backups automáticos (ver deuda al final) y sin la durabilidad/HA de RDS. Migrar a RDS antes de tener datos de producción reales que importe no perder.

## 7. Credenciales de Earth Engine

```bash
sudo mkdir -p /opt/agroscore/secrets
# copiar el JSON del service account a esa carpeta, ej vía scp desde tu máquina:
#   scp gee-service-account.json ubuntu@<IP_EC2>:/tmp/
#   sudo mv /tmp/gee-service-account.json /opt/agroscore/secrets/
sudo chmod 600 /opt/agroscore/secrets/gee-service-account.json
sudo chown root:root /opt/agroscore/secrets/gee-service-account.json
```

El compose lo monta read-only dentro del contenedor del worker en `/run/secrets/gee-service-account.json` (coincide con `GOOGLE_APPLICATION_CREDENTIALS` en `.env.worker`). Nunca copiar este archivo dentro del repo ni de ninguna imagen Docker.

## 8. Levantar backend + worker (+ Postgres si Opción B)

```bash
cd /opt/agroscore/agro-score-api
docker compose -f deploy/aws/docker-compose.prod.yml up -d --build
```

Si se usa RDS (Opción A) y ya se borró el servicio `postgres` del compose, este mismo comando levanta solo `agro-score-api` + `agro-score-worker`.

## 9. Migraciones

El esquema se versiona con TypeORM migrations (`src/migrations/`) — `TYPEORM_SYNCHRONIZE` queda siempre en `false` en `.env.backend` (nunca ponerlo en `true` en producción: con `synchronize:true` TypeORM puede alterar el schema real a partir del código, sin control ni revisión previa).

Correrlas es un paso **manual y controlado**, no automático — el `CMD` del Dockerfile del backend (`node dist/src/main.js`) deliberadamente no corre migrations al arrancar.

```bash
# 1. Backup antes de correr migrations en prod (ver sección Backups)

# 2. Ver qué migrations están pendientes
docker compose -f deploy/aws/docker-compose.prod.yml exec agro-score-api \
  node dist/src/main.js --version 2>/dev/null; \
docker compose -f deploy/aws/docker-compose.prod.yml run --rm agro-score-api \
  npm run migration:show

# 3. Revisar el SQL de las migrations pendientes ANTES de aplicarlas —
#    src/migrations/*.ts tiene el SQL crudo en up()/down(), legible sin
#    correr nada.

# 4. Aplicar
docker compose -f deploy/aws/docker-compose.prod.yml run --rm agro-score-api \
  npm run migration:run
```

`migration:run`/`migration:show`/`migration:revert` ya existen como scripts de `package.json` (no hizo falta agregar ninguno para esta ficha). **Nunca correr `npm run migration:generate` en producción** — ese comando compara el estado actual de las entidades contra la DB y genera una migration nueva; corriendo esto en prod se puede terminar generando (y aplicando sin querer) un diff no revisado. `migration:generate` es solo para desarrollo local, seguido de un commit de la migration generada y revisión de PR antes de que llegue a producción.

`docker compose run --rm` (en vez de `exec`) levanta un contenedor efímero nuevo con la misma imagen/env — corre el comando y se destruye, sin dejar un proceso corriendo de más ni interferir con el contenedor real de `agro-score-api` que ya está sirviendo tráfico.

## 10. Configurar Nginx

```bash
sudo cp /opt/agroscore/agro-score-api/deploy/aws/nginx/agroscore-api.conf \
  /etc/nginx/sites-available/agroscore-api.conf
sudo ln -s /etc/nginx/sites-available/agroscore-api.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 11. DNS

Crear un registro **A** para `api.agroscorelatam.com` apuntando a la IP pública (elástica, idealmente) de la EC2. Confirmar propagación antes de pedir el certificado SSL:

```bash
dig +short api.agroscorelatam.com
```

## 12. SSL con Certbot

```bash
sudo certbot --nginx -d api.agroscorelatam.com
```

Certbot reescribe `/etc/nginx/sites-available/agroscore-api.conf` automáticamente (agrega el bloque `listen 443 ssl`, los `ssl_certificate*`, y el redirect 80→443). Confirmar el renovado automático:

```bash
sudo certbot renew --dry-run
```

## 13. Confirmar el origin real de la landing y configurar CORS_ORIGIN

**Este repo no tiene forma de confirmar por sí solo cuál es el origin público real de la landing en S3** (no hay referencia al bucket/dominio en ningún archivo de `agro-score-web`). Antes de habilitar el acceso público, confirmar con quien gestiona el bucket S3/CloudFront cuál de estas opciones aplica, y setear `CORS_ORIGIN` en `deploy/aws/.env.backend` acorde:

- Si hay dominio propio: `CORS_ORIGIN=https://agroscorelatam.com,https://www.agroscorelatam.com`
- Si todavía no hay dominio propio y se sirve desde CloudFront: `CORS_ORIGIN=https://<id-real>.cloudfront.net`
- Si se sirve directo desde el website endpoint de S3 (sin CloudFront): `CORS_ORIGIN=http://<bucket>.s3-website-<region>.amazonaws.com` (notar que el website endpoint de S3 es HTTP, no HTTPS, salvo que haya CloudFront delante)

`CORS_ORIGIN` admite lista separada por comas (soportado desde esta ficha, ver `src/config/cors-origins.util.ts`). **Nunca usar `CORS_ORIGIN=*`** — con `credentials: true` (como está configurado acá para que el login/JWT funcionen), un wildcard de origin es una vulnerabilidad real, no solo una mala práctica.

Después de cambiar `CORS_ORIGIN`, reiniciar el backend para que tome el nuevo valor:

```bash
docker compose -f deploy/aws/docker-compose.prod.yml up -d agro-score-api
```

## 14. Actualizar la landing en S3

Ver la sección dedicada **"Actualizar la landing en S3"** más abajo en este mismo documento.

## 15. Smoke tests

Ver sección **"Health checks y smoke tests"** más abajo.

## 16. Rollback — backend/worker

```bash
cd /opt/agroscore/agro-score-api   # o agro-score-worker
git log --oneline -5
git checkout <commit-anterior>
cd /opt/agroscore/agro-score-api
docker compose -f deploy/aws/docker-compose.prod.yml up -d --build
```

Si el rollback es solo del worker, `git checkout` en `agro-score-worker` y volver a correr el mismo `docker compose up -d --build` desde `agro-score-api` (el compose reconstruye ambas imágenes si hace falta; para reconstruir solo una, `docker compose -f deploy/aws/docker-compose.prod.yml up -d --build agro-score-worker`).

Si el rollback requiere revertir una migration: `docker compose -f deploy/aws/docker-compose.prod.yml run --rm agro-score-api npm run migration:revert` — revisar el `down()` de la migration antes de correrlo, y tener el backup de la Parte 9 a mano.

## 17. Rollback — landing S3

Ver sección **"Actualizar la landing en S3"** — depende de si el bucket tiene versioning habilitado.

## 18. Logs

```bash
docker compose -f deploy/aws/docker-compose.prod.yml logs -f agro-score-api
docker compose -f deploy/aws/docker-compose.prod.yml logs -f agro-score-worker
docker compose -f deploy/aws/docker-compose.prod.yml logs -f postgres   # solo si Opción B
```

Deuda conocida (ver sección final): sin rotación de logs configurada más allá del log-driver default de Docker, sin CloudWatch todavía.

## 19. Backups

- **RDS (Opción A):** usar los snapshots automáticos de RDS — configurarlos al crear la instancia (fuera de alcance de esta ficha).
- **Postgres en Docker (Opción B):**
  ```bash
  docker compose -f deploy/aws/docker-compose.prod.yml exec postgres \
    pg_dump -U agro_user agro_score > /opt/agroscore/backups/agro_score_$(date +%Y%m%d_%H%M%S).sql
  ```
  Correr esto **antes de cualquier migration** y con una cadencia regular (cron). No hay backup automático configurado en esta ficha — ver deuda al final (`BACKUP-1`).

## 20. Qué NO hacer

- No abrir el puerto 8000 (worker) en el Security Group, bajo ninguna circunstancia.
- No abrir el puerto 5432 (Postgres) en el Security Group.
- No commitear `deploy/aws/.env.backend`, `.env.worker`, `.env.postgres` (ya están gitignored por patrón `.env.*`; confirmar con `git status` antes de cualquier commit en esta carpeta).
- No commitear `gee-service-account.json` ni ningún JSON de credenciales.
- No poner `TYPEORM_SYNCHRONIZE=true` en producción.
- No servir el frontend Angular desde esta EC2 — la landing vive en S3, esa es la arquitectura elegida.
- No usar `CORS_ORIGIN=*`.
- No correr `npm run migration:generate` en producción.

---

## Health checks y smoke tests

Desde la EC2:

```bash
docker compose -f deploy/aws/docker-compose.prod.yml ps
docker compose -f deploy/aws/docker-compose.prod.yml logs -f agro-score-api
docker compose -f deploy/aws/docker-compose.prod.yml logs -f agro-score-worker

curl http://127.0.0.1:3001/health
# → {"status":"ok"}
```

Worker (solo alcanzable desde dentro de la red interna — así se confirma que efectivamente NO es alcanzable desde afuera):

```bash
docker compose -f deploy/aws/docker-compose.prod.yml exec agro-score-worker \
  curl http://127.0.0.1:8000/health
# → {"status":"ok"}
```

Desde internet (tu máquina, no la EC2):

```bash
curl -I https://api.agroscorelatam.com/health
# → HTTP/2 200, con cabeceras de helmet (X-Content-Type-Options, etc.)

# Confirmar que el worker y Postgres NO responden desde afuera (deben fallar/timeout):
curl -m 5 http://<IP_PUBLICA_EC2>:8000/health   # debe fallar — sin ruta
curl -m 5 http://<IP_PUBLICA_EC2>:5432          # debe fallar — sin ruta
```

**Smoke funcional** (manual, desde un browser):
1. La landing en S3/CloudFront carga.
2. El CTA "Solicitar acceso" está visible en la landing (reemplazó a "Crear cuenta", ver `ACCESS-REQUEST-1`).
3. Completar y enviar el formulario de solicitud de acceso → confirmar en las DevTools del browser que el `POST` va a `https://api.agroscorelatam.com/access-request` (no a `localhost` ni a ninguna otra URL) y responde `200`.
4. Confirmar que llega el email a `agroscorelatam@gmail.com` (o revisar logs del backend si `CONTACT_EMAIL_DRY_RUN` quedó en `true` por error — no debería, ver Parte 6).
5. `/register` redirige a `/#solicitar-acceso` (ya no hay alta pública de cuenta).
6. Login con un usuario real funciona.
7. `/app/dashboard` sin sesión iniciada redirige a `/login`.
8. Crear un campo, agregar un lote, disparar un diagnóstico, esperar a que termine.
9. Descargar el PDF del reporte y confirmar que abre correctamente.

---

## Actualizar la landing en S3

La landing Angular **ya está en producción en S3** — esta ficha no prepara ni modifica esa infraestructura, solo documenta cómo actualizarla cuando haya cambios en `agro-score-web`. Ver también [`agro-score-web/docs/audits/s3-landing-update.md`](../../../agro-score-web/docs/audits/s3-landing-update.md) (mismo contenido, vive también en el repo del frontend para que quede junto al código que describe).

1. **Validar localmente:**
   ```bash
   cd agro-score-web
   npx tsc --noEmit
   npm run build
   ng test --watch=false --browsers=ChromeHeadless
   ng lint
   ```
2. **Confirmar `environment.prod.ts`:** `apiUrl` debe ser `https://api.agroscorelatam.com` (ya está así desde `SEC-FIX-1` — confirmar que sigue así antes de cada build de producción).
3. **Output real del build:** `dist/agro-score-web/browser` (confirmado leyendo `angular.json` — el builder `@angular-devkit/build-angular:application` siempre anida el output bajo `browser/`, con o sin SSR configurado; este proyecto no tiene SSR).
4. **Sync a S3:**
   ```bash
   aws s3 sync dist/agro-score-web/browser s3://NOMBRE_BUCKET_LANDING --delete
   ```
   `NOMBRE_BUCKET_LANDING` es un placeholder — este repo no documenta el nombre real del bucket en ningún lado. Completar con el nombre real antes de correr el comando.
5. **Invalidar CloudFront si aplica:**
   ```bash
   aws cloudfront create-invalidation --distribution-id <DISTRIBUTION_ID> --paths "/*"
   ```
   Solo si la landing se sirve vía CloudFront (no todos los setups de S3 lo usan). `<DISTRIBUTION_ID>` — mismo caso, no está documentado en el repo, completar con el ID real.
6. **Smoke test:** ver sección "Health checks y smoke tests" arriba.
7. **CORS:** si el dominio/origin de la landing cambió, actualizar `CORS_ORIGIN` en `deploy/aws/.env.backend` (ver Parte 13 más arriba) — si no coincide exactamente con el origin real, el browser bloquea las llamadas a la API con un error de CORS (no es un bug del backend, es el comportamiento esperado de un origin no autorizado).

**Rollback de la landing:** si el bucket S3 tiene **versioning** habilitado, restaurar las versiones anteriores de los objetos desde la consola de S3 (o `aws s3api list-object-versions` + `copy-object` apuntando a la versión previa). Si no tiene versioning, la única forma de rollback es volver a correr `npm run build` sobre un commit anterior del repo y repetir el `aws s3 sync --delete`. **Versioning del bucket no está confirmado** — ver deuda al final; si no está habilitado, es una mejora recomendable antes de depender de rollbacks rápidos de la landing.

---

## Hallazgos de SECOPS-AUDIT-1 mitigados por esta ficha

- **SEC-008** (no había Dockerfiles/compose/Nginx/SSL) — ✅ mitigado: Dockerfiles de backend y worker creados y validados con `docker build`; `docker-compose.prod.yml` + Nginx + guía de Certbot listos en esta carpeta.
- **SEC-006** (patrón de compose exponía Postgres en `0.0.0.0`) — ✅ mitigado: el compose productivo usa `expose` (nunca `ports`) para Postgres y el worker; solo el backend publica puerto, y solo en `127.0.0.1`.
- **SEC-005** (worker sin autenticación) — 🟡 mitigado parcialmente: el worker queda aislado de la red pública (sin puerto publicado al host, sin ruta desde Nginx). La autenticación interna en sí (`WORKER_INTERNAL_TOKEN` / header `X-Worker-Token`) sigue **sin implementar** — ver `SEC-FIX-2`. El aislamiento de red de esta ficha es la mitigación real hoy; si en el futuro se corre el worker en una red menos controlada (ej. Kubernetes con más servicios), la falta de auth interna vuelve a ser relevante.

---

## Deuda conocida (fuera de alcance de esta ficha)

- **RDS:** esta ficha deja Postgres en Docker (Opción B) como default operable; migrar a RDS antes de tener datos de producción reales que importe no perder.
- **Backups automáticos:** el `pg_dump` de la sección 19 es manual — no hay cron ni verificación de que el backup se haya hecho.
- **CloudWatch / rotación de logs:** los logs de Docker usan el driver default (`json-file`), sin rotación configurada ni envío a CloudWatch.
- **`WORKER_INTERNAL_TOKEN` (SEC-FIX-2):** documentado pero no implementado — el worker sigue sin validar ningún token, solo protegido por aislamiento de red.
- **CI/CD:** el deploy de esta ficha es manual (`git pull` + `docker compose up -d --build` a mano en la EC2). No hay pipeline con ECR/ECS ni GitHub Actions.
- **WAF / rate limiting distribuido:** el rate limiting de `SEC-FIX-1` (`@nestjs/throttler`) usa storage en memoria del proceso — no es efectivo si el backend corre con más de una réplica. Un WAF (ej. AWS WAF delante de la API) o Redis compartido son las mejoras naturales.
- **Monitoreo de disco/memoria de la EC2:** no configurado.
- **Versioning del bucket S3 de la landing:** no confirmado desde este repo — recomendable para poder hacer rollback rápido.
- **Invalidación de CloudFront automatizada:** hoy es un comando manual documentado, no está integrada a ningún pipeline.
- **`/auth/register` admin-only:** con `ACCESS-REQUEST-1`, la landing ya no ofrece alta pública (ahora es "Solicitar acceso" vía `/access-request`, que solo manda un email, no crea usuarios). El endpoint `POST /auth/register` del backend, sin embargo, **sigue existiendo y sigue siendo público** (con rate limiting de `SEC-FIX-1`, pero sin auth) — evaluar si conviene cerrarlo a admin-only o eliminarlo si el flujo de alta de usuarios ahora es 100% manual/interno tras una solicitud de acceso aprobada. No se tocó en esta ficha por ser un cambio de lógica de negocio/flujo de auth, fuera de alcance de "solo infraestructura de deploy".
