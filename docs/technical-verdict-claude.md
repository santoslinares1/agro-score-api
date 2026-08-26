# Technical Verdict / Claude Integration

Documento operativo de la feature completa: qué es, cómo se genera, dónde
aparece, cómo probarla y cómo apagarla rápido. Pensado para cualquier
dev/ops que necesite tocar o debuguear esto sin releer los ~8 PRs que la
construyeron.

Historial de PRs que armaron esta feature (para rastrear el porqué de una
decisión puntual, no para entender el estado actual — este documento es la
fuente de verdad del estado actual):
`11A` (contrato/persistencia) → `11B` (provider Claude real) → `11C` (web)
→ `11D` (PDF) → `12A` (mail semanal) → `13A`/`13B` (admin) → `14A` (prompt
conservador) → `15A` (este documento).

> **Diagnóstico semanal (`weeklyTechnicalVerdict`)**: interpretación de la
> *evolución* de un campo vs. su reporte semanal anterior — un concepto
> relacionado pero deliberadamente separado de este (`technicalVerdict`
> interpreta un análisis puntual, sin eje temporal). Ver
> `docs/weekly-technical-verdict.md` (PR 16A/16B en adelante).

---

## 1. Resumen

Technical Verdict ("Diagnóstico AgroScore") es la interpretación técnica
automática de un `Analysis` ya finalizado: a partir de las métricas
satelitales ya calculadas (score, NDVI, NDMI, zonas de vigor), genera un
veredicto (`favorable` / `attention` / `critical` / `insufficient_data`)
con un resumen, hallazgos, posibles causas, recomendaciones y limitaciones,
todo en español y en lenguaje hipotético (ver sección 9).

Se dispara automáticamente al finalizar un `Analysis` exitoso — nunca antes,
nunca manualmente. Según `TECHNICAL_VERDICT_PROVIDER`, lo genera un motor de
reglas local (`deterministic-v1`, sin red) o Claude real (`claude`, server-
side vía el SDK de Anthropic). Se persiste en `analysis_technical_verdicts`,
una fila por análisis.

No es un chat, no tiene un botón "Interpretar con IA", y nunca se llama
desde el frontend — ni el web público ni el admin hablan con Anthropic
directamente. El frontend solo lee lo que este backend ya generó y guardó.

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
          → INSERT/UPDATE analysis_technical_verdicts (status='generated' | 'failed')
