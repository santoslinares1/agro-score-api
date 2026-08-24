import { classifyDataQuality, extractSnapshotMetrics } from './weekly-analysis-snapshot-metrics.util';

describe('extractSnapshotMetrics', () => {
  it('devuelve todo null/false si resultJson es null (análisis viejo o corrupto)', () => {
    const metrics = extractSnapshotMetrics(null);

    expect(metrics).toEqual({
      analyzedAreaHa: null,
      lotCount: null,
      dominantZone: null,
      dominantZonePercentage: null,
      ndviMean: null,
      ndmiMean: null,
      hasRgbImage: false,
      hasNdviImage: false,
      hasNdmiImage: false,
      hasImageSeries: false,
    });
  });

  it('extrae la zona predominante desde resultJson.totalsByZone (mayor cantidad de hectáreas)', () => {
    const metrics = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      totalsByZone: [
        { zone: 0, name: 'Baja', hectares: 5, percent: 10 },
        { zone: 2, name: 'Muy Alta', hectares: 40, percent: 80 },
        { zone: 1, name: 'Alta', hectares: 5, percent: 10 },
      ],
    } as any);

    expect(metrics.dominantZone).toBe('Muy Alta');
    expect(metrics.dominantZonePercentage).toBe(80);
  });

  it('extrae la superficie analizada desde resultJson.zones[].area_ha (no la superficie de referencia)', () => {
    const metrics = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      zones: [
        { lot: 'Lote Norte', area_ha: 30.5, valid_pixels: 100, zones: [], campaigns_used: 1, warnings: [] },
        { lot: 'Lote Sur', area_ha: 12.25, valid_pixels: 100, zones: [], campaigns_used: 1, warnings: [] },
      ],
    } as any);

    expect(metrics.analyzedAreaHa).toBe(42.75);
    expect(metrics.lotCount).toBe(2);
  });

  it('NDVI/NDMI mean: promedia values.NDVI_mean/NDMI_mean de resultJson.timeseries, descartando filas sin píxeles válidos', () => {
    const metrics = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      timeseries: [
        {
          lot: 'Lote Norte',
          rows: [
            { date: '2026-08-18', values: { NDVI_mean: 0.6, NDMI_mean: 0.2, NDVI_count: 500 } },
            { date: '2026-08-19', values: { NDVI_mean: 0.8, NDMI_mean: 0.4, NDVI_count: 500 } },
            { date: '2026-08-20', values: { NDVI_mean: 99, NDMI_mean: 99, NDVI_count: 0 } }, // sin píxeles válidos
          ],
        },
      ],
    } as any);

    expect(metrics.ndviMean).toBe(0.7);
    expect(metrics.ndmiMean).toBe(0.3);
  });

  it('NDVI/NDMI mean quedan null si no hay filas con datos válidos — nunca inventa 0', () => {
    const metrics = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      timeseries: [{ lot: 'Lote Norte', rows: [{ date: '2026-08-18', values: { NDVI_count: 0 } }] }],
    } as any);

    expect(metrics.ndviMean).toBeNull();
    expect(metrics.ndmiMean).toBeNull();
  });

  it('hasRgbImage: true solo si mapAssets.rgb.available=true y trae image_base64', () => {
    const withRgb = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      mapAssets: { rgb: { available: true, image_base64: 'abc' } },
    } as any);
    const withoutRgb = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      mapAssets: { rgb: { available: false } },
    } as any);

    expect(withRgb.hasRgbImage).toBe(true);
    expect(withoutRgb.hasRgbImage).toBe(false);
  });

  it('hasNdviImage/hasNdmiImage: desde mapAssets.indexImages filtrando por index exacto', () => {
    const metrics = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      mapAssets: {
        indexImages: [
          { index: 'NDVI', available: true, image_base64: 'abc' },
          { index: 'NDMI', available: false },
          { index: 'NDWI', available: true, image_base64: 'legacy' },
        ],
      },
    } as any);

    expect(metrics.hasNdviImage).toBe(true);
    expect(metrics.hasNdmiImage).toBe(false);
  });

  it('hasImageSeries: true si hay al menos una imagen available=true en imageSeries.ndvi o .ndmi', () => {
    const withSeries = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      imageSeries: { ndvi: [{ campaign: '2026', images: [{ available: false }, { available: true }] }], ndmi: [] },
    } as any);
    const withoutSeries = extractSnapshotMetrics({
      mode: 'python-worker-v2',
      message: '',
      imageSeries: { ndvi: [{ campaign: '2026', images: [{ available: false }] }], ndmi: [] },
    } as any);
    const noSeriesAtAll = extractSnapshotMetrics({ mode: 'python-worker-v2', message: '' } as any);

    expect(withSeries.hasImageSeries).toBe(true);
    expect(withoutSeries.hasImageSeries).toBe(false);
    expect(noSeriesAtAll.hasImageSeries).toBe(false);
  });
});

describe('classifyDataQuality', () => {
  const base = {
    hasRgbImage: false,
    hasNdviImage: false,
    hasNdmiImage: false,
    hasImageSeries: false,
    ndviMean: null as number | null,
    ndmiMean: null as number | null,
    dominantZone: null as string | null,
    analyzedAreaHa: null as number | null,
  };

  it('sufficient: hay al menos una imagen disponible', () => {
    const result = classifyDataQuality({ ...base, hasRgbImage: true });

    expect(result.status).toBe('sufficient');
    expect(result.hasEnoughData).toBe(true);
  });

  it('sufficient: no hay imágenes pero sí NDVI/NDMI comparable', () => {
    const result = classifyDataQuality({ ...base, ndviMean: 0.55 });

    expect(result.status).toBe('sufficient');
  });

  it('partial: sin imágenes ni NDVI/NDMI, pero con clasificación real (zona + superficie > 0)', () => {
    const result = classifyDataQuality({ ...base, dominantZone: 'Alta', analyzedAreaHa: 30 });

    expect(result.status).toBe('partial');
    expect(result.hasEnoughData).toBe(true);
  });

  it('insufficient: sin imágenes, sin métricas comparables y sin clasificación real', () => {
    const result = classifyDataQuality({ ...base });

    expect(result.status).toBe('insufficient');
    expect(result.hasEnoughData).toBe(false);
    expect(result.limitations).toContain('no hubo imágenes satelitales válidas');
    expect(result.limitations).toContain('No hubo datos satelitales suficientes');
  });

  it('insufficient si hay zona pero analyzedAreaHa es 0 (sin superficie real analizada)', () => {
    const result = classifyDataQuality({ ...base, dominantZone: 'Alta', analyzedAreaHa: 0 });

    expect(result.status).toBe('insufficient');
  });

  it('limitations describe exactamente qué imagen faltó, sin inventar', () => {
    const onlyRgbMissing = classifyDataQuality({ ...base, hasNdviImage: true, hasNdmiImage: true, ndviMean: 0.5 });
    expect(onlyRgbMissing.limitations).toBe('Esta semana no hubo imagen RGB válida.');

    const allMissing = classifyDataQuality({ ...base, dominantZone: 'Alta', analyzedAreaHa: 10 });
    expect(allMissing.limitations).toContain('RGB, NDVI ni NDMI');
  });
});
