import {
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
} from '../entities/analysis-technical-verdict.entity';
import { GeneratedVerdict } from '../analysis-verdict-generator.util';

/**
 * PR 11B: "no confiar ciegamente en Claude" — este módulo es la única puerta de entrada del
 * output de Anthropic hacia AnalysisTechnicalVerdict. Aunque ClaudeTechnicalVerdictGenerator usa
 * un tool call `strict: true` (la API ya rechaza tipos/enums que no matchean el JSON Schema), acá
 * se vuelve a validar todo desde cero — arrays/largos no están cubiertos por `strict`, y esta
 * función es la que queda cubierta por tests sin necesidad de mockear el SDK.
 */

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

/**
 * Términos que el prompt le pide a Claude no usar (el veredicto es "AgroScore", no "IA"/"Claude").
 * `\bia\b` es la única forma de cazar "IA" como palabra suelta sin falsos positivos: la letra
 * "i" ASCII nunca aparece pegada a una "a" dentro de una palabra española sin que haya un límite
 * de palabra real antes (p.ej. "historia", "compañía", "vía" no matchean).
 */
const FORBIDDEN_TERM_PATTERNS = [
  /\bclaude\b/i,
  /\banthropic\b/i,
  /\bchatbot\b/i,
  /\bia\b/i,
  /inteligencia artificial/i,
];

function containsForbiddenTerms(value: string): boolean {
  return FORBIDDEN_TERM_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * PR 14A: defensa en profundidad detrás de la regla de lenguaje hipotético del prompt (ver
 * buildSystemPrompt en technical-verdict-prompt.ts) — igual criterio que FORBIDDEN_TERM_PATTERNS
 * arriba: no confiar ciegamente en que el prompt alcance.
 *
 * Deliberadamente acotado a los patrones concretos pedidos por producto, no un detector de
 * hedging genérico (eso requeriría NLP real y generaría falsos positivos impredecibles). Mismo
 * criterio que \bia\b más abajo: prefiere dejar pasar un caso dudoso antes que rechazar un
 * veredicto por lo demás correcto.
 *
 * Sustantivos que solo se prohíben en afirmación directa ("hay X", "presenta X", "tiene X", o
 * "existe X" sin el condicional "si existe" antes) — en forma hedgeada ("podría estar asociado a
 * estrés hídrico", "validar si existe compactación") son exactamente el lenguaje que el prompt
 * pide usar, así que nunca se bloquean como mención bare.
 */
const ASSERTIVE_CLAIM_NOUNS =
  '(estrés\\s+hídrico|compactación|plagas?|enfermedad(es)?|deficiencias?\\s+nutricional(es)?|falta\\s+de\\s+nutrientes)';

const UNHEDGED_CLAIM_PATTERNS = [
  new RegExp(`\\b(hay|presenta|tiene)\\s+${ASSERTIVE_CLAIM_NOUNS}\\b`, 'i'),
  new RegExp(`\\bexiste\\s+${ASSERTIVE_CLAIM_NOUNS}\\b`, 'i'),
  // "déficit hídrico"/"déficit de humedad" se prohíben como mención bare (no solo en afirmación
  // directa): el objetivo es que Claude use directamente vocabulario más prudente
  // ("disponibilidad hídrica", "diferencias de humedad"), no que hedgee esa frase en particular.
  /\bdéficit\s+(hídrico|de\s+humedad)\b/i,
  /\bla\s+causa\s+es\b/i,
  /\bel\s+problema\s+es\b/i,
  /\bse\s+debe\s+a\b/i,
];

// Condicionales que vuelven prudente una afirmación que de otra forma matchearía arriba ("si
// existe compactación", "si hay plaga") — se remueven del texto antes de chequear, para no
// generar falsos positivos con el lenguaje hedgeado que el prompt pide.
const HEDGE_LEAD_IN_PATTERN = /\bsi\s+(existe|hay|presenta|tiene)\b/gi;

function containsUnhedgedCausalClaim(value: string): boolean {
  const withoutHedges = value.replace(HEDGE_LEAD_IN_PATTERN, ' ');
  return UNHEDGED_CLAIM_PATTERNS.some((pattern) => pattern.test(withoutHedges));
}

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
 * - no es un objeto;
 * - `verdict`/`confidence` no están en el enum permitido;
 * - `summary` falta, no es string, o queda vacío tras trim;
 * - el texto (summary o cualquier item de los arrays) menciona Claude/IA/Anthropic/chatbot —
 *   ver FORBIDDEN_TERM_PATTERNS.
 * - el texto afirma una causa agronómica como hecho en vez de como hipótesis (PR 14A) — ver
 *   UNHEDGED_CLAIM_PATTERNS / containsUnhedgedCausalClaim.
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
