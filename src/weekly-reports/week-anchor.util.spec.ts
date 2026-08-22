import { computeWeekAnchorDate } from './week-anchor.util';

// Espejo de tests/test_weekly.py::test_week_anchor_date_* en agro-score-worker (Fase 1) — mismos
// casos, para confirmar que el puerto TypeScript se comporta igual que la función Python que
// weekly.py usa para calcular la grilla semanal.
describe('computeWeekAnchorDate', () => {
  const campaignStart = '2025-10-01';

  it('devuelve campaignStart si targetDate es igual', () => {
    expect(computeWeekAnchorDate(campaignStart, campaignStart)).toBe(campaignStart);
  });

  it('+3 días redondea hacia atrás (semana 0)', () => {
    expect(computeWeekAnchorDate(campaignStart, '2025-10-04')).toBe('2025-10-01');
  });

  it('+4 días redondea hacia adelante (semana 1)', () => {
    expect(computeWeekAnchorDate(campaignStart, '2025-10-05')).toBe('2025-10-08');
  });

  it('+8 días cae en semana 1', () => {
    expect(computeWeekAnchorDate(campaignStart, '2025-10-09')).toBe('2025-10-08');
  });

  it('fecha anterior a campaignStart, cerca, redondea a semana 0 (no clampea)', () => {
    expect(computeWeekAnchorDate(campaignStart, '2025-09-28')).toBe('2025-10-01');
  });

  it('fecha bien anterior a campaignStart cae en una semana negativa real', () => {
    expect(computeWeekAnchorDate(campaignStart, '2025-09-24')).toBe('2025-09-24');
  });

  it('dos corridas dentro de la misma semana de campaña producen el mismo anchor', () => {
    const run1 = computeWeekAnchorDate(campaignStart, '2025-10-02');
    const run2 = computeWeekAnchorDate(campaignStart, '2025-10-04');
    expect(run1).toBe(run2);
  });
});
