import {
  DETERMINISTIC_GENERATOR_NAME,
  DeterministicTechnicalVerdictGenerator,
} from './deterministic-technical-verdict.generator';
import { VerdictGeneratorInput } from '../analysis-verdict-generator.util';

describe('DeterministicTechnicalVerdictGenerator', () => {
  const generator = new DeterministicTechnicalVerdictGenerator();

  const input: VerdictGeneratorInput = {
    globalScore: 80,
    hasZoneData: true,
    ndviAverageMax: 0.7,
    ndviVariability: 'Media',
    ndmiMean: 0.3,
  };

  it('expone generatorName=deterministic-v1, promptVersion=null y modelId=null', () => {
    expect(generator.generatorName).toBe(DETERMINISTIC_GENERATOR_NAME);
    expect(generator.promptVersion).toBeNull();
    expect(generator.modelId).toBeNull();
  });

  it('delega en generateTechnicalVerdict (PR 11A) sin alterar el resultado', async () => {
    const result = await generator.generate(input);

    expect(result.verdict).toBe('favorable');
    expect(result.confidence).toBe('high');
  });
});
