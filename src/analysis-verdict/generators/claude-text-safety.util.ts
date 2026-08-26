/**
 * PR 14A → PR 16B: funciones puras de "no confiar ciegamente en Claude" sobre texto libre — antes
 * vivían solo en claude-output.validator.ts (veredicto individual). PR 16B las extrae acá porque
 * el nuevo validator de weeklyTechnicalVerdict necesita EXACTAMENTE las mismas reglas (nunca
 * autorreferenciarse como Claude/IA/Anthropic, nunca afirmar una causa agronómica como hecho) y
 * duplicar estos regex a mano es el tipo de lógica que vale la pena compartir (a diferencia de,
 * por ejemplo, extractNdmiMean en analysis-verdict-input.util.ts, que sí se duplica a propósito
 * por ser trivial) — un regex con casos de falsos positivos ya afinados (ver tests) es exactamente
 * lo que NO conviene resolver dos veces.
 *
 * Sin dependencias de NestJS/DI ni de ningún módulo — funciones puras sobre string, importables
 * desde cualquier módulo sin acoplar nada más que esto.
 */

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

export function containsForbiddenTerms(value: string): boolean {
  return FORBIDDEN_TERM_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * PR 14A: defensa en profundidad detrás de la regla de lenguaje hipotético del prompt — no
 * confiar ciegamente en que el prompt alcance.
 *
 * Deliberadamente acotado a los patrones concretos pedidos por producto, no un detector de
 * hedging genérico (eso requeriría NLP real y generaría falsos positivos impredecibles). Mismo
 * criterio que \bia\b arriba: prefiere dejar pasar un caso dudoso antes que rechazar un veredicto
 * por lo demás correcto.
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

export function containsUnhedgedCausalClaim(value: string): boolean {
  const withoutHedges = value.replace(HEDGE_LEAD_IN_PATTERN, ' ');
  return UNHEDGED_CLAIM_PATTERNS.some((pattern) => pattern.test(withoutHedges));
}
