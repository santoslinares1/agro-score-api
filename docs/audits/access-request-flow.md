# ACCESS-REQUEST-1 — Solicitud de acceso en vez de registro público

**Fecha:** 2026-08-03
**Contexto:** AgroScore todavía no debe tener registro abierto libre. Se reemplaza el flujo público de "crear cuenta" por un flujo de "solicitar acceso": la landing ya no invita a registrarse, sino a dejar una solicitud que llega por email al equipo de AgroScore para habilitar el acceso manualmente.
**Alcance respetado:** no se tocó DB schema ni migrations. No se hizo deploy. No se llamó a `/lots`. No se expusieron secretos. No se rompió `/auth/login`. `POST /auth/register` **sigue existiendo** (ver sección "Qué no se tocó").

Frontend: [`docs/audits/access-request-flow.md`](../../../agro-score-web/docs/audits/access-request-flow.md) en `agro-score-web`.

---

## Qué se agregó

Módulo nuevo `src/access-request/`, mirror exacto de `src/contact/` (mismo patrón: DTO validado con `class-validator`, servicio que arma y envía el email vía Resend con `ConfigService`, controller con `ThrottlerGuard`):

- `access-request.module.ts` — registrado en `app.module.ts` junto a `ContactModule`.
- `access-request.controller.ts` — `POST /access-request`, `@HttpCode(200)` (igual que `/contact`: el resultado se comunica en el body `{ ok, message }`, no vía status code).
- `access-request.service.ts` — arma el mail y lo envía con Resend (o loguea en dry-run).
- `access-request-profile.enum.ts` — enum propio `AccessRequestProfile` (no reutiliza `ContactProfile`; los valores pedidos para este formulario son distintos: productor / asesor / consultora / empresa agro / otro).
- `dto/create-access-request.dto.ts` — `CreateAccessRequestDto`.

## DTO

```ts
class CreateAccessRequestDto {
  name: string;              // requerido, 2–120
  email: string;             // requerido, formato email, máx 160
  organization: string;      // requerido, 2–160
  profile: AccessRequestProfile; // requerido, enum
  estimatedSurface?: string; // opcional, máx 80
  message?: string;          // opcional, máx 2000
}
```

Enum `AccessRequestProfile`: `producer` (Productor), `advisor` (Asesor), `consultancy` (Consultora), `agro_company` (Empresa agro), `other` (Otro).

A diferencia de `CreateContactDto`, `estimatedSurface` y `message` son **opcionales** (`@IsOptional()`) — el formulario de solicitud de acceso no necesita esos datos para ser útil. Si faltan, el email los muestra como "No especificada" / "Sin mensaje adicional".

Igual que `/contact`, cualquier campo fuera del DTO es rechazado con 400 por el `ValidationPipe` global (`whitelist: true`, `forbidNonWhitelisted: true`).

## Email

- **No se creó infraestructura de mail nueva.** `AccessRequestService` reutiliza el mismo mecanismo que `ContactService` (Resend, `ConfigService`, dry-run) y **las mismas variables de entorno**: `CONTACT_TO_EMAIL`, `CONTACT_FROM_EMAIL`, `CONTACT_EMAIL_DRY_RUN`, `RESEND_API_KEY`. No se agregó ninguna variable nueva — `.env.example` solo suma un comentario aclarando que `/access-request` reutiliza estas variables.
- Destino real en producción: `CONTACT_TO_EMAIL=agroscorelatam@gmail.com` (variable existente, sin cambios).
- Asunto: `Solicitud de acceso — AgroScore` (fijo, no interpola datos del usuario — evita necesitar sanitizar el subject).
- Cuerpo: Nombre, Email, Organización/Campo, Perfil, Superficie estimada/cantidad de campos, Mensaje, Fecha/hora, Origen ("Formulario de solicitud de acceso").
- `replyTo` = email del usuario (sanitizado); `from`/`to` siempre vienen de config, nunca del usuario.

## Seguridad (igual que `/contact`)

- **HTML escaping**: todos los campos de usuario pasan por `escapeHtml()` antes de interpolarse en el HTML del email (test: inyecta `<script>` y verifica que llega escapado).
- **Header injection**: `replyTo` pasa por `sanitizeHeaderValue()` (quita `\r\n`); el `subject` es un string fijo, no depende de input de usuario.
- **`from`/`to` nunca vienen del cliente** — siempre de `CONTACT_FROM_EMAIL`/`CONTACT_TO_EMAIL` (config), nunca del payload.
- **Errores genéricos**: un fallo de Resend o la falta de `RESEND_API_KEY` en modo real nunca expone el detalle interno al cliente — solo se loguea server-side con `Logger`, el cliente recibe `"No pudimos enviar la solicitud en este momento"`.
- **Rate limiting**: `@UseGuards(ThrottlerGuard)` + `@Throttle({ default: { limit: 3, ttl: 60_000 } })` — 3 requests/minuto por IP, idéntico a `/contact`.
- **API key server-side únicamente** — `RESEND_API_KEY` se lee vía `ConfigService` dentro del servicio, nunca se expone al frontend.

## Tests nuevos

- `dto/create-access-request.dto.spec.ts` (8 casos): payload válido, payload válido sin campos opcionales, email inválido, `profile` fuera de enum, `name`/`organization` vacíos, `message`/`estimatedSurface` demasiado largos.
- `access-request.controller.spec.ts` (3 casos): delega en el service con el DTO recibido, propaga el error genérico, y verifica metadata de `ThrottlerGuard` (3 req/min) leyendo `Reflect.getMetadata` directamente sobre el método del controller — mismo patrón que `contact.controller.spec.ts`.
- `access-request.service.spec.ts` (9 casos): dry-run no llama a Resend / no requiere API key; modo real arma `to/from/replyTo/subject/html/text` correctamente; nunca usa el email del usuario como `from`; usa los valores por defecto cuando faltan los campos opcionales; escapa HTML; sanitiza `replyTo`; falta de `RESEND_API_KEY` da error controlado; error de Resend no expone detalle interno.

Total: 20 tests nuevos. Suite completa del backend: **165/165** (`npm test`). `npm run build` (`nest build`): sin errores.

## Qué no se tocó

- **`POST /auth/register` sigue existiendo**, sin cambios, con su rate limit de 5 req/min ya vigente desde SEC-FIX-1. Se mantiene por si hace falta alta manual/interna. Ya no lo llama ninguna pantalla pública del frontend (ver doc del frontend). Decisión explícita de esta ficha: no cerrarlo del todo acá — si se decide bloquearlo por completo, es alcance de una ficha futura (`AUTH-POLICY-1`).
- **`POST /contact` sigue existiendo**, sin cambios, funcionando exactamente igual que antes (ver `docs/contact-email.md`). El frontend dejó de usarlo porque la sección de "contacto" de la landing pasó a ser la de "solicitud de acceso" (ver doc del frontend) — pero el endpoint en sí no se tocó ni se eliminó.
- DB schema, migrations, worker: sin cambios.

## Deuda pendiente

- Decidir si `/auth/register` debe cerrarse del todo o volverse admin-only (`AUTH-POLICY-1`).
- Captcha/honeypot si el formulario empieza a recibir spam (mismo punto pendiente que `/contact`).
- Rate limiting en memoria del proceso — si el backend corre con más de una réplica, migrar a un storage compartido (Redis) para que el límite sea efectivo entre todas las instancias (deuda heredada de SEC-FIX-1, aplica igual acá).
- No hay persistencia de las solicitudes (solo viajan por email); si se necesita un historial/CRM, sumar una tabla — explícitamente fuera de alcance de esta ficha.
