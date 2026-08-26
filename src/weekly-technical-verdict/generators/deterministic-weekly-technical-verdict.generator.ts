import { Injectable } from '@nestjs/common';

import {
  GeneratedWeeklyVerdict,
  WeeklyVerdictGeneratorInput,
  generateWeeklyTechnicalVerdict,
} from '../weekly-technical-verdict-generator.util';
import { WeeklyTechnicalVerdictGenerator } from './weekly-technical-verdict-generator.interface';

export const DETERMINISTIC_WEEKLY_GENERATOR_NAME = 'deterministic-v1';

/**
 * PR 16B: adaptador delgado sobre generateWeeklyTechnicalVerdict (función pura, testeada en
 * weekly-technical-verdict-generator.util.spec.ts) — mismo patrón que
 * DeterministicTechnicalVerdictGenerator para el veredicto individual. Solo la envuelve en la
 * interfaz WeeklyTechnicalVerdictGenerator para que WeeklyTechnicalVerdictService la trate igual
 * que ClaudeWeeklyTechnicalVerdictGenerator.
 */
@Injectable()
export class DeterministicWeeklyTechnicalVerdictGenerator implements WeeklyTechnicalVerdictGenerator {
  readonly generatorName = DETERMINISTIC_WEEKLY_GENERATOR_NAME;
  readonly promptVersion = null;
  readonly modelId = null;

  generate(
    input: WeeklyVerdictGeneratorInput,
  ): Promise<GeneratedWeeklyVerdict> {
    return Promise.resolve(generateWeeklyTechnicalVerdict(input));
  }
}
