import {
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
} from '../entities/analysis-technical-verdict.entity';
import { GeneratedVerdict } from '../analysis-verdict-generator.util';
import {
  containsForbiddenTerms,
  containsUnhedgedCausalClaim,
} from './claude-text-safety.util';

/**
 * PR 11B: "no confiar ciegamente en Claude" — este módulo es la única puerta de entrada del
 * output de Anthropic hacia AnalysisTechnicalVerdict. Aunque ClaudeTechnicalVerdictGenerator usa
 * un tool call `strict: true` (la API ya rechaza tipos/enums que no matchean el JSON Schema), acá
 * se vuelve a validar todo desde cero — arrays/largos no están cubiertos por `strict`, y esta
 * función es la que queda cubierta por tests sin necesidad de mockear el SDK.
 */

/**
 * PR 17: motivo acotado (nunca texto libre) de por qué el guardrail de seguridad rechazó el
 * output — exactamente los dos checks de "no confiar ciegamente en Claude" de más abajo, nunca
 * los checks de forma (enum/summary vacío/etc.), que siguen tirando `Error` genérico a propósito:
 * esos no son reintentables con un prompt correctivo (ver ClaudeTechnicalVerdictGenerator).
 */
export type VerdictSafetyValidationReason =
  | 'forbidden_terms'
  | 'unhedged_causal_claim';

/**
 * PR 17: error específico del guardrail de seguridad — permite a ClaudeTechnicalVerdictGenerator
 * distinguir "Claude violó una regla de estilo/seguridad" (reintentable una vez, con feedback
 * correctivo) de cualquier otro error (schema inválido, auth, rate limit, red, timeout — ninguno
 * de esos se arregla reintentando con el mismo input). El `message` es siempre el mismo texto fijo
 * y genérico que ya se usaba acá — nunca incluye la respuesta cruda de Claude, el texto generado
 * completo, prompts, ni ningún dato sensible; eso es justamente lo que evita que el error termine
 * filtrando contenido rechazado hacia logs o hacia AnalysisTechnicalVerdict.errorMessage.
 */
export class VerdictSafetyValidationError extends Error {
  readonly reason: VerdictSafetyValidationReason;

  constructor(reason: VerdictSafetyValidationReason, message: string) {
    super(message);
    this.name = 'VerdictSafetyValidationError';
    this.reason = reason;
  }
}

const VALID_VERDICTS = new Set<AnalysisVerdictLabel>([
  'favorable',
  'attention',
  'critical',
  'insufficient_data',
]);

const VALID_CONFIDENCES = new Set<AnalysisVerdictConfidence>([
  'low',
  'medium',
  'high',
]);

export const SUMMARY_MAX_LENGTH = 1200;
export const ITEM_MAX_LENGTH = 300;
export const ARRAY_MAX_ITEMS = 6;
export const LIMITATIONS_MAX_ITEMS = 5;

function clampString(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Descarta silenciosamente items que no son string o quedan vacíos tras trim — nunca los
 * convierte a texto ni los rellena. Corta al máximo permitido, sin importar cuántos haya
 * mandado Claude.
 */
function clampStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    )
    .slice(0, maxItems)
    .map((item) => clampString(item, ITEM_MAX_LENGTH));
}

/**
 * Valida y normaliza el `tool_use.input` crudo que devuelve Claude. Tira (nunca devuelve un
 * valor parcial) si:
 * - no es un objeto (`Error` genérico);
 * - `verdict`/`confidence` no están en el enum permitido (`Error` genérico);
 * - `summary` falta, no es string, o queda vacío tras trim (`Error` genérico);
 * - el texto (summary o cualquier item de los arrays) menciona Claude/IA/Anthropic/chatbot
 *   (`VerdictSafetyValidationError` con reason='forbidden_terms'), o
 * - afirma una causa agronómica como hecho en vez de como hipótesis (PR 14A)
 *   (`VerdictSafetyValidationError` con reason='unhedged_causal_claim') —
 *   ver claude-text-safety.util.ts (PR 16B: extraído acá para compartirlo con el validator de
 *   weeklyTechnicalVerdict, ver claude-weekly-output.validator.ts).
 * PR 17: los dos últimos casos usan un error tipado a propósito — es la señal que
 * ClaudeTechnicalVerdictGenerator usa para decidir si vale la pena un segundo intento con
 * feedback correctivo (un enum inválido o un summary vacío no se arreglan reintentando con el
 * mismo input, así que esos siguen siendo `Error` genérico, nunca reintentados).
 * Los arrays (keyFindings/possibleCauses/recommendations/limitations) son más tolerantes: si
 * faltan, no son array, o traen items no-string, se normalizan a lo que sí sea válido en vez de
 * fallar — un array mal formado no es motivo para descartar un veredicto por lo demás válido.
 */
export function validateAndNormalizeGeneratedVerdict(
  raw: unknown,
): GeneratedVerdict {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Claude no devolvió un objeto JSON válido.');
  }

  const obj = raw as Record<string, unknown>;

  if (!VALID_VERDICTS.has(obj.verdict as AnalysisVerdictLabel)) {
    throw new Error(
      `Claude devolvió un verdict fuera de enum: ${String(obj.verdict)}`,
    );
  }

  if (!VALID_CONFIDENCES.has(obj.confidence as AnalysisVerdictConfidence)) {
    throw new Error(
      `Claude devolvió un confidence fuera de enum: ${String(obj.confidence)}`,
    );
  }

  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    throw new Error('Claude devolvió un summary vacío o inválido.');
  }

  const verdict: GeneratedVerdict = {
    verdict: obj.verdict as AnalysisVerdictLabel,
    confidence: obj.confidence as AnalysisVerdictConfidence,
    summary: clampString(obj.summary, SUMMARY_MAX_LENGTH),
    keyFindings: clampStringArray(obj.keyFindings, ARRAY_MAX_ITEMS),
    possibleCauses: clampStringArray(obj.possibleCauses, ARRAY_MAX_ITEMS),
    recommendations: clampStringArray(obj.recommendations, ARRAY_MAX_ITEMS),
    limitations: clampStringArray(obj.limitations, LIMITATIONS_MAX_ITEMS),
  };

  const allText = [
    verdict.summary,
    ...verdict.keyFindings,
    ...verdict.possibleCauses,
    ...verdict.recommendations,
    ...verdict.limitations,
  ].join(' ');

  if (containsForbiddenTerms(allText)) {
    throw new VerdictSafetyValidationError(
      'forbidden_terms',
      'Claude mencionó un término prohibido (Claude/IA/Anthropic/chatbot) en el texto generado.',
    );
  }

  if (containsUnhedgedCausalClaim(allText)) {
    throw new VerdictSafetyValidationError(
      'unhedged_causal_claim',
      'Claude usó lenguaje demasiado afirmativo sobre una causa agronómica (debe hablar en hipótesis, no en certezas).',
    );
  }

  return verdict;
}
