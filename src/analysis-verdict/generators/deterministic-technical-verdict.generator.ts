import { Injectable } from '@nestjs/common';

import {
  GeneratedVerdict,
  VerdictGeneratorInput,
  generateTechnicalVerdict,
} from '../analysis-verdict-generator.util';
import { TechnicalVerdictGenerator } from './technical-verdict-generator.interface';

export const DETERMINISTIC_GENERATOR_NAME = 'deterministic-v1';

/**
 * PR 11B: adaptador delgado sobre generateTechnicalVerdict (PR 11A, sin cambios — sigue siendo
 * la función pura testeada en analysis-verdict-generator.util.spec.ts). Solo la envuelve en la
 * interfaz TechnicalVerdictGenerator para que AnalysisVerdictService pueda tratarla igual que
 * ClaudeTechnicalVerdictGenerator.
 */
@Injectable()
export class DeterministicTechnicalVerdictGenerator implements TechnicalVerdictGenerator {
  readonly generatorName = DETERMINISTIC_GENERATOR_NAME;
  readonly promptVersion = null;
  readonly modelId = null;

  generate(input: VerdictGeneratorInput): Promise<GeneratedVerdict> {
    return Promise.resolve(generateTechnicalVerdict(input));
  }
}
