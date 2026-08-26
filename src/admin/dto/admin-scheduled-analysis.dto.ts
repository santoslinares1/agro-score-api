import { AnalysisStatus } from '../../analysis/entities/analysis.entity';
import {
  ScheduleFrequency,
  ScheduleLastStatus,
} from '../../scheduled-analysis/entities/field-analysis-schedule.entity';
import { ScheduledRunStatus } from '../../scheduled-analysis/entities/scheduled-analysis-run.entity';
import { WeeklyTechnicalVerdictResponse } from '../../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
import { AdminAnalysisTechnicalVerdict } from './admin-analysis-technical-verdict.dto';

/**
 * PR 13B: solo lectura, un vistazo operativo por schedule — nunca dispara nada (ni una corrida,
 * ni un email, ni una generación de veredicto). latestRun es la corrida más reciente de ese
 * schedule (por scheduledFor/createdAt), no un historial completo: para eso ya existe
 * GET fields/:fieldId/analysis-schedule (contrato de usuario, no admin).
 */
export type AdminScheduledAnalysisRun = {
  id: string;
  status: ScheduledRunStatus;
  scheduledFor: string;
  analysisId: string | null;
  analysisStatus: AnalysisStatus | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  emailSentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminScheduledAnalysisItem = {
  id: string;
  fieldId: string;
  fieldName: string | null;
  userId: string;
  userEmail: string | null;
  userFullName: string | null;
  enabled: boolean;
  frequency: ScheduleFrequency;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ScheduleLastStatus | null;
  lastErrorMessage: string | null;
  latestRun: AdminScheduledAnalysisRun | null;
  technicalVerdict: AdminAnalysisTechnicalVerdict | null;
  /**
   * PR 16D: diagnóstico semanal comparativo (evolución vs. el reporte anterior), distinto de
   * `technicalVerdict` (estado del análisis puntual de `latestRun`) — ver PR 16A/16B. Reusa
   * WeeklyTechnicalVerdictResponse tal cual (no un tipo "Admin*" separado, a diferencia de
   * AdminAnalysisTechnicalVerdict): ese shape ya incluye errorMessage por diseño desde PR 16B, no
   * hay una versión pública más angosta de la que distinguirse todavía.
   */
  weeklyTechnicalVerdict: WeeklyTechnicalVerdictResponse | null;
};
