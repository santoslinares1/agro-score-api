/**
 * OPS-2: máximo de `maxCloudiness` soportado ACTUALMENTE por el contrato API → Worker.
 *
 * El Worker (agro-score-worker/app/limits.py) tiene su propio límite, configurable por env
 * (`AGROSCORE_MAX_CLOUDINESS`, default 80) — esta constante NO es "la fuente única de verdad del
 * Worker" ni lo reemplaza. Es el techo que la API acepta hoy en sus DTOs públicos para no crear
 * un Analysis que el Worker vaya a rechazar (ver RISK-004 en 20-known-risks.md). Si el default
 * del Worker cambiara alguna vez, esta constante debe actualizarse en lockstep a mano: no existe
 * hoy un schema compartido entre los dos repos.
 *
 * 80 no es una decisión agronómica ni de producto validada — es simplemente el máximo que el
 * contrato soporta sin romper hoy. La política de producto (¿debería el usuario poder pedir más
 * en el futuro, y bajo qué criterio?) sigue abierta — ver Q-002 en
 * agroscore-agent-context/docs/agent-context/21-open-questions.md. No usar este valor como
 * evidencia de que 80 es "correcto" agronómicamente.
 */
export const MAX_ANALYSIS_CLOUDINESS = 80;

/**
 * F02: máximo de días entre `startDate` y `endDate` soportado ACTUALMENTE por el contrato
 * API → Worker, para un `Analysis` puntual (no para `Field.startDate`/`Field.endDate`, ver
 * abajo).
 *
 * El Worker (agro-score-worker/app/limits.py) tiene su propio límite, configurable por env
 * (`AGROSCORE_MAX_DATE_RANGE_DAYS`, default 366) — esta constante NO es "la fuente única de
 * verdad del Worker" ni lo reemplaza, es exactamente el mismo criterio que MAX_ANALYSIS_CLOUDINESS
 * de arriba, aplicado a la duración del rango en vez de a la nubosidad. Si el default del Worker
 * cambiara alguna vez (o un deploy lo configurara distinto vía env), esta constante debe
 * actualizarse en lockstep a mano — no existe hoy un schema compartido entre los dos repos, así
 * que esta constante NO sigue automáticamente overrides de `AGROSCORE_MAX_DATE_RANGE_DAYS` en un
 * despliegue que no use el default. Ver "Configuración no predeterminada" en la entrega de F02
 * para el alcance exacto de esta limitación.
 *
 * 366 no es una decisión agronómica ni de producto validada — es el máximo que el contrato
 * soporta sin romper hoy (protección de cómputo/cuota de Earth Engine del lado del Worker, ver
 * SEC-005/SEC-007 en agro-score-worker/app/limits.py). No usar este valor como evidencia de que
 * un año de imágenes es "correcto" agronómicamente.
 *
 * IMPORTANTE — esto NO limita `Field.startDate`/`Field.endDate` (CreateFieldDto/UpdateFieldDto):
 * esas fechas son un rango de campaña general del campo (entre otros usos, `Field.startDate` se
 * reutiliza como `campaignStart` del pipeline técnico semanal — ver
 * docs/agent-context/13-weekly-monitoring.md), que puede legítimamente abarcar más de un año.
 * Este límite aplica solo a la ejecución puntual de UN Analysis
 * (AnalysisService.runFieldAnalysis) — no confundir ambos contratos.
 */
export const MAX_ANALYSIS_DATE_RANGE_DAYS = 366;

/**
 * Cantidad de días calendario entre dos fechas ISO (`YYYY-MM-DD`), calculada exactamente igual
 * que el Worker (`(end - start).days` en Python: ambas fechas puras, sin componente horario). Se
 * asume `end >= start`; el llamador es responsable de rechazar el orden inválido por separado
 * (AnalysisService.runFieldAnalysis ya lo hace antes de llegar acá).
 */
export function daysBetweenIsoDates(
  startDate: string,
  endDate: string,
): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  return Math.round(
    (new Date(endDate).getTime() - new Date(startDate).getTime()) / MS_PER_DAY,
  );
}
