import {
  WeeklyTechnicalVerdict,
  WeeklyVerdictConfidence,
  WeeklyVerdictLabel,
  WeeklyVerdictStatus,
  WeeklyVerdictTrend,
} from '../entities/weekly-technical-verdict.entity';

/**
 * PR 16B: shape interno de WeeklyTechnicalVerdictService.findResponseBySnapshotId — no expuesto
 * todavía por ningún endpoint/mail/admin (eso es PR 16C/16D/16E). `errorMessage` SÍ va acá (a
 * diferencia de AnalysisTechnicalVerdictResponse, el contrato público del veredicto individual):
 * hasta que exista una superficie pública real para weeklyTechnicalVerdict, no hay necesidad de
 * separar un shape público de uno admin — cuando PR 16D/16E lo requieran, seguir el mismo patrón
 * ya usado por AdminAnalysisTechnicalVerdict (admin/dto/admin-analysis-technical-verdict.dto.ts).
 */
export type WeeklyTechnicalVerdictResponse = {
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
  generator: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
};

export function toWeeklyTechnicalVerdictResponse(
  entity: WeeklyTechnicalVerdict,
): WeeklyTechnicalVerdictResponse {
  return {
    status: entity.status,
    verdict: entity.verdict,
    trend: entity.trend,
    confidence: entity.confidence,
    summary: entity.summary,
    keyChanges: entity.keyChanges ?? [],
    areasToReview: entity.areasToReview ?? [],
    recommendations: entity.recommendations ?? [],
    limitations: entity.limitations ?? [],
    previousSnapshotId: entity.previousSnapshotId,
    generatedAt: entity.generatedAt ? entity.generatedAt.toISOString() : null,
    generator: entity.generator,
    promptVersion: entity.promptVersion,
    errorMessage: entity.errorMessage,
  };
}
