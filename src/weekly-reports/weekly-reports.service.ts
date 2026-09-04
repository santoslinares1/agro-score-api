import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, LessThan, Not, Repository } from 'typeorm';

import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { WeeklyReportWorkerObservation, WeeklyReportWorkerResult } from '../python-worker/types';
import { CreateWeeklyReportDto } from './dto/create-weekly-report.dto';
import { ListWeeklyReportsQueryDto } from './dto/list-weekly-reports-query.dto';
import { WeeklyObservationsQueryDto } from './dto/weekly-observations-query.dto';
import { WeeklyFieldReport } from './entities/weekly-field-report.entity';
import { WeeklyLotIndexObservation } from './entities/weekly-lot-index-observation.entity';
import { computeDeltaDirection } from './weekly-delta.util';
import { computeWeekAnchorDate } from './week-anchor.util';

const METHODOLOGY_VERSION = 'weekly-v1';
const DEFAULT_STEP_DAYS = 7;
const DEFAULT_INDICES = ['NDVI', 'NDMI'];
const ERROR_MESSAGE_MAX_LENGTH = 500;

@Injectable()
export class WeeklyReportsService {
  private readonly logger = new Logger(WeeklyReportsService.name);

  constructor(
    @InjectRepository(WeeklyFieldReport)
    private readonly weeklyReportRepository: Repository<WeeklyFieldReport>,
    @InjectRepository(WeeklyLotIndexObservation)
    private readonly observationRepository: Repository<WeeklyLotIndexObservation>,
    private readonly fieldsService: FieldsService,
    private readonly pythonWorkerService: PythonWorkerService,
  ) {}

  /**
   * Crea (o reutiliza) el WeeklyFieldReport de la semana de campaña resuelta a partir de
   * campaignStart/targetDate, y dispara el pipeline en background — mismo patrón fire-and-forget
   * que AnalysisService.runFieldAnalysis, no bloquea la respuesta HTTP a la corrida completa del
   * worker (que puede tardar minutos, ver PythonWorkerService.runWeeklyReport).
   */
  async create(
    fieldId: string,
    dto: CreateWeeklyReportDto,
    userId: string,
  ): Promise<WeeklyFieldReport> {
    const field = await this.fieldsService.findOne(fieldId, userId);

    const includeNdreExperimental = dto.includeNdreExperimental ?? false;
    const requestedIndices = dto.indices ?? DEFAULT_INDICES;

    if (requestedIndices.includes('NDRE') && !includeNdreExperimental) {
      throw new BadRequestException(
        'NDRE es un índice experimental: para incluirlo en "indices" hay que mandar ' +
          'includeNdreExperimental=true explícitamente.',
      );
    }

    const targetDate = dto.targetDate ?? new Date().toISOString().slice(0, 10);

    if (new Date(dto.campaignStart) > new Date(targetDate)) {
      throw new BadRequestException('campaignStart debe ser anterior o igual a targetDate.');
    }

    if (dto.campaignEnd && new Date(dto.campaignEnd) < new Date(dto.campaignStart)) {
      throw new BadRequestException('campaignEnd debe ser posterior o igual a campaignStart.');
    }

    // Mismo criterio que PythonWorkerService.mapFieldInputToWorkerPayload para /analyze: solo
    // los lotes habilitados para clasificación productiva llegan al worker.
    const includedLots = (field.lots ?? []).filter(
      (lot) => lot.includeInProductivityClassification,
    );

    if (!includedLots.length) {
      throw new BadRequestException(
        'El campo no tiene ningún lote incluido en la clasificación productiva. Habilitá al ' +
          'menos un lote antes de generar un reporte semanal.',
      );
    }

    const weekAnchorDate = computeWeekAnchorDate(dto.campaignStart, targetDate, DEFAULT_STEP_DAYS);

    // No comparar/duplicar la misma semana de campaña (Cambio 4 del handoff de Fase 1): si ya
    // hay un reporte no-failed para este field+semana+versión, se devuelve tal cual en vez de
    // disparar otro — 'failed' queda afuera a propósito para no bloquear un reintento tras un
    // error real (ver unique parcial en la migración).
    const existing = await this.weeklyReportRepository.findOne({
      where: {
        fieldId,
        weekAnchorDate,
        methodologyVersion: METHODOLOGY_VERSION,
        status: Not('failed'),
      },
      order: { createdAt: 'DESC' },
    });

    if (existing) {
      this.logger.warn(
        `Ya existe un WeeklyFieldReport no-failed para fieldId=${fieldId} ` +
          `weekAnchorDate=${weekAnchorDate} (reportId=${existing.id}, status=${existing.status}); ` +
          'no se dispara uno nuevo.',
      );

      return existing;
    }

    const report = this.weeklyReportRepository.create({
      fieldId,
      userId,
      campaignStart: dto.campaignStart,
      campaignEnd: dto.campaignEnd ?? null,
      targetDate,
      weekAnchorDate,
      stepDays: DEFAULT_STEP_DAYS,
      methodologyVersion: METHODOLOGY_VERSION,
      status: 'processing',
      source: 'manual',
      includeNdreExperimental,
      indices: requestedIndices,
      startedAt: new Date(),
    });

    const savedReport = await this.weeklyReportRepository.save(report);

    this.processInBackground(savedReport.id, field, includedLots, {
      campaignStart: dto.campaignStart,
      campaignEnd: dto.campaignEnd ?? null,
      targetDate,
      indices: requestedIndices,
      includeNdreExperimental,
    });

    return savedReport;
  }

