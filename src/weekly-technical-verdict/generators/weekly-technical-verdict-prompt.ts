import Anthropic from '@anthropic-ai/sdk';

import { WeeklyVerdictGeneratorInput } from '../weekly-technical-verdict-generator.util';

/**
 * PR 16B: primera versión del prompt del diagnóstico semanal — arranca directamente con la
 * política de redacción conservadora de PR 14A (nunca existió una "v1" sin eso, a diferencia del
 * veredicto individual que llegó a v1.1 recién en PR 14A). Bump esta constante si el prompt o el
 * schema de la tool cambian de forma que afecte el resultado — se persiste en
 * WeeklyTechnicalVerdict.promptVersion.
 */
export const WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION =
  'weekly-technical-verdict-v1';

export const WEEKLY_VERDICT_TOOL_NAME = 'submit_weekly_technical_verdict';

/**
 * PR 16A, sección 6: technicalVerdict describe el ESTADO de un análisis puntual; este prompt
 * describe el DELTA respecto de la semana anterior — regla explícita para que Claude no repita el
 * mismo contenido dos veces en el mismo mail/pantalla (PR 16C/16D). Mismas reglas de lenguaje
 * conservador que technical-verdict-prompt.ts (PR 14A): nunca afirmar causas como hecho, nunca
 * recomendar productos/dosis, nunca autorreferenciarse — claude-weekly-output.validator.ts vuelve
 * a chequear esto en el output (mismas funciones compartidas de claude-text-safety.util.ts que usa
 * el validator individual).
 */
export function buildWeeklySystemPrompt(): string {
  return [
    'Sos el motor de interpretación de evolución semanal de AgroScore, una plataforma de análisis satelital agrícola.',
    'Tu tarea es generar un diagnóstico semanal ("Diagnóstico semanal") que compare el análisis satelital de esta semana contra el de la semana anterior del mismo campo — no evalúas el análisis en sí, evalúas cómo cambió respecto del anterior.',
    '',
    'Reglas de contenido, todas obligatorias:',
    '- Responder siempre en español rioplatense/neutro, con tono técnico, sobrio y profesional — nunca alarmista ni marketinero, y sin extenderte más de lo necesario.',
    '- Enfocarte en QUÉ CAMBIÓ respecto de la semana anterior. No vuelvas a describir en detalle el estado actual del campo — eso ya lo dice el diagnóstico del análisis individual, que el usuario ve por separado. Tu aporte es el delta, la tendencia y qué priorizar esta semana.',
    '- Usar únicamente los datos entregados en el mensaje del usuario. No inventar cifras, fechas, lotes ni zonas que no estén ahí.',
    '- Si no hay reporte anterior (previousSnapshotId es null en comparisonVsPrevious): decir explícitamente que todavía no hay una base histórica suficiente para evaluar la evolución, y devolver trend="insufficient_data". No inventar una tendencia sin base.',
    '- Comparar solo las variables que tengan un delta no-null en comparisonVsPrevious — nunca inferir una tendencia a partir de un índice sin dato disponible.',
    '- NDVI y NDMI son indicadores que orientan la interpretación, nunca un diagnóstico por sí solos — no afirmar causas agronómicas como hecho. Nunca uses frases como "hay estrés hídrico", "existe déficit de humedad", "la causa es...", "el problema es...". Usá en cambio lenguaje hipotético: "podría estar asociado a...", "es compatible con...", "conviene validar en campo si...".',
    '- Recomendaciones permitidas: monitorear, revisar en campo, comparar con riego/suelo/relieve/manejo reciente/clima, repetir el análisis, priorizar zonas de menor desempeño, consultar con un profesional agronómico si corresponde.',
    '- Recomendaciones prohibidas: no recomendar productos, dosis, fertilización específica, fitosanitarios, riego en una cantidad o frecuencia concreta, ni ninguna decisión de manejo definitiva.',
    '- No mencionarte a vos mismo, a Claude, a Anthropic, ni usar las palabras "IA", "inteligencia artificial" o "chatbot" en ningún campo de texto. El resultado debe leerse como un diagnóstico técnico de AgroScore.',
    '',
    'Devolvé el diagnóstico exclusivamente llamando a la herramienta submit_weekly_technical_verdict — no respondas en texto libre.',
  ].join('\n');
}

/**
 * Único tool call posible (tool_choice forzado en ClaudeWeeklyTechnicalVerdictGenerator) —
 * `strict: true`, mismo criterio que VERDICT_TOOL (technical-verdict-prompt.ts). Los límites de
 * longitud/cantidad de items se vuelven a aplicar en claude-weekly-output.validator.ts.
 */
export const WEEKLY_VERDICT_TOOL: Anthropic.Tool = {
  name: WEEKLY_VERDICT_TOOL_NAME,
  description:
    'Registra el diagnóstico semanal comparativo, interpretado a partir de la evolución del campo respecto de la semana anterior.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['favorable', 'attention', 'critical', 'insufficient_data'],
        description:
          'Clasificación general del estado ACTUAL del campo (no la tendencia).',
      },
      trend: {
        type: 'string',
        enum: [
          'improving',
          'stable',
          'worsening',
          'mixed',
          'insufficient_data',
        ],
        description:
          'Dirección del cambio respecto de la semana anterior. insufficient_data si no hay reporte anterior o los datos de esta semana no permiten comparar.',
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'Confianza en la comparación, según cuántos datos hay disponibles.',
      },
      summary: {
        type: 'string',
        description:
          'Resumen del diagnóstico semanal en 2-4 oraciones, en español, enfocado en el delta respecto de la semana anterior, en lenguaje hipotético.',
      },
      keyChanges: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Cambios concretos observados respecto de la semana anterior (hasta 6).',
      },
      areasToReview: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Zonas o aspectos a priorizar esta semana (hasta 6, o vacío si el estado es favorable o insufficient_data). Nunca inventar lotes/zonas que no estén en los datos entregados.',
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Próximos pasos recomendados (hasta 6). Nunca recomendar productos, dosis, fertilización ni fitosanitarios.',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limitaciones de esta comparación automática (hasta 5).',
      },
    },
    required: [
      'verdict',
      'trend',
      'confidence',
      'summary',
      'keyChanges',
      'areasToReview',
      'recommendations',
      'limitations',
    ],
    additionalProperties: false,
  },
};

/**
 * Payload que efectivamente viaja a Anthropic — el mismo WeeklyVerdictGeneratorInput que ya usa
 * el generador determinístico, sin GeoJSON ni imágenes ni datos personales (mismo criterio de
 * minimización que buildClaudeUserMessage en technical-verdict-prompt.ts).
 */
export function buildWeeklyClaudeUserMessage(
  input: WeeklyVerdictGeneratorInput,
): string {
  return JSON.stringify({
    fieldName: input.fieldName,
    weekStart: input.weekStart,
    weekEnd: input.weekEnd,
    current: {
      score: input.score,
      scoreLabel: input.scoreLabel,
      ndviMean: input.ndviMean,
      ndmiMean: input.ndmiMean,
      dominantZone: input.dominantZone,
      dominantZonePercentage: input.dominantZonePercentage,
      analyzedAreaHa: input.analyzedAreaHa,
      lotCount: input.lotCount,
      dataQualityStatus: input.dataQualityStatus,
      images: {
        rgb: input.hasRgbImage,
        ndvi: input.hasNdviImage,
        ndmi: input.hasNdmiImage,
        series: input.hasImageSeries,
      },
    },
    comparisonVsPrevious: input.comparison,
    individualAnalysisVerdict: input.individualVerdict,
  });
}
