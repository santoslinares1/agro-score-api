# Weekly Technical Verdict / Diagnóstico semanal

PR 16B — backend de persistencia y generación del **diagnóstico semanal**
(`weeklyTechnicalVerdict`). PR 16C lo muestra en el mail semanal. PR 16D lo
muestra en Admin Programados. PR 17C lo expone público y lo muestra en la
web (agro-score-web). Ver `docs/technical-verdict-claude.md` para el
veredicto individual (`technicalVerdict`) — son dos features relacionadas
pero deliberadamente separadas (ver PR 16A, la auditoría/diseño que
precede a este PR).

**Estado actual: backend + mail semanal + admin Programados + web
pública.** El diagnóstico semanal ya se ve en el mail (PR 16C), en
Admin → Programados (PR 16D, agro-score-admin) y en el detalle de campo →
Monitoreo semanal de la web (PR 17C, agro-score-web).

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

## Mail semanal (PR 16C)

`ScheduledAnalysisRunnerService.sendCompletionEmail` lee (nunca genera)
`weeklyTechnicalVerdictService.findResponseBySnapshotId(snapshot.id)` y lo
pasa al template (`scheduled-analysis-report.template.ts`) como
`weeklyTechnicalVerdict`, junto al ya existente `technicalVerdict`
individual. Sección nueva "Diagnóstico semanal", separada y debajo de
"Veredicto técnico" — nunca lo reemplaza.

- **`status='generated'`**: se renderiza completo — tendencia/estado/
  confianza, summary, y las 4 listas (`keyChanges`→"Cambios relevantes",
  `areasToReview`→"Áreas a revisar", `recommendations`, `limitations`),
  ocultando las que vengan vacías. `generator`/`promptVersion`/
  `generatedAt`/`errorMessage` nunca se renderizan, aunque estén en el
  objeto recibido (mismo criterio defensivo que `technicalVerdict`).
- **`trend='insufficient_data'`** (primer reporte o datos insuficientes)
  **no es un caso especial en el template** — se renderiza por el mismo
  camino que cualquier otro `trend`: el `summary` ya persistido (PR 16B)
  explica la falta de base histórica sin que el template tenga que
  duplicar esa decisión de copy.
- **`status='failed'`**: se omite la sección entera (decisión de
  producto — el mail ya tiene "Veredicto técnico" con su propio aviso de
  error si corresponde; no hace falta un segundo aviso).
- **`null`/`undefined`**: se omite la sección entera.
- **Sin ventana de espera propia**: a diferencia del veredicto individual
  (que corre en background, con `VERDICT_WAIT_WINDOW_MS`), el diagnóstico
  semanal ya se generó de forma síncrona en el mismo tick de
  `reconcileRun`, antes de llegar a `sendCompletionEmail` (ver PR 16B) —
  si no existe acá es porque falló (best-effort) o porque el snapshot no
  llegó a crearse, nunca por una carrera.

Labels: `verdictLabel`/`confidenceLabel`/`trendLabel`
(`src/weekly-technical-verdict/weekly-technical-verdict-labels.ts`) —
mismos valores que `analysis-verdict-labels.ts` para verdict/confidence,
duplicados a propósito (mismo criterio de no acoplar módulos hermanos ya
usado en todo `weekly-technical-verdict`); `trendLabel` es nuevo, sin
equivalente en el veredicto individual.

## Admin Programados (PR 16D)

`GET /admin/scheduled-analysis` (`AdminService.listScheduledAnalysis`)
suma `weeklyTechnicalVerdict` a cada item, resuelto en una cuarta consulta
en lote (batch, nunca N+1): `WeeklyTechnicalVerdictService.
findResponsesByScheduledRunIds(scheduledRunIds)`, donde `scheduledRunIds`
son los `id` de `latestRun` de cada schedule de la página — una sola
query `IN` sin importar cuántos schedules haya.

