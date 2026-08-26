# Weekly Technical Verdict / Diagnóstico semanal

PR 16B — backend de persistencia y generación del **diagnóstico semanal**
(`weeklyTechnicalVerdict`). Ver `docs/technical-verdict-claude.md` para el
veredicto individual (`technicalVerdict`) — son dos features relacionadas
pero deliberadamente separadas (ver PR 16A, la auditoría/diseño que precede
a este PR).

**Estado de este PR: solo backend.** No hay ningún endpoint, mail, pantalla
admin ni web que muestre esto todavía — se genera y persiste, nada más. Eso
es PR 16C (mail semanal), PR 16D (admin Programados) y, opcionalmente, PR
16E (web).

## Diferencia con `technicalVerdict`

| | `technicalVerdict` | `weeklyTechnicalVerdict` |
|---|---|---|
| Pregunta que responde | ¿Cómo está este análisis puntual? | ¿Qué cambió respecto de la semana anterior? |
| Se genera para | Todo análisis (manual o programado) | Solo análisis programados (requiere un `WeeklyAnalysisSnapshot`) |
| Eje temporal | Ninguno — foto fija | Comparativo — delta vs. el snapshot anterior |
| Campo distintivo | `verdict` (estado) | `trend` (dirección del cambio) |
| Tabla | `analysis_technical_verdicts` | `weekly_technical_verdicts` |

Regla de contenido (reforzada en el prompt, sección más abajo): el
diagnóstico semanal describe el **delta**, nunca repite en detalle el
**estado** que ya describe el veredicto individual.

## Flujo de generación

```
ScheduledAnalysisRunnerService.reconcileRun
  → analysis.status = 'Finalizado'
  → WeeklyAnalysisSnapshotService.createFromAnalysis(run, analysis)   (ya existía, Fase 5)
  → [PR 16B] WeeklyTechnicalVerdictService.generateAndPersist(snapshot, {
        fieldName,            // FieldsService.findByIdOrFail(run.fieldId)
        individualVerdict,    // AnalysisVerdictService.findResponseByAnalysisId(analysis.id) — best-effort
      })
  → INSERT/UPDATE weekly_technical_verdicts
  → (mismo tick) sendCompletionEmail(run) — todavía no incluye esta sección, ver PR 16C
```

Puntos clave:

- **Best-effort, en su propio try/catch**, separado del try/catch del
  snapshot. Si la generación del diagnóstico semanal falla, el snapshot ya
  creado no se revierte y el flujo sigue con normalidad hacia el envío del
  email (que hoy no lo usa, pero en PR 16C tampoco se bloqueará por esto).
- **Nunca depende de que el `technicalVerdict` individual exista o haya
  salido `generated`.** Se lee (`findResponseByAnalysisId`) como
  enriquecimiento opcional del prompt/contexto, nunca se espera a que
  termine — evita heredar la ventana de espera de 10 minutos que ya tiene
  el veredicto individual (`VERDICT_WAIT_WINDOW_MS`,
  `scheduled-analysis-runner.service.ts`).
- Corre en el **mismo tick de reconciliación** (cada 2 minutos) que crea el
  snapshot — no hay una ventana de espera propia para el diagnóstico
  semanal en sí, porque su contenido central (`comparisonVsPrevious`) ya
  está disponible en el momento en que se crea el snapshot, sin depender de
  ningún otro proceso asíncrono.

## Providers / variable de entorno

```
WEEKLY_TECHNICAL_VERDICT_PROVIDER=deterministic | claude
```

Default: `deterministic` (igual criterio que `TECHNICAL_VERDICT_PROVIDER`:
vacía o desconocida cae acá con un `warning`, nunca rompe).

**Deliberadamente una env separada de `TECHNICAL_VERDICT_PROVIDER`** (PR
16A, sección 9):

- Permite apagar solo el diagnóstico semanal (feature nueva, sin historial
  de producción todavía) sin tocar el veredicto individual (ya estable).
- Controla el costo/latencia de una segunda llamada a Claude por corrida
  programada, de forma independiente.
- El fallback determinístico es barato de mantener: reutiliza
  `comparisonVsPrevious.summary`, que ya es una redacción determinística
  del delta (ver `weekly-analysis-snapshot-comparison.util.ts`).

No se agregan variables de modelo/timeout propias — `claude` reutiliza
`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`/`ANTHROPIC_TIMEOUT_MS`, las mismas
que ya usa el veredicto individual.

## Prompt vigente

```
promptVersion vigente: weekly-technical-verdict-v1
```

Arranca directamente con la política de redacción conservadora de PR 14A
(nunca existió una versión sin eso). Reglas del system prompt
(`weekly-technical-verdict-prompt.ts`):

- Español rioplatense/neutro, tono técnico y sobrio.
- Enfocarse en **qué cambió**, no repetir el estado actual en detalle.
- Sin snapshot anterior (`previousSnapshotId` null): decir explícitamente
  que no hay base histórica, `trend="insufficient_data"` — nunca inventar
  una tendencia.
- Comparar solo variables con delta no-null.
- No afirmar causas agronómicas como hecho — lenguaje hipotético
  ("podría estar asociado a...", "es compatible con...").
