import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Analysis } from '../analysis/entities/analysis.entity';
import { buildVerdictGeneratorInput } from './analysis-verdict-input.util';
import {
  toAnalysisTechnicalVerdictResponse,
  AnalysisTechnicalVerdictResponse,
} from './dto/analysis-technical-verdict.dto';
import { AnalysisTechnicalVerdict } from './entities/analysis-technical-verdict.entity';
import { ClaudeTechnicalVerdictGenerator } from './generators/claude-technical-verdict.generator';
import { DeterministicTechnicalVerdictGenerator } from './generators/deterministic-technical-verdict.generator';
import { TechnicalVerdictGenerator } from './generators/technical-verdict-generator.interface';

// Mismo criterio que ANALYSIS_ERROR_MESSAGE_MAX_LENGTH en analysis.service.ts: nunca un stack
// trace completo, solo lo suficiente para diagnosticar por qué falló la generación.
const VERDICT_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * PR 11B: contenido "seguro" para una fila status='failed' — a diferencia de PR 11A (que dejaba
 * verdict/confidence/summary en null), esto le da al frontend algo mostrable sin tener que hacer
 * null-checks especiales por campo. errorMessage (el motivo real, interno) sigue siendo el único
 * campo que varía por error — todo lo demás es fijo y genérico a propósito.
 */
const FAILED_VERDICT_CONTENT = {
  verdict: 'insufficient_data' as const,
  confidence: 'low' as const,
  summary: 'No se pudo generar el veredicto técnico automático.',
  keyFindings: [] as string[],
  possibleCauses: [] as string[],
  recommendations: [] as string[],
  limitations: [
    'El análisis satelital finalizó, pero la interpretación automática no pudo generarse.',
  ] as string[],
};

@Injectable()
export class AnalysisVerdictService {
  private readonly logger = new Logger(AnalysisVerdictService.name);

  constructor(
    @InjectRepository(AnalysisTechnicalVerdict)
    private readonly verdictRepository: Repository<AnalysisTechnicalVerdict>,
    private readonly config: ConfigService,
    private readonly deterministicGenerator: DeterministicTechnicalVerdictGenerator,
    private readonly claudeGenerator: ClaudeTechnicalVerdictGenerator,
  ) {}

  /**
   * PR 11B: TECHNICAL_VERDICT_PROVIDER decide quién genera el veredicto — nunca hardcodeado.
   * Vacía/ausente → deterministic (default seguro, nunca rompe local por falta de env). Valor
   * desconocido → deterministic + warning (nunca tira la app abajo por un typo en el env).
   */
  private resolveGenerator(): TechnicalVerdictGenerator {
    const raw = (this.config.get<string>('TECHNICAL_VERDICT_PROVIDER') ?? '')
      .trim()
      .toLowerCase();

    if (!raw || raw === 'deterministic') {
      return this.deterministicGenerator;
    }

    if (raw === 'claude') {
      return this.claudeGenerator;
    }

    this.logger.warn(
      `TECHNICAL_VERDICT_PROVIDER="${raw}" no reconocido (valores válidos: deterministic, claude) — usando deterministic.`,
    );
    return this.deterministicGenerator;
  }

  /**
   * Llamado desde AnalysisService.processFieldAnalysisInBackground una vez que el Analysis ya se
   * guardó como 'Finalizado' — nunca para un análisis 'Error' (no hay nada que interpretar). Este
   * método nunca propaga una excepción: si el generador (determinístico o Claude) o el guardado
   * fallan, persiste (best-effort) una fila status='failed' y devuelve igual. El caller además
   * envuelve esta llamada en su propio try/catch como cinturón adicional (ver AnalysisService)
   * para que ni siquiera un fallo al guardar el 'failed' pueda tumbar el análisis que sí terminó
   * bien.
   */
  async generateAndPersist(
    analysis: Analysis,
  ): Promise<AnalysisTechnicalVerdict> {
    const generator = this.resolveGenerator();

    try {
      const input = buildVerdictGeneratorInput(analysis);
      const generated = await generator.generate(input);

      const inputSnapshot: Record<string, unknown> = generator.modelId
        ? { ...input, model: generator.modelId }
        : { ...input };

      return await this.saveVerdict(analysis.id, {
        status: 'generated',
        verdict: generated.verdict,
        confidence: generated.confidence,
        summary: generated.summary,
        keyFindings: generated.keyFindings,
        possibleCauses: generated.possibleCauses,
        recommendations: generated.recommendations,
        limitations: generated.limitations,
        inputSnapshot,
        generator: generator.generatorName,
        promptVersion: generator.promptVersion,
        errorMessage: null,
        generatedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo generar el veredicto técnico (analysisId=${analysis.id}, provider=${generator.generatorName}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.saveVerdict(analysis.id, {
        status: 'failed',
        ...FAILED_VERDICT_CONTENT,
        inputSnapshot: null,
        generator: generator.generatorName,
        promptVersion: generator.promptVersion,
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
