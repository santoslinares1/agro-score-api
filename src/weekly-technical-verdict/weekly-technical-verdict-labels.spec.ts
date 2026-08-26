import {
  confidenceLabel,
  trendLabel,
  verdictLabel,
} from './weekly-technical-verdict-labels';

describe('weekly-technical-verdict-labels (PR 16C)', () => {
  it('mapea cada verdict al mismo label que analysis-verdict-labels.ts', () => {
    expect(verdictLabel('favorable')).toBe('Favorable');
    expect(verdictLabel('attention')).toBe('Requiere atención');
    expect(verdictLabel('critical')).toBe('Crítico');
    expect(verdictLabel('insufficient_data')).toBe('Datos insuficientes');
    expect(verdictLabel(null)).toBe('No disponible');
  });

  it('mapea cada confidence al mismo label que analysis-verdict-labels.ts', () => {
    expect(confidenceLabel('low')).toBe('Baja');
    expect(confidenceLabel('medium')).toBe('Media');
    expect(confidenceLabel('high')).toBe('Alta');
    expect(confidenceLabel(null)).toBe('');
  });

  it('mapea cada trend a su label (sin equivalente en el veredicto individual)', () => {
    expect(trendLabel('improving')).toBe('En mejora');
    expect(trendLabel('stable')).toBe('Estable');
    expect(trendLabel('worsening')).toBe('En deterioro');
    expect(trendLabel('mixed')).toBe('Mixta');
    expect(trendLabel('insufficient_data')).toBe('Datos insuficientes');
    expect(trendLabel(null)).toBe('No disponible');
  });
});
