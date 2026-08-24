import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';

import { Analysis } from '../analysis/entities/analysis.entity';
import { FieldsService } from '../fields/fields.service';
import { WeeklyAnalysisSnapshot } from './entities/weekly-analysis-snapshot.entity';
import { ScheduledAnalysisRun } from './entities/scheduled-analysis-run.entity';
import { classifyDataQuality, extractSnapshotMetrics } from './weekly-analysis-snapshot-metrics.util';
import { compareWeeklySnapshots, SnapshotComparisonInput } from './weekly-analysis-snapshot-comparison.util';

export interface ListWeeklyAnalysisSnapshotsQuery {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
}

const DEFAULT_LIST_LIMIT = 12;
const MAX_LIST_LIMIT = 52; // ~un año de snapshots semanales — cota razonable, no arbitraria.

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
}

function toComparisonInput(snapshot: WeeklyAnalysisSnapshot): SnapshotComparisonInput {
  return {
    id: snapshot.id,
    weekStart: snapshot.weekStart,
    weekEnd: snapshot.weekEnd,
    score: snapshot.score,
    ndviMean: snapshot.ndviMean,
    ndmiMean: snapshot.ndmiMean,
    dominantZone: snapshot.dominantZone,
    analyzedAreaHa: snapshot.analyzedAreaHa,
    dataQualityStatus: snapshot.dataQualityStatus,
    hasRgbImage: snapshot.hasRgbImage,
    hasNdviImage: snapshot.hasNdviImage,
    hasNdmiImage: snapshot.hasNdmiImage,
  };
}

/**
 * Fase 5: crea y consulta snapshots semanales comparativos derivados de Analysis.resultJson —
 * nunca dispara cálculo nuevo, nunca toca Analysis ni weekly-reports. Separado deliberadamente de
 * FieldAnalysisScheduleService/ScheduledAnalysisRunnerService: este servicio no sabe nada de
 * scheduling ni de email, solo de "dado un Analysis Finalizado, guardar y comparar su resumen".
 */
@Injectable()
export class WeeklyAnalysisSnapshotService {
  private readonly logger = new Logger(WeeklyAnalysisSnapshotService.name);

  constructor(
    @InjectRepository(WeeklyAnalysisSnapshot)
    private readonly snapshotRepository: Repository<WeeklyAnalysisSnapshot>,
    private readonly fieldsService: FieldsService,
  ) {}

