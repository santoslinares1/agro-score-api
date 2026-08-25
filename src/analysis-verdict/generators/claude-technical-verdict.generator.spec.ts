import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Anthropic from '@anthropic-ai/sdk';

import { VerdictGeneratorInput } from '../analysis-verdict-generator.util';
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

  it('generatorName/promptVersion quedan fijos en "claude"/technical-verdict-v1', () => {
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
});
