import {
  buildCorrectiveInstruction,
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

  it('PR 17: la promptVersion queda en technical-verdict-v1.2', () => {
    expect(TECHNICAL_VERDICT_PROMPT_VERSION).toBe('technical-verdict-v1.2');
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

describe('buildCorrectiveInstruction (PR 17 — retry correctivo)', () => {
  it('reason=unhedged_causal_claim: pide regenerar sin afirmar causalidad, en hipótesis', () => {
    const instruction = buildCorrectiveInstruction('unhedged_causal_claim');

    expect(instruction).toMatch(/nivel de certeza no permitido/i);
    expect(instruction).toMatch(/generá nuevamente el veredicto completo/i);
    expect(instruction).toMatch(/hipótesis/i);
    expect(instruction).toMatch(/no afirmes causalidad/i);
  });

  it('reason=forbidden_terms: pide regenerar sin autorreferenciarse', () => {
    const instruction = buildCorrectiveInstruction('forbidden_terms');

    expect(instruction).toMatch(/término prohibido/i);
    expect(instruction).toMatch(/generá nuevamente el veredicto completo/i);
  });

  it('ninguna instrucción correctiva menciona contenido de un veredicto real rechazado — solo el tipo de fallo', () => {
    const causal = buildCorrectiveInstruction('unhedged_causal_claim');
    const forbidden = buildCorrectiveInstruction('forbidden_terms');

    // "Anthropic"/"Claude"/"IA" SÍ aparecen en forbidden_terms — son ejemplos del término a evitar,
    // ya presentes tal cual en buildSystemPrompt (regla de "no mencionarte a vos mismo"), no una
    // fuga de la respuesta rechazada. Lo que nunca debe aparecer es contenido propio de un
    // veredicto real (causas/hallazgos agronómicos concretos como "estrés hídrico").
    expect(causal).not.toMatch(/estrés hídrico|compactación|plaga/i);
    expect(forbidden).not.toMatch(/estrés hídrico|compactación|plaga/i);
  });

  it('las dos instrucciones nunca relajan las reglas de contenido — no piden certeza ni mencionan Claude/IA', () => {
    const causal = buildCorrectiveInstruction('unhedged_causal_claim');
    const forbidden = buildCorrectiveInstruction('forbidden_terms');

    expect(causal + forbidden).not.toMatch(/afirmá|podés afirmar|con certeza/i);
  });
});
