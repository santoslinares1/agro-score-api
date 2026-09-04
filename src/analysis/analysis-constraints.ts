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
