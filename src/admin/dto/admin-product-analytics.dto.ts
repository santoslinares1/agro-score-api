/**
 * KPIs P0 (auditoría de KPIs + Decision 1/2) — GET /admin/product-analytics.
 *
 * Reemplaza el funnel de 9 etapas (Admin PR 4) que mezclaba grains incompatibles (users, fields,
 * schedules, runs, emails) en una sola secuencia de "conversión" — ver AdminService.getProductAnalytics
 * para el detalle completo de cada cálculo. Este shape es deliberadamente el "conjunto mínimo" que
 * pidió el ticket: solo las 5 métricas P0 basadas en resultados `sufficient`, nunca un grab-bag de
 * paneles operativos (ese tipo de info ya vive en /admin/metrics).
 *
 * Invariantes de shape (ver el ticket):
 * - Cada rate viaja siempre junto a su numerador y denominador — nunca un porcentaje solo.
 * - Ninguna métrica mezcla unidades (users vs. fields) en una misma conversión.
 * - `partial`/`insufficient` nunca aparecen en un numerador de valor — solo en qualityBreakdown.
 * - `coverage` expone honestamente cuándo un denominador es históricamente incompleto, en vez de
 *   inferir silenciosamente desde el estado actual.
 */

import { WeeklySnapshotDataQuality } from '../../scheduled-analysis/entities/weekly-analysis-snapshot.entity';

export type AdminProductAnalyticsWeek = {
  /** YYYY-MM-DD, lunes de la semana calendario (ver product-analytics-week.util.ts). */
  weekStart: string;
  /** YYYY-MM-DD, domingo de la semana calendario. */
  weekEnd: string;
};

/**
 * Cobertura honesta de los dos insumos que SÍ pueden estar incompletos — expuesta siempre, nunca
 * inferida en silencio desde el estado actual (ver ambos tickets de origen).
 */
export type AdminProductAnalyticsCoverage = {
  /**
   * Historial de habilitación de schedules (field_analysis_schedule_status_transitions, ticket
   * anterior) — el denominador de North Star lo necesita para saber qué campos "estaban
   * habilitados y debidos" en la semana consultada.
   */
  scheduleHistory: {
    /** Instante ISO desde el cual el historial es confiable (la fila más antigua registrada —
     * baseline de migración o primera transición real), o null si todavía no hay ninguna fila. */
    availableFrom: string | null;
    /** true si TODA la semana consultada (su lunes) cae en o después de `availableFrom`. false
     * (incluyendo el caso `availableFrom: null`) significa que el denominador de North Star para
     * esa semana no puede afirmarse completo — puede faltar historia real. */
    complete: boolean;
  };
  /**
   * Clasificación de Analysis.resultJson para activation/time-to-value — acotada por un tope
   * operativo (ver ANALYSIS_ACTIVATION_SCAN_MAX_ROWS en admin.service.ts) para no cargar volumen
   * ilimitado de resultJson en un solo request.
   */
  analysisClassificationScan: {
    /** Cantidad de Analysis efectivamente inspeccionados en este cómputo. */
    scanned: number;
    /** Tope operativo aplicado. */
    limit: number;
    /** true si se alcanzó el tope con usuarios todavía sin resolver — activation/time-to-value
     * pueden estar subestimados para esta corrida. */
    truncated: boolean;
  };
  /**
   * Decisión de producto (North Star eligibility): la población de North Star se restringe a
   * schedules con configuración CANÓNICA (frequency='weekly', dayOfWeek=lunes, hour=9, minute=0,
   * timezone='America/Argentina/Cordoba' — ver PRODUCT_ANALYTICS_CANONICAL_CUTOFF en
   * admin.service.ts). Un schedule con cualquier otra configuración queda fuera de North Star por
   * completo (ni numerador ni denominador) — nunca se reconstruye su historia de horario (no
   * existe, y no es el alcance de este ticket), así que no hay forma de afirmar con certeza que su
   * configuración ACTUAL describa el pasado. `count` es siempre sobre la configuración vigente
   * ahora mismo (no depende de la semana consultada) — es una señal de calidad de datos, nunca un
   * error operativo.
   */
  nonCanonicalSchedules: {
    count: number;
  };
};

