import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LotsService } from '../lots/lots.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { Analysis } from './entities/analysis.entity';

@Injectable()
export class AnalysisService {
  constructor(
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    private readonly lotsService: LotsService,
    private readonly pythonWorkerService: PythonWorkerService,
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
      lotId: lot.id,
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
      analysis.resultJson = result.resultJson;

      await this.analysisRepository.save(analysis);

      await this.lotsService.markAsFinished(
        lotId,
        analysisId,
        result.globalScore,
      );
    }  catch (error) {
      console.error('Pipeline error:', error);
    
      const analysis = await this.findOne(analysisId);
    
      analysis.status = 'Error';
      analysis.category = 'Error al procesar análisis';
      analysis.resultJson = {
        mode: 'error',
        message: 'Error al ejecutar el pipeline.',
        error: error instanceof Error ? error.message : String(error),
      };
    
      await this.analysisRepository.save(analysis);
      await this.lotsService.markAsError(lotId, analysisId);
    }
  }
}