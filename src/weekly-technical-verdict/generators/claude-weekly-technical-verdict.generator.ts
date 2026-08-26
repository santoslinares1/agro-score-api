import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import {
  GeneratedWeeklyVerdict,
  WeeklyVerdictGeneratorInput,
} from '../weekly-technical-verdict-generator.util';
import { validateAndNormalizeGeneratedWeeklyVerdict } from './claude-weekly-output.validator';
import {
  WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION,
  WEEKLY_VERDICT_TOOL,
  WEEKLY_VERDICT_TOOL_NAME,
  buildWeeklyClaudeUserMessage,
  buildWeeklySystemPrompt,
} from './weekly-technical-verdict-prompt';
import { WeeklyTechnicalVerdictGenerator } from './weekly-technical-verdict-generator.interface';

export const WEEKLY_GENERATOR_NAME = 'claude';

/**
 * PR 16B: mismo default que ClaudeTechnicalVerdictGenerator
 * (analysis-verdict/generators/claude-technical-verdict.generator.ts) — reutiliza
 * ANTHROPIC_MODEL/ANTHROPIC_TIMEOUT_MS, no agrega variables nuevas (ver PR 16A, sección 9: la
 * única env nueva es el provider, no el modelo/timeout).
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 20_000;

const MAX_OUTPUT_TOKENS = 4096;

/**
 * PR 16B: implementación real sobre Anthropic del diagnóstico semanal — mismo patrón que
 * ClaudeTechnicalVerdictGenerator (cliente lazy, nunca se instancia/valida ANTHROPIC_API_KEY en
 * el constructor, así que el boot de la app nunca falla por esta env var). Solo
 * WeeklyTechnicalVerdictService.generateAndPersist la invoca, y solo cuando
 * WEEKLY_TECHNICAL_VERDICT_PROVIDER=claude.
 */
@Injectable()
export class ClaudeWeeklyTechnicalVerdictGenerator implements WeeklyTechnicalVerdictGenerator {
  private readonly logger = new Logger(
    ClaudeWeeklyTechnicalVerdictGenerator.name,
  );
  private client: Anthropic | null = null;

  readonly generatorName = WEEKLY_GENERATOR_NAME;
  readonly promptVersion = WEEKLY_TECHNICAL_VERDICT_PROMPT_VERSION;
  readonly modelId: string;

  constructor(private readonly config: ConfigService) {
    this.modelId =
      this.config.get<string>('ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL;
  }

  async generate(
    input: WeeklyVerdictGeneratorInput,
  ): Promise<GeneratedWeeklyVerdict> {
    const client = this.getClient();
    const timeoutMs = this.resolveTimeoutMs();

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: this.modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: buildWeeklySystemPrompt(),
          tools: [WEEKLY_VERDICT_TOOL],
          tool_choice: { type: 'tool', name: WEEKLY_VERDICT_TOOL_NAME },
          messages: [
            { role: 'user', content: buildWeeklyClaudeUserMessage(input) },
          ],
        },
        { timeout: timeoutMs },
      );
    } catch (error) {
      throw new Error(this.describeSdkError(error));
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (!toolUse) {
      throw new Error(
        `Claude no devolvió la herramienta esperada (stop_reason=${response.stop_reason}).`,
      );
    }

    return validateAndNormalizeGeneratedWeeklyVerdict(toolUse.input);
  }

  private getClient(): Anthropic {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY no está configurada (requerida cuando WEEKLY_TECHNICAL_VERDICT_PROVIDER=claude).',
      );
    }

    this.client = new Anthropic({ apiKey });
    return this.client;
  }

  private resolveTimeoutMs(): number {
    const raw = this.config.get<string>('ANTHROPIC_TIMEOUT_MS');
    const parsed = raw ? Number(raw) : NaN;

    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_ANTHROPIC_TIMEOUT_MS;
  }

  /** Misma cadena más-específico-primero que ClaudeTechnicalVerdictGenerator — ver
   * shared/error-codes.md del skill claude-api. Nunca incluye la API key ni el error crudo. */
  private describeSdkError(error: unknown): string {
    if (error instanceof Anthropic.AuthenticationError) {
      this.logger.error('Claude rechazó la API key configurada (401).');
      return 'Claude rechazó la API key configurada.';
    }

    if (error instanceof Anthropic.NotFoundError) {
      this.logger.error(`Modelo de Claude no encontrado: ${this.modelId}.`);
      return `Modelo de Claude no encontrado: ${this.modelId}.`;
    }

    if (error instanceof Anthropic.RateLimitError) {
      this.logger.warn('Rate limit de Claude alcanzado.');
      return 'Rate limit de Claude alcanzado.';
    }

    if (error instanceof Anthropic.APIConnectionError) {
      this.logger.error(`No se pudo conectar con Claude: ${error.message}`);
      return 'No se pudo conectar con Claude (timeout o red).';
    }

    if (error instanceof Anthropic.APIError) {
      this.logger.error(
        `Error de la API de Claude (status ${error.status}): ${error.message}`,
      );
      return `Error de la API de Claude (status ${error.status}).`;
    }

    const message =
      error instanceof Error
        ? error.message
        : 'Error desconocido llamando a Claude.';
    this.logger.error(`Error inesperado llamando a Claude: ${message}`);
    return message;
  }
}
