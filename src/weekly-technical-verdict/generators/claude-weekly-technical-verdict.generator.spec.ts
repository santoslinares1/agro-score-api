import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import Anthropic from '@anthropic-ai/sdk';

import { WeeklyVerdictGeneratorInput } from '../weekly-technical-verdict-generator.util';
import {
  ClaudeWeeklyTechnicalVerdictGenerator,
  DEFAULT_ANTHROPIC_MODEL,
} from './claude-weekly-technical-verdict.generator';
import {
  WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
  WEEKLY_VERDICT_TOOL_NAME,
} from './weekly-technical-verdict-prompt';

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

describe('ClaudeWeeklyTechnicalVerdictGenerator', () => {
  let generator: ClaudeWeeklyTechnicalVerdictGenerator;
  let configGetMock: jest.Mock;

  const validInput: WeeklyVerdictGeneratorInput = {
    fieldName: 'Campo Norte',
    weekStart: '2026-08-18',
    weekEnd: '2026-08-25',
    score: 58,
    scoreLabel: 'Atención',
    ndviMean: 0.6,
    ndmiMean: 0.25,
    dominantZone: 'Alta',
    dominantZonePercentage: 40,
    analyzedAreaHa: 100,
    lotCount: 3,
    dataQualityStatus: 'sufficient',
    hasRgbImage: true,
    hasNdviImage: true,
    hasNdmiImage: true,
    hasImageSeries: false,
    previousSnapshotId: 'snapshot-0',
    comparison: {
      previousSnapshotId: 'snapshot-0',
      previousWeekStart: '2026-08-11',
      previousWeekEnd: '2026-08-18',
      scoreDelta: -3,
      ndviMeanDelta: 0.01,
      ndmiMeanDelta: null,
      dominantZoneChanged: false,
      dominantZoneFrom: 'Alta',
      dominantZoneTo: 'Alta',
      analyzedAreaDeltaHa: 0,
      dataQualityChanged: false,
      summary: ['El score se mantuvo estable respecto de la semana anterior.'],
    },
    individualVerdict: null,
  };

  const validToolResponse = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg_1',
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: WEEKLY_VERDICT_TOOL_NAME,
        input: {
          verdict: 'attention',
          trend: 'stable',
          confidence: 'medium',
          summary: 'Resumen semanal.',
          keyChanges: ['cambio'],
          areasToReview: ['zona'],
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
        ClaudeWeeklyTechnicalVerdictGenerator,
        { provide: ConfigService, useValue: { get: configGetMock } },
      ],
    }).compile();

    generator = module.get(ClaudeWeeklyTechnicalVerdictGenerator);
  });

  it('generatorName/promptVersion quedan fijos en "claude"/WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION', () => {
    expect(generator.generatorName).toBe('claude');
    expect(generator.promptVersion).toBe(
      WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
    );
  });

  it('usa DEFAULT_ANTHROPIC_MODEL si ANTHROPIC_MODEL no está seteado', () => {
    expect(generator.modelId).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it('envía model/system/tools/tool_choice/messages con el input estructurado (snapshot + comparison)', async () => {
    mockCreate.mockResolvedValue(validToolResponse());

    await generator.generate(validInput);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(params.tool_choice).toEqual({
      type: 'tool',
      name: WEEKLY_VERDICT_TOOL_NAME,
    });
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].strict).toBe(true);
    expect(typeof params.system).toBe('string');
    expect(params.system).toMatch(/español/i);
    const userContent = JSON.parse(params.messages[0].content as string);
    expect(userContent.current.score).toBe(58);
    expect(userContent.comparisonVsPrevious.scoreDelta).toBe(-3);
    expect(options.timeout).toBe(20000);
  });

  it('previousSnapshotId null en el input fuerza que el mensaje enviado también lo tenga null (Claude decide trend=insufficient_data)', async () => {
    mockCreate.mockResolvedValue(
      validToolResponse({ trend: 'insufficient_data' }),
    );

    await generator.generate({
      ...validInput,
      previousSnapshotId: null,
      comparison: { ...validInput.comparison, previousSnapshotId: null },
    });

    const [params] = mockCreate.mock.calls[0];
    const userContent = JSON.parse(params.messages[0].content as string);
    expect(userContent.comparisonVsPrevious.previousSnapshotId).toBeNull();
  });

  it('parsea correctamente un tool_use válido y lo devuelve normalizado', async () => {
    mockCreate.mockResolvedValue(validToolResponse());

    const result = await generator.generate(validInput);

    expect(result.verdict).toBe('attention');
    expect(result.trend).toBe('stable');
    expect(result.summary).toBe('Resumen semanal.');
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

  it('rechaza (vía el validador) lenguaje afirmativo prohibido', async () => {
    mockCreate.mockResolvedValue(
      validToolResponse({
        summary: 'La causa es un manejo de riego inadecuado.',
      }),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(/afirmativo/i);
  });

  it('rechaza (vía el validador) si el output menciona Claude/IA', async () => {
    mockCreate.mockResolvedValue(
      validToolResponse({
        summary: 'Este diagnóstico fue generado por Claude.',
      }),
    );

    await expect(generator.generate(validInput)).rejects.toThrow(/prohibido/i);
  });

  it('arrays largos se normalizan/limitan (vía el validador)', async () => {
    mockCreate.mockResolvedValue(
      validToolResponse({
        keyChanges: Array.from({ length: 20 }, (_, i) => `cambio ${i}`),
      }),
    );

    const result = await generator.generate(validInput);

    expect(result.keyChanges).toHaveLength(6);
  });

  it('sin ANTHROPIC_API_KEY, rechaza antes de llamar al SDK', async () => {
    configGetMock.mockImplementation(() => undefined);

    await expect(generator.generate(validInput)).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('AuthenticationError del SDK produce un error controlado, sin filtrar detalles internos', async () => {
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

  it('usa ANTHROPIC_MODEL/ANTHROPIC_TIMEOUT_MS del config cuando están seteados (compartidos con el veredicto individual)', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return 'test-api-key';
      if (key === 'ANTHROPIC_MODEL') return 'claude-opus-5';
      if (key === 'ANTHROPIC_TIMEOUT_MS') return '5000';
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClaudeWeeklyTechnicalVerdictGenerator,
        { provide: ConfigService, useValue: { get: configGetMock } },
      ],
    }).compile();
    const customGenerator = module.get(ClaudeWeeklyTechnicalVerdictGenerator);

    mockCreate.mockResolvedValue(validToolResponse());
    await customGenerator.generate(validInput);

    expect(customGenerator.modelId).toBe('claude-opus-5');
    const [params, options] = mockCreate.mock.calls[0];
    expect(params.model).toBe('claude-opus-5');
    expect(options.timeout).toBe(5000);
  });
});
