import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { LotsService } from '../lots/lots.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { Analysis } from './entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { FieldAnalysisSummary } from './dto/field-analysis-summary.dto';
@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    private readonly lotsService: LotsService,
    private readonly pythonWorkerService: PythonWorkerService,
    private readonly fieldsService: FieldsService,
  ) {}

  async createForLot(lotId: string): Promise<Analysis> {
    const runningAnalysis = await this.analysisRepository.findOne({
      where: {
        lotId,
        status: 'Procesando',
      },
    });

    if (runningAnalysis) {
      return runningAnalysis;
    }

    const lot = await this.lotsService.findOne(lotId);

    const analysis = this.analysisRepository.create({
      scope: 'lot',
      lotId: lot.id,
      fieldId: null,
      lotName: lot.name,
      status: 'Procesando',
      globalScore: 0,
      category: 'Procesando análisis',
      maxCloudiness: lot.maxCloudiness,
      startDate: lot.startDate,
      endDate: lot.endDate,
      resultJson: null,
    });

    const savedAnalysis = await this.analysisRepository.save(analysis);

    await this.lotsService.markAsProcessing(lot.id, savedAnalysis.id);

    this.runPipeline(savedAnalysis.id, lot.id);

    return savedAnalysis;
  }
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

  getReportPdfPath(analysis: Analysis): string {
    const pdfPath = analysis.resultJson?.report?.pdfPath;

    if (!pdfPath) {
      throw new NotFoundException('El análisis no tiene PDF generado.');
    }

    return pdfPath;
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

      analysis.status = 'Finalizado';
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
        analysis.status = 'Error';
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

  private async runPipeline(analysisId: string, lotId: string): Promise<void> {
    try {
      const input = await this.lotsService.getPipelineInput(lotId);
      const result = await this.pythonWorkerService.runAnalysis(input);

      const analysis = await this.findOne(analysisId);

      analysis.status = 'Finalizado';
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
        // Mismo criterio que fieldId en el flujo de campo: nada lo lee
        // todavía, pero deja el modelo simétrico para cuando haga falta.
        lotId,
      };

      await this.analysisRepository.save(analysis);

      await this.lotsService.markAsFinished(
        lotId,
        analysisId,
        result.globalScore,
      );
    } catch (error) {
      this.logger.error(
        `Pipeline error (analysisId=${analysisId}, lotId=${lotId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      const analysis = await this.analysisRepository.findOne({
        where: { id: analysisId },
      });

      if (analysis) {
        analysis.status = 'Error';
        analysis.category = 'Error al procesar análisis';
        analysis.resultJson = {
          mode: 'error',
          message: 'Error al ejecutar el pipeline.',
          error: error instanceof Error ? error.message : String(error),
          lotId,
        };

        await this.analysisRepository.save(analysis);
      }

      await this.lotsService.markAsError(lotId, analysisId);
    }
  }
}
