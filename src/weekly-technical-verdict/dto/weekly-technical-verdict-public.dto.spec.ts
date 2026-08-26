import { WeeklyTechnicalVerdictResponse } from './weekly-technical-verdict.dto';
import { toPublicWeeklyTechnicalVerdictDto } from './weekly-technical-verdict-public.dto';

const buildResponse = (
  overrides: Partial<WeeklyTechnicalVerdictResponse> = {},
): WeeklyTechnicalVerdictResponse => ({
  status: 'generated',
  verdict: 'favorable',
  trend: 'stable',
  confidence: 'high',
  summary: 'El campo se mantiene estable respecto de la semana anterior.',
  keyChanges: ['El NDVI promedio se mantuvo dentro del mismo rango.'],
  areasToReview: [],
  recommendations: ['Sin acciones urgentes esta semana.'],
  limitations: ['La lectura se basa en indicadores satelitales.'],
  previousSnapshotId: 'snapshot-0',
  generatedAt: '2026-08-24T09:05:00.000Z',
  generator: 'claude-weekly-technical-verdict',
  promptVersion: 'weekly-technical-verdict-v1',
  errorMessage: null,
  ...overrides,
});

describe('toPublicWeeklyTechnicalVerdictDto', () => {
  it('mapea un veredicto generated al shape público, sin campos internos', () => {
    const result = toPublicWeeklyTechnicalVerdictDto(buildResponse());

    expect(result).toEqual({
      status: 'generated',
      verdict: 'favorable',
      trend: 'stable',
      confidence: 'high',
      summary: 'El campo se mantiene estable respecto de la semana anterior.',
      keyChanges: ['El NDVI promedio se mantuvo dentro del mismo rango.'],
      areasToReview: [],
      recommendations: ['Sin acciones urgentes esta semana.'],
      limitations: ['La lectura se basa en indicadores satelitales.'],
      previousSnapshotId: 'snapshot-0',
      generatedAt: '2026-08-24T09:05:00.000Z',
    });
  });

  it('nunca incluye generator/promptVersion/errorMessage aunque vengan en el input', () => {
    const result = toPublicWeeklyTechnicalVerdictDto(
      buildResponse({
        generator: 'claude',
        promptVersion: 'v9',
        errorMessage: 'boom',
      }),
    );

    expect(result).not.toBeNull();
    expect(Object.keys(result as object)).not.toContain('generator');
    expect(Object.keys(result as object)).not.toContain('promptVersion');
    expect(Object.keys(result as object)).not.toContain('errorMessage');
    expect(Object.keys(result as object)).not.toContain('inputSnapshot');
    expect(Object.keys(result as object)).not.toContain('analysisId');
    expect(Object.keys(result as object)).not.toContain('scheduledRunId');
  });

  it('status=failed se mapea a null (no expone errorMessage, no distingue "sin dato" de "error")', () => {
    const result = toPublicWeeklyTechnicalVerdictDto(
      buildResponse({
        status: 'failed',
        errorMessage: 'El worker no respondió a tiempo.',
      }),
    );

    expect(result).toBeNull();
  });

  it('input null se mapea a null (todavía no hay veredicto para el snapshot)', () => {
    expect(toPublicWeeklyTechnicalVerdictDto(null)).toBeNull();
  });

  it('trend=insufficient_data se mapea igual que cualquier otro trend, sin caso especial', () => {
    const result = toPublicWeeklyTechnicalVerdictDto(
      buildResponse({
        trend: 'insufficient_data',
        verdict: 'insufficient_data',
      }),
    );

    expect(result?.status).toBe('generated');
    expect(result?.trend).toBe('insufficient_data');
    expect(result?.verdict).toBe('insufficient_data');
  });
});
