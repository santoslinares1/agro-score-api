import {
  buildSystemPrompt,
  TECHNICAL_VERDICT_PROMPT_VERSION,
} from './technical-verdict-prompt';

/**
 * PR 14A: tests del contenido del system prompt como string — complementa
 * claude-technical-verdict.generator.spec.ts (que ya verifica que buildSystemPrompt() viaja como
 * `system` en la request real al SDK mockeado). Acá se testea el contenido en sí, sin necesidad
 * de mockear el SDK.
 */
describe('buildSystemPrompt (PR 14A — lenguaje conservador)', () => {
  const prompt = buildSystemPrompt();

  it('la promptVersion queda en technical-verdict-v1.1', () => {
    expect(TECHNICAL_VERDICT_PROMPT_VERSION).toBe('technical-verdict-v1.1');
  });

  it('exige lenguaje hipotético en vez de afirmativo', () => {
    expect(prompt).toMatch(/lenguaje hipotético/i);
    expect(prompt).toMatch(/podría estar asociado a/i);
    expect(prompt).toMatch(/es compatible con/i);
  });

  it('prohíbe afirmar causas agronómicas como hecho, con ejemplos concretos', () => {
    expect(prompt).toMatch(/no afirmar causas agronómicas como hecho/i);
    expect(prompt).toMatch(/hay estrés hídrico/i);
    expect(prompt).toMatch(/la causa es/i);
  });

  it('exige validación en campo antes de concluir una causa', () => {
    expect(prompt).toMatch(/validación en campo/i);
    expect(prompt).toMatch(/contraste con observación en campo/i);
  });

  it('prohíbe recomendar productos, dosis o aplicaciones concretas', () => {
    expect(prompt).toMatch(
      /no recomendar productos, dosis, fertilización específica, fitosanitarios/i,
    );
  });

  it('deja explícito que NDVI/NDMI son indicadores, no un diagnóstico por sí solos', () => {
    expect(prompt).toMatch(/ndvi y ndmi son indicadores/i);
    expect(prompt).toMatch(/nunca un diagnóstico por sí solos/i);
  });

  it('pide tono técnico, sobrio, no alarmista y español rioplatense/neutro', () => {
    expect(prompt).toMatch(/español rioplatense\/neutro/i);
    expect(prompt).toMatch(/nunca alarmista ni marketinero/i);
  });

  it('mantiene intacta la regla de no autorreferenciarse como Claude/IA/Anthropic', () => {
    expect(prompt).toMatch(
      /no mencionarte a vos mismo, a claude, a anthropic/i,
    );
  });

  it('responde exclusivamente vía la tool submit_technical_verdict, nunca en texto libre para la UI', () => {
    expect(prompt).toMatch(
      /exclusivamente llamando a la herramienta submit_technical_verdict/i,
    );
  });
});
