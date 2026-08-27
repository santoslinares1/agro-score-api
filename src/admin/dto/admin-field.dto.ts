import { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import { AdminAnalysisTechnicalVerdict } from './admin-analysis-technical-verdict.dto';

/**
 * Admin PR 5: estado administrativo/producto de un campo — NUNCA un diagnóstico agronómico.
 * Deriva de datos que ya existen (Analysis.status, AnalysisTechnicalVerdict.verdict), no agrega
 * ninguna regla nueva de negocio. Ver AdminService.deriveFieldAnalysisStatus para el detalle
 * exacto de cada transición.
 *
 * - `without_analysis`: no existe ningún Analysis asociado al campo (mismo criterio que
 *   `hasAnalysis=false`, PR1).
 * - `processing`/`error`: el análisis MÁS RECIENTE del campo está en ese estado.
 * - `attention`: el análisis más reciente está Finalizado, pero su veredicto técnico es
 *   'attention' o 'critical'.
 * - `completed`: el análisis más reciente está Finalizado y no requiere atención según el
 *   veredicto (o no hay veredicto todavía).
 */
export type AdminFieldAnalysisStatus =
  | 'without_analysis'
  | 'processing'
  | 'completed'
  | 'error'
  | 'attention';

export type AdminFieldLatestAnalysis = {
  id: string;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /**
   * Analysis.globalScore tal cual lo persiste el pipeline — nunca recalculado acá. Solo viaja
   * cuando el análisis está Finalizado: mientras está Procesando (o si terminó en Error),
   * globalScore sigue en su default de fila (0) y mostrarlo sería un score falso, no "ausente".
   */
  score: number | null;
};

/**
 * Admin PR 5: reusa AdminAnalysisTechnicalVerdict tal cual (PR 13A) — mismo criterio que
 * AdminScheduledAnalysisItem.technicalVerdict (PR 13B): un solo tipo de veredicto en todo el
 * admin, la tabla de Campos solo pinta un subconjunto compacto (verdict + confidence), pero el
 * shape que viaja por la red es el mismo completo.
 */
export type AdminFieldWeeklyMonitoring = {
  active: boolean;
  scheduleId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** Existencia REAL de ScheduledAnalysisRun (mismo criterio que hasRuns, PR3) — no lastRunAt. */
  hasRuns: boolean;
};

export type AdminFieldItem = {
  id: string;
  name: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerFullName: string | null;
  lotsCount: number;
  createdAt: string;
  updatedAt: string;
  analysisStatus: AdminFieldAnalysisStatus;
  /**
   * Señal operativa independiente de analysisStatus — puede ser true incluso con
   * analysisStatus='completed' (ej.: schedule activo sin corridas todavía). Ver
   * AdminService.fieldRequiresAttention para las 3 reglas exactas (error / veredicto de atención
   * / schedule activo sin corridas) — a propósito NO usa umbrales de score: el admin no tiene
   * bandas de score propias (a diferencia de agro-score-web), así que este PR no inventa una.
   */
  requiresAttention: boolean;
  latestAnalysis: AdminFieldLatestAnalysis | null;
  technicalVerdict: AdminAnalysisTechnicalVerdict | null;
  weeklyMonitoring: AdminFieldWeeklyMonitoring;
};
