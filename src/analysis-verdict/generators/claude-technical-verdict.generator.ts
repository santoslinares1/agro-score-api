import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import {
  GeneratedVerdict,
  VerdictGeneratorInput,
} from '../analysis-verdict-generator.util';
import { validateAndNormalizeGeneratedVerdict } from './claude-output.validator';
import {
  TECHNICAL_VERDICT_PROMPT_VERSION,
  VERDICT_TOOL,
  VERDICT_TOOL_NAME,
  buildClaudeUserMessage,
  buildSystemPrompt,
} from './technical-verdict-prompt';
import { TechnicalVerdictGenerator } from './technical-verdict-generator.interface';

export const GENERATOR_NAME = 'claude';

/**
 * PR 11B: la fecha suplantada en el PR era claude-3-5-haiku-latest (modelo Claude 3.5,
 * retirado) — se usa acá el equivalente vigente de gama Haiku. Configurable vía ANTHROPIC_MODEL,
 * este valor es solo el fallback si esa env var no está seteada.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';
export const DEFAULT_ANTHROPIC_TIMEOUT_MS = 20_000;

// Salida corta (JSON estructurado, ver VERDICT_TOOL) — no necesita el default de ~16000 de
// requests de texto libre.
const MAX_OUTPUT_TOKENS = 4096;

/**
 * PR 11B: implementación real de TechnicalVerdictGenerator sobre Anthropic. Nunca llamada desde
 * el frontend ni desde ningún endpoint manual — solo AnalysisVerdictService.generateAndPersist la
 * invoca, y solo cuando TECHNICAL_VERDICT_PROVIDER=claude (ver ese servicio).
 *
 * Cliente lazy (mismo patrón que EmailService.getResendClient): no se construye ni valida
 * ANTHROPIC_API_KEY en el constructor, así que el boot de la app nunca falla por esta env var —
 * el error (si falta) sale recién acá, dentro de generate(), y queda contenido por el try/catch
 * de AnalysisVerdictService.generateAndPersist (persiste status='failed', el análisis sigue
 * Finalizado).
 */
@Injectable()
export class ClaudeTechnicalVerdictGenerator implements TechnicalVerdictGenerator {
  private readonly logger = new Logger(ClaudeTechnicalVerdictGenerator.name);
  private client: Anthropic | null = null;

  readonly generatorName = GENERATOR_NAME;
  readonly promptVersion = TECHNICAL_VERDICT_PROMPT_VERSION;
  readonly modelId: string;

  constructor(private readonly config: ConfigService) {
    this.modelId =
      this.config.get<string>('ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL;
  }

  async generate(input: VerdictGeneratorInput): Promise<GeneratedVerdict> {
    const client = this.getClient();
    const timeoutMs = this.resolveTimeoutMs();

    let response: Anthropic.Message;
    try {
      response = await client.messages.create(
        {
          model: this.modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: buildSystemPrompt(),
          tools: [VERDICT_TOOL],
          tool_choice: { type: 'tool', name: VERDICT_TOOL_NAME },
          messages: [{ role: 'user', content: buildClaudeUserMessage(input) }],
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

    return validateAndNormalizeGeneratedVerdict(toolUse.input);
  }

  private getClient(): Anthropic {
    if (this.client) {
      return this.client;
    }

    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY no está configurada (requerida cuando TECHNICAL_VERDICT_PROVIDER=claude).',
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

  /**
   * Cadena más-específico-primero (nunca un catch genérico) — ver shared/error-codes.md del
   * skill claude-api. El mensaje devuelto es lo único que termina en
   * AnalysisTechnicalVerdict.errorMessage: nunca incluye la API key ni el objeto de error crudo,
   * solo la categoría + lo mínimo para diagnosticar.
   */
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
