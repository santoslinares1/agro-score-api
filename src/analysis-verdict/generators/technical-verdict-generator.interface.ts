import {
  GeneratedVerdict,
  VerdictGeneratorInput,
} from '../analysis-verdict-generator.util';

/**
 * PR 11B: contrato común entre DeterministicTechnicalVerdictGenerator (PR 11A, sin cambios) y
 * ClaudeTechnicalVerdictGenerator (Anthropic real). AnalysisVerdictService resuelve cuál
 * implementación usar según TECHNICAL_VERDICT_PROVIDER y solo conoce esta interfaz — no sabe
 * nada de Claude ni de reglas determinísticas.
 */
export interface TechnicalVerdictGenerator {
  /** 'deterministic-v1' | 'claude' — persistido tal cual en AnalysisTechnicalVerdict.generator. */
  readonly generatorName: string;

  /** null para el generador determinístico (no versiona prompt); versionado para Claude. */
  readonly promptVersion: string | null;

  /** null para el generador determinístico; el model id de Anthropic usado, para Claude. */
  readonly modelId: string | null;

  generate(input: VerdictGeneratorInput): Promise<GeneratedVerdict>;
}
