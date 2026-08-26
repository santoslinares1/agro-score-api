import { AnalysisTechnicalVerdictResponse } from '../../analysis-verdict/dto/analysis-technical-verdict.dto';
import {
  ScheduledAnalysisEmailParams,
  buildScheduledAnalysisEmail,
} from './scheduled-analysis-report.template';

describe('buildScheduledAnalysisEmail', () => {
  const baseParams: ScheduledAnalysisEmailParams = {
    userName: 'Ana Productora',
    fieldName: 'Campo San José',
    weekStart: '2026-08-17',
    weekEnd: '2026-08-24',
    analysisUrl: 'https://app.agroscore.test/app/analysis/analysis-1',
    reportUrl: 'https://app.agroscore.test/app/analysis/analysis-1/report',
    dataQualityStatus: 'sufficient',
    hasRgbImage: true,
    hasNdviImage: true,
    hasNdmiImage: true,
    hasImageSeries: false,
    summary: [
      'El score subió 4 puntos respecto de la semana anterior.',
      'NDVI promedio estable.',
    ],
  };

  const buildTechnicalVerdict = (
    overrides: Partial<AnalysisTechnicalVerdictResponse> = {},
  ): AnalysisTechnicalVerdictResponse => ({
    status: 'generated',
    verdict: 'attention',
    confidence: 'medium',
    summary: 'El campo muestra variabilidad relevante entre zonas.',
    keyFindings: [
      'Zona Alta concentra la mayor superficie.',
      'Variabilidad interna moderada.',
    ],
    possibleCauses: [],
    recommendations: [
      'Revisar riego diferencial en los sectores de menor respuesta.',
    ],
    limitations: ['Cobertura satelital parcial en el período.'],
    generatedAt: '2026-08-24T12:00:00.000Z',
    generator: 'claude-technical-verdict',
    promptVersion: 'technical-verdict-v1',
    ...overrides,
  });

  it('muestra la semana analizada con fechas reales, no una promesa genérica de "N días"', () => {
    const email = buildScheduledAnalysisEmail(baseParams);

    expect(email.html).toContain('17/08/2026 — 24/08/2026');
    expect(email.text).toContain('17/08/2026 — 24/08/2026');
  });

  it('renderiza cada línea del summary de comparación tal cual viene, sin agregar contenido propio', () => {
    const email = buildScheduledAnalysisEmail(baseParams);

    for (const line of baseParams.summary) {
      expect(email.html).toContain(line);
      expect(email.text).toContain(line);
    }
  });

  it('muestra disponibilidad real de RGB/NDVI/NDMI/evolución — nunca "disponible" si el flag es false', () => {
    const email = buildScheduledAnalysisEmail({
      ...baseParams,
      hasRgbImage: false,
      hasNdviImage: true,
      hasNdmiImage: false,
      hasImageSeries: false,
    });

    expect(email.text).toContain('RGB: no disponible');
    expect(email.text).toContain('NDVI: disponible');
    expect(email.text).toContain('NDMI: no disponible');
    expect(email.text).toContain('Evolución semanal: no disponible');
  });

  it('no promete "PDF completo con todas las imágenes" — nunca esa frase en el copy', () => {
    const email = buildScheduledAnalysisEmail({
      ...baseParams,
      hasRgbImage: false,
      hasNdviImage: false,
      hasNdmiImage: false,
    });

    expect(email.html.toLowerCase()).not.toContain(
      'pdf completo con todas las imágenes',
    );
  });

  it('muestra la calidad del reporte (sufficient/partial/insufficient) en español legible', () => {
    const sufficient = buildScheduledAnalysisEmail({
      ...baseParams,
      dataQualityStatus: 'sufficient',
    });
    const partial = buildScheduledAnalysisEmail({
      ...baseParams,
      dataQualityStatus: 'partial',
    });
    const insufficient = buildScheduledAnalysisEmail({
      ...baseParams,
      dataQualityStatus: 'insufficient',
    });

    expect(sufficient.text).toContain('Calidad del reporte: Suficiente');
    expect(partial.text).toContain('Calidad del reporte: Parcial');
    expect(insufficient.text).toContain('Calidad del reporte: Insuficiente');
  });

  it('escapa fieldName en el HTML (sin XSS)', () => {
    const email = buildScheduledAnalysisEmail({
      ...baseParams,
      fieldName: '<script>alert(1)</script>',
    });

    expect(email.html).not.toContain('<script>alert(1)</script>');
  });

  it('sin userName usa un saludo genérico', () => {
    const email = buildScheduledAnalysisEmail({
      ...baseParams,
      userName: null,
    });

    expect(email.text.startsWith('Hola,')).toBe(true);
  });

  it('incluye el link al análisis', () => {
    const email = buildScheduledAnalysisEmail(baseParams);

    expect(email.text).toContain(baseParams.analysisUrl);
  });

  describe('Veredicto técnico (PR 12A)', () => {
    it('status generated: renderiza "Veredicto técnico" con verdict/confidence mapeados en HTML y text', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          verdict: 'attention',
          confidence: 'medium',
        }),
      });

      for (const content of [email.html, email.text]) {
        expect(content).toContain('Veredicto técnico');
        expect(content).toContain('Requiere atención');
        expect(content).toContain('Media');
      }
    });

    it('renderiza el summary', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          summary: 'Resumen técnico de la semana.',
        }),
      });

      expect(email.html).toContain('Resumen técnico de la semana.');
      expect(email.text).toContain('Resumen técnico de la semana.');
    });

    it('renderiza keyFindings, recommendations y limitations', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict(),
      });

      for (const content of [email.html, email.text]) {
        expect(content).toContain('Hallazgos principales');
        expect(content).toContain('Zona Alta concentra la mayor superficie.');
        expect(content).toContain('Recomendaciones');
        expect(content).toContain(
          'Revisar riego diferencial en los sectores de menor respuesta.',
        );
        expect(content).toContain('Limitaciones');
        expect(content).toContain('Cobertura satelital parcial en el período.');
      }
    });

    it('renderiza possibleCauses cuando vienen, y no muestra el subtítulo cuando el array viene vacío', () => {
      const withCauses = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          possibleCauses: ['Baja disponibilidad hídrica en el sector norte.'],
        }),
      });
      expect(withCauses.html).toContain('Posibles causas');
      expect(withCauses.text).toContain(
        'Baja disponibilidad hídrica en el sector norte.',
      );

      const withoutCauses = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({ possibleCauses: [] }),
      });
      expect(withoutCauses.html).not.toContain('Posibles causas');
      expect(withoutCauses.text).not.toContain('Posibles causas');
    });

    it('no deja "undefined"/"null" ni bullets vacíos en HTML ni text', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          possibleCauses: [],
          keyFindings: [],
          recommendations: [],
          limitations: [],
        }),
      });

      expect(email.html).not.toContain('undefined');
      expect(email.html.toLowerCase()).not.toContain('>null<');
      expect(email.text).not.toContain('undefined');
      expect(email.text).not.toContain('- \n');
    });

    it('technicalVerdict null u omitido: no renderiza la sección', () => {
      const withNull = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: null,
      });
      const omitted = buildScheduledAnalysisEmail(baseParams);

      for (const email of [withNull, omitted]) {
        expect(email.html).not.toContain('Veredicto técnico');
        expect(email.text).not.toContain('Veredicto técnico');
        // El resto del mail sigue intacto.
        expect(email.text).toContain('Resumen:');
        expect(email.text).toContain('Disponibilidad de datos:');
      }
    });

    it('technicalVerdict pending: omite la sección (nunca se manda con un estado "esperando")', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          status: 'pending',
          verdict: null,
          confidence: null,
          summary: null,
          keyFindings: [],
          possibleCauses: [],
          recommendations: [],
          limitations: [],
        }),
      });

      expect(email.html).not.toContain('Veredicto técnico');
      expect(email.text).not.toContain('Veredicto técnico');
    });

    it('technicalVerdict failed: muestra un aviso sobrio, sin listas', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          status: 'failed',
          verdict: null,
          confidence: null,
          summary: null,
          keyFindings: [],
          possibleCauses: [],
          recommendations: [],
          limitations: [],
        }),
      });

      expect(email.html).toContain('Veredicto técnico');
      expect(email.html).toContain(
        'El análisis satelital finalizó correctamente, pero no se pudo generar el veredicto técnico automático.',
      );
      expect(email.text).toContain(
        'El análisis satelital finalizó correctamente, pero no se pudo generar el veredicto técnico automático.',
      );
      expect(email.html).not.toContain('Hallazgos principales');
      expect(email.text).not.toContain('Hallazgos principales');
    });

    it('nunca menciona Claude/Anthropic/IA/chatbot, en ningún estado', () => {
      const states: Array<AnalysisTechnicalVerdictResponse | null | undefined> =
        [
          buildTechnicalVerdict({ status: 'generated' }),
          buildTechnicalVerdict({
            status: 'failed',
            verdict: null,
            confidence: null,
            summary: null,
            keyFindings: [],
            possibleCauses: [],
            recommendations: [],
            limitations: [],
          }),
          buildTechnicalVerdict({
            status: 'pending',
            verdict: null,
            confidence: null,
            summary: null,
            keyFindings: [],
            possibleCauses: [],
            recommendations: [],
            limitations: [],
          }),
          null,
          undefined,
        ];

      for (const technicalVerdict of states) {
        const email = buildScheduledAnalysisEmail({
          ...baseParams,
          technicalVerdict,
        });

        for (const content of [email.html, email.text]) {
          expect(content.toLowerCase()).not.toContain('claude');
          expect(content.toLowerCase()).not.toContain('anthropic');
          expect(content.toLowerCase()).not.toContain('chatbot');
          expect(/\bia\b/i.test(content)).toBe(false);
        }
      }
    });

    it('nunca expone generator/promptVersion/generatedAt/errorMessage, aunque vengan en el objeto', () => {
      const technicalVerdict = buildTechnicalVerdict({
        generator: 'claude-technical-verdict',
        promptVersion: 'technical-verdict-v1',
        generatedAt: '2026-08-24T12:00:00.000Z',
      });
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict,
      });

      for (const content of [email.html, email.text]) {
        expect(content).not.toContain('claude-technical-verdict');
        expect(content).not.toContain('technical-verdict-v1');
        expect(content).not.toContain('2026-08-24T12:00:00.000Z');
      }
    });

    it('escapa el contenido del veredicto en HTML (sin XSS)', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict({
          summary: '<script>alert(1)</script>',
          keyFindings: ['<img src=x onerror=alert(1)>'],
        }),
      });

      expect(email.html).not.toContain('<script>alert(1)</script>');
      expect(email.html).not.toContain('<img src=x onerror=alert(1)>');
    });

    it('incluye el disclaimer de veredicto automático cuando status=generated', () => {
      const email = buildScheduledAnalysisEmail({
        ...baseParams,
        technicalVerdict: buildTechnicalVerdict(),
      });

      const disclaimer =
        'Veredicto técnico generado automáticamente a partir del análisis satelital. Debe validarse con observación en campo.';
      expect(email.html).toContain(disclaimer);
      expect(email.text).toContain(disclaimer);
    });
  });
});
