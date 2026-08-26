import {
  WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
  WEEKLY_VERDICT_TOOL,
  buildWeeklyClaudeUserMessage,
  buildWeeklySystemPrompt,
} from './weekly-technical-verdict-prompt';
import { WeeklyVerdictGeneratorInput } from '../weekly-technical-verdict-generator.util';

describe('buildWeeklySystemPrompt (PR 16B)', () => {
  const prompt = buildWeeklySystemPrompt();

  it('la promptVersion queda en weekly-technical-verdict-v1', () => {
    expect(WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION).toBe(
      'weekly-technical-verdict-v1',
    );
  });

  it('pide enfocarse en el delta, no repetir el estado actual', () => {
    expect(prompt).toMatch(/qué cambió respecto de la semana anterior/i);
    expect(prompt).toMatch(
      /no vuelvas a describir en detalle el estado actual/i,
    );
  });

  it('exige trend=insufficient_data sin reporte anterior', () => {
    expect(prompt).toMatch(/previoussnapshotid es null/i);
    expect(prompt).toMatch(/trend="insufficient_data"/);
  });

  it('exige lenguaje hipotético, no afirmar causas como hecho', () => {
    expect(prompt).toMatch(/no afirmar causas agronómicas como hecho/i);
    expect(prompt).toMatch(/podría estar asociado a/i);
  });

  it('prohíbe recomendar productos/dosis/fitosanitarios', () => {
    expect(prompt).toMatch(
      /no recomendar productos, dosis, fertilización específica, fitosanitarios/i,
    );
  });

  it('mantiene la regla de no autorreferenciarse como Claude/IA/Anthropic', () => {
    expect(prompt).toMatch(
      /no mencionarte a vos mismo, a claude, a anthropic/i,
    );
  });

  it('responde exclusivamente vía la tool submit_weekly_technical_verdict', () => {
    expect(prompt).toMatch(
      /exclusivamente llamando a la herramienta submit_weekly_technical_verdict/i,
    );
  });
});

describe('WEEKLY_VERDICT_TOOL', () => {
  it('es strict y expone verdict/trend/confidence/summary/keyChanges/areasToReview/recommendations/limitations como requeridos', () => {
    expect(WEEKLY_VERDICT_TOOL.strict).toBe(true);
    expect(WEEKLY_VERDICT_TOOL.name).toBe('submit_weekly_technical_verdict');
    expect(WEEKLY_VERDICT_TOOL.input_schema.required).toEqual([
      'verdict',
      'trend',
      'confidence',
      'summary',
      'keyChanges',
      'areasToReview',
      'recommendations',
      'limitations',
    ]);
  });

  it('trend tiene su propio enum, distinto del de verdict', () => {
    const properties = WEEKLY_VERDICT_TOOL.input_schema.properties as Record<
      string,
      any
    >;

    expect(properties.trend.enum).toEqual([
      'improving',
      'stable',
      'worsening',
      'mixed',
      'insufficient_data',
    ]);
    expect(properties.verdict.enum).toEqual([
      'favorable',
      'attention',
      'critical',
      'insufficient_data',
    ]);
  });
});

describe('buildWeeklyClaudeUserMessage', () => {
  it('serializa snapshot actual, comparisonVsPrevious e individualAnalysisVerdict', () => {
    const input: WeeklyVerdictGeneratorInput = {
      fieldName: 'Campo Norte',
      weekStart: '2026-08-18',
      weekEnd: '2026-08-25',
      score: 65,
      scoreLabel: 'Atención',
      ndviMean: 0.6,
      ndmiMean: 0.2,
      dominantZone: 'Alta',
      dominantZonePercentage: 40,
      analyzedAreaHa: 100,
      lotCount: 3,
      dataQualityStatus: 'sufficient',
      hasRgbImage: true,
      hasNdviImage: true,
      hasNdmiImage: false,
      hasImageSeries: false,
      previousSnapshotId: 'snapshot-0',
      comparison: {
        previousSnapshotId: 'snapshot-0',
        previousWeekStart: '2026-08-11',
        previousWeekEnd: '2026-08-18',
        scoreDelta: 5,
        ndviMeanDelta: 0.02,
        ndmiMeanDelta: null,
        dominantZoneChanged: false,
        dominantZoneFrom: 'Alta',
        dominantZoneTo: 'Alta',
        analyzedAreaDeltaHa: 0,
        dataQualityChanged: false,
        summary: ['El score subió 5 puntos respecto de la semana anterior.'],
      },
      individualVerdict: {
        verdict: 'attention',
        confidence: 'medium',
        summary: 'Resumen del análisis individual.',
      },
    };

    const parsed = JSON.parse(buildWeeklyClaudeUserMessage(input));

    expect(parsed.fieldName).toBe('Campo Norte');
    expect(parsed.current.score).toBe(65);
    expect(parsed.current.images).toEqual({
      rgb: true,
      ndvi: true,
      ndmi: false,
      series: false,
    });
    expect(parsed.comparisonVsPrevious.scoreDelta).toBe(5);
    expect(parsed.individualAnalysisVerdict.summary).toBe(
      'Resumen del análisis individual.',
    );
  });

  it('individualAnalysisVerdict null cuando no está disponible', () => {
    const input: WeeklyVerdictGeneratorInput = {
      fieldName: null,
      weekStart: '2026-08-18',
      weekEnd: '2026-08-25',
      score: null,
      scoreLabel: null,
      ndviMean: null,
      ndmiMean: null,
      dominantZone: null,
      dominantZonePercentage: null,
      analyzedAreaHa: null,
      lotCount: null,
      dataQualityStatus: 'insufficient',
      hasRgbImage: false,
      hasNdviImage: false,
      hasNdmiImage: false,
      hasImageSeries: false,
      previousSnapshotId: null,
      comparison: {
        previousSnapshotId: null,
        previousWeekStart: null,
        previousWeekEnd: null,
        scoreDelta: null,
        ndviMeanDelta: null,
        ndmiMeanDelta: null,
        dominantZoneChanged: false,
        dominantZoneFrom: null,
        dominantZoneTo: null,
        analyzedAreaDeltaHa: null,
        dataQualityChanged: false,
        summary: [],
      },
      individualVerdict: null,
    };

    const parsed = JSON.parse(buildWeeklyClaudeUserMessage(input));

    expect(parsed.individualAnalysisVerdict).toBeNull();
  });
});
