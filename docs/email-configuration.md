# Configuración de email AgroScore

**SMTP-MIGRATION-1** — reemplaza a Resend (`docs/contact-email.md` y
`docs/invitation-password-reset-email.md`, ambos deprecados por este documento) por SMTP directo
contra Google Workspace. Un único servicio (`EmailService`, `src/email/email.service.ts`)
centraliza los 5 flujos de mail del backend; ninguno instancia su propio transporte.

## Arquitectura

```
slinares@agroscorelatam.com
  → cuenta real de Google Workspace, única credencial SMTP (SMTP_USER/SMTP_PASS)

no-reply@agroscorelatam.com
  → alias de slinares@, remitente visible de todo mail saliente (MAIL_FROM)

contacto@agroscorelatam.com
  → Google Group, receptor de solicitudes/consultas (CONTACT_EMAIL) y reply-to
    default de los mails transaccionales (MAIL_REPLY_TO)

reportes@agroscorelatam.com
  → Google Group, copia BCC de los reportes automáticos enviados (REPORTS_BCC_EMAIL)
```

**`contacto@` y `reportes@` son grupos de Google, no cuentas** — nunca se usan como `SMTP_USER`
en ningún flujo. El backend nunca los usa para autenticarse contra SMTP, solo como `to`/`bcc`.

## Variables de entorno

```
MAIL_PROVIDER=smtp

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=slinares@agroscorelatam.com
SMTP_PASS=<app-password-de-slinares>

MAIL_FROM=no-reply@agroscorelatam.com
MAIL_REPLY_TO=contacto@agroscorelatam.com

CONTACT_EMAIL=contacto@agroscorelatam.com
REPORTS_BCC_EMAIL=reportes@agroscorelatam.com

MAIL_DRY_RUN=true
```

`REPORTS_BCC_EMAIL` es opcional — si queda vacía, el reporte semanal se manda igual, sin bcc.
Todas las demás son requeridas para envío real (`MAIL_DRY_RUN=false`); `MAIL_DRY_RUN` en sí es
opcional y por default vale `true` (nunca manda un email real por accidente en un entorno mal
configurado).

### Mapping — variables viejas (Resend) → nuevas (SMTP)

| Variable vieja | Variable nueva | Notas |
|---|---|---|
| `CONTACT_TO_EMAIL` | `CONTACT_EMAIL` | destinatario de `/access-request` y `/contact` |
| `CONTACT_FROM_EMAIL` / `EMAIL_FROM` | `MAIL_FROM` | remitente único de todo el backend |
| `CONTACT_EMAIL_PROVIDER` / `EMAIL_PROVIDER` | `MAIL_PROVIDER` | siempre `smtp` ahora |
| `CONTACT_EMAIL_DRY_RUN` / `EMAIL_DRY_RUN` | `MAIL_DRY_RUN` | un solo flag de dry-run para todo |
| `RESEND_API_KEY` | `SMTP_PASS` | ya no es una API key — es el app password de Google Workspace |
| *(no existía)* | `MAIL_REPLY_TO` | nuevo — reply-to default de invitación/reset/reporte |
| *(no existía)* | `REPORTS_BCC_EMAIL` | nuevo — bcc del reporte semanal, opcional |
| *(no existía)* | `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` | nuevos — conexión SMTP |

Las variables viejas se mantienen como **fallback deprecado**: si `MAIL_FROM`/`MAIL_DRY_RUN`/
`CONTACT_EMAIL` no están seteadas, `EmailService` cae a su equivalente vieja (`EMAIL_FROM` →
`CONTACT_FROM_EMAIL`, `EMAIL_DRY_RUN` → `CONTACT_EMAIL_DRY_RUN`, `CONTACT_TO_EMAIL`) — así un
`.env` real que todavía no migró sigue funcionando, aunque ya no debería usarse en un `.env`
nuevo. `RESEND_API_KEY` **no tiene fallback**: si `SMTP_PASS` falta, el envío real falla con un
error claro en logs (ver "Validación", más abajo) — no hay forma de que el backend vuelva a
Resend solo, el SDK ya no está instalado (`resend` se sacó de `package.json`).

## Flujos

Los 5 flujos de mail del backend, todos servidos por `EmailService`:

| Flujo | Método | `to` | `from` | `reply-to` | `bcc` |
|---|---|---|---|---|---|
| Solicitud de acceso (`POST /access-request`) | `sendAccessRequestNotification` | `CONTACT_EMAIL` | `MAIL_FROM` | email del solicitante (o `MAIL_REPLY_TO` si no es válido) | — |
| Consulta pública (`POST /contact`) | `sendContactInquiry` | `CONTACT_EMAIL` | `MAIL_FROM` | email del consultante | — |
| Invitación de usuario | `sendInvitationEmail` | usuario invitado | `MAIL_FROM` | `MAIL_REPLY_TO` | — |
| Reset de contraseña | `sendPasswordResetEmail` | usuario | `MAIL_FROM` | `MAIL_REPLY_TO` | — |
| Reporte semanal automático | `sendScheduledAnalysisEmail` | usuario final | `MAIL_FROM` | `MAIL_REPLY_TO` | `REPORTS_BCC_EMAIL` (si está configurada) |

`to`/`from`/`bcc` siempre vienen de config — nunca del payload del cliente. Solicitud de acceso y
consulta pública son los únicos flujos donde `reply-to` depende de un dato del usuario (su
propio email, ya validado por el DTO con `@IsEmail`); si por algún motivo llegara vacío, cae a
`MAIL_REPLY_TO` en vez de quedar sin reply-to.

## Servicio

