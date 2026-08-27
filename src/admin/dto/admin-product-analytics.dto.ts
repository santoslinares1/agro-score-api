/**
 * Admin PR 4: Product Analytics básico — responde "de los usuarios/campos creados, ¿cuántos
 * llegan a generar valor real?" con un funnel simple, 9 etapas, sobre entidades ACTUALES (no
 * cohortes por fecha de alta). A propósito NO se llama "conversión real" en ningún lado del copy:
 * ver AdminService.getProductAnalytics para el detalle de cada cálculo y por qué algunas etapas
 * no tienen `route` (no existe todavía un filtro exacto en ninguna pantalla admin para esa
 * pregunta puntual — mejor sin link que un link que mienta).
 *
 * Decisión de responsabilidades distinta de PR1 (ver operational-alerts.util.ts en
 * agro-score-admin, donde el copy vive en el frontend): acá el copy básico (label/description/
 * title de cada etapa e insight) SÍ vive en la API, porque el shape que pidió la ficha ya lo
 * incluye a nivel de DTO — el frontend solo pinta lo que recibe, no arma texto.
 */
export type AdminProductAnalyticsFunnelStage = {
  id: string;
  label: string;
  count: number;
  previousCount?: number;
  /**
   * Fracción 0–1 (no porcentaje, se formatea en el frontend — mismo criterio que
   * analysisFailureRateLast7Days en /admin/metrics). `undefined` cuando previousCount es 0 o
   * no aplica (primera etapa) — nunca 0, para no leerse como "0% de conversión".
   */
  conversionFromPrevious?: number;
  /**
   * previousCount - count. Puede ser NEGATIVO: varias transiciones del funnel cambian de entidad
   * (usuarios → campos) y no son un subconjunto estricto de la etapa anterior, así que un número
   * negativo significa "creció respecto de la etapa anterior", no un error. El frontend lo pinta
   * con signo, nunca como "caída" fija.
   */
  dropoffFromPrevious?: number;
  description?: string;
  route?: string;
  queryParams?: Record<string, string | number | boolean>;
};

export type AdminProductAnalyticsInsightSeverity =
  | 'critical'
  | 'warning'
  | 'info'
  | 'opportunity';

export type AdminProductAnalyticsInsight = {
  id: string;
  severity: AdminProductAnalyticsInsightSeverity;
  title: string;
  description: string;
  route?: string;
  queryParams?: Record<string, string | number | boolean>;
};

export type AdminProductAnalyticsWeeklyMonitoring = {
  totalFields: number;
  activeSchedules: number;
  /**
   * A propósito NO es el mismo número que `activeSchedulesWithoutRuns` de /admin/metrics (ese usa
   * `lastRunAt IS NULL`, ver PR1) — acá se usa el criterio real de PR3 (EXISTS/NOT EXISTS contra
   * scheduled_analysis_runs). Hoy ambos coinciden siempre, pero este bloque usa la fuente de
   * verdad a propósito, igual que el filtro `hasRuns` de Programados.
   */
  activeSchedulesWithoutRuns: number;
  schedulesWithRuns: number;
  /** Corridas con emailSentAt seteado, histórico completo (no acotado a una ventana de días). */
  sentEmails: number;
};

export type AdminAnalysisErrorBucket = {
  message: string;
  count: number;
};

export type AdminProductAnalyticsDto = {
  generatedAt: string;
  funnel: AdminProductAnalyticsFunnelStage[];
  insights: AdminProductAnalyticsInsight[];
  weeklyMonitoring: AdminProductAnalyticsWeeklyMonitoring;
  topAnalysisErrorsLast30Days: AdminAnalysisErrorBucket[];
};
