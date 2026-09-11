import {
  computeTimeToValuePercentiles,
  hoursBetween,
  MIN_SAMPLES_FOR_P95,
} from './time-to-value.util';

describe('time-to-value.util', () => {
  describe('hoursBetween', () => {
    it('calcula horas entre dos instantes', () => {
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-01-02T12:00:00Z');
      expect(hoursBetween(from, to)).toBe(36);
    });

    it('nunca negativo cuando `to` es posterior a `from` (caso normal)', () => {
      const from = new Date('2026-01-01T00:00:00Z');
      const to = new Date('2026-01-01T00:30:00Z');
      expect(hoursBetween(from, to)).toBeCloseTo(0.5, 5);
    });
  });

  describe('computeTimeToValuePercentiles', () => {
    it('cero muestras: los tres percentiles son null, nunca 0 ni NaN', () => {
      const result = computeTimeToValuePercentiles([]);
      expect(result).toEqual({ p50: null, p75: null, p95: null });
    });

    it('una sola muestra: p50/p75 devuelven esa muestra; p95 queda null (volumen insuficiente)', () => {
      const result = computeTimeToValuePercentiles([10]);
      expect(result.p50).toBe(10);
      expect(result.p75).toBe(10);
      expect(result.p95).toBeNull();
    });

    it('el resultado nunca inventa un valor entre dos muestras (nearest-rank, no interpolación)', () => {
      const result = computeTimeToValuePercentiles([1, 2, 3, 4]);
      expect([1, 2, 3, 4]).toContain(result.p50);
      expect([1, 2, 3, 4]).toContain(result.p75);
    });

    it('p95 se calcula recién a partir de MIN_SAMPLES_FOR_P95 muestras', () => {
      const justBelow = Array.from(
        { length: MIN_SAMPLES_FOR_P95 - 1 },
        (_, i) => i + 1,
      );
      const atThreshold = Array.from(
        { length: MIN_SAMPLES_FOR_P95 },
        (_, i) => i + 1,
      );

      expect(computeTimeToValuePercentiles(justBelow).p95).toBeNull();
      expect(computeTimeToValuePercentiles(atThreshold).p95).not.toBeNull();
    });

    it('no depende del orden de entrada (ordena antes de calcular)', () => {
      const ascending = computeTimeToValuePercentiles([1, 2, 3, 4, 5]);
      const shuffled = computeTimeToValuePercentiles([5, 1, 4, 2, 3]);
      expect(shuffled).toEqual(ascending);
    });

    it('mediana de un dataset conocido (nearest-rank, 5 muestras): p50 es el 3er valor', () => {
      const result = computeTimeToValuePercentiles([10, 20, 30, 40, 50]);
      expect(result.p50).toBe(30);
    });

    it('valores negativos (completedAt antes de createdAt, dato inconsistente) no lanzan ni se filtran silenciosamente', () => {
      // No es un caso "esperado" del dominio (completedAt siempre debería ser posterior a
      // createdAt), pero el util es una función pura de agregación estadística — no le
      // corresponde a esta capa decidir qué es un dato inválido; eso lo filtra (o no) el caller.
      const result = computeTimeToValuePercentiles([-5, 10, 20]);
      expect(result.p50).toBe(10);
    });
  });
});