  async findAll(
    fieldId: string,
    userId: string,
    query: ListWeeklyReportsQueryDto,
  ): Promise<WeeklyFieldReport[]> {
    await this.fieldsService.findOne(fieldId, userId);

    const where: FindOptionsWhere<WeeklyFieldReport> = { fieldId };

    if (query.campaignStart) {
      where.campaignStart = query.campaignStart;
    }

    if (query.status) {
      where.status = query.status;
    }

    // WeeklyFieldReport no tiene ninguna columna pesada (a diferencia de Analysis.resultJson) —
    // `observations` es una relación separada que TypeORM no trae salvo que se pida
    // explícitamente (ver findOneWithObservations/findLatestCompleted), así que este listado ya
    // es liviano por default sin necesitar una proyección de columnas especial.
    return this.weeklyReportRepository.find({
      where,
      order: { weekAnchorDate: 'DESC' },
      take: query.limit ?? 20,
      skip: query.offset ?? 0,
    });
  }

  async findOneWithObservations(
    fieldId: string,
    reportId: string,
    userId: string,
  ): Promise<WeeklyFieldReport> {
    await this.fieldsService.findOne(fieldId, userId);

    const report = await this.weeklyReportRepository.findOne({
      where: { id: reportId, fieldId },
      relations: { observations: true },
    });

    if (!report) {
      throw new NotFoundException('Reporte semanal no encontrado.');
    }

    return report;
  }

  async findLatestCompleted(fieldId: string, userId: string): Promise<WeeklyFieldReport> {
    await this.fieldsService.findOne(fieldId, userId);

    const report = await this.weeklyReportRepository.findOne({
      where: { fieldId, status: 'completed' },
      order: { weekAnchorDate: 'DESC' },
      relations: { observations: true },
    });

    if (!report) {
      throw new NotFoundException('Todavía no hay un reporte semanal completado para este campo.');
    }

    return report;
  }

  /**
   * Serie temporal filtrable de observaciones (lote x índice x semana). Devuelve la lista plana
   * — agruparla por lote para un gráfico de evolución es una decisión de presentación que queda
   * para el consumidor (frontend), no de esta fase de backend.
   */
  async findObservations(
    fieldId: string,
    userId: string,
    query: WeeklyObservationsQueryDto,
  ): Promise<WeeklyLotIndexObservation[]> {
    await this.fieldsService.findOne(fieldId, userId);

    const qb = this.observationRepository
      .createQueryBuilder('observation')
      .where('observation.fieldId = :fieldId', { fieldId })
      .orderBy('observation.weekAnchorDate', 'ASC');

    if (query.index) {
      qb.andWhere('observation.index = :index', { index: query.index });
    }

    if (query.lotId) {
      qb.andWhere('observation.lotId = :lotId', { lotId: query.lotId });
    }

    if (query.from) {
      qb.andWhere('observation.weekAnchorDate >= :from', { from: query.from });
    }

    if (query.to) {
      qb.andWhere('observation.weekAnchorDate <= :to', { to: query.to });
    }

    if (query.campaignStart) {
      qb.innerJoin('observation.weeklyReport', 'report').andWhere(
        'report.campaignStart = :campaignStart',
        { campaignStart: query.campaignStart },
      );
    }

    return qb.getMany();
  }

  private async processInBackground(
    reportId: string,
    field: Field,
    includedLots: Field['lots'],
    input: {
      campaignStart: string;
      campaignEnd: string | null;
      targetDate: string;
      indices: string[];
      includeNdreExperimental: boolean;
    },
  ): Promise<void> {
    try {
      const result = await this.pythonWorkerService.runWeeklyReport({
        fieldId: field.id,
        lots: includedLots.map((lot) => ({ id: lot.id, name: lot.name, geojson: lot.geojson })),
        campaignStart: input.campaignStart,
        campaignEnd: input.campaignEnd,
        targetDate: input.targetDate,
        indices: input.indices,
        includeNdreExperimental: input.includeNdreExperimental,
      });

      await this.persistResult(reportId, field.id, result);

      this.logger.log(
        `Weekly report finalizado (reportId=${reportId}, fieldId=${field.id}, ` +
          `observations=${result.lots.length}).`,
      );
    } catch (error) {
      await this.markFailed(reportId, error);
    }
  }

