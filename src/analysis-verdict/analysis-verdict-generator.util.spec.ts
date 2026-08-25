import {
  generateTechnicalVerdict,
  VerdictGeneratorInput,
} from './analysis-verdict-generator.util';

describe('generateTechnicalVerdict', () => {
  const buildInput = (
    overrides: Partial<VerdictGeneratorInput> = {},
  ): VerdictGeneratorInput => ({
    globalScore: 80,
    hasZoneData: true,
    ndviAverageMax: 0.7,
    ndviVariability: 'Media',
    ndmiMean: 0.3,
    ...overrides,
  });

  it('score alto (>=75) con datos → favorable', () => {
    const result = generateTechnicalVerdict(buildInput({ globalScore: 80 }));

    expect(result.verdict).toBe('favorable');
  });

  it('score medio (50-74) con datos → attention', () => {
    const result = generateTechnicalVerdict(buildInput({ globalScore: 60 }));

    expect(result.verdict).toBe('attention');
  });

  it('score bajo (<50) con datos → critical', () => {
    const result = generateTechnicalVerdict(buildInput({ globalScore: 30 }));

    expect(result.verdict).toBe('critical');
  });

  it('sin datos de zona (hasZoneData=false) → insufficient_data sin importar el score', () => {
    const result = generateTechnicalVerdict(
      buildInput({ globalScore: 95, hasZoneData: false }),
    );

    expect(result.verdict).toBe('insufficient_data');
  });

  it('insufficient_data siempre tiene confidence=low', () => {
    const result = generateTechnicalVerdict(
      buildInput({ hasZoneData: false, ndmiMean: 0.5 }),
    );

    expect(result.confidence).toBe('low');
  });

  it('con score+NDVI+NDMI (ndmiMean presente) → confidence=high', () => {
    const result = generateTechnicalVerdict(
      buildInput({ globalScore: 80, ndmiMean: 0.4 }),
    );

    expect(result.confidence).toBe('high');
  });

  it('con score+NDVI pero sin NDMI (ndmiMean null) → confidence=medium', () => {
    const result = generateTechnicalVerdict(
      buildInput({ globalScore: 80, ndmiMean: null }),
    );

    expect(result.confidence).toBe('medium');
  });

  it.each<[VerdictGeneratorInput['globalScore'], boolean]>([
    [80, true],
    [60, true],
    [30, true],
  ])('siempre incluye limitaciones no vacías (score=%s)', (globalScore) => {
    const result = generateTechnicalVerdict(buildInput({ globalScore }));

    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it('insufficient_data también incluye limitaciones no vacías', () => {
    const result = generateTechnicalVerdict(buildInput({ hasZoneData: false }));

    expect(result.limitations.length).toBeGreaterThan(0);
  });

  it.each<VerdictGeneratorInput['globalScore']>([80, 60, 30])(
    'con datos suficientes, ningún array queda vacío (score=%s)',
    (globalScore) => {
      const result = generateTechnicalVerdict(buildInput({ globalScore }));

      expect(result.keyFindings.length).toBeGreaterThan(0);
      expect(result.possibleCauses.length).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.limitations.length).toBeGreaterThan(0);
    },
  );

  it('insufficient_data no inventa causas (possibleCauses vacío)', () => {
    const result = generateTechnicalVerdict(buildInput({ hasZoneData: false }));

    expect(result.possibleCauses).toEqual([]);
  });

  it('no menciona productos químicos ni diagnósticos de enfermedades específicas', () => {
    const forbidden = [
      'glifosato',
      'fungicida',
      'herbicida',
      'plaguicida',
      'roya',
      'tizón',
    ];

    for (const globalScore of [80, 60, 30]) {
      const result = generateTechnicalVerdict(buildInput({ globalScore }));
      const allText = [
        result.summary,
        ...result.keyFindings,
        ...result.possibleCauses,
        ...result.recommendations,
        ...result.limitations,
      ]
        .join(' ')
        .toLowerCase();

      for (const term of forbidden) {
        expect(allText).not.toContain(term);
      }
    }
  });
});
