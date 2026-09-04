# Technical Verdict / Claude Integration

Documento operativo de la feature completa: qué es, cómo se genera, dónde
aparece, cómo probarla y cómo apagarla rápido. Pensado para cualquier
dev/ops que necesite tocar o debuguear esto sin releer los ~9 PRs que la
construyeron.

Historial de PRs que armaron esta feature (para rastrear el porqué de una
decisión puntual, no para entender el estado actual — este documento es la
fuente de verdad del estado actual):
`11A` (contrato/persistencia) → `11B` (provider Claude real) → `11C` (web)
→ `11D` (PDF) → `12A` (mail semanal) → `13A`/`13B` (admin) → `14A` (prompt
conservador) → `15A` (este documento) → `17` (retry correctivo ante rechazo
de seguridad + retry manual admin).

> **Diagnóstico semanal (`weeklyTechnicalVerdict`)**: interpretación de la
> *evolución* de un campo vs. su reporte semanal anterior — un concepto
> relacionado pero deliberadamente separado de este (`technicalVerdict`
> interpreta un análisis puntual, sin eje temporal). Ver
> `docs/weekly-technical-verdict.md` (PR 16A/16B en adelante). **No** tiene
> el retry correctivo de PR 17 — eso es exclusivo de `technicalVerdict` por
> ahora.

---

## 1. Resumen

Technical Verdict ("Diagnóstico AgroScore") es la interpretación técnica
automática de un `Analysis` ya finalizado: a partir de las métricas
satelitales ya calculadas (score, NDVI, NDMI, zonas de vigor), genera un
veredicto (`favorable` / `attention` / `critical` / `insufficient_data`)
con un resumen, hallazgos, posibles causas, recomendaciones y limitaciones,
todo en español y en lenguaje hipotético (ver sección 9).

Se dispara automáticamente al finalizar un `Analysis` exitoso — nunca antes.
Según `TECHNICAL_VERDICT_PROVIDER`, lo genera un motor de reglas local
(`deterministic-v1`, sin red) o Claude real (`claude`, server-side vía el
SDK de Anthropic). Se persiste en `analysis_technical_verdicts`, una fila
por análisis.

No es un chat, no tiene un botón "Interpretar con IA" para el productor, y
nunca se llama desde el frontend — ni el web público ni el admin hablan con
Anthropic directamente. El frontend solo lee lo que este backend ya generó
y guardó. Desde PR 17 existe una única acción manual, exclusiva de
admin/owner y solo sobre el veredicto (nunca sobre el pipeline completo) —
ver sección 10.

## 2. Flujo de generación

```
POST /field/:fieldId  (alias legacy: POST /analysis/field/:fieldId)
  → AnalysisController.runFieldAnalysis
  → AnalysisService.runFieldAnalysis          (crea Analysis, status='Procesando')
  → processFieldAnalysisInBackground           (fire-and-forget, no bloquea la respuesta HTTP)
      → PythonWorkerService.runFieldAnalysis    (worker FastAPI, cálculo real)
      → analysis.status = 'Finalizado'
      → AnalysisVerdictService.generateAndPersist(analysis)
          → resolveGenerator() según TECHNICAL_VERDICT_PROVIDER
          → deterministic | claude
              → (si claude) ClaudeTechnicalVerdictGenerator.generate()
                  → intento 1 → validateAndNormalizeGeneratedVerdict()
                  → si rechazo de seguridad (PR 17): intento 2 correctivo, mismo validador
          → INSERT/UPDATE analysis_technical_verdicts (status='generated' | 'failed')
```

El mismo `generateAndPersist` corre para los análisis semanales programados
(`ScheduledAnalysisRunnerService`, ver sección 8) apenas su `Analysis`
llega a `'Finalizado'` — es el mismo código, no una segunda implementación.
El retry correctivo de PR 17 (ver sección 10) vive dentro de
`ClaudeTechnicalVerdictGenerator`, así que también aplica automáticamente
ahí — no hizo falta tocar `generateAndPersist` ni el runner semanal.

Puntos clave:

- **Best-effort, nunca bloqueante.** `generateAndPersist` nunca propaga una
  excepción — si el generador o el guardado fallan, persiste una fila
  `status='failed'` con contenido "seguro" (nunca `null`) y devuelve igual.
  El caller (`processFieldAnalysisInBackground`) además envuelve la llamada
  en su propio `.catch()` como red adicional.
