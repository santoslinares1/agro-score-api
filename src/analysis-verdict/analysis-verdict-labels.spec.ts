import { confidenceLabel, verdictLabel } from './analysis-verdict-labels';

describe('analysis-verdict-labels (PR 12A)', () => {
  it('mapea cada verdict al mismo label que analysis-result.component.ts / report-pdf.helpers.ts', () => {
    expect(verdictLabel('favorable')).toBe('Favorable');
    expect(verdictLabel('attention')).toBe('Requiere atención');
    expect(verdictLabel('critical')).toBe('Crítico');
    expect(verdictLabel('insufficient_data')).toBe('Datos insuficientes');
    expect(verdictLabel(null)).toBe('No disponible');
  });

  it('mapea cada confidence al mismo label que analysis-result.component.ts / report-pdf.helpers.ts', () => {
    expect(confidenceLabel('low')).toBe('Baja');
    expect(confidenceLabel('medium')).toBe('Media');
    expect(confidenceLabel('high')).toBe('Alta');
    expect(confidenceLabel(null)).toBe('');
  });
});
