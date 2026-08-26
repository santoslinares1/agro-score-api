import { DeterministicWeeklyTechnicalVerdictGenerator } from './deterministic-weekly-technical-verdict.generator';
import { WeeklyVerdictGeneratorInput } from '../weekly-technical-verdict-generator.util';

describe('DeterministicWeeklyTechnicalVerdictGenerator', () => {
  it('expone generatorName=deterministic-v1, promptVersion=null y modelId=null', () => {
    const generator = new DeterministicWeeklyTechnicalVerdictGenerator();

    expect(generator.generatorName).toBe('deterministic-v1');
    expect(generator.promptVersion).toBeNull();
    expect(generator.modelId).toBeNull();
  });

  it('generate() envuelve generateWeeklyTechnicalVerdict y resuelve una Promise', async () => {
    const generator = new DeterministicWeeklyTechnicalVerdictGenerator();
    const input: WeeklyVerdictGeneratorInput = {
      fieldName: 'Campo Norte',
      weekStart: '2026-08-18',
      weekEnd: '2026-08-25',
      score: 80,
      scoreLabel: 'Favorable',
      ndviMean: 0.7,
      ndmiMean: 0.3,
      dominantZone: 'Alta',
      dominantZonePercentage: 60,
      analyzedAreaHa: 100,
      lotCount: 2,
      dataQualityStatus: 'sufficient',
      hasRgbImage: true,
      hasNdviImage: true,
      hasNdmiImage: true,
      hasImageSeries: false,
      previousSnapshotId: null,
      comparison: {
        previousSnapshotId: null,
        previousWeekStart: null,
        previousWeekEnd: null,
        scoreDelta: null,
        ndviMeanDelta: null,
        ndmiMeanDelta: null,
        dominantZoneChanged: false,
        dominantZoneFrom: null,
        dominantZoneTo: 'Alta',
        analyzedAreaDeltaHa: null,
        dataQualityChanged: false,
        summary: ['Primer reporte semanal disponible para este campo.'],
      },
      individualVerdict: null,
    };

    const result = await generator.generate(input);

    expect(result.verdict).toBe('favorable');
    expect(result.trend).toBe('insufficient_data');
  });
});