- **El `Analysis` nunca depende del veredicto.** Un análisis ya se guardó
  como `'Finalizado'` (con score, NDVI, etc.) *antes* de intentar generar
  el veredicto. Si Claude falla por completo, el análisis sigue
  `'Finalizado'` — solo su `technicalVerdict` queda `status='failed'`.
- **No hay regeneración automática por sí sola** (cron/job que "revisite"
  veredictos viejos) — pero desde PR 17 hay dos formas reales de que
  `generateAndPersist` corra más de una vez para el mismo `analysisId`,
  ambas idempotentes por `analysisId` (find-then-merge, nunca duplica
  fila):
  - **Interno, automático, dentro de la misma llamada**: si Claude es
    rechazado por el guardrail de seguridad en el intento 1,
    `ClaudeTechnicalVerdictGenerator` hace un único intento 2 correctivo
    *antes* de que `generateAndPersist` decida `'generated'` o `'failed'`
    — ver sección 10. Esto no es "llamar `generateAndPersist` de nuevo",
    es interno a una sola llamada.
  - **Externo, manual, un `analysisId` a la vez**: `POST
    /admin/analysis/:id/technical-verdict/retry`, exclusivo admin/owner,
    solo sobre un `Analysis` ya `'Finalizado'` — ver
    `docs/admin-backend.md`. Nunca hay un cron que dispare esto solo.

## 3. Providers

```
TECHNICAL_VERDICT_PROVIDER=deterministic
TECHNICAL_VERDICT_PROVIDER=claude
```

Resolución real (`AnalysisVerdictService.resolveGenerator()`,
case-insensitive, con trim):

| Valor de la env var | Generador usado |
|---|---|
| `deterministic` | `DeterministicTechnicalVerdictGenerator` |
| `claude` | `ClaudeTechnicalVerdictGenerator` |
| vacía / no seteada | `deterministic` (default) |
| cualquier otro valor (typo, etc.) | `deterministic` + `logger.warn` — nunca rompe el boot ni el request |

- **`deterministic`**: reglas locales sobre `globalScore`/NDVI/NDMI
  (`analysis-verdict-generator.util.ts`), sin red, sin API key, sin retry
  (no hay nada que reintentar — no llama a ningún proveedor externo). Es lo
  que corre en desarrollo y en los tests por default.
- **`claude`**: llama a la API de Anthropic server-side vía el SDK oficial
  (`@anthropic-ai/sdk`), un único tool call forzado (`tool_choice`,
  `strict: true`), con el retry correctivo acotado de la sección 10. Es lo
  que corre en producción hoy.

## 4. Variables de entorno

