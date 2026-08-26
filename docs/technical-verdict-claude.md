# PR 11B — Veredicto técnico con Claude real

Segunda parte de PR 11A (`docs`: ver commit `aca7b0f`, "feat(api): add
technical verdict contract for analyses"). PR 11A dejó el modelo, la
persistencia (`analysis_technical_verdicts`) y un generador determinístico
local (`deterministic-v1`). Este PR agrega una segunda implementación real
sobre Anthropic, seleccionable por variable de entorno — **sin cambiar el
contrato de `GET /analysis/:id`** ni el flujo de producto: el veredicto sigue
siendo parte del resultado normal del análisis, nunca un botón ni una
sección "Interpretar con IA".

## Provider configurable

```
TECHNICAL_VERDICT_PROVIDER=deterministic | claude
```

- `deterministic` (default: vacía o cualquier valor no reconocido cae acá,
  con un `warning` en el log si el valor no está vacío pero tampoco es
  válido): reglas locales sobre score/NDVI/NDMI, sin red, sin API key. Es lo
  que corre en desarrollo y en los tests por default.
- `claude`: llama a la API de Anthropic server-side, vía el SDK oficial
  (`@anthropic-ai/sdk`). **Nunca se llama desde el frontend.**

La resolución vive en `AnalysisVerdictService.resolveGenerator()`
(`src/analysis-verdict/analysis-verdict.service.ts`) y nunca tira una
excepción por un valor de env inesperado — cae a `deterministic` siempre que
el valor no sea exactamente `claude`.

## Variables de entorno

Ver `.env.example`.

```
TECHNICAL_VERDICT_PROVIDER=deterministic
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=
ANTHROPIC_TIMEOUT_MS=
```

- `ANTHROPIC_API_KEY`: secreto real. **Nunca commitear.** Solo se lee
  server-side, dentro de `ClaudeTechnicalVerdictGenerator`
  (`src/analysis-verdict/generators/claude-technical-verdict.generator.ts`).
  Si falta y `TECHNICAL_VERDICT_PROVIDER=claude`, el boot de la app **no
  falla** — recién al generar el primer veredicto ese análisis particular
  queda `technicalVerdict.status = "failed"`, con `errorMessage` genérico
  (nunca la key, nunca el error crudo del SDK).
- `ANTHROPIC_MODEL`: vacía → usa el default interno
  `DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5'` (constante en el mismo
  archivo del generador, nunca hardcodeada en la lógica de negocio). Ver
  nota abajo sobre por qué no es `claude-3-5-haiku-latest`.
- `ANTHROPIC_TIMEOUT_MS`: vacía → `20000` (20s). Se pasa como timeout
  per-request al SDK (`client.messages.create(params, { timeout })`), así
  que nunca se hereda del timeout global (10 min) del cliente.

### Nota sobre el modelo por defecto

El valor sugerido originalmente en la ficha (`claude-3-5-haiku-latest`)
corresponde a un modelo de la generación Claude 3.5, retirado. Se usó en su
lugar el equivalente vigente de gama Haiku (`claude-haiku-4-5`) como
default interno — sigue siendo 100% configurable vía `ANTHROPIC_MODEL` sin
tocar código.

## Arquitectura

```
AnalysisVerdictService (orquestador, sin cambios de responsabilidad desde PR 11A)
  → resolveGenerator() según TECHNICAL_VERDICT_PROVIDER
  → arma VerdictGeneratorInput (buildVerdictGeneratorInput, sin cambios de PR 11A)
  → generator.generate(input)
  → persiste generated/failed

TechnicalVerdictGenerator (interfaz común)
  ├── DeterministicTechnicalVerdictGenerator   — envuelve generateTechnicalVerdict (PR 11A, intacto)
  └── ClaudeTechnicalVerdictGenerator           — Anthropic SDK real
        └── claude-output.validator.ts          — valida/normaliza el output antes de persistirlo
        └── technical-verdict-prompt.ts          — system prompt + tool schema + prompt version
```

Todo vive bajo `src/analysis-verdict/generators/`. `AnalysisVerdictModule`
provee ambos generadores siempre (construcción de `ClaudeTechnicalVerdictGenerator`
es barata — el cliente de Anthropic es lazy, solo se instancia la primera vez
que `generate()` corre con provider=claude).

## Cómo le habla a Claude

- Un único tool call forzado (`tool_choice: { type: 'tool', name:
  'submit_technical_verdict' }`) con `strict: true` — la API ya rechaza
  cualquier `verdict`/`confidence` fuera de enum o con tipos incorrectos, no
  es texto libre que después haya que parsear con regex.
- `messages: [{ role: 'user', content: <JSON> }]` — el mismo
  `VerdictGeneratorInput` que ya usa el generador determinístico (score,
  `hasZoneData`, NDVI promedio/variabilidad, NDMI promedio). Nunca viaja
  GeoJSON, imágenes, tokens de usuario ni ningún dato personal.
- `promptVersion = "technical-verdict-v1"` (`TECHNICAL_VERDICT_PROMPT_VERSION`
  en `technical-verdict-prompt.ts`) — se persiste en
  `AnalysisTechnicalVerdict.promptVersion`; bump esa constante si el prompt o
  el schema de la tool cambian de forma que afecte el resultado.
- `inputSnapshot` (jsonb) guarda `VerdictGeneratorInput` + `{ model:
  <ANTHROPIC_MODEL efectivo> }` — no se agregó una columna `model` nueva
  (no hacía falta migración: alcanza con `generator` + `promptVersion` +
  `inputSnapshot.model`, tal como pedía la ficha).

## Validación defensiva del output

`claude-output.validator.ts` es la única puerta de entrada del output de
Anthropic hacia la base de datos — nunca se confía ciegamente en el modelo,
aunque `strict: true` ya cubre tipos/enums:

- `verdict`/`confidence` fuera de enum → rechaza (se marca `failed`).
- `summary` vacío o ausente → rechaza.
- Arrays faltantes, mal tipados, o con items no-string → se normalizan a lo
  válido (nunca hacen fallar todo el veredicto por un array corrupto).
- Límites: `summary` ≤ 1200 caracteres, `keyFindings`/`possibleCauses`/
  `recommendations` ≤ 6 items, `limitations` ≤ 5 items, cada item ≤ 300
  caracteres — se truncan/recortan, nunca se guarda texto sin control.
- Si el texto generado menciona "Claude", "Anthropic", "chatbot",
  "inteligencia artificial" o "IA" (como palabra suelta, sin falsos
  positivos con "historia"/"compañía"/etc.) → rechaza. Es la defensa en
  profundidad detrás del system prompt, que ya le pide a Claude no
  mencionarse a sí mismo.

## Errores, timeouts, y por qué el análisis nunca se rompe

`ClaudeTechnicalVerdictGenerator` nunca deja pasar un error crudo del SDK:
cadena de `instanceof` más-específico-primero
(`AuthenticationError → NotFoundError → RateLimitError → APIConnectionError → APIError`)
que convierte cada caso en un mensaje corto y sin secretos. Ese error sube a
`AnalysisVerdictService.generateAndPersist`, que:

1. Ya tiene su propio try/catch (desde PR 11A): si el generador falla,
   persiste una fila `status='failed'` con contenido "seguro" (no null) —
   `verdict: 'insufficient_data'`, `confidence: 'low'`, `summary`/
   `limitations` genéricos, `errorMessage` con el detalle interno
   (truncado a 500 caracteres, nunca la API key).
2. El caller (`AnalysisService.processFieldAnalysisInBackground`) envuelve
   esa llamada en un `.catch()` adicional — ni siquiera un fallo al guardar
   la fila `failed` puede tumbar el análisis, que ya se guardó como
   `Finalizado` antes de intentar generar el veredicto.

`GET /analysis/:id` con un veredicto fallido devuelve:

```json
{
  "technicalVerdict": {
    "status": "failed",
    "verdict": "insufficient_data",
    "confidence": "low",
    "summary": "No se pudo generar el veredicto técnico automático.",
    "keyFindings": [],
    "possibleCauses": [],
    "recommendations": [],
    "limitations": ["El análisis satelital finalizó, pero la interpretación automática no pudo generarse."],
    "generatedAt": null,
    "generator": "claude",
    "promptVersion": "technical-verdict-v1"
  }
}
```

## Frontend

Sin cambios de contrato desde PR 11A — sigue siendo `technicalVerdict` dentro
de `GET /analysis/:id`, `null` mientras no exista fila. El frontend no sabe
(ni necesita saber) si el veredicto vino del generador determinístico o de
Claude; `generator`/`promptVersion` son metadata interna para auditar/depurar,
no texto pensado para mostrarse tal cual en la UI.

## PR 14A — Lenguaje conservador (`technical-verdict-v1.1`)

AgroScore trabaja con índices satelitales (NDVI/NDMI) que deben validarse en
campo, no con diagnósticos agronómicos definitivos. PR 14A ajustó el system
prompt (`buildSystemPrompt()` en `technical-verdict-prompt.ts`) y agregó una
segunda capa de validación en `claude-output.validator.ts` para reforzar
esto:

- El veredicto técnico usa lenguaje hipotético y conservador ("podría estar
  asociado a...", "es compatible con...", "conviene validar si...") en vez
  de afirmaciones causales definitivas ("hay estrés hídrico", "la causa
  es...").
- Los índices satelitales (NDVI/NDMI) no confirman causas agronómicas por sí
  solos — son indicadores que orientan la interpretación y siempre requieren
  contraste con observación en campo, manejo, riego, suelo, relieve y clima.
- El output debe recomendar validación en campo antes de concluir una causa,
  y nunca recomienda productos, dosis, fertilización específica,
  fitosanitarios ni riego en cantidad/frecuencia concreta.
- `claude-output.validator.ts` agrega `containsUnhedgedCausalClaim` como
  defensa en profundidad (igual criterio que `containsForbiddenTerms` para
  autorreferencias): rechaza afirmaciones directas no hedgeadas de causas
  agronómicas (`hay estrés hídrico`, `existe compactación`, `la causa es...`,
  `el problema es...`, `se debe a...`) sin bloquear el mismo vocabulario
  cuando aparece hedgeado (`podría estar asociado a estrés hídrico`,
  `validar si existe compactación`). Es un chequeo acotado a patrones
  concretos, no un detector de hedging general — si el texto es dudoso pero
  no matchea ninguno de esos patrones, se deja pasar (el prompt es la
  primera línea de defensa).
- La `promptVersion` nueva (`technical-verdict-v1.1`, no `v2`: mismo
  contrato/schema de la tool, solo cambia la política de redacción) aplica
  únicamente a veredictos nuevos. Los veredictos ya persistidos con
  `promptVersion="technical-verdict-v1"` no se regeneran — quedan
  identificables contra la política de redacción anterior.
