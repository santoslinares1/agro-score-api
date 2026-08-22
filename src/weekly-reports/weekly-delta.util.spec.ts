import { computeDeltaDirection, DEFAULT_DELTA_THRESHOLD } from './weekly-delta.util';

describe('computeDeltaDirection', () => {
  it('devuelve null si el delta es null/undefined', () => {
    expect(computeDeltaDirection(null)).toBeNull();
    expect(computeDeltaDirection(undefined)).toBeNull();
  });

  it('devuelve "up" si el delta supera el umbral', () => {
    expect(computeDeltaDirection(0.05)).toBe('up');
  });

  it('devuelve "down" si el delta es menor a -umbral', () => {
    expect(computeDeltaDirection(-0.05)).toBe('down');
  });

  it('devuelve "stable" dentro del umbral (inclusive en los bordes)', () => {
    expect(computeDeltaDirection(0)).toBe('stable');
    expect(computeDeltaDirection(DEFAULT_DELTA_THRESHOLD)).toBe('stable');
    expect(computeDeltaDirection(-DEFAULT_DELTA_THRESHOLD)).toBe('stable');
  });

  it('acepta un umbral configurable distinto del default', () => {
    expect(computeDeltaDirection(0.02, 0.01)).toBe('up');
    expect(computeDeltaDirection(0.02, 0.05)).toBe('stable');
  });
});
