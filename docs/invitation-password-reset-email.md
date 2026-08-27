# ADMIN-3 — Envío real de emails (invitaciones + password reset)

> **Deprecado (SMTP-MIGRATION-1):** este documento describe la implementación original vía
> Resend. El envío real ahora pasa por SMTP (Google Workspace) — ver
> [`docs/email-configuration.md`](./email-configuration.md) para la configuración vigente.
> `EMAIL_PROVIDER`/`EMAIL_FROM`/`EMAIL_DRY_RUN`/`RESEND_API_KEY` quedan como fallback deprecado,
> no usar en un `.env` nuevo. El resto de este documento (flujo de invitación/reset,
> `APP_PUBLIC_URL`) sigue vigente.

Cierra la deuda documentada en ADMIN-2 (`docs/admin-backend.md`): las invitaciones
de usuario y los tokens de password reset ya no dependen de que un admin copie
un link de la respuesta HTTP — se envían por email de verdad, usando
[Resend](https://resend.com) (mismo proveedor que `/contact`, ver
`docs/contact-email.md`).

## Servicio

`src/email/email.service.ts` (`EmailService`, `EmailModule`) — centraliza el
envío para dos casos de uso:

- `sendInvitationEmail(to, { invitationUrl, expiresAt })`
- `sendPasswordResetEmail(to, { resetUrl, expiresAt })`

Ambos devuelven:

```ts
{ sent: boolean; provider: string; messageId?: string; dryRun: boolean }
```

Nunca lanzan — un fallo de Resend (o la falta de `RESEND_API_KEY` en modo real)
se refleja en `sent: false` y se loguea server-side con `Logger`, mismo
criterio que `ContactService`. Quien llama (`AdminService`) nunca revierte la
creación del token/invitación por esto — ya se persistió antes de intentar el
envío.

Es un servicio **nuevo**, no una extensión de `ContactService`: copia (no
comparte) las funciones `escapeHtml`/`sanitizeHeaderValue` en
`src/email/email.util.ts` a propósito, para no tocar el flujo de `/contact`
que ya funciona en producción.

## Variables de entorno

```
EMAIL_PROVIDER=resend
EMAIL_FROM="AgroScore <no-reply@agroscorelatam.com>"
EMAIL_DRY_RUN=true
RESEND_API_KEY=
APP_PUBLIC_URL=
```

### Precedencia

`EMAIL_PROVIDER` / `EMAIL_FROM` / `EMAIL_DRY_RUN` son la capa nueva y tienen
prioridad. Si alguna no está seteada, `EmailService` cae a su equivalente de
`/contact`:

| Variable nueva  | Fallback si no está seteada | Default si ninguna está seteada |
|---|---|---|
| `EMAIL_PROVIDER` | `CONTACT_EMAIL_PROVIDER` | `resend` |
| `EMAIL_FROM` | `CONTACT_FROM_EMAIL` | `''` (Resend rechaza el envío) |
| `EMAIL_DRY_RUN` | `CONTACT_EMAIL_DRY_RUN` | `true` — nunca manda un email real por accidente |

`RESEND_API_KEY` siempre se comparte con `/contact` — un solo proveedor
transaccional, una sola API key para todo el backend.

Un `.env` de producción que ya tenga `/contact` configurado (`CONTACT_*`)
**no necesita duplicar nada** para que el envío de invitaciones/reset
funcione: alcanza con no dejar `EMAIL_DRY_RUN` en `true`. Para usar un
remitente o dry-run distinto entre ambos flujos, sí hay que setear las
variables `EMAIL_*` explícitamente.

### `APP_PUBLIC_URL`

