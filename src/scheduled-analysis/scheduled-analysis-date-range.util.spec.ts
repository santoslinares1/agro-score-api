import {
  computeScheduledAnalysisDateRange,
  SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS,
  SCHEDULED_ANALYSIS_WINDOW_DAYS,
} from './scheduled-analysis-date-range.util';

describe('computeScheduledAnalysisDateRange', () => {
  it('endDate es la fecha local de hoy y startDate es endDate menos 7 días', () => {
    // Mediodía UTC cae holgadamente dentro del mismo día en Córdoba (UTC-3) para cualquier fecha,
    // así que "hoy" en la zona coincide con la fecha UTC de este instante — evita depender de la
    // hora exacta en que corre el test.
    const now = new Date('2026-08-24T12:00:00.000Z');

    const result = computeScheduledAnalysisDateRange(now);

    expect(result.endDate).toBe('2026-08-24');
    expect(result.startDate).toBe('2026-08-17'); // 2026-08-24 menos 7 días
    expect(result.source).toBe('rolling_7_days');
  });

  it('el ancho por defecto es exactamente SCHEDULED_ANALYSIS_WINDOW_DAYS (7) días', () => {
    const now = new Date('2026-01-01T12:00:00.000Z');

    const result = computeScheduledAnalysisDateRange(now);
    const spanDays =
      (Date.parse(`${result.endDate}T00:00:00.000Z`) - Date.parse(`${result.startDate}T00:00:00.000Z`)) /
      (24 * 60 * 60 * 1000);

    expect(spanDays).toBe(SCHEDULED_ANALYSIS_WINDOW_DAYS);
  });

  it('respeta el offset de America/Argentina/Cordoba (UTC-3) en un caso límite cerca de medianoche', () => {
    // 01:30 UTC del 24/08 = 22:30 del 23/08 en Córdoba (UTC-3) — la fecha local todavía es el 23.
    const now = new Date('2026-08-24T01:30:00.000Z');

    const result = computeScheduledAnalysisDateRange(now, { timezone: 'America/Argentina/Cordoba' });

    expect(result.endDate).toBe('2026-08-23');
  });

  it('con timezone=UTC no aplica ningún corrimiento', () => {
    const now = new Date('2026-08-24T01:30:00.000Z');

    const result = computeScheduledAnalysisDateRange(now, { timezone: 'UTC' });

    expect(result.endDate).toBe('2026-08-24');
  });

  it('nunca supera SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS (366) — tira si se pide más', () => {
    expect(() =>
      computeScheduledAnalysisDateRange(new Date('2026-08-24T12:00:00.000Z'), {
        windowDays: SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS + 1,
      }),
    ).toThrow(/no puede superar/);
  });

  it('exactamente 366 días (el límite) es válido, no tira', () => {
    expect(() =>
      computeScheduledAnalysisDateRange(new Date('2026-08-24T12:00:00.000Z'), {
        windowDays: SCHEDULED_ANALYSIS_MAX_WINDOW_DAYS,
      }),
    ).not.toThrow();
  });

  it('tira un error claro para una timezone no soportada', () => {
    expect(() =>
      computeScheduledAnalysisDateRange(new Date('2026-08-24T12:00:00.000Z'), { timezone: 'Europe/Madrid' }),
    ).toThrow(/no soportada/);
  });
});
