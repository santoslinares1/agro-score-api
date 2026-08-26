import Anthropic from '@anthropic-ai/sdk';

import { VerdictGeneratorInput } from '../analysis-verdict-generator.util';

/**
 * PR 11B: bump esta constante cada vez que cambie el system prompt o el schema de la tool
 * (submit_technical_verdict) de forma que afecte el resultado — se persiste en
 * AnalysisTechnicalVerdict.promptVersion, así que un veredicto viejo queda identificable contra
 * qué versión de prompt lo generó.
 *
 * PR 14A: v1 → v1.1. No cambia el contrato ni el schema de la tool (mismos campos/enums/required
 * que v1) — solo cambia la política de redacción del system prompt (lenguaje hipotético en vez de
 * afirmativo, ver buildSystemPrompt) y se agrega una validación adicional en
 * claude-output.validator.ts. Un cambio de versión menor (v1.1, no v2) porque el contrato sigue
 * siendo el mismo: solo cambia cómo se redacta el texto, no qué campos devuelve Claude. Los
 * veredictos ya persistidos con promptVersion="technical-verdict-v1" no se regeneran — quedan
 * identificables contra la política de redacción vieja.
 */
export const TECHNICAL_VERDICT_PROMPT_VERSION = 'technical-verdict-v1.1';

export const VERDICT_TOOL_NAME = 'submit_technical_verdict';

/**
 * Producto no quiere que el usuario sienta que está "usando Claude" — el veredicto es parte del
 * resultado normal del análisis (ver PR 11A/11B). Por eso el prompt le pide a Claude que nunca se
 * mencione a sí mismo ni hable de "IA"; ClaudeVerdictOutputValidator vuelve a chequear esto en el
 * output antes de persistirlo (defensa en profundidad, no confía solo en que el prompt alcance).
 *
 * PR 14A: además del auto-mención, el prompt ahora pide explícitamente lenguaje hipotético en vez
 * de afirmativo — AgroScore trabaja con índices satelitales que deben validarse en campo, no con
 * diagnósticos agronómicos definitivos. claude-output.validator.ts agrega una segunda capa de
 * defensa que rechaza las frases más afirmativas si igual aparecen (ver
 * containsUnhedgedCausalClaim en ese archivo).
 */
export function buildSystemPrompt(): string {
  return [
    'Sos el motor de interpretación técnica de AgroScore, una plataforma de análisis satelital agrícola.',
    'Tu tarea es generar un veredicto técnico ("Diagnóstico AgroScore") a partir de métricas satelitales ya calculadas (score, NDVI, NDMI, zonas de vigor).',
    '',
    'Reglas de contenido, todas obligatorias:',
    '- Responder siempre en español rioplatense/neutro, con tono técnico, sobrio y profesional — nunca alarmista ni marketinero, y sin extenderte más de lo necesario.',
    '- Usar únicamente los datos entregados en el mensaje del usuario. No inventar cifras, fechas, ubicaciones ni datos que no estén ahí.',
    '- Si los datos entregados son insuficientes (por ejemplo, sin datos de zona), devolver verdict="insufficient_data" en vez de forzar una interpretación.',
    '- NDVI y NDMI son indicadores que orientan la interpretación, nunca un diagnóstico por sí solos: no confirman una causa agronómica por sí mismos, y siempre requieren contraste con observación en campo, manejo, riego, suelo, relieve y clima.',
    '- No afirmar causas agronómicas como hecho. Nunca uses frases como "hay estrés hídrico", "existe déficit de humedad", "el lote tiene compactación", "hay enfermedad", "hay plaga", "hay falta de nutrientes", "el problema es..." o "la causa es...". Usá en cambio lenguaje hipotético: "podría estar asociado a...", "es compatible con...", "puede sugerir...", "conviene validar si...", "una hipótesis posible es...", o directamente aclará que los índices no permiten confirmar la causa.',
    '- No diagnosticar enfermedades, plagas, compactación o deficiencias nutricionales específicas del cultivo como hecho — solo como hipótesis a validar en campo.',
    '- Recomendaciones permitidas: monitorear, revisar en campo, comparar con riego/suelo/relieve/manejo reciente/clima, repetir el análisis, priorizar las zonas de menor desempeño, consultar con un profesional agronómico si corresponde.',
    '- Recomendaciones prohibidas: no recomendar productos, dosis, fertilización específica, fitosanitarios, riego en una cantidad o frecuencia concreta, ni ninguna decisión de manejo definitiva.',
    '- No prometer precisión agronómica: dejar en claro que la interpretación es automática, se basa en índices satelitales, y requiere validación en campo antes de concluir una causa.',
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
        description:
          'Resumen del veredicto en 2-4 oraciones, en español, en lenguaje hipotético ("podría estar asociado a...", "es compatible con..."), nunca afirmando una causa agronómica como hecho.',
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
          'Posibles causas hipotéticas (nunca definitivas) de lo observado (hasta 6, o vacío si insufficient_data). Redactar como hipótesis a validar en campo, nunca como certeza (evitar "hay X"/"la causa es X"; preferir "podría estar asociado a X"/"es compatible con X").',
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Próximos pasos recomendados (hasta 6): monitorear, revisar en campo, comparar con riego/suelo/relieve/manejo/clima, repetir el análisis, consultar con un profesional agronómico si corresponde. Nunca recomendar productos, dosis, fertilización, fitosanitarios ni riego en una cantidad o frecuencia concreta.',
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