- **Excepción deliberada al criterio "repositorio directo"** que usa el
  resto de `AdminService` (`AnalysisTechnicalVerdict`, `Field`,
  `ScheduledAnalysisRun`, etc.): acá sí se importa `WeeklyTechnicalVerdictModule`
  y se reusa `WeeklyTechnicalVerdictService` en vez de inyectar el
  repositorio a mano. Motivo: `WeeklyTechnicalVerdictResponse` (el shape
  que el servicio ya devuelve) **ya incluye `errorMessage`** por diseño
  desde PR 16B — a diferencia de `AnalysisTechnicalVerdictResponse` (el
  contrato público del veredicto individual, que sí lo omite y por eso
  forzó el bypass del repositorio en PR 13A), acá no hay un shape público
  más angosto del que distinguirse todavía, así que reusar el servicio es
  simplemente no reinventar la query/el mapeo entidad→DTO que ya existen.
- Se resuelve por `scheduledRunId` (no por `snapshotId`): `WeeklyTechnicalVerdict`
  ya denormaliza `scheduledRunId` (mismo criterio que `analysisId`, ver la
  entidad en PR 16B), así que no hace falta pasar por
  `WeeklyAnalysisSnapshot` primero.
- Shape: se reusa `WeeklyTechnicalVerdictResponse` tal cual (no un tipo
  `Admin*` separado, a diferencia de `AdminAnalysisTechnicalVerdict`) — ver
  razón arriba. Admin ve `generator`/`promptVersion`/`errorMessage` sin
  restricciones, igual que en el veredicto individual.

En agro-score-admin, la pantalla "Programados" (`/scheduled-analysis`)
suma una sección "Diagnóstico semanal" al panel expandible de cada fila,
entre "Veredicto técnico" y "Mail" — mismo componente/CSS ya existentes de
PR 13A/13B (`.verdict-panel__summary`, `.verdict-panel__section-title`,
`.verdict-panel__tech-data`, `.verdict-panel__error`), sin CSS nuevo.
Estados: `generated` (panel completo), `failed` (badge + "Error técnico" en
rojo con el `errorMessage`), `null` ("Diagnóstico semanal no disponible."
— admin sí necesita ver la ausencia, a diferencia del mail que la omite).
`trendLabel`/`trendTone` nuevos en
`src/app/shared/utils/technical-verdict-labels.ts`; `AdminWeeklyTechnicalVerdict`
en `scheduled-analysis.model.ts` reusa los enums de `AnalysisTechnicalVerdict`
(mismo criterio que el propio modelo ya hacía con `technicalVerdict`, a
diferencia del backend que sí duplica esos tipos entre módulos).

## PR 17C — superficie pública (`GET /fields/:fieldId/weekly-analysis-snapshots*`)

`WeeklyAnalysisSnapshotService` (`scheduled-analysis/weekly-analysis-snapshot.service.ts`) ahora
inyecta `WeeklyTechnicalVerdictService` y adjunta `weeklyTechnicalVerdict` a cada snapshot que
devuelve — mismo patrón que `AnalysisWithTechnicalVerdict` (`analysis/analysis.service.ts`):
spread de la entidad + campo extra, sin tocar el controller (los métodos no anotan tipo de
retorno). `findByField` (lista) usa `findResponsesBySnapshotIds` — un solo `IN` query para toda la
página, no N+1; `findLatest`/`findOne` (single) usan `findResponseBySnapshotId`. Ambos ya
existían, son de solo lectura, y ninguno de los dos llama `generateAndPersist` ni a Claude.

**Nuevo shape público** (`weekly-technical-verdict/dto/weekly-technical-verdict-public.dto.ts`,
`PublicWeeklyTechnicalVerdictDto`) — el split público/admin que este mismo documento pedía
aplicar cuando existiera superficie pública, mirror exacto de `AnalysisTechnicalVerdictResponse`:
nunca expone `generator`, `promptVersion`, `errorMessage`, `inputSnapshot`, `analysisId` ni
`scheduledRunId`. **Decisión: `status: 'failed'` se mapea a `null`** — mismo criterio que ya usa
el mail (que omite la sección entera en `failed`); evita que la web pública tenga que distinguir
"todavía no hay dato" de "hubo un error técnico", y evita cualquier necesidad de exponer
`errorMessage`. En la práctica, `status` en el shape público siempre llega `'generated'`.

