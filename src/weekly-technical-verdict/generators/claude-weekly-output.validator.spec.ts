import { validateAndNormalizeGeneratedWeeklyVerdict } from './claude-weekly-output.validator';

describe('validateAndNormalizeGeneratedWeeklyVerdict', () => {
  const validRaw = {
    verdict: 'attention',
    trend: 'stable',
    confidence: 'medium',
    summary: 'Resumen semanal válido.',
    keyChanges: ['cambio 1', 'cambio 2'],
    areasToReview: ['zona 1'],
    recommendations: ['recomendación 1'],
    limitations: ['limitación 1'],
  };

  it('parsea y devuelve un objeto válido tal cual cuando el JSON ya es correcto', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict(validRaw);

    expect(result).toEqual(validRaw);
  });

  it.each([null, undefined, 'texto libre', 42, []])(
    'rechaza output que no es un objeto (%p)',
    (raw) => {
      expect(() => validateAndNormalizeGeneratedWeeklyVerdict(raw)).toThrow();
    },
  );

  it('rechaza un verdict fuera del enum permitido', () => {
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({
        ...validRaw,
        verdict: 'muy_bueno',
      }),
    ).toThrow(/verdict/i);
  });

  it('rechaza un trend fuera del enum permitido (distinto del enum de verdict)', () => {
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({
        ...validRaw,
        trend: 'attention',
      }),
    ).toThrow(/trend/i);
  });

  it('rechaza un confidence fuera del enum permitido', () => {
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({
        ...validRaw,
        confidence: 'altísima',
      }),
    ).toThrow(/confidence/i);
  });

  it('rechaza un summary vacío o ausente', () => {
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({ ...validRaw, summary: '' }),
    ).toThrow(/summary/i);
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({
        ...validRaw,
        summary: undefined,
      }),
    ).toThrow(/summary/i);
  });

  it('normaliza arrays faltantes o mal tipados a [] en vez de fallar', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict({
      ...validRaw,
      keyChanges: undefined,
      areasToReview: 'no es un array',
      recommendations: [1, 2, 3],
    });

    expect(result.keyChanges).toEqual([]);
    expect(result.areasToReview).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it('limita cada array a ARRAY_MAX_ITEMS (6) items', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict({
      ...validRaw,
      keyChanges: Array.from({ length: 20 }, (_, i) => `cambio ${i}`),
    });

    expect(result.keyChanges).toHaveLength(6);
  });

  it('limita limitations a LIMITATIONS_MAX_ITEMS (5) items', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict({
      ...validRaw,
      limitations: Array.from({ length: 20 }, (_, i) => `limitación ${i}`),
    });

    expect(result.limitations).toHaveLength(5);
  });

  it('trunca summary a SUMMARY_MAX_LENGTH (1200) caracteres', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict({
      ...validRaw,
      summary: 'x'.repeat(5000),
    });

    expect(result.summary.length).toBe(1200);
  });

  it.each([
    ['claude', 'Este diagnóstico fue generado por Claude.'],
    ['anthropic', 'Servicio provisto por Anthropic.'],
    ['ia', 'Este resultado usa IA para interpretar los datos.'],
  ])(
    'rechaza el output si menciona un término prohibido (%s)',
    (_label, summary) => {
      expect(() =>
        validateAndNormalizeGeneratedWeeklyVerdict({ ...validRaw, summary }),
      ).toThrow(/prohibido/i);
    },
  );

  it.each([
    'hay estrés hídrico',
    'la causa es compactación',
    'se debe a una plaga',
  ])(
    'rechaza lenguaje demasiado afirmativo sobre causas agronómicas: "%s"',
    (summary) => {
      expect(() =>
        validateAndNormalizeGeneratedWeeklyVerdict({ ...validRaw, summary }),
      ).toThrow(/afirmativo/i);
    },
  );

  it('acepta lenguaje hipotético/hedgeado', () => {
    const result = validateAndNormalizeGeneratedWeeklyVerdict({
      ...validRaw,
      summary:
        'Podría estar asociado a diferencias de humedad respecto de la semana anterior.',
    });

    expect(result.summary).toContain('Podría estar asociado');
  });

  it('detecta el término prohibido/afirmativo aunque esté en areasToReview, no solo en summary', () => {
    expect(() =>
      validateAndNormalizeGeneratedWeeklyVerdict({
        ...validRaw,
        areasToReview: ['La causa es un manejo de riego inadecuado.'],
      }),
    ).toThrow(/afirmativo/i);
  });
});
