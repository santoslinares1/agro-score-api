import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { WeeklyAnalysisSnapshot } from '../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import { buildWeeklyVerdictGeneratorInput } from './weekly-technical-verdict-input.util';
import { WeeklyVerdictIndividualContext } from './weekly-technical-verdict-generator.util';
import {
  toWeeklyTechnicalVerdictResponse,
  WeeklyTechnicalVerdictResponse,
} from './dto/weekly-technical-verdict.dto';
import { WeeklyTechnicalVerdict } from './entities/weekly-technical-verdict.entity';
import { ClaudeWeeklyTechnicalVerdictGenerator } from './generators/claude-weekly-technical-verdict.generator';
import { DeterministicWeeklyTechnicalVerdictGenerator } from './generators/deterministic-weekly-technical-verdict.generator';
import { WeeklyTechnicalVerdictGenerator } from './generators/weekly-technical-verdict-generator.interface';

// Mismo criterio que VERDICT_ERROR_MESSAGE_MAX_LENGTH en analysis-verdict.service.ts.
const WEEKLY_VERDICT_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * PR 16B: contenido "seguro" para una fila status='failed' — mismo criterio que
 * FAILED_VERDICT_CONTENT en analysis-verdict.service.ts: nunca deja al futuro consumidor
 * (mail/admin, PR 16C/16D) con campos null que obliguen a null-checks especiales. `verdict`/
 * `trend`='insufficient_data' en vez de null, misma filosofía que el veredicto individual.
 */
const FAILED_WEEKLY_VERDICT_CONTENT = {
  verdict: 'insufficient_data' as const,
  trend: 'insufficient_data' as const,
  confidence: 'low' as const,
  summary: 'No se pudo generar el diagnóstico semanal automático.',
  keyChanges: [] as string[],
  areasToReview: [] as string[],
  recommendations: [] as string[],
  limitations: [
    'El reporte semanal se generó correctamente, pero la interpretación automática de la evolución no pudo generarse.',
  ] as string[],
};

export interface GenerateWeeklyVerdictContext {
  fieldName: string | null;
  individualVerdict: WeeklyVerdictIndividualContext | null;
}

@Injectable()
export class WeeklyTechnicalVerdictService {
  private readonly logger = new Logger(WeeklyTechnicalVerdictService.name);

  constructor(
    @InjectRepository(WeeklyTechnicalVerdict)
    private readonly verdictRepository: Repository<WeeklyTechnicalVerdict>,
    private readonly config: ConfigService,
    private readonly deterministicGenerator: DeterministicWeeklyTechnicalVerdictGenerator,
    private readonly claudeGenerator: ClaudeWeeklyTechnicalVerdictGenerator,
  ) {}

  /**
   * PR 16A, sección 9: env separado de TECHNICAL_VERDICT_PROVIDER a propósito — permite apagar
   * solo el diagnóstico semanal (feature nueva) sin tocar el veredicto individual (ya estable en
   * producción). Misma semántica de resolución que AnalysisVerdictService.resolveGenerator: vacía
   * o desconocida cae a deterministic con warning, nunca rompe.
   */
  private resolveGenerator(): WeeklyTechnicalVerdictGenerator {
    const raw = (
      this.config.get<string>('WEEKLY_TECHNICAL_VERDICT_PROVIDER') ?? ''
    )
      .trim()
      .toLowerCase();

    if (!raw || raw === 'deterministic') {
      return this.deterministicGenerator;
    }

    if (raw === 'claude') {
      return this.claudeGenerator;
    }

    this.logger.warn(
      `WEEKLY_TECHNICAL_VERDICT_PROVIDER="${raw}" no reconocido (valores válidos: deterministic, claude) — usando deterministic.`,
    );
    return this.deterministicGenerator;
  }