  private async persistResult(
    reportId: string,
    fieldId: string,
    result: WeeklyReportWorkerResult,
  ): Promise<void> {
    const observations: WeeklyLotIndexObservation[] = [];

    for (const lotObservation of result.lots) {
      const delta = await this.resolveDelta(fieldId, lotObservation);
      const notes = lotObservation.notes ?? [];
      const rawUnavailableReason = lotObservation.available ? null : (notes[0] ?? null);

      observations.push(
        this.observationRepository.create({
          weeklyReportId: reportId,
          fieldId,
          lotId: lotObservation.lotId,
          lotName: lotObservation.lotName,
          index: lotObservation.index,
          experimental: lotObservation.experimental,
          available: lotObservation.available,
          weekAnchorDate: lotObservation.weekAnchorDate,
          imageDate: lotObservation.imageDate,
          cloudPct: lotObservation.cloudPct,
          scaleM: lotObservation.scaleM,
          mean: lotObservation.stats?.mean ?? null,
          stdDev: lotObservation.stats?.stdDev ?? null,
          min: lotObservation.stats?.min ?? null,
          max: lotObservation.stats?.max ?? null,
          validPixelCount: lotObservation.stats?.validPixelCount ?? null,
          deltaVsPrevious: delta,
          deltaDirection: computeDeltaDirection(delta),
          // RISK-022: la sanitización principal vive en el Worker (weekly.py) — esto es solo un
          // truncado defensivo por longitud, no reemplaza esa sanitización. Ver truncatePublicText.
          unavailableReason: rawUnavailableReason ? this.truncatePublicText(rawUnavailableReason) : null,
          // metadata.notes conserva el array completo tal cual lo manda el Worker: una vez
          // sanitizado en origen, este campo queda seguro automáticamente sin tocarlo acá.
          metadata:
            notes.length || lotObservation.scaleWarning
              ? { notes, scaleWarning: lotObservation.scaleWarning }
              : null,
        }),
      );
    }

    if (observations.length) {
      await this.observationRepository.save(observations);
    }

    await this.weeklyReportRepository.update(reportId, {
      status: 'completed',
      completedAt: new Date(),
      warnings: result.warnings?.length
        ? result.warnings.map((warning) => this.truncatePublicText(warning))
        : null,
      errorMessage: null,
    });
  }

  /**
   * Si el worker manda deltaVsPrevious, se respeta (nunca se recalcula por encima). Si no (el
   * caso normal hoy — ver nota en WeeklyLotIndexObservation.deltaVsPrevious), se calcula contra
   * la observación anterior real ya persistida para el mismo fieldId+lotId+index, filtrando por
   * weekAnchorDate estrictamente anterior — nunca compara la semana contra sí misma.
   */
  private async resolveDelta(
    fieldId: string,
    lotObservation: WeeklyReportWorkerObservation,
  ): Promise<number | null> {
    if (lotObservation.deltaVsPrevious !== null && lotObservation.deltaVsPrevious !== undefined) {
      return lotObservation.deltaVsPrevious;
    }

    const currentMean = lotObservation.stats?.mean;

    if (currentMean === null || currentMean === undefined) {
      return null;
    }

    const previous = await this.observationRepository.findOne({
      where: {
        fieldId,
        lotId: lotObservation.lotId ?? IsNull(),
        index: lotObservation.index,
        weekAnchorDate: LessThan(lotObservation.weekAnchorDate),
        mean: Not(IsNull()),
      },
      order: { weekAnchorDate: 'DESC' },
    });

    if (!previous || previous.mean === null) {
      return null;
    }

    return Number((currentMean - previous.mean).toFixed(6));
  }

  private async markFailed(reportId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);

    this.logger.error(`Weekly report pipeline error (reportId=${reportId}): ${message}`);

    await this.weeklyReportRepository.update(reportId, {
      status: 'failed',
      failedAt: new Date(),
      errorMessage: this.truncatePublicText(message),
    });
  }

  /**
   * Truncado defensivo para texto persistido y expuesto al usuario (errorMessage,
   * unavailableReason, warnings). NO es la sanitización principal de RISK-022 — esa vive en el
   * origen, en agro-score-worker/app/pipeline/weekly.py — es solo una red de seguridad ante un
   * futuro cambio del Worker que reintroduzca contenido largo o crudo. Mismo límite que
   * AnalysisService.summarizeError() para Analysis.errorMessage.
   */
  private truncatePublicText(text: string): string {
    return text.length > ERROR_MESSAGE_MAX_LENGTH
      ? `${text.slice(0, ERROR_MESSAGE_MAX_LENGTH)}…`
      : text;
  }
}
