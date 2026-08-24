import { ScheduledAnalysisEmailParams, buildScheduledAnalysisEmail } from './scheduled-analysis-report.template';

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
    summary: ['El score subió 4 puntos respecto de la semana anterior.', 'NDVI promedio estable.'],
  };

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
    const email = buildScheduledAnalysisEmail({ ...baseParams, hasRgbImage: false, hasNdviImage: false, hasNdmiImage: false });

    expect(email.html.toLowerCase()).not.toContain('pdf completo con todas las imágenes');
  });

  it('muestra la calidad del reporte (sufficient/partial/insufficient) en español legible', () => {
    const sufficient = buildScheduledAnalysisEmail({ ...baseParams, dataQualityStatus: 'sufficient' });
    const partial = buildScheduledAnalysisEmail({ ...baseParams, dataQualityStatus: 'partial' });
    const insufficient = buildScheduledAnalysisEmail({ ...baseParams, dataQualityStatus: 'insufficient' });

    expect(sufficient.text).toContain('Calidad del reporte: Suficiente');
    expect(partial.text).toContain('Calidad del reporte: Parcial');
    expect(insufficient.text).toContain('Calidad del reporte: Insuficiente');
  });

  it('escapa fieldName en el HTML (sin XSS)', () => {
    const email = buildScheduledAnalysisEmail({ ...baseParams, fieldName: '<script>alert(1)</script>' });

    expect(email.html).not.toContain('<script>alert(1)</script>');
  });

  it('sin userName usa un saludo genérico', () => {
    const email = buildScheduledAnalysisEmail({ ...baseParams, userName: null });

    expect(email.text.startsWith('Hola,')).toBe(true);
  });

  it('incluye el link al análisis', () => {
    const email = buildScheduledAnalysisEmail(baseParams);

    expect(email.text).toContain(baseParams.analysisUrl);
  });
});
