import { Analysis } from '../analysis/entities/analysis.entity';
import { buildVerdictGeneratorInput } from './analysis-verdict-input.util';

describe('buildVerdictGeneratorInput', () => {
  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis =>
    ({
      id: 'analysis-1',
      globalScore: 80,
      ndviAverageMax: 0.7,
      ndviVariability: 'Media',
      resultJson: null,
      ...overrides,
    }) as Analysis;

  it('hasZoneData=false si resultJson es null', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({ resultJson: null }),
    );

    expect(input.hasZoneData).toBe(false);
    expect(input.ndmiMean).toBeNull();
  });

  it('hasZoneData=false si totalsByZone está vacío (misma señal que report-pdf.service.ts)', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [],
        } as any,
      }),
    );

    expect(input.hasZoneData).toBe(false);
  });

  it('hasZoneData=true si totalsByZone tiene al menos una zona', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 0, name: 'Alta', hectares: 10, percent: 100 }],
        } as any,
      }),
    );

    expect(input.hasZoneData).toBe(true);
  });

  it('extrae ndmiMean promediando values.NDMI_mean de resultJson.timeseries, descartando filas sin píxeles válidos', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 0, name: 'Alta', hectares: 10, percent: 100 }],
          timeseries: [
            {
              rows: [
                { values: { NDVI_count: 100, NDMI_mean: 0.2 } },
                { values: { NDVI_count: 100, NDMI_mean: 0.4 } },
                { values: { NDVI_count: 0, NDMI_mean: 0.9 } },
              ],
            },
          ],
        } as any,
      }),
    );

    expect(input.ndmiMean).toBeCloseTo(0.3, 4);
  });

  it('ndmiMean=null si no hay filas con píxeles válidos', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 0, name: 'Alta', hectares: 10, percent: 100 }],
          timeseries: [
            { rows: [{ values: { NDVI_count: 0, NDMI_mean: 0.9 } }] },
          ],
        } as any,
      }),
    );

    expect(input.ndmiMean).toBeNull();
  });

  it('propaga globalScore/ndviAverageMax/ndviVariability tal cual desde Analysis', () => {
    const input = buildVerdictGeneratorInput(
      buildAnalysis({
        globalScore: 42,
        ndviAverageMax: 0.55,
        ndviVariability: 'Alta',
      }),
    );

    expect(input.globalScore).toBe(42);
    expect(input.ndviAverageMax).toBe(0.55);
    expect(input.ndviVariability).toBe('Alta');
  });
});
