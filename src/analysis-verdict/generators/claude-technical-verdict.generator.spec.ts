import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Anthropic from '@anthropic-ai/sdk';

import { VerdictGeneratorInput } from '../analysis-verdict-generator.util';
import { VerdictSafetyValidationError } from './claude-output.validator';
import {
  ClaudeTechnicalVerdictGenerator,
  DEFAULT_ANTHROPIC_MODEL,
} from './claude-technical-verdict.generator';
import {
  TECHNICAL_VERDICT_PROMPT_VERSION,
  VERDICT_TOOL_NAME,
} from './technical-verdict-prompt';

jest.mock('@anthropic-ai/sdk', () => {
  const actual = jest.requireActual('@anthropic-ai/sdk');
  const mockCreate = jest.fn();

  class MockAnthropic extends actual.Anthropic {
    constructor(opts: unknown) {
      super(opts);
      (this as any).messages = { create: mockCreate };
    }
  }

  return {
    __esModule: true,
    ...actual,
    default: MockAnthropic,
    Anthropic: MockAnthropic,
    __mockCreate: mockCreate,
  };
});

const { __mockCreate: mockCreate } = jest.requireMock(
  '@anthropic-ai/sdk',
) as unknown as {
  __mockCreate: jest.Mock;
};

describe('ClaudeTechnicalVerdictGenerator', () => {
  let generator: ClaudeTechnicalVerdictGenerator;
  let configGetMock: jest.Mock;

  const validInput: VerdictGeneratorInput = {
    globalScore: 58,
    hasZoneData: true,
    ndviAverageMax: 0.6,
    ndviVariability: 'Media',
    ndmiMean: 0.25,
  };

  const validToolResponse = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: VERDICT_TOOL_NAME,
        input: {
          verdict: 'attention',
          confidence: 'medium',
          summary: 'Resumen técnico.',
          keyFindings: ['hallazgo'],
          possibleCauses: ['causa'],
          recommendations: ['recomendación'],
          limitations: ['limitación'],
          ...overrides,
        },
      },
    ],
  });

  beforeEach(async () => {
    mockCreate.mockReset();
    configGetMock = jest.fn().mockImplementation((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return 'test-api-key';
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeTechnicalVerdictGenerator,
        { provide: ConfigService, useValue: { get: configGetMock } },
      ],
    }).compile();

    generator = module.get(ClaudeTechnicalVerdictGenerator);
  });

  it('generatorName/promptVersion quedan fijos en "claude"/TECHNICAL_VERDICT_PROMPT_VERSION', () => {
    expect(generator.generatorName).toBe('claude');
    expect(generator.promptVersion).toBe(TECHNICAL_VERDICT_PROMPT_VERSION);
  });

  it('usa DEFAULT_ANTHROPIC_MODEL si ANTHROPIC_MODEL no está seteado', () => {
    expect(generator.modelId).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('envía model/system/tools/tool_choice/messages con el input estructurado y el prompt versionado', async () => {
    mockCreate.mockResolvedValue(validToolResponse());

    await generator.generate(validInput);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: VERDICT_TOOL_NAME,
    });
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].name).toBe(VERDICT_TOOL_NAME);
    expect(params.tools[0].strict).toBe(true);
    expect(typeof params.system).toBe('string');
    expect(params.system).toMatch(/español/i);
    const userContent = JSON.parse(params.messages[0].content as string);
    expect(userContent).toEqual({
      score: 58,
      hasZoneData: true,
      ndvi: { averageMax: 0.6, variability: 'Media' },
      ndmi: { mean: 0.25 },
    });
    expect(options.timeout).toBe(20000);
  });

  it('parsea correctamente un tool_use válido y lo devuelve normalizado', async () => {
    mockCreate.mockResolvedValue(validToolResponse());

    const result = await generator.generate(validInput);

    expect(result.verdict).toBe('attention');
    expect(result.confidence).toBe('medium');
    expect(result.summary).toBe('Resumen técnico.');
  });

  it('rechaza si Claude no devuelve un tool_use (stop_reason distinto)', async () => {
    mockCreate.mockResolvedValue({
      id: 'msg_1',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'no debería pasar esto' }],
    });

    await expect(generator.generate(validInput)).rejects.toThrow(
      /no devolvió la herramienta/i,
    );
  });

  it('rechaza (vía el validador) un enum inválido dentro del tool_use', async () => {
    mockCreate.mockResolvedValue(validToolResponse({ verdict: 'excelente' }));

    await expect(generator.generate(validInput)).rejects.toThrow(/verdict/i);
  });

  it('sin ANTHROPIC_API_KEY, rechaza antes de llamar al SDK', async () => {
    configGetMock.mockImplementation(() => undefined);

    await expect(generator.generate(validInput)).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('nunca incluye la API key en el mensaje de error', async () => {
    configGetMock.mockImplementation(() => undefined);

    await expect(generator.generate(validInput)).rejects.not.toThrow(
      /test-api-key/,
    );
  });

  it('AuthenticationError del SDK produce un error controlado y legible, sin filtrar detalles internos', async () => {
    mockCreate.mockRejectedValue(
      new Anthropic.AuthenticationError(
        401,
        {},
        'invalid x-api-key',
        undefined,
        'authentication_error',
      ),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(/api key/i);
  });

  it('RateLimitError del SDK produce un error controlado', async () => {
    mockCreate.mockRejectedValue(
      new Anthropic.RateLimitError(
        429,
        {},
        'rate limited',
        undefined,
        'rate_limit_error',
      ),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(/rate limit/i);
  });

  it('APIConnectionError del SDK (timeout/red) produce un error controlado', async () => {
    mockCreate.mockRejectedValue(
      new Anthropic.APIConnectionError({ message: 'Request timed out.' }),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(
      /timeout|red/i,
    );
  });

  it('APIError genérico (5xx) produce un error controlado con el status', async () => {
    mockCreate.mockRejectedValue(
      new Anthropic.APIError(500, {}, 'internal error', undefined, 'api_error'),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(/status 500/);
  });

  it('usa ANTHROPIC_MODEL/ANTHROPIC_TIMEOUT_MS del config cuando están seteados', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return 'test-api-key';
      if (key === 'ANTHROPIC_MODEL') return 'claude-opus-5';
      if (key === 'ANTHROPIC_TIMEOUT_MS') return '5000';
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeTechnicalVerdictGenerator,
        { provide: ConfigService, useValue: { get: configGetMock } },
      ],
    }).compile();
    const customGenerator = module.get(ClaudeTechnicalVerdictGenerator);

    mockCreate.mockResolvedValue(validToolResponse());
    await customGenerator.generate(validInput);

    expect(customGenerator.modelId).toBe('claude-opus-5');
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.model).toBe('claude-opus-5');
    expect(options.timeout).toBe(5000);
  });

  describe('PR 17: retry correctivo ante VerdictSafetyValidationError', () => {
    it('respuesta válida en el intento 1 → una sola llamada a Anthropic, sin reintento', async () => {
      mockCreate.mockResolvedValue(validToolResponse());

      const result = await generator.generate(validInput);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.verdict).toBe('attention');
    });

    it('causal claim en el intento 1 + válida en el intento 2 → generated, exactamente 2 llamadas', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(
          validToolResponse({
            summary: 'podría estar asociado a estrés hídrico',
          }),
        );

      const result = await generator.generate(validInput);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.summary).toBe('podría estar asociado a estrés hídrico');
    });

    it('forbidden terms en el intento 1 + válida en el intento 2 → generated, exactamente 2 llamadas', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'Generado por Claude.' }),
        )
        .mockResolvedValueOnce(validToolResponse({ summary: 'Resumen ok.' }));

      const result = await generator.generate(validInput);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(result.summary).toBe('Resumen ok.');
    });

    it('el intento 2 agrega la instrucción correctiva DESPUÉS del system prompt base, sin reemplazarlo', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(validToolResponse());

      await generator.generate(validInput);

      const [firstParams] = mockCreate.mock.calls[0];
      const [secondParams] = mockCreate.mock.calls[1];

      expect(firstParams.system).toMatch(/español/i);
      expect(firstParams.system).not.toMatch(/nivel de certeza no permitido/i);

      expect((secondParams.system as string).startsWith(firstParams.system)).toBe(
        true,
      );
      expect(secondParams.system).toMatch(/nivel de certeza no permitido/i);
      expect(secondParams.system).toMatch(/no afirmes causalidad/i);
    });

    it('la instrucción correctiva de forbidden_terms es distinta a la de unhedged_causal_claim', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'Generado por Claude.' }),
        )
        .mockResolvedValueOnce(validToolResponse());

      await generator.generate(validInput);

      const [, secondParams] = mockCreate.mock.calls.map(([p]) => p);
      expect(secondParams.system).toMatch(/término prohibido/i);
      expect(secondParams.system).not.toMatch(/nivel de certeza no permitido/i);
    });

    it('el intento 2 reenvía el mismo user message (mismos datos) — nunca la respuesta rechazada', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(validToolResponse());

      await generator.generate(validInput);

      const [firstParams] = mockCreate.mock.calls[0];
      const [secondParams] = mockCreate.mock.calls[1];

      expect(secondParams.messages).toEqual(firstParams.messages);
      const secondUserContent = secondParams.messages[0].content as string;
      expect(secondUserContent).not.toMatch(/estrés hídrico/i);
    });

    it('safety violation en ambos intentos → falla después de exactamente 2 llamadas, propaga VerdictSafetyValidationError', async () => {
      mockCreate.mockResolvedValue(
        validToolResponse({ summary: 'hay estrés hídrico' }),
      );

      await expect(generator.generate(validInput)).rejects.toBeInstanceOf(
        VerdictSafetyValidationError,
      );
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('el intento 2 pasa por EXACTAMENTE el mismo validador — un error de forma en el intento 2 no dispara un tercer intento', async () => {
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(validToolResponse({ verdict: 'excelente' }));

      await expect(generator.generate(validInput)).rejects.toThrow(/verdict/i);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('un enum inválido en el intento 1 (error de forma, no de estilo) nunca dispara el retry correctivo', async () => {
      mockCreate.mockResolvedValue(validToolResponse({ verdict: 'excelente' }));

      await expect(generator.generate(validInput)).rejects.toThrow(/verdict/i);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('"no tool_use" (stop_reason inesperado) nunca dispara el retry correctivo', async () => {
      mockCreate.mockResolvedValue({
        id: 'msg_1',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'no debería pasar esto' }],
      });

      await expect(generator.generate(validInput)).rejects.toThrow(
        /no devolvió la herramienta/i,
      );
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'AuthenticationError',
        // AuthenticationError/RateLimitError son APIError<_, Headers> (headers NO opcional en su
        // firma, a diferencia del genérico APIError<_, Headers | undefined> que sí lo admite) — se
        // pasa un Headers vacío real en vez de `undefined` para respetar la firma exacta de la SDK
        // sin recurrir a `as any`.
        () =>
          new Anthropic.AuthenticationError(
            401,
            {},
            'invalid x-api-key',
            new Headers(),
            'authentication_error',
          ),
      ],
      [
        'RateLimitError',
        () =>
          new Anthropic.RateLimitError(
            429,
            {},
            'rate limited',
            new Headers(),
            'rate_limit_error',
          ),
      ],
      [
        'APIConnectionError',
        () =>
          new Anthropic.APIConnectionError({ message: 'Request timed out.' }),
      ],
    ])(
      '%s del SDK nunca dispara el retry correctivo — una sola llamada a Anthropic',
      async (_label, buildError) => {
        mockCreate.mockRejectedValue(buildError());

        await expect(generator.generate(validInput)).rejects.toThrow();
        expect(mockCreate).toHaveBeenCalledTimes(1);
      },
    );

    it('el log del rechazo nunca incluye el texto generado por Claude, solo metadata acotada', async () => {
      const warnSpy = jest
        .spyOn((generator as any).logger, 'warn')
        .mockImplementation(() => undefined);
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(validToolResponse());

      await generator.generate({ ...validInput, analysisId: 'analysis-42' });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [logLine] = warnSpy.mock.calls[0];
      expect(logLine).toContain('analysisId=analysis-42');
      expect(logLine).toContain('attempt=1');
      expect(logLine).toContain('provider=claude');
      expect(logLine).toContain('reason=unhedged_causal_claim');
      expect(logLine).toContain('retrying=true');
      expect(logLine).not.toContain('estrés hídrico');
    });

    it('sin analysisId en el input, loguea analysisId=unknown en vez de romper', async () => {
      const warnSpy = jest
        .spyOn((generator as any).logger, 'warn')
        .mockImplementation(() => undefined);
      mockCreate
        .mockResolvedValueOnce(
          validToolResponse({ summary: 'hay estrés hídrico' }),
        )
        .mockResolvedValueOnce(validToolResponse());

      await generator.generate(validInput);

      const [logLine] = warnSpy.mock.calls[0];
      expect(logLine).toContain('analysisId=unknown');
    });
  });
});
