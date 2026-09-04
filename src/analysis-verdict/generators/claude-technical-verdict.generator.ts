import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import {
  GeneratedVerdict,
  VerdictGeneratorInput,
} from '../analysis-verdict-generator.util';
import {
  VerdictSafetyValidationError,
  VerdictSafetyValidationReason,
  validateAndNormalizeGeneratedVerdict,
} from './claude-output.validator';
import {
  TECHNICAL_VERDICT_PROMPT_VERSION,
  VERDICT_TOOL,
  VERDICT_TOOL_NAME,
  buildClaudeUserMessage,
  buildCorrectiveInstruction,
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
 * PR 17: máximo 2 llamadas a Anthropic por generación — el intento normal más, únicamente si ese
 * intento fue rechazado por el guardrail de seguridad (VerdictSafetyValidationError), UN único
 * reintento correctivo. Nunca un loop, nunca más de 2: cualquier otro tipo de error (auth, rate
 * limit, red, timeout, "no tool_use", schema/enum inválido) corta en el primer intento porque un
 * segundo intento con el mismo input no lo va a arreglar. Ver generate().
 */
const MAX_ATTEMPTS = 2;

/**
 * PR 11B: implementación real de TechnicalVerdictGenerator sobre Anthropic. Nunca llamada desde
 * el frontend ni desde ningún endpoint manual — solo AnalysisVerdictService.generateAndPersist la
 * invoca (y, desde PR 17, también AdminService.retryTechnicalVerdict para el retry manual — ambos
 * caminos pasan siempre por generateAndPersist, nunca directo), y solo cuando
 * TECHNICAL_VERDICT_PROVIDER=claude (ver ese servicio).
 *
 * Cliente lazy (mismo patrón que EmailService.getTransporter): no se construye ni valida
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

  /**
   * PR 17: intento 1 siempre con el system prompt base. Si validateAndNormalizeGeneratedVerdict
   * tira VerdictSafetyValidationError (y solo en ese caso — ver el catch de abajo), se hace UN
   * único intento 2 agregando buildCorrectiveInstruction() al mismo system prompt base (nunca lo
   * reemplaza ni lo relaja) y reenviando el mismo buildClaudeUserMessage(input) — nunca la
   * respuesta rechazada de Claude, siguiendo la política de "regenerar desde cero con feedback
   * sobre el tipo de fallo". El intento 2 pasa por EXACTAMENTE el mismo
   * validateAndNormalizeGeneratedVerdict, sin bypass: si vuelve a fallar (por seguridad o por
   * cualquier otro motivo), el error se propaga tal cual y queda a cargo de
   * AnalysisVerdictService.generateAndPersist (persiste status='failed', como ya hacía antes de
   * este PR).
   */
  async generate(input: VerdictGeneratorInput): Promise<GeneratedVerdict> {
    const client = this.getClient();
    const timeoutMs = this.resolveTimeoutMs();
    const baseSystemPrompt = buildSystemPrompt();

    let correctiveReason: VerdictSafetyValidationReason | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const system = correctiveReason
        ? `${baseSystemPrompt}\n\n${buildCorrectiveInstruction(correctiveReason)}`
        : baseSystemPrompt;

      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: this.modelId,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            tools: [VERDICT_TOOL],
            tool_choice: { type: 'tool', name: VERDICT_TOOL_NAME },
            messages: [
              { role: 'user', content: buildClaudeUserMessage(input) },
            ],
          },
          { timeout: timeoutMs },
        );
      } catch (error) {
        // Error del SDK (auth/rate-limit/red/timeout/5xx) — nunca reintentable: un segundo
        // intento con el mismo input no lo arregla.
        throw new Error(this.describeSdkError(error));
      }

      const toolUse = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );

      if (!toolUse) {
        // No es un rechazo del guardrail de seguridad — nunca reintentable.
        throw new Error(
          `Claude no devolvió la herramienta esperada (stop_reason=${response.stop_reason}).`,
        );
      }

      try {
        return validateAndNormalizeGeneratedVerdict(toolUse.input);
      } catch (error) {
        if (!(error instanceof VerdictSafetyValidationError)) {
          // Error de forma (enum inválido, summary vacío, JSON no-objeto) — no de estilo: el
          // mismo input le va a dar el mismo resultado, así que reintentar no ayuda.
          throw error;
        }

        const willRetry = attempt < MAX_ATTEMPTS;
        this.logSafetyRejection(input.analysisId, attempt, error.reason, willRetry);

        if (!willRetry) {
          throw error;
        }

        correctiveReason = error.reason;
      }
    }

    // Inalcanzable: el loop siempre retorna (éxito) o tira (SDK, "no tool_use", error de forma, o
    // VerdictSafetyValidationError en el último intento) dentro de su propio cuerpo. Solo está acá
    // para que TS vea una salida exhaustiva de la función.
    throw new Error(
      'No se pudo generar el veredicto técnico tras los intentos permitidos.',
    );
  }

  /**
   * PR 17: única función de logging del retry correctivo. Deliberadamente nunca recibe ni loguea
   * el output rechazado de Claude (toolUse.input) — solo el motivo acotado (reason, un enum de
   * VerdictSafetyValidationReason) y metadata operativa (analysisId/attempt/retrying). Formato
   * legible por humanos y grep-eable en logs, no JSON estructurado — coherente con el resto de
   * los loggers de este módulo (ver describeSdkError).
   */
  private logSafetyRejection(
    analysisId: string | undefined,
    attempt: number,
    reason: VerdictSafetyValidationReason,
    retrying: boolean,
  ): void {
    this.logger.warn(
      `[technical-verdict] safety validation rejected attempt=${attempt} analysisId=${
        analysisId ?? 'unknown'
      } provider=${this.generatorName} reason=${reason} retrying=${retrying}`,
    );
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
