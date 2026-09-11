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
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { UserComputeThrottlerGuard } from '../common/guards/user-compute-throttler.guard';
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
  //
  // MEASUREMENT GAP P1-04 ("PDF descargado"): el listener de `finish` se registra ANTES de
  // `stream.pipe(res)` — evita la carrera de que la respuesta pudiera completarse (síncronamente
  // en un mock, o por buffering interno) antes de que el listener exista. Solo `finish` (el
  // servidor terminó de ENTREGAR la respuesta) dispara markPdfDownloaded — nunca se escucha
  // `close`: un cierre prematuro (cliente desconectado antes de `finish`) simplemente nunca
  // dispara nada, y un `close` que llega DESPUÉS de `finish` (comportamiento normal del socket
  // subyacente) tampoco tiene ningún handler que reaccione — no hay dos escrituras que puedan
  // contradecirse porque solo existe una. Si la generación falla o el stream de pdfmake emite un
  // error a mitad de camino, `res.end()` nunca se invoca y `finish` nunca se dispara (comportamiento
  // real de Node: `.pipe()` no propaga errores de la fuente al destino ni lo cierra por su cuenta)
  // — nada que agregar acá para que "stream fallido no marca" ya sea cierto por construcción.
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

    // .once(): defensivo ante un mock/stream defectuoso que emitiera 'finish' más de una vez —
    // el propio UPDATE set-once en el service ya lo garantiza a nivel de datos, esto evita
    // encolar una segunda llamada innecesaria a nivel de proceso. El .catch() es belt-and-suspenders:
    // markPdfDownloaded ya nunca rechaza por su cuenta (try/catch interno, ver el service), pero la
    // respuesta HTTP ya está completa en este punto — ninguna futura regresión de esa garantía
    // interna debe poder convertirse en un unhandled rejection.
    res.once('finish', () => {
      this.analysisService.markPdfDownloaded(analysis.id).catch(() => {});
    });

    stream.pipe(res);
    stream.end();
  }

  // PERF-2: versión liviana para el polling del frontend mientras el análisis está
  // 'Procesando' — nunca trae resultJson (mapAssets/imageSeries pueden pesar varios MB). No
  // hay ambigüedad de ruteo con GET /analysis/:id: los path segments son distintos
  // ('analysis/:id' vs. 'analysis/:id/status'), Express/Nest los resuelve sin conflicto.
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id/status')
  findOneStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.findOneOwnedStatus(id, req.user.sub);
  }

  // PR 11A: incluye technicalVerdict (null mientras no exista) — ver
  // AnalysisService.findOneOwnedWithVerdict para el porqué de que solo esta ruta lo resuelva.
  @UseGuards(JwtAuthGuard)
  @Get('analysis/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.findOneOwnedWithVerdict(id, req.user.sub);
  }

  // MEASUREMENT GAP P1-03: acknowledgement explícito, separado a propósito de GET
  // /analysis/:id — mezclar consumo (GET) con escritura (POST) sobre el mismo endpoint
  // ensuciaría un endpoint que también usan otras superficies (ver AnalysisService.
  // markResultViewed). Nunca devuelve resultJson.
  @UseGuards(JwtAuthGuard)
  @Post('analysis/:id/result-viewed')
  markResultViewed(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.analysisService.markResultViewed(id, req.user.sub);
  }

  // Ruta histórica. El alias 'analysis/field/:fieldId' es el nombre preferido
  // hacia adelante; se mantienen ambas para no romper clientes existentes.
  //
  // SEC-008: rate limit por usuario COMPARTIDO con run-now/weekly-reports (ver
  // UserComputeThrottlerGuard, bucket 'compute') + techo de análisis concurrentes por usuario (ver
  // AnalysisService.assertUserBelowConcurrencyCeiling). @SkipThrottle({default:true}) evita que el
  // bucket 'default' (SEC-003, keyeado por IP) también se evalúe acá — esta ruta usa un único
  // bucket, 'compute', keyeado por usuario.
  @UseGuards(JwtAuthGuard, UserComputeThrottlerGuard)
  @SkipThrottle({ default: true })
  @Throttle({ compute: { limit: 10, ttl: 600_000 } })
  @Post(['field/:fieldId', 'analysis/field/:fieldId'])
  async runFieldAnalysis(
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() body: RunFieldAnalysisDto,
    @Req() req: AuthenticatedRequest,
  ) {
    await this.analysisService.assertUserBelowConcurrencyCeiling(req.user.sub);
    return this.analysisService.runFieldAnalysis(fieldId, body, req.user.sub);
  }
}