  /**
   * Llamado desde ScheduledAnalysisRunnerService.reconcileRun cuando un Analysis llega a
   * 'Finalizado' — nunca desde un análisis 'Error' (el caller ya lo garantiza). Idempotente por
   * unique(fieldId, weekStart, weekEnd): si dos ticks del reconciler se solapan y ambos intentan
   * crear el snapshot de la misma semana, el segundo recupera el ya creado por el primero en vez
   * de fallar.
   */
  async createFromAnalysis(run: ScheduledAnalysisRun, analysis: Analysis): Promise<WeeklyAnalysisSnapshot> {
    const metrics = extractSnapshotMetrics(analysis.resultJson);
    const quality = classifyDataQuality(metrics);

    // "Anterior" = el snapshot más reciente del mismo campo cuya semana ya terminó antes de que
    // termine la actual (weekEnd < current.weekEnd) — así una corrida manual fuera de orden no
    // termina comparándose contra sí misma ni contra una semana futura.
    const previous = await this.snapshotRepository.findOne({
      where: { fieldId: run.fieldId, weekEnd: LessThan(analysis.endDate) },
      order: { weekEnd: 'DESC' },
    });

    const current: SnapshotComparisonInput = {
      id: '', // se completa después de guardar — la comparación no depende del id propio.
      weekStart: analysis.startDate,
      weekEnd: analysis.endDate,
      score: analysis.globalScore ?? null,
      ndviMean: metrics.ndviMean,
      ndmiMean: metrics.ndmiMean,
      dominantZone: metrics.dominantZone,
      analyzedAreaHa: metrics.analyzedAreaHa,
      dataQualityStatus: quality.status,
      hasRgbImage: metrics.hasRgbImage,
      hasNdviImage: metrics.hasNdviImage,
      hasNdmiImage: metrics.hasNdmiImage,
    };

    const comparisonVsPrevious = compareWeeklySnapshots(current, previous ? toComparisonInput(previous) : null);

    const snapshot = this.snapshotRepository.create({
      fieldId: run.fieldId,
      userId: run.userId,
      analysisId: analysis.id,
      scheduledRunId: run.id,
      weekStart: analysis.startDate,
      weekEnd: analysis.endDate,
      source: 'scheduled_analysis',
      score: current.score,
      scoreLabel: analysis.category ?? null,
      analyzedAreaHa: metrics.analyzedAreaHa,
      lotCount: metrics.lotCount,
      dominantZone: metrics.dominantZone,
      dominantZonePercentage: metrics.dominantZonePercentage,
      ndviMean: metrics.ndviMean,
      ndmiMean: metrics.ndmiMean,
      hasRgbImage: metrics.hasRgbImage,
      hasNdviImage: metrics.hasNdviImage,
      hasNdmiImage: metrics.hasNdmiImage,
      hasImageSeries: metrics.hasImageSeries,
      hasEnoughData: quality.hasEnoughData,
      dataQualityStatus: quality.status,
      limitations: quality.limitations,
      comparisonVsPrevious: comparisonVsPrevious as unknown as Record<string, unknown>,
      metrics: null,
    });

    try {
      return await this.snapshotRepository.save(snapshot);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const existing = await this.snapshotRepository.findOne({
        where: { fieldId: run.fieldId, weekStart: analysis.startDate, weekEnd: analysis.endDate },
      });

      if (existing) {
        this.logger.warn(
          `[weekly-analysis-snapshot] ya existía un snapshot para fieldId=${run.fieldId} semana ${analysis.startDate}→${analysis.endDate} (carrera de reconciler) — se reutiliza.`,
        );
        return existing;
      }

      throw error;
    }
  }

  async findByScheduledRunId(scheduledRunId: string): Promise<WeeklyAnalysisSnapshot | null> {
    return this.snapshotRepository.findOne({ where: { scheduledRunId } });
  }

  async findByField(
    fieldId: string,
    userId: string,
    query: ListWeeklyAnalysisSnapshotsQuery = {},
  ): Promise<WeeklyAnalysisSnapshot[]> {
    await this.fieldsService.findOne(fieldId, userId);

    const limit = Math.min(query.limit && query.limit > 0 ? query.limit : DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = query.offset && query.offset > 0 ? query.offset : 0;

    const where: Record<string, unknown> = { fieldId };
    if (query.from) {
      where.weekStart = MoreThanOrEqual(query.from);
    }
    if (query.to) {
      where.weekEnd = LessThanOrEqual(query.to);
    }

    return this.snapshotRepository.find({
      where,
      order: { weekEnd: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  async findLatest(fieldId: string, userId: string): Promise<WeeklyAnalysisSnapshot> {
    await this.fieldsService.findOne(fieldId, userId);

    const snapshot = await this.snapshotRepository.findOne({
      where: { fieldId },
      order: { weekEnd: 'DESC' },
    });

    if (!snapshot) {
      throw new NotFoundException('Todavía no hay reportes semanales comparativos para este campo.');
    }

    return snapshot;
  }

  async findOne(fieldId: string, snapshotId: string, userId: string): Promise<WeeklyAnalysisSnapshot> {
    await this.fieldsService.findOne(fieldId, userId);

    const snapshot = await this.snapshotRepository.findOne({ where: { id: snapshotId, fieldId } });

    if (!snapshot) {
      throw new NotFoundException('Reporte semanal no encontrado.');
    }

    return snapshot;
  }
}