Ya documentadas en `.env.example` (bloque "PR 11B: veredicto técnico
automático"), sin secrets reales:

| Variable | Para qué sirve | Default si falta/vacía |
|---|---|---|
| `TECHNICAL_VERDICT_PROVIDER` | Elige el generador (ver sección 3). | `deterministic` |
| `ANTHROPIC_API_KEY` | Secreto real de Anthropic. Solo se lee dentro de `ClaudeTechnicalVerdictGenerator`, de forma lazy (recién al generar el primer veredicto, nunca en el boot de la app). | Si falta y el provider es `claude`, ese veredicto queda `status='failed'` — el boot de la app **no** falla. Este error nunca dispara el retry correctivo (sección 10): falta de API key no es un rechazo de seguridad. |
| `ANTHROPIC_MODEL` | Modelo de Anthropic a usar. | `DEFAULT_ANTHROPIC_MODEL` interno (`claude-haiku-4-5`, constante en `claude-technical-verdict.generator.ts`) |
| `ANTHROPIC_TIMEOUT_MS` | Timeout por request a Anthropic, en milisegundos. Se pasa per-request al SDK, nunca hereda el timeout global del cliente. Aplica a **cada** intento por separado (hasta 2, ver sección 10) — un timeout en el intento 1 no dispara el intento 2 (no es un rechazo de seguridad). | `20000` (20s) |

## 5. Persistencia

Tabla `analysis_technical_verdicts` (entidad `AnalysisTechnicalVerdict`,
`src/analysis-verdict/entities/analysis-technical-verdict.entity.ts`):

| Columna | Tipo | Notas |
|---|---|---|
| `id` | uuid, PK | |
| `analysisId` | uuid | FK a `Analysis`, **unique** (`UQ_analysis_technical_verdicts_analysis`) — un veredicto por análisis, no un historial de intentos. `onDelete: CASCADE`: borrar el análisis borra su veredicto. |
| `status` | varchar | `'pending' \| 'generated' \| 'failed'`. `'pending'` está en el tipo pero nunca se persiste hoy — la fila solo se crea una vez que el análisis terminó de procesar (éxito o intento fallido de generación), nunca antes. |
| `verdict` | varchar, nullable | `'favorable' \| 'attention' \| 'critical' \| 'insufficient_data'` |
| `confidence` | varchar, nullable | `'low' \| 'medium' \| 'high'` |
| `summary` | text, nullable | |
| `keyFindings` / `possibleCauses` / `recommendations` / `limitations` | jsonb, nullable | arrays de string |
| `inputSnapshot` | jsonb, nullable | Snapshot de las señales usadas para generar el veredicto (score, ndvi, ndmi, y `{ model }` si fue Claude) — para auditar sin depender del `resultJson` del análisis, que puede cambiar de forma entre versiones del worker. |
| `generator` | varchar | `'deterministic-v1' \| 'claude'` |
| `promptVersion` | varchar, nullable | Ver sección 9. `null` para `deterministic-v1`. |
| `errorMessage` | varchar, nullable | Mensaje corto (nunca stack trace, nunca la API key, nunca el output rechazado de Claude — ver sección 10), solo si `status='failed'`. |
| `generatedAt` | timestamp, nullable | `null` si `status='failed'`. |
| `createdAt` / `updatedAt` | timestamp | |

Aclaraciones:

- Una fila por `analysisId` (constraint unique real, no solo convención) —
  se mantiene así incluso con el retry correctivo interno (sección 10, que
  nunca crea una segunda fila: es interno a una sola llamada de
  `generateAndPersist`) y con el retry manual de PR 17 (que reutiliza
  `generateAndPersist`, find-then-merge sobre la misma fila).
- **No hay regeneración automática *periódica*.** Nada cronjobea ni
  "revisita" veredictos viejos por su cuenta — ver sección 2 para las dos
  formas reales (acotadas, nunca espontáneas) en que `generateAndPersist`
  puede correr más de una vez para el mismo `analysisId`.
- Un veredicto viejo conserva su `promptVersion` original (ej.
  `technical-verdict-v1`, `v1.1`) aunque el prompt vigente ya sea otro —
  así queda identificable contra qué política de redacción (y, desde
  `v1.2`, contra si tuvo o no la posibilidad de un turno correctivo) se
  generó.

## 6. Shape de respuesta

Hay **dos** shapes distintos según quién consulta — no son el mismo tipo,
aunque comparten casi todos los campos:

**Público** (`AnalysisTechnicalVerdictResponse`,
`src/analysis-verdict/dto/analysis-technical-verdict.dto.ts` — dentro de
`GET /analysis/:id` y del PDF/mail):

```ts
technicalVerdict: {
  status: 'pending' | 'generated' | 'failed';
  verdict: 'favorable' | 'attention' | 'critical' | 'insufficient_data' | null;
  confidence: 'low' | 'medium' | 'high' | null;
  summary: string | null;
  keyFindings: string[];        // nunca null, [] si no aplica
  possibleCauses: string[];
  recommendations: string[];
  limitations: string[];
  generatedAt: string | null;   // ISO string
  generator: string | null;
  promptVersion: string | null;
} | null   // null mientras la fila todavía no existe (análisis 'Procesando')
```

**Admin** (`AdminAnalysisTechnicalVerdict`,
`src/admin/dto/admin-analysis-technical-verdict.dto.ts` — dentro de
`GET /admin/analysis`, `GET /admin/scheduled-analysis` y la respuesta de
`POST /admin/analysis/:id/technical-verdict/retry`): **mismo shape
público + `errorMessage: string | null`**.

Importante — corrigiendo una idea común pero incorrecta: `generator` y
`promptVersion` **no son admin-only**, ya viajan en la respuesta pública
(`GET /analysis/:id`) desde PR 11A/11B. El único campo que de verdad es
exclusivo de admin es **`errorMessage`** — la UI pública nunca expone el
motivo interno de un fallo de generación, solo admin (ver sección 7). Esto
no cambió con PR 17: ni el intento correctivo ni su resultado agregan
ningún campo nuevo al shape público.

## 7. Dónde se muestra

| Superficie | Endpoint/pantalla | Qué muestra |
|---|---|---|
| Web pública | Pantalla de resultado individual de análisis | `technicalVerdict` completo salvo `errorMessage` |
| PDF individual | `GET /analysis/:id/report/pdf` (`AnalysisService.buildReportPdf` → `ReportPdfService`) | Sección "05. Veredicto técnico", mismo contenido interpretado que la pantalla |
| Mail semanal | Ver sección 8 | Sección "Veredicto técnico" del email (o su ausencia/estado pendiente, ver sección 8) |
| Admin — análisis | `GET /admin/analysis` (`AdminController.listAnalysis`) | Shape admin completo, batch (sin N+1) |
| Admin — programados | `GET /admin/scheduled-analysis` (`AdminController.listScheduledAnalysis`) | Idem, más el estado de la corrida/schedule/email asociado |
| Admin — retry manual | `POST /admin/analysis/:id/technical-verdict/retry` (PR 17) | Dispara una nueva generación y devuelve el shape admin actualizado — ver `docs/admin-backend.md` |

Regla de producto, reforzada en todo el pipeline (prompt + validator, ver
secciones 9 y 11): **la UI pública nunca menciona "Claude", "Anthropic",
"IA" ni "inteligencia artificial"** — el veredicto se lee como parte del
resultado normal del análisis, no como la respuesta de un asistente. Admin
sí puede (y debe, para soporte/debugging) mostrar `generator`,
`promptVersion` y `errorMessage` tal cual — está gateado por
`JwtAuthGuard` + `RolesGuard(owner|admin)`, no por usuarios finales. El
retry manual (fila anterior) tiene exactamente el mismo gateo.

## 8. Reportes semanales por mail

```
ScheduledAnalysisScheduler (cron)
  → ScheduledAnalysisRunnerService.reconcileRun
      → dispara el Analysis semanal (mismo pipeline de la sección 2:
        processFieldAnalysisInBackground → generateAndPersist, con el
        retry correctivo interno de la sección 10 si aplica)
  → ScheduledAnalysisRunnerService.sendCompletionEmail(run)
      → weeklySnapshotService.findByScheduledRunId(run.id)   (si no existe aún, reintenta en el próximo ciclo)
      → analysisVerdictService.findResponseByAnalysisId(run.analysisId)   ← SOLO LEE, nunca regenera, nunca llama a Claude
      → EmailService.sendScheduledAnalysisEmail(..., { technicalVerdict, ... })
      → scheduled-analysis-report.template.ts renderiza la sección "Veredicto técnico"
```

Condición de carrera (`isWithinVerdictWaitWindow`,
`src/scheduled-analysis/scheduled-analysis-runner.service.ts`):

- El `Analysis` puede llegar a `'Finalizado'` unos milisegundos antes de
  que termine de generarse (o fallar) su `technicalVerdict` — son dos
  pasos secuenciales del mismo pipeline, no atómicos. El retry correctivo
  (sección 10) agrega como máximo una llamada extra a Anthropic dentro de
  ese mismo paso — no cambia esta condición de carrera ni la ventana de
  espera de abajo.
- Si `sendCompletionEmail` corre y todavía no hay fila de verdict: si el
  `run` completó hace **menos de 10 minutos**
  (`VERDICT_WAIT_WINDOW_MS = 10 * 60 * 1000`, medido contra
  `run.completedAt`), **no manda el mail todavía** — lo reintenta en el
  próximo ciclo del scheduler.
- **Pasados esos 10 minutos** (o si `run.completedAt` faltara, caso que no
  debería darse para un run `'completed'` real), el mail sale igual, con
  `technicalVerdict=null` — el template lo renderiza con su propio estado
  "pendiente", nunca deja al mail trabado indefinidamente por esto.

## 9. Prompt Claude vigente

```
promptVersion vigente: technical-verdict-v1.2
```

Historial de versiones:

- **`v1` → `v1.1`** (PR 14A): no cambió el contrato/schema de la tool
  (`submit_technical_verdict`, `strict: true`) — cambió la política de
  redacción del system prompt (`buildSystemPrompt()`,
  `src/analysis-verdict/generators/technical-verdict-prompt.ts`): lenguaje
  conservador en vez de afirmativo, porque AgroScore interpreta índices
  satelitales, no diagnostica en el sentido agronómico estricto.
- **`v1.1` → `v1.2`** (PR 17): tampoco cambió el contrato/schema de la
  tool, ni las reglas de contenido de `buildSystemPrompt()` (siguen siendo
  exactamente las mismas — ninguna se relajó). Lo que cambia es el
  comportamiento *efectivo* de prompting: un veredicto `'generated'` con
  `promptVersion='technical-verdict-v1.2'` puede haber pasado por un
  segundo turno correctivo (ver sección 10) antes de la respuesta final;
  uno con `'v1.1'` nunca pudo. Los veredictos ya persistidos con
  `'technical-verdict-v1.1'` no se regeneran retroactivamente.

Reglas clave del prompt vigente (sin cambios desde `v1.1`):

- NDVI/NDMI son indicadores que orientan la interpretación, nunca un
  diagnóstico por sí solos — requieren contraste con observación en campo,
  manejo, riego, suelo, relieve y clima.
- No afirmar causas agronómicas como hecho — solo como hipótesis.
- Recomendaciones permitidas: monitorear, revisar en campo, comparar con
  riego/suelo/relieve/manejo/clima, repetir el análisis, consultar con un
  profesional agronómico. Prohibidas: productos, dosis, fertilización,
  fitosanitarios, riego en cantidad/frecuencia concreta.
- Tono técnico, sobrio, español rioplatense/neutro — nunca alarmista ni
  marketinero.
- Nunca autorreferenciarse como "Claude"/"Anthropic"/"IA" (reforzado
  también por el validator, ver sección 11).

**Permitido:**

```
"podría estar asociado a..."
"es compatible con..."
"posibles señales compatibles con menor disponibilidad hídrica"
"conviene validar en campo si..."
"una hipótesis posible es..."
```

**Prohibido** (bloqueado también a nivel de validator, no solo de prompt):

```
"hay estrés hídrico"
"la causa es..."
"el problema es..."
"se debe a..."
"déficit de humedad en el suelo"
"hay compactación / hay plaga / hay enfermedad"
```

## 10. Retry correctivo ante rechazo de seguridad (PR 17)

Un rechazo *legítimo* del guardrail de seguridad (el bloque de "prohibido"
de arriba, aplicado por `claude-output.validator.ts`) ya no deja al
`Analysis` sin veredicto después de un único intento — sin debilitar el
guardrail en ningún punto.

**Dónde vive.** Enteramente dentro de
`ClaudeTechnicalVerdictGenerator.generate()`
(`src/analysis-verdict/generators/claude-technical-verdict.generator.ts`).
`AnalysisVerdictService` no sabe que existe — sigue llamando a
`generator.generate(input)` una sola vez, tal como antes de PR 17.

**Qué lo dispara — y qué NO.** Solo `VerdictSafetyValidationError`
(`claude-output.validator.ts`), un error tipado con
`reason: 'forbidden_terms' | 'unhedged_causal_claim'`, lanzado
exclusivamente por los dos checks de seguridad
(`containsForbiddenTerms`/`containsUnhedgedCausalClaim`,
`claude-text-safety.util.ts`). Nada más dispara el retry:

| Error | ¿Dispara el intento 2? |
|---|---|
| `VerdictSafetyValidationError` (rechazo de seguridad) | **Sí** — único caso |
| `Anthropic.AuthenticationError` (API key inválida) | No |
| `Anthropic.RateLimitError` | No |
| `Anthropic.APIConnectionError` (timeout/red) | No |
| `Anthropic.APIError` genérico (5xx) | No |
| Claude no devuelve `tool_use` (`stop_reason` inesperado) | No |
| Error de forma del validador (enum inválido, `summary` vacío, JSON no-objeto) | No |

La razón: ninguno de esos otros errores se arregla reintentando con el
mismo input — un problema de credencial, de cuota, de red o de forma no es
un problema de *estilo* de la respuesta.

**Límite duro.** Máximo **2** llamadas a Anthropic por generación: el
intento 1 más, únicamente si ese intento fue rechazado por seguridad, un
único intento 2. Nunca un loop, nunca un tercer intento — si el intento 2
también es rechazado (por seguridad o por cualquier otro motivo), el error
se propaga tal cual.

**Qué cambia en el intento 2:**

- **Mismo** `buildSystemPrompt()` — nunca se reemplaza ni se relaja
  ninguna regla de contenido.
- Se agrega **a continuación** del prompt base una instrucción correctiva
  interna (`buildCorrectiveInstruction(reason)`,
  `technical-verdict-prompt.ts`), distinta según el `reason`:
  - `unhedged_causal_claim`: *"La respuesta anterior fue rechazada porque
    formuló una interpretación agronómica con un nivel de certeza no
    permitido. Generá nuevamente el veredicto completo. Las posibles
    causas deben expresarse exclusivamente como hipótesis o aspectos a
    verificar en campo. No afirmes causalidad a partir de los datos
    satelitales."*
  - `forbidden_terms`: instrucción análoga, pidiendo regenerar sin
    autorreferenciarse ("Claude"/"Anthropic"/"IA"/"chatbot").
- **Mismo** `buildClaudeUserMessage(input)` — mismos datos (score, NDVI,
  NDMI, `hasZoneData`) que el intento 1. **Nunca se reenvía la respuesta
  rechazada de Claude** — la política es regenerar desde cero con feedback
  sobre el *tipo* de fallo, no sobre el contenido puntual rechazado.
- **Misma** tool (`submit_technical_verdict`), mismo schema, mismo
  `tool_choice` forzado.

**El intento 2 pasa por exactamente el mismo validador.** El `tool_use`
del intento 2 se valida con la misma `validateAndNormalizeGeneratedVerdict()`
— sin bypass, sin flag especial, sin relajar ningún check. Si pasa, se
devuelve `'generated'` como siempre. Si vuelve a fallar, el error (de
seguridad o de cualquier otro tipo) se propaga y cae al comportamiento de
siempre (ver sección 11): `AnalysisVerdictService.generateAndPersist`
persiste `status='failed'` con el contenido placeholder seguro de siempre.
**Nada fuerza ni maquilla un resultado.**

**Qué nunca se persiste ni se loguea.** El output rechazado del intento 1
(texto completo generado por Claude) nunca llega a
`AnalysisTechnicalVerdict.errorMessage` ni a ningún log completo. El único
rastro es un `logger.warn` de una línea, acotado:

```
[technical-verdict] safety validation rejected attempt=1 analysisId=<uuid> provider=claude reason=unhedged_causal_claim retrying=true
```

con exactamente `analysisId`, `provider`, `attempt` (1 o 2), `reason`
(`forbidden_terms` | `unhedged_causal_claim`) y `retrying` (`true`/`false`)
— nunca el summary, nunca los arrays de hallazgos/causas/recomendaciones.

## 11. Manejo de errores

`ClaudeTechnicalVerdictGenerator` nunca deja pasar un error crudo del SDK
— cadena `instanceof` más-específico-primero
(`AuthenticationError → NotFoundError → RateLimitError → APIConnectionError → APIError`)
que convierte cada caso en un mensaje corto sin secretos:

| Causa | Qué pasa |
|---|---|
| Falta `ANTHROPIC_API_KEY` | Rechaza antes de llamar al SDK — `errorMessage` genérico, nunca la key. Nunca dispara el retry de la sección 10. |
| Timeout / rate limit / error de red | Mensaje corto identificando la categoría (`AuthenticationError`/`RateLimitError`/`APIConnectionError`/etc.), nunca el objeto crudo del SDK. Nunca dispara el retry de la sección 10. |
| Output inválido (fuera de enum, `summary` vacío, arrays corruptos) | `claude-output.validator.ts` rechaza antes de persistir — arrays corruptos se normalizan a `[]` cuando es seguro hacerlo, pero enum/summary inválidos tiran `Error` genérico. Nunca dispara el retry de la sección 10 (es un error de forma, no de estilo). |
| Lenguaje demasiado afirmativo (PR 14A) | El validator lo detecta (`containsUnhedgedCausalClaim`) y rechaza con `VerdictSafetyValidationError(reason='unhedged_causal_claim')` — dispara el intento 2 correctivo de la sección 10. |
| Automención ("Claude"/"IA"/"Anthropic"/"chatbot") | Igual criterio (`containsForbiddenTerms`), `VerdictSafetyValidationError(reason='forbidden_terms')` — también dispara el intento 2. |

En **todos** los casos de arriba (incluido un intento 2 que también
falla), el resultado final es el mismo: la excepción sube a
`AnalysisVerdictService.generateAndPersist`, que persiste una fila
`status='failed'` con contenido "seguro" (nunca `null`,
`verdict='insufficient_data'`, `confidence='low'`) y `errorMessage` con el
detalle interno truncado a 500 caracteres — nunca el output rechazado de
Claude, ver sección 10. **El `Analysis` nunca falla por esto** — ya se
guardó `'Finalizado'` antes. `errorMessage` se expone en admin
(`GET /admin/analysis`, `GET /admin/scheduled-analysis`, y la respuesta del
retry manual); la UI pública nunca lo recibe (ver sección 6).

## 12. Smoke test local

1. En `.env`: `TECHNICAL_VERDICT_PROVIDER=claude` y `ANTHROPIC_API_KEY=<tu key real>`.
2. Levantar el backend (`npm run start:dev`) — el boot no falla aunque falte la key; recién falla al generar.
3. Disparar un análisis nuevo (`POST /field/:fieldId`, con un usuario/campo/lote reales).
4. Esperar a que `GET /analysis/:id/status` reporte `'Finalizado'`.
5. Consultar la tabla:

   ```sql
   SELECT
     status,
     verdict,
     confidence,
     generator,
     "promptVersion",
     summary,
     "generatedAt",
     "errorMessage"
   FROM analysis_technical_verdicts
   ORDER BY "createdAt" DESC
   LIMIT 5;
   ```

6. Verificar `generator = 'claude'`.
7. Verificar `"promptVersion" = 'technical-verdict-v1.2'`.
8. Si aplica al cambio que se está probando: revisar `GET /analysis/:id`
   (web), `GET /analysis/:id/report/pdf` (PDF), el mail semanal (si el
   campo tiene seguimiento programado, ver sección 8), y
   `GET /admin/analysis` / `GET /admin/scheduled-analysis` (admin).
9. Para probar el retry correctivo (sección 10) sin depender de que Claude
   realmente sea rechazado: revisar los tests de
   `claude-technical-verdict.generator.spec.ts` (mockean
   `VerdictSafetyValidationError` en el intento 1) — no hay una forma
   determinística de forzarlo contra la API real.
10. Para probar el retry manual (PR 17): tomar un `analysisId` con
    `technicalVerdict.status='failed'` y llamar
    `POST /admin/analysis/:id/technical-verdict/retry` con un JWT
    admin/owner. Repetir el paso 5 — debería quedar `'generated'` (si
    Claude produce una salida válida en esta corrida) o seguir `'failed'`
    (si vuelve a rechazar) sin crear una segunda fila. Ver
    `docs/admin-backend.md`.

## 13. Smoke test producción

Runbook corto, sin secrets en ningún paso:

1. **Health**: `GET /system/health` (o el endpoint de health configurado) responde 200.
2. **Disparar un análisis de prueba** contra un campo/usuario de prueba real (no producción de un cliente), vía la UI o `POST /field/:fieldId`.
3. **Revisar DB**: la misma query SQL de la sección 12 contra la base de producción, confirmando `generator='claude'` y `"promptVersion"='technical-verdict-v1.2'` en la fila nueva.
4. **Revisar UI**: pantalla de resultado del análisis de prueba, sección "Veredicto técnico" visible y coherente.
5. **Revisar PDF**: descargar el PDF del mismo análisis, confirmar que la sección "05. Veredicto técnico" está presente.
6. **Revisar admin**: `GET /admin/analysis` (o la pantalla admin equivalente) muestra el mismo veredicto con `generator`/`promptVersion` visibles.
7. **Revisar mail semanal** (si aplica — solo si el campo de prueba tiene seguimiento semanal activo): confirmar que el próximo envío incluye la sección "Veredicto técnico" o su estado "pendiente" si corrió dentro de la ventana de 10 minutos.
8. **Retry manual (PR 17), si hay un veredicto `'failed'` real que amerite reintentar**: `POST /admin/analysis/:id/technical-verdict/retry` con un JWT admin/owner sobre ese `analysisId` puntual. Confirmar en DB (paso 3) que pasó a `'generated'` o que se mantuvo `'failed'` — nunca forzar una publicación si el guardrail vuelve a rechazar. Ver `docs/admin-backend.md` para el contrato completo del endpoint.

## 14. Fallback / apagado rápido

Para desactivar Claude sin rollback de código ni de deploy:

```
TECHNICAL_VERDICT_PROVIDER=deterministic
```

y reiniciar/recrear el proceso del backend (para que la env var nueva
tome efecto — no hay endpoint ni flag en caliente).

Aclaraciones:

- Los veredictos **nuevos** (de análisis que se generen después del
  cambio) usan `deterministic-v1` — reglas locales, sin red, sin
  dependencia de Anthropic, y por lo tanto sin retry correctivo (sección
  10): no hay nada que un guardrail de seguridad de Claude pueda rechazar.
- Los veredictos **ya persistidos** con `generator='claude'` no cambian —
  siguen mostrándose tal cual quedaron guardados.
- El retry manual (`POST /admin/analysis/:id/technical-verdict/retry`)
  sigue funcionando con `deterministic` activo — simplemente vuelve a
  correr el generador determinístico (siempre `'generated'`, nunca
  `'failed'` salvo error de infraestructura).
- No hace falta tocar código, DTOs, ni frontend — el shape de respuesta es
  idéntico entre providers (`generator` simplemente cambia de valor).

## 15. Qué NO hace la feature

- No es un chat ni una interfaz conversacional.
- No hay ningún botón "Generar con IA" para el productor — para el
  productor, todo sigue siendo 100% automático al finalizar el análisis.
  La única acción manual (PR 17) es `POST
  /admin/analysis/:id/technical-verdict/retry`, exclusiva admin/owner vía
  API (sin UI de producer), y acotada al veredicto — nunca al pipeline
  completo (ver sección 10 y `docs/admin-backend.md`).
- No se llama a Claude desde el frontend (ni web público ni admin) — el
  SDK de Anthropic solo se instancia server-side, dentro de
  `ClaudeTechnicalVerdictGenerator`.
- No diagnostica causas agronómicas de forma definitiva — el prompt y el
  validator (sección 9/11) fuerzan lenguaje hipotético. El retry
  correctivo (sección 10) nunca debilita esto: el intento 2 pasa por
  exactamente el mismo validador que el intento 1.
- No recomienda productos, dosis, fertilización ni fitosanitarios
  concretos.
- No reemplaza la validación en campo — el propio contenido generado lo
  aclara explícitamente en `limitations`.
- No regenera automáticamente veredictos existentes por su cuenta (sin que
  nadie lo pida) — un cambio de prompt, de provider, o de modelo solo
  afecta análisis futuros (ver secciones 9 y 14). El retry correctivo
  (sección 10) y el retry manual (PR 17) son las únicas dos excepciones
  reales, ambas acotadas y nunca espontáneas — ver sección 2.
- No persiste ni expone la respuesta rechazada de Claude en ningún punto
  — ni en `errorMessage`, ni en logs completos, ni en ningún campo público
  o admin (ver sección 10).

## 16. Archivos clave

```
src/analysis-verdict/
  analysis-verdict.service.ts                    — orquestador: resolveGenerator + generateAndPersist
  analysis-verdict-generator.util.ts              — generador deterministic-v1
  analysis-verdict-input.util.ts                  — arma VerdictGeneratorInput desde un Analysis
  dto/analysis-technical-verdict.dto.ts           — shape público (GET /analysis/:id)
  entities/analysis-technical-verdict.entity.ts   — tabla analysis_technical_verdicts
  generators/
    claude-technical-verdict.generator.ts         — llamada real al SDK de Anthropic + retry correctivo (PR 17, sección 10)
    claude-output.validator.ts                    — validación defensiva del output de Claude + VerdictSafetyValidationError (PR 17)
    claude-text-safety.util.ts                    — regex de forbidden terms / causal claims (sin cambios en PR 17)
    technical-verdict-prompt.ts                   — system prompt + tool schema + promptVersion + buildCorrectiveInstruction (PR 17)
    deterministic-technical-verdict.generator.ts  — wrapper del generador local

src/analysis/analysis.service.ts                  — dispara generateAndPersist al finalizar un análisis;
                                                      buildReportPdf incluye el verdict en el PDF
src/analysis/report-pdf/report-pdf.service.ts      — sección "Veredicto técnico" del PDF (sin cambios en PR 17)

src/scheduled-analysis/scheduled-analysis-runner.service.ts — condición de carrera + envío del mail semanal
src/email/templates/scheduled-analysis-report.template.ts   — render HTML/texto del mail

src/admin/
  admin.service.ts                                — listAnalysis/listScheduledAnalysis con verdict batcheado;
                                                      retryTechnicalVerdict (PR 17, sección 10)
  admin.controller.ts                              — GET /admin/analysis, GET /admin/scheduled-analysis,
                                                      POST /admin/analysis/:id/technical-verdict/retry (PR 17)
  dto/admin-analysis-technical-verdict.dto.ts       — shape admin (incluye errorMessage)

src/audit-log/audit-log.service.ts                 — admin.analysis.technical_verdict_retry_requested (PR 17)

.env.example                                       — TECHNICAL_VERDICT_PROVIDER / ANTHROPIC_*
docs/technical-verdict-claude.md                    — este documento
docs/admin-backend.md                               — contrato completo del retry manual (PR 17)
```
