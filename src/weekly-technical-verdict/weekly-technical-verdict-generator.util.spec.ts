import { ComparisonVsPrevious } from '../scheduled-analysis/weekly-analysis-snapshot-comparison.util';
import {
  WeeklyVerdictGeneratorInput,
  generateWeeklyTechnicalVerdict,
} from './weekly-technical-verdict-generator.util';

function buildComparison(
  overrides: Partial<ComparisonVsPrevious> = {},
): ComparisonVsPrevious {
  return {
    previousSnapshotId: 'snapshot-prev',
    previousWeekStart: '2026-08-10',
    previousWeekEnd: '2026-08-17',
    scoreDelta: null,
    ndviMeanDelta: null,
    ndmiMeanDelta: null,
    dominantZoneChanged: false,
    dominantZoneFrom: 'Alta',
    dominantZoneTo: 'Alta',
    analyzedAreaDeltaHa: null,
    dataQualityChanged: false,
    summary: ['El score se mantuvo estable respecto de la semana anterior.'],
    ...overrides,
  };
}

function buildInput(
  overrides: Partial<WeeklyVerdictGeneratorInput> = {},
): WeeklyVerdictGeneratorInput {
  return {
    fieldName: 'Campo Norte',
    weekStart: '2026-08-18',
    weekEnd: '2026-08-25',
    score: 70,
    scoreLabel: 'Atención',
    ndviMean: 0.6,
    ndmiMean: 0.2,
    dominantZone: 'Alta',
    dominantZonePercentage: 40,
    analyzedAreaHa: 100,
    lotCount: 3,
    dataQualityStatus: 'sufficient',
    hasRgbImage: true,
    hasNdviImage: true,
    hasNdmiImage: true,
    hasImageSeries: false,
    previousSnapshotId: 'snapshot-prev',
    comparison: buildComparison(),
    individualVerdict: null,
    ...overrides,
  };
}

describe('generateWeeklyTechnicalVerdict', () => {
  it('sin previousSnapshotId → trend insufficient_data', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        previousSnapshotId: null,
        comparison: buildComparison({
          previousSnapshotId: null,
          summary: ['Primer reporte semanal disponible para este campo.'],
        }),
      }),
    );

    expect(result.trend).toBe('insufficient_data');
    expect(result.confidence).toBe('low');
    expect(result.summary).toContain('primer reporte semanal');
    expect(result.limitations).toContain(
      'No hay un reporte semanal anterior para calcular una tendencia.',
    );
  });

  it('scoreDelta positivo relevante (>= 5) → improving', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({ comparison: buildComparison({ scoreDelta: 10 }) }),
    );

    expect(result.trend).toBe('improving');
  });

  it('scoreDelta negativo relevante (<= -5) → worsening', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({ comparison: buildComparison({ scoreDelta: -12 }) }),
    );

    expect(result.trend).toBe('worsening');
  });

  it('deltas chicos (dentro del umbral) → stable', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        comparison: buildComparison({
          scoreDelta: 2,
          ndviMeanDelta: 0.01,
          ndmiMeanDelta: -0.01,
        }),
      }),
    );

    expect(result.trend).toBe('stable');
  });

  it('score estable pero NDVI/NDMI en direcciones opuestas → mixed', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        comparison: buildComparison({
          scoreDelta: 1,
          ndviMeanDelta: 0.08,
          ndmiMeanDelta: -0.08,
        }),
      }),
    );

    expect(result.trend).toBe('mixed');
  });

  it('dataQualityStatus=insufficient esta semana → trend insufficient_data aunque haya snapshot anterior', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        dataQualityStatus: 'insufficient',
        comparison: buildComparison({ scoreDelta: 10 }),
      }),
    );

    expect(result.trend).toBe('insufficient_data');
    expect(result.verdict).toBe('insufficient_data');
  });

  it('no inventa lotes/zonas específicas — areasToReview usa exactamente dominantZone del input', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        score: 40, // critical
        dominantZone: 'Media',
        comparison: buildComparison({ scoreDelta: -10 }),
      }),
    );

    expect(result.areasToReview.join(' ')).toContain('Media');
    expect(result.areasToReview.join(' ')).not.toMatch(/lote\s*\d/i);
  });

  it('areasToReview vacío cuando el verdict actual es favorable', () => {
    const result = generateWeeklyTechnicalVerdict(buildInput({ score: 90 }));

    expect(result.areasToReview).toEqual([]);
  });

  it('siempre incluye limitations (las comunes al menos)', () => {
    const result = generateWeeklyTechnicalVerdict(buildInput());

    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.limitations[0]).toMatch(/índices satelitales/i);
  });

  it('keyChanges reusa comparisonVsPrevious.summary tal cual', () => {
    const summary = ['El score subió 8 puntos respecto de la semana anterior.'];
    const result = generateWeeklyTechnicalVerdict(
      buildInput({ comparison: buildComparison({ summary }) }),
    );

    expect(result.keyChanges).toEqual(summary);
  });

  it('verdict se deriva del score actual, independiente de trend', () => {
    const result = generateWeeklyTechnicalVerdict(
      buildInput({
        score: 85,
        comparison: buildComparison({ scoreDelta: -20 }),
      }),
    );

    expect(result.verdict).toBe('favorable');
    expect(result.trend).toBe('worsening');
  });
});
