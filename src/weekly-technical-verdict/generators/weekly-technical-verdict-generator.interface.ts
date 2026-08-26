import {
  GeneratedWeeklyVerdict,
  WeeklyVerdictGeneratorInput,
} from '../weekly-technical-verdict-generator.util';

/**
 * PR 16B: contrato común entre DeterministicWeeklyTechnicalVerdictGenerator y
 * ClaudeWeeklyTechnicalVerdictGenerator — mismo rol que TechnicalVerdictGenerator
 * (analysis-verdict/generators/technical-verdict-generator.interface.ts) para el veredicto
 * individual. WeeklyTechnicalVerdictService resuelve cuál implementación usar según
 * WEEKLY_TECHNICAL_VERDICT_PROVIDER y solo conoce esta interfaz.
 */
export interface WeeklyTechnicalVerdictGenerator {
  /** 'deterministic-v1' | 'claude' — persistido tal cual en WeeklyTechnicalVerdict.generator. */
  readonly generatorName: string;

  /** null para el generador determinístico (no versiona prompt); versionado para Claude. */
  readonly promptVersion: string | null;

  /** null para el generador determinístico; el model id de Anthropic usado, para Claude. */
  readonly modelId: string | null;

  generate(input: WeeklyVerdictGeneratorInput): Promise<GeneratedWeeklyVerdict>;
}
