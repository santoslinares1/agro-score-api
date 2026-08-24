import { compareWeeklySnapshots, SnapshotComparisonInput } from './weekly-analysis-snapshot-comparison.util';

describe('compareWeeklySnapshots', () => {
  const buildSnapshot = (overrides: Partial<SnapshotComparisonInput> = {}): SnapshotComparisonInput => ({
    id: 'snapshot-1',
    weekStart: '2026-08-10',
    weekEnd: '2026-08-17',
    score: 70,
    ndviMean: 0.6,
    ndmiMean: 0.2,
    dominantZone: 'Muy Alta',
    analyzedAreaHa: 100,
    dataQualityStatus: 'sufficient',
    hasRgbImage: true,
    hasNdviImage: true,
    hasNdmiImage: true,
    ...overrides,
  });

  it('sin snapshot anterior: summary dice que es el primer reporte, sin deltas', () => {
    const result = compareWeeklySnapshots(buildSnapshot(), null);

    expect(result.previousSnapshotId).toBeNull();
    expect(result.scoreDelta).toBeNull();
    expect(result.ndviMeanDelta).toBeNull();
    expect(result.summary).toContain('Primer reporte semanal disponible para este campo.');
  });

  it('primer reporte con datos incompletos también informa la limitación, sin inventar que hay más', () => {
    const result = compareWeeklySnapshots(buildSnapshot({ hasRgbImage: false }), null);

    expect(result.summary.some((line) => line.includes('RGB'))).toBe(true);
  });

  it('calcula scoreDelta como current.score - previous.score', () => {
    const current = buildSnapshot({ id: 'snap-2', score: 78 });
    const previous = buildSnapshot({ id: 'snap-1', score: 74 });

    const result = compareWeeklySnapshots(current, previous);

    expect(result.scoreDelta).toBe(4);
    expect(result.previousSnapshotId).toBe('snap-1');
  });

  it('scoreDelta >= 5 se describe como mejora en el summary', () => {
    const result = compareWeeklySnapshots(buildSnapshot({ score: 80 }), buildSnapshot({ score: 74 }));

    expect(result.summary.some((line) => line.includes('subió 6 puntos'))).toBe(true);
  });

  it('scoreDelta entre -4 y +4 se describe como estable', () => {
    const result = compareWeeklySnapshots(buildSnapshot({ score: 72 }), buildSnapshot({ score: 70 }));

    expect(result.summary.some((line) => line.includes('estable'))).toBe(true);
  });

  it('calcula ndviMeanDelta cuando ambos snapshots tienen ndviMean', () => {
    const result = compareWeeklySnapshots(buildSnapshot({ ndviMean: 0.63 }), buildSnapshot({ ndviMean: 0.6 }));

    expect(result.ndviMeanDelta).toBeCloseTo(0.03, 5);
  });

  it('NUNCA inventa ndviMeanDelta/ndmiMeanDelta si a alguno de los dos snapshots le falta el dato', () => {
    const currentSinNdvi = buildSnapshot({ ndviMean: null });
    const result1 = compareWeeklySnapshots(currentSinNdvi, buildSnapshot({ ndviMean: 0.6 }));
    expect(result1.ndviMeanDelta).toBeNull();

    const previousSinNdmi = buildSnapshot({ ndmiMean: null });
    const result2 = compareWeeklySnapshots(buildSnapshot({ ndmiMean: 0.3 }), previousSinNdmi);
    expect(result2.ndmiMeanDelta).toBeNull();
  });

  it('detecta cambio de zona predominante', () => {
    const result = compareWeeklySnapshots(
      buildSnapshot({ dominantZone: 'Muy Alta' }),
      buildSnapshot({ dominantZone: 'Alta' }),
    );

    expect(result.dominantZoneChanged).toBe(true);
    expect(result.dominantZoneFrom).toBe('Alta');
    expect(result.dominantZoneTo).toBe('Muy Alta');
    expect(result.summary.some((line) => line.includes('cambió de Alta a Muy Alta'))).toBe(true);
  });

  it('zona predominante estable produce un mensaje "se mantiene", no "cambió"', () => {
    const result = compareWeeklySnapshots(
      buildSnapshot({ dominantZone: 'Muy Alta' }),
      buildSnapshot({ dominantZone: 'Muy Alta' }),
    );

    expect(result.dominantZoneChanged).toBe(false);
    expect(result.summary.some((line) => line.includes('se mantiene Muy Alta'))).toBe(true);
  });

  it('calcula analyzedAreaDeltaHa', () => {
    const result = compareWeeklySnapshots(
      buildSnapshot({ analyzedAreaHa: 112.4 }),
      buildSnapshot({ analyzedAreaHa: 100 }),
    );

    expect(result.analyzedAreaDeltaHa).toBe(12.4);
  });

  it('detecta cambio de dataQualityStatus y lo menciona en el summary', () => {
    const result = compareWeeklySnapshots(
      buildSnapshot({ dataQualityStatus: 'insufficient', hasRgbImage: false, hasNdviImage: false, hasNdmiImage: false }),
      buildSnapshot({ dataQualityStatus: 'sufficient' }),
    );

    expect(result.dataQualityChanged).toBe(true);
    expect(result.summary.some((line) => line.toLowerCase().includes('calidad'))).toBe(true);
  });

  it('incluye una línea de limitación honesta cuando falta una imagen esta semana', () => {
    const result = compareWeeklySnapshots(buildSnapshot({ hasRgbImage: false }), buildSnapshot());

    expect(result.summary.some((line) => line.includes('no hubo imagen RGB válida'))).toBe(true);
  });
});