Base para armar `invitationUrl`/`resetUrl` — tanto en el email real (siempre)
como en la respuesta HTTP de dev/QA (`NODE_ENV != production`). Apunta a
**agro-score-web**, donde viven las páginas públicas `/accept-invitation` y
`/reset-password` (junto al login real de usuarios — ver "Dónde viven las
páginas públicas" en `docs/admin-backend.md`). Si no está seteada, cae a
`FRONTEND_URL` (que en producción ya vale `https://agroscorelatam.com`).

`ADMIN_APP_URL` (de ADMIN-2) queda deprecada para este propósito — las
páginas públicas ya no viven en agro-score-admin. Se deja documentada en
`.env.example` por si algún `.env` real todavía la tiene seteada; el código
ya no la lee.

## Dry-run (desarrollo sin API key)

Con `EMAIL_DRY_RUN=true` (default), `EmailService`:

1. Arma el email igual que en modo real (mismo `to`/`subject`/`html`/`text`).
2. No llama al SDK de Resend.
3. Loguea con `Logger` el `to`, el `from` y el `subject` — **nunca el link ni
   el token completo** (viajan en el HTML/text del email, que no se loguea en
   dry-run).
4. Devuelve `{ sent: true, provider, dryRun: true }`.

No requiere `RESEND_API_KEY` seteada.

## Envío real

```
EMAIL_DRY_RUN=false
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
EMAIL_FROM="AgroScore <no-reply@dominio-verificado.com>"
APP_PUBLIC_URL=https://agroscorelatam.com
```

Mismas condiciones que `/contact` respecto al remitente: mientras no haya un
dominio propio verificado en Resend, `EMAIL_FROM` puede usar el remitente de
prueba `onboarding@resend.dev` (con las limitaciones que documenta el panel
de Resend). Para producción real, verificar un dominio propio.

## Flujo de invitación

1. Admin crea la invitación (`POST /admin/invitations` o
   `POST /admin/access-requests/:id/create-user`) — sin cambios de lógica
   respecto a ADMIN-2 (token hasheado, 7 días de expiración).
2. `AdminService` arma `invitationUrl` con `APP_PUBLIC_URL`/`FRONTEND_URL` +
   `/accept-invitation?token=...` y llama `EmailService.sendInvitationEmail`.
3. Se auditan **dos** acciones separadas: `admin.invitation.created` (la
   invitación existe en DB) y `admin.invitation.email_sent` (resultado del
   envío — éxito o fallo, siempre se audita).
4. El usuario abre el link → `features/public/accept-invitation` en
   **agro-score-web** → `POST /auth/accept-invitation` → cuenta creada, login
   automático, se audita `auth.invitation.accepted`.

## Flujo de password reset

1. Admin genera el token (`POST /admin/users/:id/password-reset`) para un
   usuario existente.
2. `AdminService` arma `resetUrl` y llama
   `EmailService.sendPasswordResetEmail`. Se auditan
   `admin.password_reset.created` y `admin.password_reset.email_sent`.
3. El usuario abre el link → `features/public/reset-password` en
   **agro-score-web** → `POST /auth/reset-password` (nuevo — ver
   `docs/admin-backend.md`) → password actualizada, token marcado como usado,
   se audita `auth.password_reset.completed`.
4. A diferencia de accept-invitation, **no hay login automático** — el
   frontend redirige a `/login` después de un reset exitoso (con un password
   que el usuario acaba de tener que recuperar, pedir que inicie sesión de
   nuevo con la contraseña nueva es el default más seguro).

## Respuesta HTTP — producción vs. desarrollo

`emailSent` / `dryRun` / `provider` viajan **siempre**, en cualquier entorno
— son el reemplazo del viejo campo `message` de ADMIN-2 ("el envío de email
no está integrado"), que ya no aplica.

`invitationToken` / `invitationUrl` (o `resetToken` / `resetUrl`) solo viajan
si `NODE_ENV != production` — pensado para desarrollo/QA manual, nunca para
uso productivo. En producción, el email es el único canal de entrega del
link.

```json
// POST /admin/invitations — desarrollo
{
  "id": "...",
  "email": "...",
  "role": "user",
  "expiresAt": "...",
  "emailSent": true,
  "dryRun": true,
  "provider": "resend",
  "invitationToken": "...",
  "invitationUrl": "http://localhost:4200/accept-invitation?token=..."
}
```

```json
// POST /admin/invitations — producción
{
  "id": "...",
  "email": "...",
  "role": "user",
  "expiresAt": "...",
  "emailSent": true,
  "dryRun": false,
  "provider": "resend"
}
```

## Seguridad

Mismos principios que `/contact` (ver `docs/contact-email.md`), más los
específicos de tokens de un solo uso ya documentados en ADMIN-2
(`docs/admin-backend.md`):

- **API key solo en backend**, compartida con `/contact`.
- **HTML escaping** en el link interpolado en el template (`escapeHtml`,
  copiado de `contact.service.ts`).
- **Nunca se loguea el token/link completo** — ni en dry-run ni en un envío
  real fallido (el error de Resend se loguea, el contenido del email no).
- **Nunca se devuelve `tokenHash`/`passwordHash`** en ninguna respuesta HTTP.
- **El audit log sanitiza `before`/`after` recursivamente** (`AuditLogService`,
  ver ADMIN-2) — aunque un caller pasara por error un campo `token`/`password`,
  se omite igual.

## Deuda pendiente

- **No hay "olvidé mi contraseña" autoservicio.** El reset lo sigue
  disparando un admin (`POST /admin/users/:id/password-reset`) — no existe un
  endpoint público donde un usuario pida su propio reset por email. Agregar
  eso implica decisiones de rate-limiting/enumeración de usuarios que quedan
  fuera de esta ficha.
- **No hay endpoint de reenvío** de invitación/reset. Si el email no llegó
  (`emailSent: false`, o simplemente se perdió), la única opción hoy es
  generar una invitación/token nuevo desde cero.
- **Un solo proveedor (Resend).** `EMAIL_PROVIDER`/`CONTACT_EMAIL_PROVIDER`
  quedan reservadas para el día que se soporte más de uno; hoy el único valor
  con efecto real es `resend`.
