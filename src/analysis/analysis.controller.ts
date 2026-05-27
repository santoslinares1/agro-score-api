import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { AnalysisService } from './analysis.service';

@Controller()
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post('lots/:lotId/analysis')
  createForLot(@Param('lotId') lotId: string) {
    return this.analysisService.createForLot(lotId);
  }

  @Get('analysis')
  findAll() {
    return this.analysisService.findAll();
  }

  @Get('analysis/:id/report')
  async getReport(@Param('id') id: string, @Res() res: Response) {
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
  async downloadReport(@Param('id') id: string, @Res() res: Response) {
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
  async downloadPdfReport(@Param('id') id: string, @Res() res: Response) {
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
  findOne(@Param('id') id: string) {
    return this.analysisService.findOne(id);
  }
}