```

El mismo `generateAndPersist` corre para los análisis semanales programados
(`ScheduledAnalysisRunnerService`, ver sección 8) apenas su `Analysis`
llega a `'Finalizado'` — es el mismo código, no una segunda implementación.

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
- **Nunca se regenera solo.** Una vez que existe una fila para un
  `analysisId`, `generateAndPersist` la actualiza (find-then-merge,
  idempotente) si se lo vuelve a llamar — pero nada en el sistema llama a
  esto una segunda vez para el mismo análisis salvo un reintento manual de
  infraestructura. No hay cron ni job que "regenere" veredictos viejos.

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
  (`analysis-verdict-generator.util.ts`), sin red, sin API key. Es lo que
  corre en desarrollo y en los tests por default.
- **`claude`**: llama a la API de Anthropic server-side vía el SDK oficial
  (`@anthropic-ai/sdk`), un único tool call forzado (`tool_choice`,
  `strict: true`). Es lo que corre en producción hoy.

## 4. Variables de entorno

Ya documentadas en `.env.example` (bloque "PR 11B: veredicto técnico
automático"), sin secrets reales:

| Variable | Para qué sirve | Default si falta/vacía |
|---|---|---|
| `TECHNICAL_VERDICT_PROVIDER` | Elige el generador (ver sección 3). | `deterministic` |
| `ANTHROPIC_API_KEY` | Secreto real de Anthropic. Solo se lee dentro de `ClaudeTechnicalVerdictGenerator`, de forma lazy (recién al generar el primer veredicto, nunca en el boot de la app). | Si falta y el provider es `claude`, ese veredicto queda `status='failed'` — el boot de la app **no** falla. |
| `ANTHROPIC_MODEL` | Modelo de Anthropic a usar. | `DEFAULT_ANTHROPIC_MODEL` interno (`claude-haiku-4-5`, constante en `claude-technical-verdict.generator.ts`) |
| `ANTHROPIC_TIMEOUT_MS` | Timeout por request a Anthropic, en milisegundos. Se pasa per-request al SDK, nunca hereda el timeout global del cliente. | `20000` (20s) |

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
| `errorMessage` | varchar, nullable | Mensaje corto (nunca stack trace, nunca la API key), solo si `status='failed'`. |
| `generatedAt` | timestamp, nullable | `null` si `status='failed'`. |
| `createdAt` / `updatedAt` | timestamp | |

Aclaraciones:

- Una fila por `analysisId` (constraint unique real, no solo convención).
- **No hay regeneración automática.** Los veredictos existentes nunca se
  vuelven a tocar por sí solos — cambiar el prompt o el provider (ver
  sección 13) solo afecta a los análisis que se generen *después* del
  cambio.
- Un veredicto viejo conserva su `promptVersion` original (ej.
  `technical-verdict-v1`) aunque el prompt vigente ya sea otro — así queda
  identificable contra qué política de redacción se generó.

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
`GET /admin/analysis` y `GET /admin/scheduled-analysis`): **mismo shape
público + `errorMessage: string | null`**.

Importante — corrigiendo una idea común pero incorrecta: `generator` y
`promptVersion` **no son admin-only**, ya viajan en la respuesta pública
(`GET /analysis/:id`) desde PR 11A/11B. El único campo que de verdad es
exclusivo de admin es **`errorMessage`** — la UI pública nunca expone el
motivo interno de un fallo de generación, solo admin (ver sección 7).

## 7. Dónde se muestra

| Superficie | Endpoint/pantalla | Qué muestra |
|---|---|---|
| Web pública | Pantalla de resultado individual de análisis | `technicalVerdict` completo salvo `errorMessage` |
| PDF individual | `GET /analysis/:id/report/pdf` (`AnalysisService.buildReportPdf` → `ReportPdfService`) | Sección "05. Veredicto técnico", mismo contenido interpretado que la pantalla |
| Mail semanal | Ver sección 8 | Sección "Veredicto técnico" del email (o su ausencia/estado pendiente, ver sección 8) |
| Admin — análisis | `GET /admin/analysis` (`AdminController.listAnalysis`) | Shape admin completo, batch (sin N+1) |
| Admin — programados | `GET /admin/scheduled-analysis` (`AdminController.listScheduledAnalysis`) | Idem, más el estado de la corrida/schedule/email asociado |

Regla de producto, reforzada en todo el pipeline (prompt + validator, ver
secciones 9 y 10): **la UI pública nunca menciona "Claude", "Anthropic",
"IA" ni "inteligencia artificial"** — el veredicto se lee como parte del
resultado normal del análisis, no como la respuesta de un asistente. Admin
sí puede (y debe, para soporte/debugging) mostrar `generator`,
`promptVersion` y `errorMessage` tal cual — está gateado por
`JwtAuthGuard` + `RolesGuard(owner|admin)`, no por usuarios finales.

## 8. Reportes semanales por mail

```
ScheduledAnalysisScheduler (cron)
  → ScheduledAnalysisRunnerService.reconcileRun
      → dispara el Analysis semanal (mismo pipeline de la sección 2:
        processFieldAnalysisInBackground → generateAndPersist)
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
  pasos secuenciales del mismo pipeline, no atómicos.
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
promptVersion vigente: technical-verdict-v1.1
```

`v1.1` (PR 14A) no cambió el contrato/schema de la tool
(`submit_technical_verdict`, `strict: true`) respecto a `v1` — cambió
únicamente la política de redacción del system prompt
(`buildSystemPrompt()`, `src/analysis-verdict/generators/technical-verdict-prompt.ts`):
lenguaje conservador en vez de afirmativo, porque AgroScore interpreta
índices satelitales, no diagnostica en el sentido agronómico estricto.

Reglas clave del prompt vigente:

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
  también por el validator, ver sección 10).

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

## 10. Manejo de errores

`ClaudeTechnicalVerdictGenerator` nunca deja pasar un error crudo del SDK
— cadena `instanceof` más-específico-primero
(`AuthenticationError → NotFoundError → RateLimitError → APIConnectionError → APIError`)
que convierte cada caso en un mensaje corto sin secretos:

| Causa | Qué pasa |
|---|---|
| Falta `ANTHROPIC_API_KEY` | Rechaza antes de llamar al SDK — `errorMessage` genérico, nunca la key. |
| Timeout / rate limit / error de red | Mensaje corto identificando la categoría (`AuthenticationError`/`RateLimitError`/`APIConnectionError`/etc.), nunca el objeto crudo del SDK. |
| Output inválido (fuera de enum, `summary` vacío, arrays corruptos) | `claude-output.validator.ts` rechaza antes de persistir — arrays corruptos se normalizan a `[]` cuando es seguro hacerlo, pero enum/summary inválidos tiran. |
| Lenguaje demasiado afirmativo (PR 14A) | El validator lo detecta (`containsUnhedgedCausalClaim`) y rechaza — es defensa en profundidad detrás del prompt, no confía en que el prompt solo alcance. |
| Automención ("Claude"/"IA"/"Anthropic"/"chatbot") | Igual criterio, rechaza (`containsForbiddenTerms`). |

En **todos** los casos de arriba, el resultado es el mismo: la excepción
sube a `AnalysisVerdictService.generateAndPersist`, que persiste una fila
`status='failed'` con contenido "seguro" (nunca `null`,
`verdict='insufficient_data'`, `confidence='low'`) y `errorMessage` con el
detalle interno truncado a 500 caracteres. **El `Analysis` nunca falla por
esto** — ya se guardó `'Finalizado'` antes. `errorMessage` se expone en
admin (`GET /admin/analysis`, `GET /admin/scheduled-analysis`); la UI
pública nunca lo recibe (ver sección 6).

## 11. Smoke test local

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
7. Verificar `"promptVersion" = 'technical-verdict-v1.1'`.
8. Si aplica al cambio que se está probando: revisar `GET /analysis/:id`
   (web), `GET /analysis/:id/report/pdf` (PDF), el mail semanal (si el
   campo tiene seguimiento programado, ver sección 8), y
   `GET /admin/analysis` / `GET /admin/scheduled-analysis` (admin).

## 12. Smoke test producción

Runbook corto, sin secrets en ningún paso:

1. **Health**: `GET /system/health` (o el endpoint de health configurado) responde 200.
2. **Disparar un análisis de prueba** contra un campo/usuario de prueba real (no producción de un cliente), vía la UI o `POST /field/:fieldId`.
3. **Revisar DB**: la misma query SQL de la sección 11 contra la base de producción, confirmando `generator='claude'` y `"promptVersion"='technical-verdict-v1.1'` en la fila nueva.
4. **Revisar UI**: pantalla de resultado del análisis de prueba, sección "Veredicto técnico" visible y coherente.
5. **Revisar PDF**: descargar el PDF del mismo análisis, confirmar que la sección "05. Veredicto técnico" está presente.
6. **Revisar admin**: `GET /admin/analysis` (o la pantalla admin equivalente) muestra el mismo veredicto con `generator`/`promptVersion` visibles.
7. **Revisar mail semanal** (si aplica — solo si el campo de prueba tiene seguimiento semanal activo): confirmar que el próximo envío incluye la sección "Veredicto técnico" o su estado "pendiente" si corrió dentro de la ventana de 10 minutos.

## 13. Fallback / apagado rápido

Para desactivar Claude sin rollback de código ni de deploy:

```
TECHNICAL_VERDICT_PROVIDER=deterministic
```

y reiniciar/recrear el proceso del backend (para que la env var nueva
tome efecto — no hay endpoint ni flag en caliente).

Aclaraciones:

- Los veredictos **nuevos** (de análisis que se generen después del
  cambio) usan `deterministic-v1` — reglas locales, sin red, sin
  dependencia de Anthropic.
- Los veredictos **ya persistidos** con `generator='claude'` no cambian —
  siguen mostrándose tal cual quedaron guardados.
- No hace falta tocar código, DTOs, ni frontend — el shape de respuesta es
  idéntico entre providers (`generator` simplemente cambia de valor).

## 14. Qué NO hace la feature

- No es un chat ni una interfaz conversacional.
- No hay ningún botón "Generar con IA" ni acción manual de regeneración —
  todo es automático al finalizar el análisis.
- No se llama a Claude desde el frontend (ni web público ni admin) — el
  SDK de Anthropic solo se instancia server-side, dentro de
  `ClaudeTechnicalVerdictGenerator`.
- No diagnostica causas agronómicas de forma definitiva — el prompt y el
  validator (sección 9/10) fuerzan lenguaje hipotético.
- No recomienda productos, dosis, fertilización ni fitosanitarios
  concretos.
- No reemplaza la validación en campo — el propio contenido generado lo
  aclara explícitamente en `limitations`.
- No regenera automáticamente veredictos existentes — un cambio de prompt,
  de provider, o de modelo solo afecta análisis futuros (ver secciones 9 y
  13).

## 15. Archivos clave

```
src/analysis-verdict/
  analysis-verdict.service.ts                    — orquestador: resolveGenerator + generateAndPersist
  analysis-verdict-generator.util.ts              — generador deterministic-v1
  analysis-verdict-input.util.ts                  — arma VerdictGeneratorInput desde un Analysis
  dto/analysis-technical-verdict.dto.ts           — shape público (GET /analysis/:id)
  entities/analysis-technical-verdict.entity.ts   — tabla analysis_technical_verdicts
  generators/
    claude-technical-verdict.generator.ts         — llamada real al SDK de Anthropic
    claude-output.validator.ts                    — validación defensiva del output de Claude
    technical-verdict-prompt.ts                   — system prompt + tool schema + promptVersion
    deterministic-technical-verdict.generator.ts  — wrapper del generador local

src/analysis/analysis.service.ts                  — dispara generateAndPersist al finalizar un análisis;
                                                      buildReportPdf incluye el verdict en el PDF
src/analysis/report-pdf/report-pdf.service.ts      — sección "Veredicto técnico" del PDF

src/scheduled-analysis/scheduled-analysis-runner.service.ts — condición de carrera + envío del mail semanal
src/email/templates/scheduled-analysis-report.template.ts   — render HTML/texto del mail

src/admin/
  admin.service.ts                                — listAnalysis/listScheduledAnalysis con verdict batcheado
  admin.controller.ts                              — GET /admin/analysis, GET /admin/scheduled-analysis
  dto/admin-analysis-technical-verdict.dto.ts       — shape admin (incluye errorMessage)

.env.example                                       — TECHNICAL_VERDICT_PROVIDER / ANTHROPIC_*
docs/technical-verdict-claude.md                    — este documento
```
