import { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import { ScheduleFrequency } from '../../scheduled-analysis/entities/field-analysis-schedule.entity';
import { WeeklyTechnicalVerdictResponse } from '../../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
import { AdminAnalysisTechnicalVerdict } from './admin-analysis-technical-verdict.dto';
import {
  AdminFieldAnalysisStatus,
  AdminFieldLatestAnalysis,
} from './admin-field.dto';
import { AdminScheduledAnalysisRun } from './admin-scheduled-analysis.dto';

/**
 * Admin PR 6: vista de detalle de UN campo — GET /admin/fields/:fieldId, solo lectura. Reusa
 * exactamente las mismas reglas de estado que el listado de Campos (PR5): deriveFieldAnalysisStatus
 * / fieldRequiresAttention, sin duplicar ni divergir. La diferencia con AdminFieldItem (PR5) es
 * que acá se agregan el HISTORIAL de análisis y de corridas (limitados, ver constantes en
 * admin.service.ts), no solo el más reciente.
 */
export const FIELD_DETAIL_ANALYSES_LIMIT = 20;
export const FIELD_DETAIL_RUNS_LIMIT = 20;

export type AdminFieldDetailAnalysisRow = {
  id: string;
  status: AnalysisStatus;
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  /** Mismo criterio que AdminFieldLatestAnalysis.score (PR5): solo cuando status='Finalizado'. */
  score: number | null;
  errorMessage: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
};

export type AdminFieldDetailWeeklyMonitoring = {
  active: boolean;
  scheduleId: string | null;
  frequency: ScheduleFrequency | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  hasRuns: boolean;
};

/**
 * Admin PR 6: cada corrida trae su weeklyTechnicalVerdict correlacionado (si existe) — a
 * diferencia de la ficha sugerida (un array paralelo que el frontend tendría que cruzar por
 * scheduledRunId), acá se anida directo en la corrida, mismo criterio que ya usa
 * AdminScheduledAnalysisItem.weeklyTechnicalVerdict (PR16D) para la corrida más reciente de un
 * schedule — este PR extiende ese mismo patrón a las N corridas del historial, no inventa uno
 * nuevo.
 */
export type AdminFieldDetailScheduledRun = AdminScheduledAnalysisRun & {
  weeklyTechnicalVerdict: WeeklyTechnicalVerdictResponse | null;
};

export type AdminFieldDetail = {
  field: {
    id: string;
    name: string;
    ownerId: string;
    ownerEmail: string | null;
    ownerFullName: string | null;
    lotsCount: number;
    createdAt: string;
    updatedAt: string;
    analysisStatus: AdminFieldAnalysisStatus;
    requiresAttention: boolean;
  };
  latestAnalysis: AdminFieldLatestAnalysis | null;
  technicalVerdict: AdminAnalysisTechnicalVerdict | null;
  lots: Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }>;
  /** Últimas FIELD_DETAIL_ANALYSES_LIMIT, orden DESC por createdAt. */
  analyses: AdminFieldDetailAnalysisRow[];
  weeklyMonitoring: AdminFieldDetailWeeklyMonitoring;
  /** Últimas FIELD_DETAIL_RUNS_LIMIT del schedule del campo (si tiene uno), orden DESC. */
  scheduledRuns: AdminFieldDetailScheduledRun[];
};