- No recomendar productos, dosis, fertilización ni fitosanitarios.
- No autorreferenciarse como Claude/IA/Anthropic.

`claude-weekly-output.validator.ts` reusa (no duplica) las mismas
funciones de detección de lenguaje afirmativo/autorreferencial que el
validator individual — extraídas en PR 16B a
`src/analysis-verdict/generators/claude-text-safety.util.ts` para que
ambos módulos compartan exactamente las mismas reglas, ya afinadas contra
falsos positivos.

## Persistencia

Tabla `weekly_technical_verdicts` (entidad `WeeklyTechnicalVerdict`,
`src/weekly-technical-verdict/entities/weekly-technical-verdict.entity.ts`),
tabla separada de `analysis_technical_verdicts` — nunca se mezclan (PR 16A,
sección 7).

- `unique(snapshotId)`, `ON DELETE CASCADE` — el `WeeklyAnalysisSnapshot`
  (no el `Analysis` ni el `ScheduledAnalysisRun`) es la unidad natural "una
  semana comparada".
- `analysisId`/`scheduledRunId` denormalizados desde el snapshot, solo
  para trazabilidad/consulta directa (`ON DELETE SET NULL`, igual criterio
  que el propio `WeeklyAnalysisSnapshot`).
- `previousSnapshotId` como columna propia (copiado de
  `comparisonVsPrevious.previousSnapshotId`), para poder consultar sin
  parsear el jsonb.
- Arrays (`keyChanges`/`areasToReview`/`recommendations`/`limitations`)
  nullable a nivel columna, normalizados a `[]` en el DTO — mismo criterio
  que `analysis_technical_verdicts`.
- Un diagnóstico semanal fallido (`status='failed'`) usa contenido
  placeholder seguro (`verdict`/`trend='insufficient_data'`,
  `confidence='low'`, nunca `null`) — misma filosofía que
  `AnalysisTechnicalVerdict`.

## Shape de respuesta (interno, todavía sin consumidores)

`WeeklyTechnicalVerdictResponse`
(`src/weekly-technical-verdict/dto/weekly-technical-verdict.dto.ts`):

```ts
{
  status: 'generated' | 'failed';
  verdict: 'favorable' | 'attention' | 'critical' | 'insufficient_data' | null;
  trend: 'improving' | 'stable' | 'worsening' | 'mixed' | 'insufficient_data' | null;
  confidence: 'low' | 'medium' | 'high' | null;
  summary: string | null;
  keyChanges: string[];
  areasToReview: string[];
  recommendations: string[];
  limitations: string[];
  previousSnapshotId: string | null;
  generatedAt: string | null;
  generator: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
}
```

`errorMessage` va directo acá (a diferencia de
`AnalysisTechnicalVerdictResponse`, que separa un shape público sin
`errorMessage` de uno admin con él) porque todavía no hay una superficie
pública real para esto — cuando PR 16D/16E lo requieran, aplicar el mismo
patrón de separación público/admin que ya usa el veredicto individual.

`WeeklyTechnicalVerdictService.findResponsesBySnapshotIds(snapshotIds)`
queda listo (batch, una sola query `IN`, `Map<snapshotId, respuesta>`) para
que PR 16D (admin Programados) lo use sin reinventar el patrón ya probado
en `AdminService.getTechnicalVerdictsByAnalysisId`.

## Qué NO hace este PR

- No hay mail semanal con "Diagnóstico semanal" todavía (PR 16C).
- No hay pantalla admin con esto todavía (PR 16D).
- No hay nada visible en la web pública (PR 16E, si aplica).
- No hay endpoint manual para disparar/regenerar un diagnóstico semanal.
- No hay botón de ningún tipo.
- No se regeneran diagnósticos semanales existentes — un cambio de
  provider/prompt solo afecta a los que se generen después del cambio.

## Archivos clave

```
src/weekly-technical-verdict/
  entities/weekly-technical-verdict.entity.ts
  dto/weekly-technical-verdict.dto.ts
  weekly-technical-verdict-generator.util.ts   — generador determinístico (función pura)
  weekly-technical-verdict-input.util.ts       — snapshot → input del generador
  weekly-technical-verdict.service.ts          — orquestador (resolveGenerator + generateAndPersist)
  weekly-technical-verdict.module.ts
  generators/
    weekly-technical-verdict-generator.interface.ts
    weekly-technical-verdict-prompt.ts          — system prompt + tool schema + promptVersion
    claude-weekly-technical-verdict.generator.ts
    claude-weekly-output.validator.ts
    deterministic-weekly-technical-verdict.generator.ts

src/analysis-verdict/generators/claude-text-safety.util.ts  — compartido con el validator individual

src/scheduled-analysis/scheduled-analysis-runner.service.ts  — enganche en reconcileRun
src/scheduled-analysis/weekly-analysis-snapshot-comparison.util.ts  — SCORE_STABLE_THRESHOLD/INDEX_STABLE_THRESHOLD exportados

.env.example — WEEKLY_TECHNICAL_VERDICT_PROVIDER
docs/weekly-technical-verdict.md — este documento
```
