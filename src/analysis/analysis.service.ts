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
  async findAll(): Promise<Analysis[]> {
    return this.analysisRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
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
   * Historial de análisis de un campo, en formato liviano (sin resultJson)
   * para no traer zones/timeseries/png en un listado. Los análisis nuevos
   * usan la columna `fieldId` dedicada (scope='field'); los creados antes de
   * esa migración reusaban `lotId` para guardar el fieldId y no tienen scope
   * seteado, así que se mantiene ese fallback para no perder historial viejo.
   */
  async findByField(fieldId: string): Promise<FieldAnalysisSummary[]> {
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

  async getReportPath(id: string): Promise<string> {
    const analysis = await this.findOne(id);

    const reportPath = analysis.resultJson?.report?.htmlPath;

    if (!reportPath) {
      throw new NotFoundException('El análisis no tiene reporte generado.');
    }

    return reportPath;
  }
  async getReportPdfPath(id: string): Promise<string> {
    const analysis = await this.findOne(id);

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
    },
  ): Promise<Analysis> {
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