export type AdminNorthStarMetric = {
  week: AdminProductAnalyticsWeek;
  /**
   * COUNT(DISTINCT fieldId) con snapshot dataQualityStatus='sufficient' en la semana, RESTRINGIDO
   * a fields elegibles (ver `eligibleFieldsCount`) — nunca cuenta un sufficient de un field que no
   * era parte de la población elegible esa semana. Por construcción SQL (INNER JOIN contra el
   * mismo universo elegible), usableFieldsCount <= eligibleFieldsCount siempre.
   */
  usableFieldsCount: number;
  /**
   * COUNT(DISTINCT fieldId) de campos con schedule CANÓNICO (ver `coverage.nonCanonicalSchedules`)
   * cuyo estado reconstruido al CUTOFF canónico (lunes 09:00 America/Argentina/Cordoba de esa
   * semana — decisión de producto, ver PRODUCT_ANALYTICS_CANONICAL_CUTOFF en admin.service.ts) es
   * enabled=true. Reconstruido desde field_analysis_schedule_status_transitions — ver
   * `coverage.scheduleHistory`. Nunca el cierre de semana (domingo): una activación después del
   * cutoff no vuelve elegible esa semana, y una desactivación después del cutoff no saca la
   * elegibilidad ya ganada.
   */
  eligibleFieldsCount: number;
  /** usableFieldsCount / eligibleFieldsCount, o null si el denominador es 0 (nunca 0/0 mostrado
   * como 0%). */
  rate: number | null;
};

export type AdminActivationMetric = {
  /** Población elegible total (usuarios no administrativos) — denominador. */
  eligibleUsersCount: number;
  /** Usuarios con al menos un Analysis de Field (regla scope/fieldId/lotId vigente) cuyo resultJson
   * clasifica 'sufficient', con Analysis.completedAt no nulo — numerador. */
  activatedUsersCount: number;
  rate: number | null;
};

export type AdminTimeToFirstTechnicalValueMetric = {
  cohortUsersCount: number;
  activatedUsersCount: number;
  notActivatedUsersCount: number;
  /** Horas entre User.createdAt y su primer Analysis.completedAt sufficient. Percentiles nearest-rank
   * (nunca interpolados) sobre los usuarios YA activados — ver time-to-value.util.ts. */
  p50Hours: number | null;
  p75Hours: number | null;
  /** null si el volumen de activados no alcanza el mínimo para un p95 real (ver MIN_SAMPLES_FOR_P95) —
   * nunca un valor inventado con apariencia de precisión que no tiene. */
  p95Hours: number | null;
};

export type AdminRetentionMetric = {
  /** Semana N — denominador: fields con snapshot sufficient acá. SIEMPRE `period.week - 1` (nunca
   * `period.week` en sí) — ver el docstring de AdminService.getProductAnalytics: así `nextWeek`
   * (N+1) queda anclada a `period.week`, que en el caso default ya es una semana completa. */
  week: AdminProductAnalyticsWeek;
  /** Semana N+1 — numerador: los MISMOS fieldId, también sufficient acá. Es siempre `period.week`. */
  nextWeek: AdminProductAnalyticsWeek;
  /**
   * true solo cuando TANTO N como N+1 terminaron completamente en America/Argentina/Cordoba —
   * condición NECESARIA para que `rate` sea no-null (ver invariante del ticket de corrección de
   * retención). N siempre está completa por construcción (es anterior a N+1); esta bandera existe
   * para el caso en que N+1 sea la semana en curso o una semana futura (solo alcanzable pidiendo
   * `week` explícitamente — el default nunca produce ese caso).
   */
  periodComplete: boolean;
  /** Conteo real tal cual está AHORA — nunca fabricado — incluso cuando `periodComplete` es false
   * (una semana en curso puede tener snapshots parciales reales; lo que no se afirma en ese caso
   * es que el número sea definitivo, por eso `rate` sí se anula). */
  sufficientInWeekCount: number;
  retainedInNextWeekCount: number;
  /** null si periodComplete=false (sin importar el denominador) o si sufficientInWeekCount=0 —
   * nunca 0% como sustituto de "todavía no se puede calcular". */
  rate: number | null;
};

export type AdminQualityBreakdownEntry = {
  status: WeeklySnapshotDataQuality;
  count: number;
  /** count / totalSnapshots de la semana, o null si totalSnapshots es 0. */
  proportion: number | null;
};

export type AdminQualityBreakdownMetric = {
  week: AdminProductAnalyticsWeek;
  totalSnapshots: number;
  /** Siempre las tres categorías (sufficient/partial/insufficient), incluso en count:0 — nunca se
   * omite una categoría porque esa semana no tuvo ningún snapshot en ese estado. */
  breakdown: AdminQualityBreakdownEntry[];
};

export type AdminProductAnalyticsDto = {
  generatedAt: string;
  /** Semana calendario (lunes-domingo) resuelta para esta consulta — la misma que usan northStar,
   * retention.week y qualityBreakdown. Timezone explícito, ver product-analytics-week.util.ts. */
  period: {
    week: AdminProductAnalyticsWeek;
    timezone: string;
  };
  coverage: AdminProductAnalyticsCoverage;
  northStar: AdminNorthStarMetric;
  activation: AdminActivationMetric;
  timeToFirstTechnicalValue: AdminTimeToFirstTechnicalValueMetric;
  retention: AdminRetentionMetric;
  qualityBreakdown: AdminQualityBreakdownMetric;
};