  /**
   * Llamado desde ScheduledAnalysisRunnerService.reconcileRun, justo después de
   * WeeklyAnalysisSnapshotService.createFromAnalysis — nunca antes de que exista el snapshot. Best
   * effort igual que AnalysisVerdictService.generateAndPersist: si el generador falla, persiste
   * (best-effort) una fila status='failed' y devuelve igual, nunca deja pasar la excepción del
   * generador. Si hasta guardar la fila 'failed' falla (infraestructura), sí propaga — el caller
   * (reconcileRun) ya tiene su propio try/catch como red adicional, mismo patrón que el snapshot.
   */
  async generateAndPersist(
    snapshot: WeeklyAnalysisSnapshot,
    context: GenerateWeeklyVerdictContext,
  ): Promise<WeeklyTechnicalVerdict> {
    const generator = this.resolveGenerator();

    try {
      const input = buildWeeklyVerdictGeneratorInput(
        snapshot,
        context.fieldName,
        context.individualVerdict,
      );
      const generated = await generator.generate(input);

      const inputSnapshot: Record<string, unknown> = generator.modelId
        ? { ...input, model: generator.modelId }
        : { ...input };

      return await this.saveVerdict(snapshot.id, {
        status: 'generated',
        verdict: generated.verdict,
        trend: generated.trend,
        confidence: generated.confidence,
        summary: generated.summary,
        keyChanges: generated.keyChanges,
        areasToReview: generated.areasToReview,
        recommendations: generated.recommendations,
        limitations: generated.limitations,
        previousSnapshotId: input.previousSnapshotId,
        inputSnapshot,
        generator: generator.generatorName,
        promptVersion: generator.promptVersion,
        analysisId: snapshot.analysisId,
        scheduledRunId: snapshot.scheduledRunId,
        errorMessage: null,
        generatedAt: new Date(),
      });
    } catch (error) {
      this.logger.error(
        `No se pudo generar el diagnóstico semanal (snapshotId=${snapshot.id}, provider=${generator.generatorName}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return this.saveVerdict(snapshot.id, {
        status: 'failed',
        ...FAILED_WEEKLY_VERDICT_CONTENT,
        previousSnapshotId: null,
        inputSnapshot: null,
        generator: generator.generatorName,
        promptVersion: generator.promptVersion,
        analysisId: snapshot.analysisId,
        scheduledRunId: snapshot.scheduledRunId,
        errorMessage: this.summarizeError(error),
        generatedAt: null,
      });
    }
  }

  /** find-then-merge — idempotente si alguna vez se vuelve a generar para el mismo snapshotId,
   * mismo patrón que AnalysisVerdictService.saveVerdict (unique(snapshotId), nunca viola el
   * constraint). */
  private async saveVerdict(
    snapshotId: string,
    data: Omit<Partial<WeeklyTechnicalVerdict>, 'id' | 'snapshotId'>,
  ): Promise<WeeklyTechnicalVerdict> {
    const existing = await this.verdictRepository.findOne({
      where: { snapshotId },
    });

    const entity = existing
      ? this.verdictRepository.merge(existing, data)
      : this.verdictRepository.create({ snapshotId, ...data });

    return this.verdictRepository.save(entity);
  }

  private summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    return message.length > WEEKLY_VERDICT_ERROR_MESSAGE_MAX_LENGTH
      ? `${message.slice(0, WEEKLY_VERDICT_ERROR_MESSAGE_MAX_LENGTH)}…`
      : message;
  }

  async findResponseBySnapshotId(
    snapshotId: string,
  ): Promise<WeeklyTechnicalVerdictResponse | null> {
    const verdict = await this.verdictRepository.findOne({
      where: { snapshotId },
    });

    return verdict ? toWeeklyTechnicalVerdictResponse(verdict) : null;
  }

  /** Batch (nunca N+1) — pensado para PR 16D (admin Programados), mismo patrón que
   * AdminService.getTechnicalVerdictsByAnalysisId (PR 13A/13B): una sola query con `IN`, mapeada a
   * Map<snapshotId, respuesta> para lookup O(1). No usado todavía por ningún caller (PR 16B es
   * solo backend), pero queda listo para no repetir este patrón después. */
  async findResponsesBySnapshotIds(
    snapshotIds: string[],
  ): Promise<Map<string, WeeklyTechnicalVerdictResponse>> {
    if (!snapshotIds.length) {
      return new Map();
    }

    const verdicts = await this.verdictRepository.find({
      where: { snapshotId: In(snapshotIds) },
    });

    return new Map(
      verdicts.map((verdict) => [
        verdict.snapshotId,
        toWeeklyTechnicalVerdictResponse(verdict),
      ]),
    );
  }

  /**
   * PR 16D: admin Programados solo tiene a mano `scheduledRunId` (vía
   * AdminService.getLatestRunsByScheduleId), no `snapshotId` — WeeklyTechnicalVerdict ya
   * denormaliza scheduledRunId (mismo criterio que analysisId, ver la entidad), así que esto
   * resuelve todo en una sola query `IN` sin tener que pasar por WeeklyAnalysisSnapshot primero.
   * Mismo patrón batch que findResponsesBySnapshotIds.
   */
  async findResponsesByScheduledRunIds(
    scheduledRunIds: string[],
  ): Promise<Map<string, WeeklyTechnicalVerdictResponse>> {
    if (!scheduledRunIds.length) {
      return new Map();
    }

    const verdicts = await this.verdictRepository.find({
      where: { scheduledRunId: In(scheduledRunIds) },
    });

    return new Map(
      verdicts
        .filter(
          (
            verdict,
          ): verdict is WeeklyTechnicalVerdict & { scheduledRunId: string } =>
            verdict.scheduledRunId !== null,
        )
        .map((verdict) => [
          verdict.scheduledRunId,
          toWeeklyTechnicalVerdictResponse(verdict),
        ]),
    );
  }
}
