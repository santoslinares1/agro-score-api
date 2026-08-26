import { WeeklyAnalysisSnapshot } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { buildWeeklyVerdictGeneratorInput } from './weekly-technical-verdict-input.util';

function buildSnapshot(
  overrides: Partial<WeeklyAnalysisSnapshot> = {},
): WeeklyAnalysisSnapshot {
  return {
    id: 'snapshot-1',
    fieldId: 'field-1',
    userId: 'user-1',
    analysisId: 'analysis-1',
    scheduledRunId: 'run-1',
    weekStart: '2026-08-18',
    weekEnd: '2026-08-25',
    source: 'scheduled_analysis',
    score: 65,
    scoreLabel: 'Atención',
    analyzedAreaHa: 100,
    lotCount: 3,
    dominantZone: 'Alta',
    dominantZonePercentage: 40,
    ndviMean: 0.6,
    ndmiMean: 0.2,
    hasRgbImage: true,
    hasNdviImage: true,
    hasNdmiImage: true,
    hasImageSeries: false,
    hasEnoughData: true,
    dataQualityStatus: 'sufficient',
    limitations: null,
    comparisonVsPrevious: {
      previousSnapshotId: 'snapshot-0',
      previousWeekStart: '2026-08-11',
      previousWeekEnd: '2026-08-18',
      scoreDelta: 5,
      ndviMeanDelta: 0.02,
      ndmiMeanDelta: 0.01,
      dominantZoneChanged: false,
      dominantZoneFrom: 'Alta',
      dominantZoneTo: 'Alta',
      analyzedAreaDeltaHa: 0,
      dataQualityChanged: false,
      summary: ['El score subió 5 puntos respecto de la semana anterior.'],
    },
    metrics: null,
    createdAt: new Date('2026-08-25T10:00:00.000Z'),
    updatedAt: new Date('2026-08-25T10:00:00.000Z'),
    ...overrides,
  };
}

describe('buildWeeklyVerdictGeneratorInput', () => {
  it('mapea todos los campos del snapshot tal cual, sin recalcular nada', () => {
    const snapshot = buildSnapshot();
    const input = buildWeeklyVerdictGeneratorInput(
      snapshot,
      'Campo Norte',
      null,
    );

    expect(input.fieldName).toBe('Campo Norte');
    expect(input.weekStart).toBe('2026-08-18');
    expect(input.weekEnd).toBe('2026-08-25');
    expect(input.score).toBe(65);
    expect(input.ndviMean).toBe(0.6);
    expect(input.ndmiMean).toBe(0.2);
    expect(input.dominantZone).toBe('Alta');
    expect(input.dataQualityStatus).toBe('sufficient');
  });

  it('previousSnapshotId sale de comparisonVsPrevious.previousSnapshotId', () => {
    const snapshot = buildSnapshot();
    const input = buildWeeklyVerdictGeneratorInput(snapshot, null, null);

    expect(input.previousSnapshotId).toBe('snapshot-0');
    expect(input.comparison.scoreDelta).toBe(5);
  });

  it('sin comparisonVsPrevious (fila corrupta/legacy) usa un fallback vacío en vez de tirar', () => {
    const snapshot = buildSnapshot({ comparisonVsPrevious: null });
    const input = buildWeeklyVerdictGeneratorInput(snapshot, null, null);

    expect(input.previousSnapshotId).toBeNull();
    expect(input.comparison.summary).toEqual([]);
    expect(input.comparison.scoreDelta).toBeNull();
  });

  it('fieldName null cuando no está disponible', () => {
    const input = buildWeeklyVerdictGeneratorInput(buildSnapshot(), null, null);

    expect(input.fieldName).toBeNull();
  });

  it('propaga individualVerdict tal cual (contexto opcional)', () => {
    const individualVerdict = {
      verdict: 'attention',
      confidence: 'medium',
      summary: 'Resumen del análisis individual.',
    };
    const input = buildWeeklyVerdictGeneratorInput(
      buildSnapshot(),
      'Campo Norte',
      individualVerdict,
    );

    expect(input.individualVerdict).toEqual(individualVerdict);
  });

  it('individualVerdict null cuando no está disponible (nunca lo inventa)', () => {
    const input = buildWeeklyVerdictGeneratorInput(
      buildSnapshot(),
      'Campo Norte',
      null,
    );

    expect(input.individualVerdict).toBeNull();
  });
});
