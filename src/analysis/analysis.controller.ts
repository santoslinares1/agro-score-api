import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { AnalysisService } from './analysis.service';
import { RunFieldAnalysisDto } from './dto/run-field-analysis.dto';

@Controller()
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post('lots/:lotId/analysis')
  createForLot(@Param('lotId', ParseUUIDPipe) lotId: string) {
    return this.analysisService.createForLot(lotId);
  }

  @Get('analysis')
  findAll() {
    return this.analysisService.findAll();
  }

  @Get('analysis/field/:fieldId')
  findByField(@Param('fieldId', ParseUUIDPipe) fieldId: string) {
    return this.analysisService.findByField(fieldId);
  }

  @Get('analysis/:id/report')
  async getReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const reportPath = await this.analysisService.getReportPath(id);

    if (!existsSync(reportPath)) {
      throw new NotFoundException('El archivo de reporte no existe.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="agro-score-report-${id}.html"`,
    );

    return createReadStream(reportPath).pipe(res);
  }
  @Get('analysis/:id/report/download')
  async downloadReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const reportPath = await this.analysisService.getReportPath(id);

    if (!existsSync(reportPath)) {
      throw new NotFoundException('El archivo de reporte no existe.');
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="agro-score-report-${id}.html"`,
    );

    return createReadStream(reportPath).pipe(res);
  }
  @Get('analysis/:id/report/pdf')
  async downloadPdfReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const pdfPath = await this.analysisService.getReportPdfPath(id);

    if (!existsSync(pdfPath)) {
      throw new NotFoundException('El archivo PDF no existe.');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="agro-score-report-${id}.pdf"`,
    );

    return createReadStream(pdfPath).pipe(res);
  }

  @Get('analysis/:id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.analysisService.findOne(id);
  }

  // Ruta histórica. El alias 'analysis/field/:fieldId' es el nombre preferido
  // hacia adelante; se mantienen ambas para no romper clientes existentes.
  @Post(['field/:fieldId', 'analysis/field/:fieldId'])
  runFieldAnalysis(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() body: RunFieldAnalysisDto,
  ) {
    return this.analysisService.runFieldAnalysis(fieldId, body);
  }
}
