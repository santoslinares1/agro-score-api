# Contact-1 — Formulario de contacto público (Resend)

> **Deprecado (SMTP-MIGRATION-1):** este documento describe la implementación original vía
> Resend. El envío real ahora pasa por SMTP (Google Workspace) — ver
> [`docs/email-configuration.md`](./email-configuration.md) para la configuración vigente.
> `CONTACT_TO_EMAIL`/`CONTACT_FROM_EMAIL`/`RESEND_API_KEY` quedan como fallback deprecado, no
> usar en un `.env` nuevo. El resto de este documento (payload, DTO, seguridad) sigue vigente.

Endpoint público que recibe las consultas del formulario de contacto de la landing
y las envía por email a AgroScore usando [Resend](https://resend.com) como
proveedor transaccional. Reemplaza el intento anterior con Gmail SMTP (la cuenta
`agroscorelatam@gmail.com` no tiene disponible la opción de "Contraseñas de
aplicación").

## Endpoint

```
POST /contact
```

Público, sin autenticación. Sujeto al `ValidationPipe` global (`whitelist: true`,
`forbidNonWhitelisted: true`, `transform: true`) — cualquier campo fuera del DTO
hace que la request completa sea rechazada con 400.

### Payload

```json
{
  "name": "Santos Linares",
  "email": "santos9linares@gmail.com",
  "companyOrField": "Campo La Esperanza",
  "profile": "producer",
  "estimatedSurface": "120 ha",
  "message": "Quiero evaluar AgroScore para analizar lotes internos y generar reportes técnicos."
}
```

| Campo | Tipo | Validación |
|---|---|---|
| `name` | string | requerido, 2–120 caracteres |
| `email` | string | requerido, formato de email válido, máx. 160 caracteres |
| `companyOrField` | string | requerido, 2–160 caracteres |
| `profile` | enum | requerido, ver [`ContactProfile`](../src/contact/contact-profile.enum.ts) |
| `estimatedSurface` | string | requerido, 1–80 caracteres |
| `message` | string | requerido, 10–2000 caracteres |

### Enum `profile`

| Valor | Label mostrado en el email |
|---|---|
| `producer` | Productor |
| `agronomist` | Asesor agronómico |
| `consultancy` | Consultora |
| `technical_team` | Equipo técnico |
| `other` | Otro |

### Respuestas

Éxito (200):

```json
{ "ok": true, "message": "Consulta enviada correctamente" }
```

Error de envío (200 — el fallo se comunica en el body, no vía status code, para
que el frontend no dependa de manejar 4xx/5xx además de `ok`):

```json
{ "ok": false, "message": "No pudimos enviar la consulta en este momento" }
```

Errores de validación de DTO (email inválido, mensaje corto, `profile` fuera de
enum, campos faltantes, etc.) devuelven 400 con el detalle estándar de
`class-validator`, generado por el `ValidationPipe` global — no pasan por
`ContactService`.

## Variables de entorno

Ver `.env.example`.

```
CONTACT_TO_EMAIL=agroscorelatam@gmail.com
CONTACT_FROM_EMAIL="AgroScore <onboarding@resend.dev>"
CONTACT_EMAIL_PROVIDER=resend
CONTACT_EMAIL_DRY_RUN=true
RESEND_API_KEY=
```

- `CONTACT_TO_EMAIL`: destinatario final (bandeja de AgroScore).
- `CONTACT_FROM_EMAIL`: remitente autorizado por Resend. Mientras no haya un
  dominio propio verificado en Resend, usar el remitente de prueba
  `onboarding@resend.dev` (permitido por Resend sin verificación de dominio).
- `CONTACT_EMAIL_PROVIDER`: reservado para el día que se soporte más de un
  proveedor; hoy el único valor válido es `resend`.
- `CONTACT_EMAIL_DRY_RUN`: `true` en desarrollo — no llama a Resend, solo
  loguea el email que se hubiera enviado. `false` en producción.
- `RESEND_API_KEY`: secreto real. **Nunca commitear.** Solo se lee en el
  backend (`ContactService`), nunca se expone al frontend.

## Dry-run (desarrollo sin API key)

Con `CONTACT_EMAIL_DRY_RUN=true` (default en `.env.example`), `ContactService`:

1. Arma el email igual que en modo real (mismo `to`/`from`/`replyTo`/`subject`/
   `html`/`text`).
2. No llama al SDK de Resend.
3. Loguea con `Logger` (prefijo `[Contact]`) el `to`, `from`, `replyTo`,
   `subject` y el cuerpo en texto plano.
4. Responde `{ ok: true, message: "Consulta enviada correctamente" }`.

No requiere `RESEND_API_KEY` seteada.

## Envío real

1. Crear una cuenta en [resend.com](https://resend.com) y generar una API key
   en **API Keys → Create API Key**.
2. Setear en el `.env` de producción:

   ```
   CONTACT_EMAIL_DRY_RUN=false
   RESEND_API_KEY=re_xxxxxxxxxxxxxxxxx
   CONTACT_FROM_EMAIL="AgroScore <contacto@dominio-verificado.com>"
   ```

3. Mientras no exista un dominio propio verificado en Resend, `CONTACT_FROM_EMAIL`
   puede seguir apuntando al remitente de prueba `onboarding@resend.dev` — Resend
   permite enviar desde ese remitente sin verificar dominio, con las
   limitaciones que documenta su panel (principalmente, solo llega de forma
   confiable a la cuenta de Resend del propio proyecto). Para producción real,
   verificar un dominio propio en Resend y usarlo en `CONTACT_FROM_EMAIL`.
4. Con `CONTACT_EMAIL_DRY_RUN=false`, si `RESEND_API_KEY` falta, el servicio
   loguea el error server-side y responde el mensaje genérico de error al
   cliente (nunca expone el detalle interno).

### Probar con curl

```bash
curl -X POST http://localhost:3001/contact \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Santos Linares",
    "email": "santos9linares@gmail.com",
    "companyOrField": "Campo La Esperanza",
    "profile": "producer",
    "estimatedSurface": "120 ha",
    "message": "Quiero probar AgroScore para diagnosticar lotes internos y generar reportes técnicos."
  }'
```

Con `CONTACT_EMAIL_DRY_RUN=true` responde `{"ok":true,"message":"Consulta enviada correctamente"}`
y loguea el dry-run en consola, sin requerir `RESEND_API_KEY`.

## Seguridad

- **API key solo en backend.** `RESEND_API_KEY` se lee vía `ConfigService`
  dentro de `ContactService`; nunca se envía al cliente ni se referencia desde
  el frontend.
- **`replyTo` = email del usuario, nunca `from`.** El remitente (`from`)
  siempre es `CONTACT_FROM_EMAIL` (controlado por env, autorizado por Resend).
  Si se usara el email del usuario como `from`, Resend rechazaría el envío
  (dominio no verificado) o, peor, permitiría spoofing.
- **`to` fijo por env** (`CONTACT_TO_EMAIL`) — el cliente no puede elegir
  destinatario.
- **HTML escaping.** Todos los campos de usuario (`name`, `email`,
  `companyOrField`, `profile` label, `estimatedSurface`, `message`) pasan por
  `escapeHtml()` antes de interpolarse en el cuerpo HTML del email, para
  evitar inyección de markup/XSS en el email recibido.
- **Header injection.** El `subject` y el `replyTo` pasan por
  `sanitizeHeaderValue()`, que quita `\r`/`\n` — sin esto, un usuario podría
  inyectar headers de email adicionales (p. ej. `Bcc:`) a través de un campo
  con saltos de línea.
- **Errores genéricos al cliente.** Un fallo de Resend (o la falta de
  `RESEND_API_KEY` en modo real) nunca expone el mensaje interno del error;
  solo se loguea server-side con `Logger` y el cliente recibe el mensaje
  genérico `"No pudimos enviar la consulta en este momento"`.
- **Rate limiting / honeypot: deuda pendiente.** El proyecto no tiene
  `ThrottlerModule` configurado todavía; agregarlo específicamente para este
  endpoint hubiera significado una dependencia y un refactor fuera del alcance
  de esta ficha. `POST /contact` es público y hoy no tiene límite de tasa ni
  honeypot anti-spam propios — queda como deuda técnica a resolver antes de
  darle mucha exposición pública a la landing (ver también
  `docs/audits/contact-form.md`).
