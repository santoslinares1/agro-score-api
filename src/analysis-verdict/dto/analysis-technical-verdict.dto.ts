import {
  AnalysisTechnicalVerdict,
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
  AnalysisVerdictStatus,
} from '../entities/analysis-technical-verdict.entity';

/**
 * Shape público de `technicalVerdict` dentro de la respuesta de GET /analysis/:id. Arrays nunca
 * son null (siempre [] si no aplica) para que el frontend no tenga que chequear null en cada
 * campo — status/verdict/confidence sí pueden ser null cuando la fila no existe todavía (ver
 * AnalysisService.findOneOwnedWithVerdict, technicalVerdict=null mientras 'Procesando').
 */
export type AnalysisTechnicalVerdictResponse = {
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
};

export function toAnalysisTechnicalVerdictResponse(
  entity: AnalysisTechnicalVerdict,
): AnalysisTechnicalVerdictResponse {
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
  };
}
