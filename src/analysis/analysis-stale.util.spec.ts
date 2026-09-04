import { ANALYSIS_STALE_THRESHOLD_MS, isAnalysisStale } from './analysis-stale.util';

describe('isAnalysisStale', () => {
  const now = new Date('2026-01-01T12:00:00Z');
  const minutesAgo = (minutes: number) =>
    new Date(now.getTime() - minutes * 60 * 1000);

  it('es stale si status=Procesando y startedAt superó el umbral', () => {
    expect(
      isAnalysisStale(
        { status: 'Procesando', startedAt: minutesAgo(25) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(true);
  });

  it('no es stale si status=Procesando pero startedAt es reciente', () => {
    expect(
      isAnalysisStale(
        { status: 'Procesando', startedAt: minutesAgo(5) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  it('exactamente en el borde del umbral todavía no es stale (comparación estricta >)', () => {
    expect(
      isAnalysisStale(
        { status: 'Procesando', startedAt: minutesAgo(20) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  it('usa createdAt como fallback si no hay startedAt (fila legacy o proyección liviana)', () => {
    expect(
      isAnalysisStale(
        { status: 'Procesando', startedAt: null, createdAt: minutesAgo(25) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(true);
  });

  it('prioriza startedAt sobre createdAt cuando ambos existen', () => {
    expect(
      isAnalysisStale(
        {
          status: 'Procesando',
          startedAt: minutesAgo(5), // fresco
          createdAt: minutesAgo(25), // viejo, pero no debe usarse acá
        },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  it('sin startedAt ni createdAt, nunca es stale (no se inventa una edad)', () => {
    expect(
      isAnalysisStale({ status: 'Procesando' }, now, ANALYSIS_STALE_THRESHOLD_MS),
    ).toBe(false);
  });

  it('nunca es stale si el status ya es terminal (Finalizado), aunque startedAt sea viejo', () => {
    expect(
      isAnalysisStale(
        { status: 'Finalizado', startedAt: minutesAgo(120) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  it('nunca es stale si el status ya es terminal (Error), aunque startedAt sea viejo', () => {
    expect(
      isAnalysisStale(
        { status: 'Error', startedAt: minutesAgo(120) },
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  it('respeta un thresholdMs custom distinto del default', () => {
    expect(
      isAnalysisStale({ status: 'Procesando', startedAt: minutesAgo(3) }, now, 2 * 60 * 1000),
    ).toBe(true);
  });

  it('sin thresholdMs explícito, usa ANALYSIS_STALE_THRESHOLD_MS por default', () => {
    expect(isAnalysisStale({ status: 'Procesando', startedAt: minutesAgo(25) }, now)).toBe(true);
    expect(isAnalysisStale({ status: 'Procesando', startedAt: minutesAgo(5) }, now)).toBe(false);
  });
});
