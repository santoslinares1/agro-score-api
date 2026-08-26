import {
  AnalysisTechnicalVerdict,
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
  AnalysisVerdictStatus,
} from '../../analysis-verdict/entities/analysis-technical-verdict.entity';

/**
 * PR 13A: shape del veredicto técnico dentro de GET /admin/analysis — distinto a
 * AnalysisTechnicalVerdictResponse (analysis-verdict/dto), que es el contrato público de
 * GET /analysis/:id y deliberadamente nunca expone errorMessage. Acá sí, porque admin es
 * soporte/debugging (JwtAuthGuard + RolesGuard owner|admin en AdminController) y necesita saber
 * por qué falló una generación sin tener que ir a los logs.
 */
export type AdminAnalysisTechnicalVerdict = {
  status: AnalysisVerdictStatus;
  verdict: AnalysisVerdictLabel | null;
  confidence: AnalysisVerdictConfidence | null;
  summary: string | null;
  keyFindings: string[];
  possibleCauses: string[];
  recommendations: string[];
  limitations: string[];
  generatedAt: string | null;
  generator: string | null;
  promptVersion: string | null;
  errorMessage: string | null;
};

export function toAdminAnalysisTechnicalVerdict(
  entity: AnalysisTechnicalVerdict,
): AdminAnalysisTechnicalVerdict {
  return {
    status: entity.status,
    verdict: entity.verdict,
    confidence: entity.confidence,
    summary: entity.summary,
    keyFindings: entity.keyFindings ?? [],
    possibleCauses: entity.possibleCauses ?? [],
    recommendations: entity.recommendations ?? [],
    limitations: entity.limitations ?? [],
    generatedAt: entity.generatedAt ? entity.generatedAt.toISOString() : null,
    generator: entity.generator,
    promptVersion: entity.promptVersion,
    errorMessage: entity.errorMessage,
  };
}
