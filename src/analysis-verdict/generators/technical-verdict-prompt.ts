import Anthropic from '@anthropic-ai/sdk';

import { VerdictGeneratorInput } from '../analysis-verdict-generator.util';

/**
 * PR 11B: bump esta constante cada vez que cambie el system prompt o el schema de la tool
 * (submit_technical_verdict) de forma que afecte el resultado — se persiste en
 * AnalysisTechnicalVerdict.promptVersion, así que un veredicto viejo queda identificable contra
 * qué versión de prompt lo generó.
 */
export const TECHNICAL_VERDICT_PROMPT_VERSION = 'technical-verdict-v1';

export const VERDICT_TOOL_NAME = 'submit_technical_verdict';

/**
 * Producto no quiere que el usuario sienta que está "usando Claude" — el veredicto es parte del
 * resultado normal del análisis (ver PR 11A/11B). Por eso el prompt le pide a Claude que nunca se
 * mencione a sí mismo ni hable de "IA"; ClaudeVerdictOutputValidator vuelve a chequear esto en el
 * output antes de persistirlo (defensa en profundidad, no confía solo en que el prompt alcance).
 */
export function buildSystemPrompt(): string {
  return [
    'Sos el motor de interpretación técnica de AgroScore, una plataforma de análisis satelital agrícola.',
    'Tu tarea es generar un veredicto técnico ("Diagnóstico AgroScore") a partir de métricas satelitales ya calculadas (score, NDVI, NDMI, zonas de vigor).',
    '',
    'Reglas de contenido, todas obligatorias:',
    '- Responder siempre en español.',
    '- Usar únicamente los datos entregados en el mensaje del usuario. No inventar cifras, fechas, ubicaciones ni datos que no estén ahí.',
    '- Si los datos entregados son insuficientes (por ejemplo, sin datos de zona), devolver verdict="insufficient_data" en vez de forzar una interpretación.',
    '- No diagnosticar enfermedades específicas del cultivo.',
    '- No recomendar productos químicos, dosis ni aplicaciones concretas.',
    '- No afirmar causas definitivas: las posibles causas son hipótesis a validar en campo, nunca certezas.',
    '- Mantener lenguaje técnico pero entendible para un productor agropecuario, no solo para un agrónomo.',
    '- No mencionarte a vos mismo, a Claude, a Anthropic, ni usar las palabras "IA", "inteligencia artificial" o "chatbot" en ningún campo de texto. El resultado debe leerse como un diagnóstico técnico de AgroScore, no como la respuesta de un asistente conversacional.',
    '',
    'Devolvé el veredicto exclusivamente llamando a la herramienta submit_technical_verdict — no respondas en texto libre.',
  ].join('\n');
}

/**
 * Único tool call posible en la request (tool_choice forzado en ClaudeTechnicalVerdictGenerator)
 * — `strict: true` hace que la API rechace cualquier input que no matchee el schema (tipos y
 * enums), así que un tool_use válido ya viene con verdict/confidence dentro del enum permitido y
 * todos los campos requeridos presentes. Los límites de longitud/cantidad de items igual se
 * vuelven a aplicar en claude-output.validator.ts — `strict` no cubre eso.
 */
export const VERDICT_TOOL: Anthropic.Tool = {
  name: VERDICT_TOOL_NAME,
  description:
    'Registra el veredicto técnico interpretado a partir de las métricas satelitales del análisis.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['favorable', 'attention', 'critical', 'insufficient_data'],
        description: 'Clasificación general del estado del lote/campo.',
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'Confianza en la interpretación, según cuántos datos hay disponibles.',
      },
      summary: {
        type: 'string',
        description: 'Resumen del veredicto en 2-4 oraciones, en español.',
      },
      keyFindings: {
        type: 'array',
        items: { type: 'string' },
        description: 'Hallazgos concretos observados en los datos (hasta 6).',
      },
      possibleCauses: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Posibles causas hipotéticas (nunca definitivas) de lo observado (hasta 6, o vacío si insufficient_data).',
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Próximos pasos recomendados, sin recomendar productos/dosis (hasta 6).',
      },
      limitations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Limitaciones de esta interpretación automática (hasta 5).',
      },
    },
    required: [
      'verdict',
      'confidence',
      'summary',
      'keyFindings',
      'possibleCauses',
      'recommendations',
      'limitations',
    ],
    additionalProperties: false,
  },
};

/**
 * Payload que efectivamente viaja a Anthropic — el mismo VerdictGeneratorInput que ya usa el
 * generador determinístico (PR 11A), sin extenderlo con analysisId/fieldName/GeoJSON/imágenes:
 * es exactamente "solo datos relevantes" (score + señales NDVI/NDMI + si hay datos de zona), sin
 * tocar código ya testeado de PR 11A ni mandar nada que el prompt no necesite para decidir.
 */
export function buildClaudeUserMessage(input: VerdictGeneratorInput): string {
  return JSON.stringify({
    score: input.globalScore,
    hasZoneData: input.hasZoneData,
    ndvi: {
      averageMax: input.ndviAverageMax,
      variability: input.ndviVariability,
    },
    ndmi: {
      mean: input.ndmiMean,
    },
  });
}
