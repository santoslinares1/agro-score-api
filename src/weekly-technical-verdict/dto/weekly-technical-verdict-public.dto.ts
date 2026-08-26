import {
  WeeklyVerdictConfidence,
  WeeklyVerdictLabel,
  WeeklyVerdictStatus,
  WeeklyVerdictTrend,
} from '../entities/weekly-technical-verdict.entity';
import { WeeklyTechnicalVerdictResponse } from './weekly-technical-verdict.dto';

/**
 * PR 17C: shape público de `weeklyTechnicalVerdict` para
 * GET /fields/:fieldId/weekly-analysis-snapshots* — mismo patrón ya usado por el veredicto
 * puntual (`AnalysisTechnicalVerdictResponse`, analysis-verdict/dto/analysis-technical-verdict.dto.ts):
 * nunca expone `generator`/`promptVersion`/`errorMessage`/`inputSnapshot`/`analysisId`/
 * `scheduledRunId`. Tal como anticipaba el doc-comment de WeeklyTechnicalVerdictResponse, este es
 * el split público/admin que faltaba.
 *
 * `status` en la práctica siempre llega 'generated' acá: `toPublicWeeklyTechnicalVerdictDto`
 * mapea 'failed' a `null` (mismo criterio que ya usa el mail semanal, que omite la sección entera
 * en 'failed') para que la web nunca tenga que distinguir "no hay dato" de "hubo un error técnico"
 * — ambos casos resuelven en "no disponible", sin exponer `errorMessage`.
 */
export type PublicWeeklyTechnicalVerdictDto = {
  status: WeeklyVerdictStatus;
  verdict: WeeklyVerdictLabel | null;
  trend: WeeklyVerdictTrend | null;
  confidence: WeeklyVerdictConfidence | null;
  summary: string | null;
  keyChanges: string[];
  areasToReview: string[];
  recommendations: string[];
  limitations: string[];
  previousSnapshotId: string | null;
  generatedAt: string | null;
};

export function toPublicWeeklyTechnicalVerdictDto(
  response: WeeklyTechnicalVerdictResponse | null,
): PublicWeeklyTechnicalVerdictDto | null {
  if (!response || response.status === 'failed') {
    return null;
  }

  return {
    status: response.status,
    verdict: response.verdict,
    trend: response.trend,
    confidence: response.confidence,
    summary: response.summary,
    keyChanges: response.keyChanges,
    areasToReview: response.areasToReview,
    recommendations: response.recommendations,
    limitations: response.limitations,
    previousSnapshotId: response.previousSnapshotId,
    generatedAt: response.generatedAt,
  };
}
