import {
  containsForbiddenTerms,
  containsUnhedgedCausalClaim,
} from './claude-text-safety.util';

/**
 * PR 16B: cobertura directa del util compartido, además de la cobertura indirecta que ya existe
 * vía claude-output.validator.spec.ts (individual) y claude-weekly-output.validator.spec.ts
 * (semanal) — acá se testea la lógica en sí, sin pasar por ningún validator concreto.
 */
describe('containsForbiddenTerms', () => {
  it.each([
    'Este análisis fue generado por Claude.',
    'Servicio provisto por Anthropic.',
    'Consultá con nuestro chatbot para más detalles.',
    'Generado con inteligencia artificial.',
    'Este resultado usa IA para interpretar los datos.',
  ])('detecta el término prohibido en: "%s"', (text) => {
    expect(containsForbiddenTerms(text)).toBe(true);
  });

  it('no genera falsos positivos con palabras españolas que contienen "ia" como substring', () => {
    expect(
      containsForbiddenTerms(
        'La historia del lote muestra buena vigencia y compañía de zonas de riego.',
      ),
    ).toBe(false);
  });
});

describe('containsUnhedgedCausalClaim', () => {
  it.each([
    'hay estrés hídrico',
    'presenta estrés hídrico',
    'existe estrés hídrico',
    'hay déficit hídrico',
    'déficit de humedad en el suelo',
    'la causa es compactación',
    'el problema es la falta de riego',
    'se debe a una plaga',
    'hay compactación',
    'hay plaga',
    'hay enfermedad',
    'hay deficiencia nutricional',
    'el lote tiene compactación',
  ])('detecta la afirmación no hedgeada en: "%s"', (text) => {
    expect(containsUnhedgedCausalClaim(text)).toBe(true);
  });

  it.each([
    'posibles señales compatibles con menor disponibilidad hídrica',
    'podría estar asociado a diferencias de humedad',
    'validar en campo si existe compactación',
    'descartar plagas o enfermedades con observación en campo',
    'posibles señales compatibles con estrés hídrico',
    'podría estar asociado a estrés hídrico',
    'validar si existe compactación',
    'descartar plagas o enfermedades en campo',
  ])('acepta lenguaje hipotético/hedgeado: "%s"', (text) => {
    expect(containsUnhedgedCausalClaim(text)).toBe(false);
  });
});
