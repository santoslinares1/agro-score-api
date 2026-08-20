import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { Analysis } from './entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { AnalysisStatusDto } from './dto/analysis-status.dto';
import { FieldAnalysisSummary } from './dto/field-analysis-summary.dto';
import { ReportPdfService } from './report-pdf/report-pdf.service';

/**
 * PERF-2: columnas que selecciona GET /analysis/:id/status — deliberadamente nunca incluye
 * `resultJson` (jsonb que puede pesar varios MB con mapAssets/imageSeries, ver auditoría
 * PERF-2). No es una lista de "qué esconder de la respuesta": es qué se le pide a Postgres,
 * así que el jsonb pesado ni siquiera sale de la base de datos durante el polling.
 */
const ANALYSIS_STATUS_COLUMNS = [
  'analysis.id',
  'analysis.status',
  'analysis.scope',
  'analysis.fieldId',
  'analysis.lotId',
  'analysis.createdAt',
  'analysis.updatedAt',
  'analysis.startedAt',
  'analysis.completedAt',
  'analysis.failedAt',
  'analysis.durationMs',
  'analysis.errorMessage',
  'analysis.globalScore',
  'analysis.productivityScore',
  'analysis.stabilityScore',
  'analysis.confidenceScore',
];

// ADMIN-1: cota para errorMessage — nunca stack traces completos ni datos
// sensibles, solo lo suficiente para que el panel admin muestre qué pasó.
const ANALYSIS_ERROR_MESSAGE_MAX_LENGTH = 500;

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    private readonly pythonWorkerService: PythonWorkerService,
    private readonly fieldsService: FieldsService,
    private readonly reportPdfService: ReportPdfService,
  ) {}

  /**
   * Solo devuelve análisis cuyo Field es del usuario autenticado (scope
   * 'field', o legacy scope=null con el fieldId guardado en lotId — ver
   * resolveOwnedFieldId). Los análisis de lote legacy (scope='lot', sin
   * relación a Field/User) quedan afuera de la lista: no hay owner
   * verificable, así que no se listan para nadie (AUTH-3).
   */
  async findAll(userId: string): Promise<Analysis[]> {
    return this.analysisRepository
      .createQueryBuilder('analysis')
      .innerJoin(
        Field,
        'field',
        `(analysis.scope = :fieldScope AND field.id::text = analysis."fieldId") OR ` +
          `(analysis.scope IS NULL AND field.id::text = analysis."lotId")`,
        { fieldScope: 'field' },
      )
      .where('field."userId" = :userId', { userId })
      .orderBy('analysis.createdAt', 'DESC')
      .getMany();
  }

  async findOne(id: string): Promise<Analysis> {
    const analysis = await this.analysisRepository.findOne({
      where: { id },
    });

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    return analysis;
  }

  /**
   * Resuelve a qué Field pertenece (verificablemente) un análisis, o null
   * si no hay ninguno. Reglas (AUTH-3):
   * - scope='field': el dueño es fieldId.
   * - scope=null (legacy, de antes de que existiera la columna scope): el
   *   fieldId histórico se guardaba en lotId — solo cuenta si scope es
   *   explícitamente null, nunca para scope='lot'.
   * - scope='lot' (análisis de lote standalone, módulo `lots` top-level sin
   *   relación a Field/User) u otro cualquier caso: no hay Field que
   *   resolver → null. Bloqueado por default, ver findOneOwned.
   */
  private resolveOwnedFieldId(analysis: Analysis): string | null {
    if (analysis.scope === 'field') {
      return analysis.fieldId;
    }

    if (analysis.scope === null && analysis.lotId) {
      return analysis.lotId;
    }

    return null;
  }

  /**
   * Igual que `findOne`, pero valida ownership antes de devolver el
   * análisis. Default-deny (AUTH-3): si no se puede resolver un Field real
   * y verificable para este análisis (ver resolveOwnedFieldId), se bloquea
   * con 404 genérico sin importar quién pregunte — nunca "autenticado
   * entonces puede verlo". Esto cierra el hueco de los análisis de lote
   * legacy (scope='lot') que antes se devolvían sin ningún chequeo.
   */
  async findOneOwned(id: string, userId: string): Promise<Analysis> {
    const analysis = await this.findOne(id);

    const fieldId = this.resolveOwnedFieldId(analysis);

    if (!fieldId) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    const field = await this.fieldsService.findOne(fieldId, userId).catch(() => null);

    if (!field) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    return analysis;
  }

  /**
   * PERF-2: versión liviana de findOneOwned para GET /analysis/:id/status — mismo chequeo de
   * ownership (AUTH-3/AUTH-4, default-deny vía resolveOwnedFieldId), pero la query a Postgres
   * solo trae ANALYSIS_STATUS_COLUMNS: resultJson (y todo lo que cuelga de él — mapAssets,
   * imageSeries, zones) nunca se lee de la base de datos ni viaja al proceso Node, no solo se
   * omite al responder. Pensado para el polling del frontend mientras status='Procesando'.
   */
  async findOneOwnedStatus(id: string, userId: string): Promise<AnalysisStatusDto> {
    const analysis = await this.analysisRepository
      .createQueryBuilder('analysis')
      .select(ANALYSIS_STATUS_COLUMNS)
      .where('analysis.id = :id', { id })
      .getOne();

    if (!analysis) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    const fieldId = this.resolveOwnedFieldId(analysis);

    if (!fieldId) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    const field = await this.fieldsService.findOne(fieldId, userId).catch(() => null);

    if (!field) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    return {
      id: analysis.id,
      status: analysis.status,
      scope: analysis.scope,
      fieldId: analysis.fieldId,
      lotId: analysis.lotId,
      createdAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      startedAt: analysis.startedAt,
      completedAt: analysis.completedAt,
      failedAt: analysis.failedAt,
      durationMs: analysis.durationMs,
      errorMessage: analysis.errorMessage,
      globalScore: analysis.globalScore,
      productivityScore: analysis.productivityScore,
      stabilityScore: analysis.stabilityScore,
      confidenceScore: analysis.confidenceScore,
    };
  }

  /**
   * Historial de análisis de un campo, en formato liviano (sin resultJson)
   * para no traer zones/timeseries/png en un listado. Los análisis nuevos
   * usan la columna `fieldId` dedicada (scope='field'); los creados antes de
   * esa migración reusaban `lotId` para guardar el fieldId y no tienen scope
   * seteado, así que se mantiene ese fallback para no perder historial viejo.
   *
   * AUTH-3: este endpoint no tenía ningún chequeo de ownership (bug
   * encontrado en la auditoría, no estaba en el alcance original de
   * AUTH-1). Ahora exige que el Field sea del usuario autenticado, mismo
   * patrón que runFieldAnalysis.
   */
  async findByField(fieldId: string, userId: string): Promise<FieldAnalysisSummary[]> {
    await this.fieldsService.findOne(fieldId, userId);

    const analyses = await this.analysisRepository.find({
      where: [
        { fieldId, scope: 'field' },
        { lotId: fieldId, scope: IsNull() },
      ],
      order: { createdAt: 'DESC' },
    });

    return analyses.map((analysis) => ({
      id: analysis.id,
      status: analysis.status,
      scope: analysis.scope,
      fieldId: analysis.fieldId,
      lotId: analysis.lotId,
      createdAt: analysis.createdAt,
      updatedAt: analysis.updatedAt,
      globalScore: analysis.globalScore,
      category: analysis.category,
      startDate: analysis.startDate,
      endDate: analysis.endDate,
      classificationScope: analysis.resultJson?.classificationScope ?? null,
      indexUsed: (analysis.resultJson?.indexUsed as string | undefined) ?? null,
    }));
  }

  /**
   * AUTH-4: recibe el analysis ya validado por ownership (findOneOwned) en
   * vez de un id — así ninguna ruta de reporte puede terminar leyendo un
   * analysis sin pasar por el chequeo de dueño.
   */
  getReportPath(analysis: Analysis): string {
    const reportPath = analysis.resultJson?.report?.htmlPath;

    if (!reportPath) {
      throw new NotFoundException('El análisis no tiene reporte generado.');
    }

    return reportPath;
  }

  /**
   * PDF-1: reemplaza el viejo getReportPdfPath (leía report.pdfPath, un archivo en disco que
   * ningún proceso llegó a generar nunca). Recibe el analysis ya validado por ownership
   * (findOneOwned) y vuelve a resolver+validar el Field dueño acá — mismo gate AUTH-4 que el
   * resto de las rutas de reporte, nunca genera el PDF antes de confirmar ownership.
   */
  async buildReportPdf(
    analysis: Analysis,
    userId: string,
  ): Promise<{ stream: NodeJS.ReadableStream & { end(): void }; filename: string }> {
    const fieldId = this.resolveOwnedFieldId(analysis);

    if (!fieldId) {
      throw new NotFoundException('El análisis no tiene reporte generado.');
    }

    const field = await this.fieldsService.findOne(fieldId, userId);

    return this.reportPdfService.build(analysis, field);
  }

  async runFieldAnalysis(
    fieldId: string,
    input: {
      startDate: string;
      endDate: string;
      maxCloudiness: number;
      indices?: string[];
      zoneIndices?: string[];
      indexImageIndices?: string[];
      includeMapAssets?: boolean;
      includeIndexImages?: boolean;
      includeImageSeries?: boolean;
      maxZoneCampaigns?: number;
    },
    userId: string,
  ): Promise<Analysis> {
    // Lanza NotFoundException si el campo no existe o no es del usuario.
    await this.fieldsService.findOne(fieldId, userId);

    if (new Date(input.startDate) > new Date(input.endDate)) {
      throw new BadRequestException(
        'La fecha de inicio debe ser anterior o igual a la fecha de fin.',
      );
    }

    const runningAnalysis = await this.analysisRepository.findOne({
      where: [
        { fieldId, scope: 'field', status: 'Procesando' },
        { lotId: fieldId, scope: IsNull(), status: 'Procesando' },
      ],
    });

    if (runningAnalysis) {
      this.logger.warn(
        `Ya hay un análisis en curso para fieldId=${fieldId} (analysisId=${runningAnalysis.id}); no se dispara uno nuevo.`,
      );

      return runningAnalysis;
    }

    const fieldInput = await this.fieldsService.getPipelineInput(fieldId);

    const hasIncludedLot = fieldInput.lots.some(
      (lot) => lot.includeInProductivityClassification,
    );

    if (!hasIncludedLot) {
      throw new BadRequestException(
        'El campo no tiene ningún lote incluido en la clasificación productiva. Habilitá al menos un lote antes de analizar.',
      );
    }

    this.logger.log(
      `Iniciando análisis de campo fieldId=${fieldId} (${fieldInput.lots.length} lotes en el input).`,
    );

    const analysis = this.analysisRepository.create({
      scope: 'field',
      fieldId: fieldInput.fieldId,
      lotId: null,
      lotName: fieldInput.name,
      status: 'Procesando',
      startedAt: new Date(),
      maxCloudiness: input.maxCloudiness,
      startDate: input.startDate,
      endDate: input.endDate,
      resultJson: {
        mode: 'python-worker-v2',
        message: 'Análisis de campo en procesamiento.',
        fieldId,
        lots: fieldInput.lots.map((lot) => ({
          id: lot.id,
          name: lot.name,
          areaHa: lot.areaHa,
          includeInProductivityClassification:
            lot.includeInProductivityClassification,
        })),
      },
    });

    const savedAnalysis = await this.analysisRepository.save(analysis);

    this.processFieldAnalysisInBackground(savedAnalysis.id, fieldId, {
      ...fieldInput,
      startDate: input.startDate,
      endDate: input.endDate,
      maxCloudiness: input.maxCloudiness,
      indices: input.indices,
      zoneIndices: input.zoneIndices,
      indexImageIndices: input.indexImageIndices,
      includeMapAssets: input.includeMapAssets,
      includeIndexImages: input.includeIndexImages,
      includeImageSeries: input.includeImageSeries,
      maxZoneCampaigns: input.maxZoneCampaigns,
    });

    return savedAnalysis;
  }
  private async processFieldAnalysisInBackground(
    analysisId: string,
    fieldId: string,
    fieldInput: {
      fieldId: string;
      name: string;
      location?: string;
      startDate: string;
      endDate: string;
      maxCloudiness: number;
      indices?: string[];
      zoneIndices?: string[];
      indexImageIndices?: string[];
      includeMapAssets?: boolean;
      includeIndexImages?: boolean;
      includeImageSeries?: boolean;
      maxZoneCampaigns?: number;
      lots: Array<{
        id: string;
        name: string;
        geojson: unknown;
        areaHa: number;
        includeInProductivityClassification: boolean;
      }>;
    },
  ): Promise<void> {
    try {
      const result =
        await this.pythonWorkerService.runFieldAnalysis(fieldInput);

      const analysis = await this.findOne(analysisId);

      const completedAt = new Date();

      analysis.status = 'Finalizado';
      analysis.completedAt = completedAt;
      analysis.durationMs = this.computeDurationMs(
        analysis.startedAt,
        completedAt,
      );
      analysis.errorMessage = null;
      analysis.globalScore = result.globalScore;
      analysis.category = result.category;
      analysis.confidenceScore = result.confidenceScore;
      analysis.productivityScore = result.productivityScore;
      analysis.stabilityScore = result.stabilityScore;
      analysis.soilScore = result.soilScore;
      analysis.climateScore = result.climateScore;
      analysis.ndviAverageMax = result.ndviAverageMax;
      analysis.ndviVariability = result.ndviVariability;
      analysis.zonesDetected = result.zonesDetected;
      analysis.resultJson = {
        ...result.resultJson,
        fieldId,
        fieldLots: fieldInput.lots.map((lot) => ({
          id: lot.id,
          name: lot.name,
          areaHa: lot.areaHa,
          includeInProductivityClassification:
            lot.includeInProductivityClassification,
        })),
      };

      await this.analysisRepository.save(analysis);

      this.logger.log(
        `Análisis de campo finalizado (analysisId=${analysisId}, fieldId=${fieldId}, ` +
          `classificationScope=${result.resultJson?.classificationScope ?? 'n/a'}).`,
      );
    } catch (error) {
      this.logger.error(
        `Field pipeline error (analysisId=${analysisId}, fieldId=${fieldId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const analysis = await this.analysisRepository.findOne({
        where: { id: analysisId },
      });

      if (analysis) {
        const failedAt = new Date();

        analysis.status = 'Error';
        analysis.failedAt = failedAt;
        analysis.durationMs = this.computeDurationMs(
          analysis.startedAt,
          failedAt,
        );
        analysis.errorMessage = this.summarizeError(error);
        analysis.category = 'Error al procesar análisis de campo';
        analysis.resultJson = {
          mode: 'error',
          message: 'Error al ejecutar el pipeline de campo.',
          error: error instanceof Error ? error.message : String(error),
          // Sin esto, el frontend no puede distinguir un análisis de campo
          // errado de uno de lote único (isFieldAnalysis se basa en
          // resultJson.fieldId) y el botón "Volver" queda mal armado.
          fieldId,
        };

        await this.analysisRepository.save(analysis);
      }
    }
  }

  /**
   * ADMIN-1: análisis viejos sin startedAt (creados antes de esta migración)
   * no tienen forma real de calcular duración — se deja null en vez de
   * inventar un número con createdAt como sustituto.
   */
  private computeDurationMs(startedAt: Date | null, endedAt: Date): number | null {
    if (!startedAt) {
      return null;
    }

    return endedAt.getTime() - new Date(startedAt).getTime();
  }

  private summarizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);

    return message.length > ANALYSIS_ERROR_MESSAGE_MAX_LENGTH
      ? `${message.slice(0, ANALYSIS_ERROR_MESSAGE_MAX_LENGTH)}…`
      : message;
  }
}
