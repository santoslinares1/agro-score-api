/**
 * SEC-004A: máximo de posiciones (coordenadas `[lon, lat]`) admitidas para la geometría de un
 * lote, ANTES de correr `isSimpleClosedRing()` (ring-topology.util.ts) — esa función compara
 * pares de segmentos con un doble loop O(n²); sin este límite explícito, un usuario autenticado
 * podía forzar trabajo cuadrático sin cota sobre un ring arbitrariamente grande.
 *
 * El límite incluye la posición final repetida que cierra el ring — mismo criterio que
 * agro-score-worker (`app/limits.py`, `MAX_GEOMETRY_COORDINATES`, default 5000, configurable por
 * `AGROSCORE_MAX_GEOMETRY_COORDINATES`): `validate_analyze_payload` cuenta `len(coordinates)`
 * sobre el array tal cual llega, sin descontar el cierre.
 *
 * Mismo criterio que `MAX_ANALYSIS_CLOUDINESS`/`MAX_ANALYSIS_DATE_RANGE_DAYS` en
 * `analysis-constraints.ts`: esta constante NO es "la fuente única de verdad del Worker" ni lo
 * reemplaza — es el techo que la API aplica hoy para no persistir ni construir una geometría que
 * el Worker igual va a rechazar (o que ni siquiera llegaría a enviarle, si la API la rechaza
 * antes). Si el default del Worker cambiara, esta constante debe actualizarse en lockstep a
 * mano — no existe hoy un schema compartido entre los dos repos, y esta constante NO sigue
 * automáticamente un override de `AGROSCORE_MAX_GEOMETRY_COORDINATES` en un despliegue que no use
 * el default (deliberado: no agregar configuración por environment solo en la API crearía drift
 * silencioso con el Worker en vez de evitarlo).
 *
 * Aplica a:
 *   - FieldsService.create(): a la SUMA de posiciones de todos los rings de todos los lotes.
 *   - FieldsService.createLot()/updateLot(): a la geometría individual del lote.
 * En los tres casos, el rechazo ocurre antes de `isSimpleClosedRing()` y antes de cualquier
 * escritura en `fieldRepository`/`fieldLotRepository`.
 *
 * 5000 no es una decisión agronómica ni de producto — es el máximo que el contrato soporta hoy
 * sin forzar trabajo cuadrático ilimitado, alineado 1:1 con el default productivo del Worker.
 */
export const MAX_GEOMETRY_COORDINATES = 5000;