`EmailService` (`src/email/email.service.ts`) — sin cambios de superficie pública para los 3
métodos que ya existían (`sendInvitationEmail`, `sendPasswordResetEmail`,
`sendScheduledAnalysisEmail`, llamados desde `AdminService` y
`ScheduledAnalysisRunnerService`), más 2 métodos nuevos que reemplazan el envío que antes vivía
en `AccessRequestService`/`ContactService` (cada uno instanciaba su propio cliente Resend):

- `sendAccessRequestNotification(dto: CreateAccessRequestDto)`
- `sendContactInquiry(dto: CreateContactDto)`

`AccessRequestService` y `ContactService` ya no arman ni mandan el mail — solo persisten (el
primero) y traducen el `EmailSendResult` a la respuesta pública `{ ok, message }` que ya
consumía el frontend (sin cambios de contrato HTTP).

Los templates HTML/text de cada flujo se movieron a `src/email/templates/` (ya existían para
invitación/reset/reporte; se sumaron `access-request-notification.template.ts` y
`contact-inquiry.template.ts`, extraídos 1:1 de los `buildMail` que antes vivían en cada
servicio). `escapeHtml`/`sanitizeHeaderValue` (protección XSS y header injection) se
consolidaron en `email.util.ts`, reusadas por los 5 templates.

## Transporte SMTP

`nodemailer` reemplaza al SDK de `resend` (que se desinstaló de `package.json` — ningún flujo lo
usa más). El transporter es lazy (mismo patrón que tenía el viejo cliente Resend): no se
construye ni se valida en el arranque de la app, así que un `.env` con SMTP mal configurado
nunca tumba el boot — el error sale recién en el primer intento de envío real, queda contenido
(nunca se propaga al caller) y se refleja en `sent: false`.

## Dry-run (desarrollo sin credenciales SMTP)

Con `MAIL_DRY_RUN=true` (default), `EmailService`:

1. Arma el email igual que en modo real (mismo `to`/`from`/`reply-to`/`bcc`/`subject`/`html`/`text`).
2. No abre conexión SMTP.
3. Loguea con `Logger` el `to`, `from`, `reply-to`/`bcc` (si aplican) y el `subject` — **nunca**
   el link/token completo (viaja en el HTML/text del email, que no se loguea en dry-run) ni
   `SMTP_PASS` (nunca se loguea, tampoco en modo real).
4. Devuelve `{ sent: true, provider: 'smtp', dryRun: true }`.

No requiere ninguna variable `SMTP_*` seteada.

## Envío real

```
MAIL_DRY_RUN=false
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=slinares@agroscorelatam.com
SMTP_PASS=<app-password-de-slinares>
MAIL_FROM=no-reply@agroscorelatam.com
MAIL_REPLY_TO=contacto@agroscorelatam.com
CONTACT_EMAIL=contacto@agroscorelatam.com
REPORTS_BCC_EMAIL=reportes@agroscorelatam.com
```

## Validación

`EmailService` valida configuración de forma **lazy** (mismo criterio que el resto del proyecto,
p. ej. `AnalysisVerdictService`/`ClaudeTechnicalVerdictGenerator` con `ANTHROPIC_API_KEY`):
nunca en el boot, siempre en el primer intento de envío real (`MAIL_DRY_RUN=false`).

- **`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`** — si falta alguna, el transporter
  lanza un error listando exactamente cuáles faltan (nunca el valor de `SMTP_PASS`, solo su
  nombre). El error queda contenido dentro de `EmailService` (try/catch), nunca se propaga —
  se loguea con `Logger.error` y el método devuelve `{ sent: false, ... }`.
- **`MAIL_FROM`** — si falta, se loguea el error y se devuelve `sent: false` sin intentar abrir
  conexión SMTP.
- **`CONTACT_EMAIL`** — solo relevante para solicitud de acceso/consulta pública; si falta, el
  envío falla de la misma forma (destinatario vacío) con error claro en logs.
- **`REPORTS_BCC_EMAIL`** — opcional, sin validación: si falta, el reporte semanal se manda sin
  bcc, comportamiento esperado, no un error.

Nunca se loguea `SMTP_PASS`, ni en dry-run ni en el mensaje de error de config incompleta.

## Nota Google Workspace

`MAIL_FROM` debe estar configurado en Google Workspace como **alias autorizado** de `SMTP_USER`
("Enviar correo como" en la configuración de Gmail de `slinares@agroscorelatam.com`) — el
backend no lo valida, es responsabilidad de la configuración de Workspace. Sin ese alias
autorizado, Gmail rechaza o reescribe el remitente de los mails salientes.

`contacto@agroscorelatam.com` y `reportes@agroscorelatam.com` son **Google Groups**, no
cuentas de usuario — no tienen password propio y nunca deben configurarse como `SMTP_USER`.

## Producción

Editar `deploy/aws/.env.backend` (archivo real, gitignored, vive en el servidor — no confundir
con `deploy/aws/env.backend.example`, que es la plantilla versionada) con las variables de
"Envío real" de arriba. **No commitear secretos** — `SMTP_PASS` nunca debe llegar a git.

## Tests

`src/email/email.service.spec.ts` cubre los 5 flujos (dry-run, envío real, from/reply-to/bcc por
flujo, config faltante, XSS, header injection). `src/email/no-resend-usage.spec.ts` verifica que
`src/email/`, `src/access-request/` y `src/contact/` no vuelvan a importar el SDK de Resend.
`access-request.service.spec.ts`/`contact.service.spec.ts` verifican que cada servicio delega en
`EmailService` y traduce su resultado sin exponer detalle interno.
