import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Analysis } from '../analysis/entities/analysis.entity';
import { generateTechnicalVerdict } from './analysis-verdict-generator.util';
import { buildVerdictGeneratorInput } from './analysis-verdict-input.util';
import {
  toAnalysisTechnicalVerdictResponse,
  AnalysisTechnicalVerdictResponse,
} from './dto/analysis-technical-verdict.dto';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';

/** PR 11A: sin Claude/IA real todavía — ver docs/audits o el PR de integración con Anthropic. */
export const DETERMINISTIC_GENERATOR_NAME = 'deterministic-v1';

// Mismo criterio que ANALYSIS_ERROR_MESSAGE_MAX_LENGTH en analysis.service.ts: nunca un stack
// trace completo, solo lo suficiente para diagnosticar por qué falló la generación.
const VERDICT_ERROR_MESSAGE_MAX_LENGTH = 500;

@Injectable()
export class AnalysisVerdictService {
  private readonly logger = new Logger(AnalysisVerdictService.name);

  constructor(
    @InjectRepository(AnalysisTechnicalVerdict)
    private readonly verdictRepository: Repository<AnalysisTechnicalVerdict>,
  ) {}

  /**
   * Llamado desde AnalysisService.processFieldAnalysisInBackground una vez que el Analysis ya se
   * guardó como 'Finalizado' — nunca para un análisis 'Error' (no hay nada que interpretar). Este
   * método nunca propaga una excepción: si el generador determinístico o el guardado fallan,
   * persiste (best-effort) una fila status='failed' y devuelve igual. El caller además envuelve
   * esta llamada en su propio try/catch como cinturón adicional (ver AnalysisService) para que ni
   * siquiera un fallo al guardar el 'failed' pueda tumbar el análisis que sí terminó bien.
   */
  async generateAndPersist(
    analysis: Analysis,
  ): Promise<AnalysisTechnicalVerdict> {
    try {
      const input = buildVerdictGeneratorInput(analysis);
      const generated = generateTechnicalVerdict(input);

      return await this.saveVerdict(analysis.id, {
        status: 'generated',
        verdict: generated.verdict,
        confidence: generated.confidence,
        summary: generated.summary,
        keyFindings: generated.keyFindings,
        possibleCauses: generated.possibleCauses,
        recommendations: generated.recommendations,
        limitations: generated.limitations,
        inputSnapshot: input as unknown as Record<string, unknown>,
        generator: DETERMINISTIC_GENERATOR_NAME,
        promptVersion: null,
        errorMessage: null,
        generatedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo generar el veredicto técnico (analysisId=${analysis.id}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.saveVerdict(analysis.id, {
        status: 'failed',
        verdict: null,
        confidence: null,
        summary: null,
        keyFindings: [],
        possibleCauses: [],
        recommendations: [],
        limitations: [],
        inputSnapshot: null,
        generator: DETERMINISTIC_GENERATOR_NAME,
        promptVersion: null,
        errorMessage: this.summarizeError(error),
        generatedAt: null,
      });
    }
  }

  /**
   * find-then-merge en vez de create ciego: idempotente si alguna vez se vuelve a generar un
   * veredicto para el mismo analysisId (p.ej. un reintento real del pipeline en un PR futuro) —
   * actualiza la fila existente en vez de violar el unique(analysisId).
   */
  private async saveVerdict(
    analysisId: string,
    data: Omit<Partial<AnalysisTechnicalVerdict>, 'id' | 'analysisId'>,
  ): Promise<AnalysisTechnicalVerdict> {
    const existing = await this.verdictRepository.findOne({
      where: { analysisId },
    });

    const entity = existing
      ? this.verdictRepository.merge(existing, data)
      : this.verdictRepository.create({ analysisId, ...data });

    return this.verdictRepository.save(entity);
  }

  private summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    return message.length > VERDICT_ERROR_MESSAGE_MAX_LENGTH
      ? `${message.slice(0, VERDICT_ERROR_MESSAGE_MAX_LENGTH)}…`
      : message;
  }

  /** Usado por AnalysisService.findOneOwnedWithVerdict para armar GET /analysis/:id. */
  async findResponseByAnalysisId(
    analysisId: string,
  ): Promise<AnalysisTechnicalVerdictResponse | null> {
    const verdict = await this.verdictRepository.findOne({
      where: { analysisId },
    });

    return verdict ? toAnalysisTechnicalVerdictResponse(verdict) : null;
  }
}
