import {
  Body,
  Controller,
  Get,
  GoneException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { AnalysisService } from './analysis.service';
import { RunFieldAnalysisDto } from './dto/run-field-analysis.dto';

type AuthenticatedRequest = Request & { user: AuthenticatedUser };

@Controller()
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  // AUTH-5: el módulo `lots` top-level (sin relación a Field/User) queda
  // deprecado — no hay ownership que validar y la preferencia de producto
  // es no mantener dos modelos paralelos. Bloqueado antes de tocar
  // lotId/worker/DB: ni siquiera consulta si el lot existe.
  @UseGuards(JwtAuthGuard)
  @Post('lots/:lotId/analysis')
  createForLot(@Param('lotId', ParseUUIDPipe) _lotId: string): never {
    throw new GoneException(
      'El análisis legacy por lote fue reemplazado por análisis por campo (POST /analysis/field/:fieldId).',
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('analysis')
  findAll(@Req() req: AuthenticatedRequest) {
    return this.analysisService.findAll(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Get('analysis/field/:fieldId')
  findByField(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.findByField(fieldId, req.user.sub);
  }

  // AUTH-4: las tres rutas de reporte pasan por findOneOwned antes de tocar
  // el filesystem — mismo gate de ownership que GET /analysis/:id, nunca un
  // findOne "pelado". Si el análisis no tiene Field verificable del usuario,
  // findOneOwned tira 404 antes de llegar a leer ningún archivo.
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id/report')
  async getReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const analysis = await this.analysisService.findOneOwned(id, req.user.sub);
    const reportPath = this.analysisService.getReportPath(analysis);

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

  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id/report/download')
  async downloadReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const analysis = await this.analysisService.findOneOwned(id, req.user.sub);
    const reportPath = this.analysisService.getReportPath(analysis);

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

  // PDF-1: genera el PDF real desde los datos del análisis ya validado por ownership — no
  // depende de resultJson.report.pdfPath ni de ningún archivo report.pdf en disco generado
  // por otro proceso (ver ReportPdfService).
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id/report/pdf')
  async downloadPdfReport(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const analysis = await this.analysisService.findOneOwned(id, req.user.sub);
    const { stream, filename } = await this.analysisService.buildReportPdf(
      analysis,
      req.user.sub,
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    stream.pipe(res);
    stream.end();
  }

  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.findOneOwned(id, req.user.sub);
  }

  // Ruta histórica. El alias 'analysis/field/:fieldId' es el nombre preferido
  // hacia adelante; se mantienen ambas para no romper clientes existentes.
  @UseGuards(JwtAuthGuard)
  @Post(['field/:fieldId', 'analysis/field/:fieldId'])
  runFieldAnalysis(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() body: RunFieldAnalysisDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.runFieldAnalysis(fieldId, body, req.user.sub);
  }
}
