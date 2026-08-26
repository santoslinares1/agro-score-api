import {
  WeeklyVerdictConfidence,
  WeeklyVerdictLabel,
  WeeklyVerdictTrend,
} from '../entities/weekly-technical-verdict.entity';
import { GeneratedWeeklyVerdict } from '../weekly-technical-verdict-generator.util';
import {
  containsForbiddenTerms,
  containsUnhedgedCausalClaim,
} from '../../analysis-verdict/generators/claude-text-safety.util';

/**
 * PR 16B: "no confiar ciegamente en Claude" — mismo rol que claude-output.validator.ts para el
 * veredicto individual, para el output del diagnóstico semanal. Reusa (no duplica)
 * containsForbiddenTerms/containsUnhedgedCausalClaim de claude-text-safety.util.ts — mismas
 * reglas de lenguaje conservador (PR 14A), ahora compartidas entre ambos validators.
 */

const VALID_VERDICTS = new Set<WeeklyVerdictLabel>([
  'favorable',
  'attention',
  'critical',
  'insufficient_data',
]);

const VALID_TRENDS = new Set<WeeklyVerdictTrend>([
  'improving',
  'stable',
  'worsening',
  'mixed',
  'insufficient_data',
]);

const VALID_CONFIDENCES = new Set<WeeklyVerdictConfidence>([
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

/** Mismo criterio que claude-output.validator.ts: descarta silenciosamente items que no son
 * string o quedan vacíos tras trim, corta al máximo permitido. */
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
 * Valida y normaliza el `tool_use.input` crudo que devuelve Claude para el diagnóstico semanal.
 * Tira (nunca devuelve un valor parcial) si:
 * - no es un objeto;
 * - `verdict`/`trend`/`confidence` no están en el enum permitido;
 * - `summary` falta, no es string, o queda vacío tras trim;
 * - el texto menciona Claude/IA/Anthropic/chatbot, o afirma una causa agronómica como hecho.
 * Los arrays (keyChanges/areasToReview/recommendations/limitations) son más tolerantes: se
 * normalizan a lo que sí sea válido en vez de fallar — mismo criterio que el validator individual.
 */
export function validateAndNormalizeGeneratedWeeklyVerdict(
  raw: unknown,
): GeneratedWeeklyVerdict {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Claude no devolvió un objeto JSON válido.');
  }

  const obj = raw as Record<string, unknown>;

  if (!VALID_VERDICTS.has(obj.verdict as WeeklyVerdictLabel)) {
    throw new Error(
      `Claude devolvió un verdict fuera de enum: ${String(obj.verdict)}`,
    );
  }

  if (!VALID_TRENDS.has(obj.trend as WeeklyVerdictTrend)) {
    throw new Error(
      `Claude devolvió un trend fuera de enum: ${String(obj.trend)}`,
    );
  }

  if (!VALID_CONFIDENCES.has(obj.confidence as WeeklyVerdictConfidence)) {
    throw new Error(
      `Claude devolvió un confidence fuera de enum: ${String(obj.confidence)}`,
    );
  }

  if (typeof obj.summary !== 'string' || !obj.summary.trim()) {
    throw new Error('Claude devolvió un summary vacío o inválido.');
  }

  const verdict: GeneratedWeeklyVerdict = {
    verdict: obj.verdict as WeeklyVerdictLabel,
    trend: obj.trend as WeeklyVerdictTrend,
    confidence: obj.confidence as WeeklyVerdictConfidence,
    summary: clampString(obj.summary, SUMMARY_MAX_LENGTH),
    keyChanges: clampStringArray(obj.keyChanges, ARRAY_MAX_ITEMS),
    areasToReview: clampStringArray(obj.areasToReview, ARRAY_MAX_ITEMS),
    recommendations: clampStringArray(obj.recommendations, ARRAY_MAX_ITEMS),
    limitations: clampStringArray(obj.limitations, LIMITATIONS_MAX_ITEMS),
  };

  const allText = [
    verdict.summary,
    ...verdict.keyChanges,
    ...verdict.areasToReview,
    ...verdict.recommendations,
    ...verdict.limitations,
  ].join(' ');

  if (containsForbiddenTerms(allText)) {
    throw new Error(
      'Claude mencionó un término prohibido (Claude/IA/Anthropic/chatbot) en el texto generado.',
    );
  }

  if (containsUnhedgedCausalClaim(allText)) {
    throw new Error(
      'Claude usó lenguaje demasiado afirmativo sobre una causa agronómica (debe hablar en hipótesis, no en certezas).',
    );
  }

  return verdict;
}
