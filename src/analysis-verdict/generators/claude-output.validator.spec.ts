import {
  VerdictSafetyValidationError,
  validateAndNormalizeGeneratedVerdict,
} from './claude-output.validator';

describe('validateAndNormalizeGeneratedVerdict', () => {
  const validRaw = {
    verdict: 'attention',
    confidence: 'medium',
    summary: 'Resumen técnico válido.',
    keyFindings: ['hallazgo 1', 'hallazgo 2'],
    possibleCauses: ['posible causa 1'],
    recommendations: ['recomendación 1'],
    limitations: ['limitación 1'],
  };

  it('parsea y devuelve un objeto válido tal cual cuando el JSON ya es correcto', () => {
    const result = validateAndNormalizeGeneratedVerdict(validRaw);

    expect(result).toEqual(validRaw);
  });

  it.each([null, undefined, 'texto libre', 42, []])(
    'rechaza output que no es un objeto (%p)',
    (raw) => {
      expect(() => validateAndNormalizeGeneratedVerdict(raw)).toThrow();
    },
  );

  it('rechaza un verdict fuera del enum permitido', () => {
    expect(() =>
      validateAndNormalizeGeneratedVerdict({
        ...validRaw,
        verdict: 'muy_bueno',
      }),
    ).toThrow(/verdict/i);
  });

  it('PR 17: un verdict fuera de enum NUNCA es VerdictSafetyValidationError (error de forma, no de estilo — no reintentable)', () => {
    expect.assertions(1);
    try {
      validateAndNormalizeGeneratedVerdict({ ...validRaw, verdict: 'muy_bueno' });
    } catch (error) {
      expect(error).not.toBeInstanceOf(VerdictSafetyValidationError);
    }
  });

  it('rechaza un confidence fuera del enum permitido', () => {
    expect(() =>
      validateAndNormalizeGeneratedVerdict({
        ...validRaw,
        confidence: 'altísima',
      }),
    ).toThrow(/confidence/i);
  });

  it('rechaza un summary vacío o ausente', () => {
    expect(() =>
      validateAndNormalizeGeneratedVerdict({ ...validRaw, summary: '' }),
    ).toThrow(/summary/i);
    expect(() =>
      validateAndNormalizeGeneratedVerdict({ ...validRaw, summary: undefined }),
    ).toThrow(/summary/i);
  });

  it('normaliza arrays faltantes o mal tipados a [] en vez de fallar', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      keyFindings: undefined,
      possibleCauses: 'no es un array',
      recommendations: [1, 2, 3],
    });

    expect(result.keyFindings).toEqual([]);
    expect(result.possibleCauses).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });

  it('limita cada array a ARRAY_MAX_ITEMS (6) items, descartando el resto', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      keyFindings: Array.from({ length: 20 }, (_, i) => `hallazgo ${i}`),
    });

    expect(result.keyFindings).toHaveLength(6);
  });

  it('limita limitations a LIMITATIONS_MAX_ITEMS (5) items', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      limitations: Array.from({ length: 20 }, (_, i) => `limitación ${i}`),
    });

    expect(result.limitations).toHaveLength(5);
  });

  it('trunca summary a SUMMARY_MAX_LENGTH (1200) caracteres', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      summary: 'x'.repeat(5000),
    });

    expect(result.summary.length).toBe(1200);
  });

  it('trunca cada item de array a ITEM_MAX_LENGTH (300) caracteres', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      keyFindings: ['y'.repeat(1000)],
    });

    expect(result.keyFindings[0].length).toBe(300);
  });

  it.each([
    ['claude', 'Este análisis fue generado por Claude.'],
    ['anthropic', 'Servicio provisto por Anthropic.'],
    ['chatbot', 'Consultá con nuestro chatbot para más detalles.'],
    ['inteligencia artificial', 'Generado con inteligencia artificial.'],
    ['ia standalone', 'Este resultado usa IA para interpretar los datos.'],
  ])(
    'rechaza el output si el texto menciona un término prohibido (%s)',
    (_label, summary) => {
      expect(() =>
        validateAndNormalizeGeneratedVerdict({ ...validRaw, summary }),
      ).toThrow(/prohibido/i);
    },
  );

  it('no genera falsos positivos con palabras españolas que contienen "ia" como substring', () => {
    const result = validateAndNormalizeGeneratedVerdict({
      ...validRaw,
      summary:
        'La historia del lote muestra buena vigencia y compañía de zonas de riego, sin variabilidad relevante.',
    });

    expect(result.summary).toContain('historia');
  });

  it('detecta el término prohibido aunque esté en un item de array, no solo en summary', () => {
    expect(() =>
      validateAndNormalizeGeneratedVerdict({
        ...validRaw,
        recommendations: ['Consultar con Claude para más información.'],
      }),
    ).toThrow(/prohibido/i);
  });

  it('PR 17: término prohibido tira VerdictSafetyValidationError con reason=forbidden_terms', () => {
    expect.assertions(2);
    try {
      validateAndNormalizeGeneratedVerdict({
        ...validRaw,
        summary: 'Este análisis fue generado por Claude.',
      });
    } catch (error) {
      expect(error).toBeInstanceOf(VerdictSafetyValidationError);
      expect((error as VerdictSafetyValidationError).reason).toBe(
        'forbidden_terms',
      );
    }
  });

  describe('lenguaje afirmativo sobre causas agronómicas (PR 14A)', () => {
    it.each([
      'hay estrés hídrico',
      'presenta estrés hídrico',
      'existe estrés hídrico',
      'hay déficit hídrico',
      'déficit de humedad en el suelo',
      'la causa es compactación',
      'el problema es la falta de riego',
      'se debe a una plaga',
      'hay compactación',
      'hay plaga',
      'hay enfermedad',
      'hay deficiencia nutricional',
      'el lote tiene compactación',
    ])(
      'rechaza el output si el texto afirma una causa como hecho: "%s"',
      (summary) => {
        expect(() =>
          validateAndNormalizeGeneratedVerdict({ ...validRaw, summary }),
        ).toThrow(/afirmativo/i);
      },
    );

    it.each([
      'posibles señales compatibles con menor disponibilidad hídrica',
      'podría estar asociado a diferencias de humedad',
      'validar en campo si existe compactación',
      'descartar plagas o enfermedades con observación en campo',
      'posibles señales compatibles con estrés hídrico',
      'podría estar asociado a estrés hídrico',
      'validar si existe compactación',
      'descartar plagas o enfermedades en campo',
    ])('acepta lenguaje hipotético/hedgeado: "%s"', (summary) => {
      expect(() =>
        validateAndNormalizeGeneratedVerdict({ ...validRaw, summary }),
      ).not.toThrow();
    });

    it('detecta la afirmación aunque esté en un item de array, no solo en summary', () => {
      expect(() =>
        validateAndNormalizeGeneratedVerdict({
          ...validRaw,
          possibleCauses: ['La causa es un manejo de riego inadecuado.'],
        }),
      ).toThrow(/afirmativo/i);
    });

    it('PR 17: causa afirmativa tira VerdictSafetyValidationError con reason=unhedged_causal_claim', () => {
      expect.assertions(2);
      try {
        validateAndNormalizeGeneratedVerdict({
          ...validRaw,
          summary: 'hay estrés hídrico',
        });
      } catch (error) {
        expect(error).toBeInstanceOf(VerdictSafetyValidationError);
        expect((error as VerdictSafetyValidationError).reason).toBe(
          'unhedged_causal_claim',
        );
      }
    });

    it('no bloquea "compactación"/"plaga"/"enfermedad" cuando no siguen a un verbo afirmativo', () => {
      const result = validateAndNormalizeGeneratedVerdict({
        ...validRaw,
        summary:
          'Zonas con menor vigor podrían estar asociadas a compactación, plaga o enfermedad — se sugiere descartarlas con observación en campo.',
      });

      expect(result.summary).toContain('compactación');
    });
  });
});