Ownership: sin cambios — `fieldsService.findOne(fieldId, userId)` sigue siendo lo primero que
corre en los 3 métodos; si un campo no es del usuario, ni el repo de snapshots ni
`weeklyTechnicalVerdictService` llegan a llamarse. No se creó ningún endpoint nuevo.

## Qué NO hace este PR (16B/16C/16D/17C)

- No hay endpoint manual para disparar/regenerar un diagnóstico semanal.
- No hay botón de ningún tipo, ni en el mail, ni en admin, ni en la web.
- No se regeneran diagnósticos semanales existentes — un cambio de
  provider/prompt solo afecta a los que se generen después del cambio.
- Ni el mail, ni admin, ni la web pública llaman a `generateAndPersist` ni
  a Claude — los tres solo leen lo ya persistido por el tick de
  `reconcileRun` que generó el snapshot.

## Archivos clave

```
src/weekly-technical-verdict/
  entities/weekly-technical-verdict.entity.ts
  dto/weekly-technical-verdict.dto.ts
  weekly-technical-verdict-generator.util.ts   — generador determinístico (función pura)
  weekly-technical-verdict-input.util.ts       — snapshot → input del generador
  weekly-technical-verdict.service.ts          — orquestador (resolveGenerator + generateAndPersist)
  weekly-technical-verdict-labels.ts           — verdictLabel/confidenceLabel/trendLabel (PR 16C)
  weekly-technical-verdict.module.ts
  generators/
    weekly-technical-verdict-generator.interface.ts
    weekly-technical-verdict-prompt.ts          — system prompt + tool schema + promptVersion
    claude-weekly-technical-verdict.generator.ts
    claude-weekly-output.validator.ts
    deterministic-weekly-technical-verdict.generator.ts

src/analysis-verdict/generators/claude-text-safety.util.ts  — compartido con el validator individual

src/scheduled-analysis/scheduled-analysis-runner.service.ts  — enganche en reconcileRun + lectura en sendCompletionEmail (PR 16C)
src/scheduled-analysis/weekly-analysis-snapshot-comparison.util.ts  — SCORE_STABLE_THRESHOLD/INDEX_STABLE_THRESHOLD exportados

src/email/templates/scheduled-analysis-report.template.ts  — sección "Diagnóstico semanal" (PR 16C)

src/admin/admin.service.ts  — listScheduledAnalysis suma weeklyTechnicalVerdict (batch, PR 16D)
src/admin/admin.module.ts   — importa WeeklyTechnicalVerdictModule (PR 16D)
src/admin/dto/admin-scheduled-analysis.dto.ts  — AdminScheduledAnalysisItem.weeklyTechnicalVerdict (PR 16D)

agro-score-admin/src/app/core/models/scheduled-analysis.model.ts       — AdminWeeklyTechnicalVerdict (PR 16D)
agro-score-admin/src/app/shared/utils/technical-verdict-labels.ts      — trendLabel/trendTone (PR 16D)
agro-score-admin/src/app/features/scheduled-analysis/scheduled-analysis.component.{ts,html}  — sección "Diagnóstico semanal" (PR 16D)

src/weekly-technical-verdict/dto/weekly-technical-verdict-public.dto.ts  — PublicWeeklyTechnicalVerdictDto, split público/admin (PR 17C)
src/scheduled-analysis/weekly-analysis-snapshot.service.ts  — findByField/findLatest/findOne suman weeklyTechnicalVerdict (PR 17C)

agro-score-web/src/app/core/model/weekly-analysis-snapshot.model.ts  — WeeklyTechnicalVerdict (PR 17C)
agro-score-web/src/app/features/app/field-detail/weekly-analysis-history/weekly-analysis-history.component.{ts,html}  — sección "Diagnóstico semanal" (PR 17C)

.env.example — WEEKLY_TECHNICAL_VERDICT_PROVIDER
docs/weekly-technical-verdict.md — este documento
```
