import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { ANALYSIS_QUEUE_CONFIG } from '../analysis-queue/analysis-queue.config';
import type { AnalysisQueueConfig } from '../analysis-queue/analysis-queue.config';
import {
  ANALYSIS_EXECUTE_JOB,
  ANALYSIS_JOB_CONTRACT_VERSION,
  AnalysisJobTrigger,
  buildAnalysisExecutePayload,
} from '../analysis-queue/analysis-job.contract';
import {
  AnalysisInputSnapshot,
  AnalysisInputSnapshotLot,
  buildAnalysisInputSnapshot,
  summarizeSnapshotLots,
} from '../analysis-queue/analysis-input-snapshot';
import { WorkerAnalysisResult } from '../python-worker/types';
import {
  daysBetweenIsoDates,
  MAX_ANALYSIS_DATE_RANGE_DAYS,
  MAX_CONCURRENT_ANALYSES_PER_USER,
} from './analysis-constraints';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import {
  ANALYSIS_STALE_THRESHOLD_MS,
  isAnalysisStale,
  StaleAnalysisCandidate,
} from './analysis-stale.util';
import { Analysis, AnalysisStatus } from './entities/analysis.entity';
import { Field } from '../fields/entities/field.entity';
import { FieldsService } from '../fields/fields.service';
import { AnalysisStatusDto } from './dto/analysis-status.dto';
import { FieldAnalysisSummary } from './dto/field-analysis-summary.dto';
import { ReportPdfService } from './report-pdf/report-pdf.service';
import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
import { AnalysisTechnicalVerdictResponse } from '../analysis-verdict/dto/analysis-technical-verdict.dto';

export type AnalysisWithTechnicalVerdict = Analysis & {
  technicalVerdict: AnalysisTechnicalVerdictResponse | null;
};

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

/**
 * OPS-1: mensaje persistido cuando un Analysis 'Procesando' se marca 'Error' por staleness (ver
 * isAnalysisStale/ANALYSIS_STALE_THRESHOLD_MS) — nunca afirma una causa concreta (reinicio,
 * crash, etc.) porque no se conoce con certeza; solo describe el hecho observable: superó el
 * tiempo máximo esperado sin resolverse.
 */
const ANALYSIS_STALE_ERROR_MESSAGE =
  'El análisis superó el tiempo máximo de procesamiento y fue marcado automáticamente como Error.';

/**
 * ADR-001: ON CONFLICT del camino encolado — mismo target/predicado EXACTO que
 * UQ_analysis_running_per_field desde la migración 1789200000000 (Queued + Procesando). El camino
 * legacy conserva su predicado original (`status = 'Procesando'`), que Postgres sigue pudiendo
 * inferir contra el índice nuevo (lo implica) y también contra el índice anterior — así la versión
 * legacy funciona antes y después de migrar.
 */
const QUEUED_UPSERT_CONFLICT_CLAUSE = `
      ON CONFLICT (COALESCE("fieldId", "lotId"))
      WHERE "status" IN ('Queued', 'Procesando') AND ("scope" = 'field' OR "scope" IS NULL)
      DO UPDATE SET "id" = "analysis"."id"
      RETURNING (xmax = 0) AS inserted, *`;

const LEGACY_UPSERT_CONFLICT_CLAUSE = `
      ON CONFLICT (COALESCE("fieldId", "lotId"))
      WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
      DO UPDATE SET "id" = "analysis"."id"
      RETURNING (xmax = 0) AS inserted, *`;

export type RunFieldAnalysisInput = {
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
  clientRequestId?: string;
};

/** ADR-001: quién origina el análisis — viaja como metadata de entrega en outbox/job. */
export type RunFieldAnalysisOptions = {
  trigger?: AnalysisJobTrigger;
  scheduledRunId?: string;
};

/**
 * ADR-001: contexto del camino encolado. `prepared` es el resultado de capturar el snapshot ANTES
 * de abrir la transacción: si falló, el error se relanza DENTRO de la transacción únicamente si
 * esta request efectivamente insertó la fila (así se revierte todo: Analysis, asociación de
 * clientRequestId y outbox), y se ignora si la request solo reutiliza un Analysis existente
 * (mismo comportamiento de dedupe/idempotencia que el camino legacy).
 */
type QueuedEnqueueContext = {
  prepared: { snapshot: AnalysisInputSnapshot } | { error: unknown };
  userId: string;
  trigger: AnalysisJobTrigger;
  scheduledRunId?: string;
};

export type ActiveFieldAnalysis = {
  id: string;
  status: AnalysisStatus;
  startedAt: Date | null;
  createdAt: Date;
  hasDurableExecution: boolean;
};

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectRepository(Analysis)
    private readonly analysisRepository: Repository<Analysis>,
    private readonly pythonWorkerService: PythonWorkerService,
    private readonly fieldsService: FieldsService,
    private readonly reportPdfService: ReportPdfService,
    private readonly analysisVerdictService: AnalysisVerdictService,
    // ADR-001: @Optional para no romper instanciaciones directas existentes (specs e2e): sin
    // config, la cola queda deshabilitada y el comportamiento es el legacy.
    @Optional()
    @Inject(ANALYSIS_QUEUE_CONFIG)
    private readonly queueConfig?: AnalysisQueueConfig,
  ) {}

  /**
   * ADR-001: ¿esta solicitud debe encolarse de forma durable? Manual: ANALYSIS_QUEUE_ENABLED.
   * Semanal: además ANALYSIS_QUEUE_WEEKLY_ENABLED (se habilita en un paso posterior del rollout).
   */
  isQueueEnabledFor(trigger: AnalysisJobTrigger): boolean {
    if (!this.queueConfig?.enabled) {
      return false;
    }

    return trigger === 'weekly' ? this.queueConfig.weeklyEnabled : true;
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

    const field = await this.fieldsService
      .findOne(fieldId, userId)
      .catch(() => null);

    if (!field) {
      throw new NotFoundException('Análisis no encontrado.');
    }

    return analysis;
  }

  /**
   * PR 11A: versión de findOneOwned para GET /analysis/:id que además adjunta el veredicto
   * técnico (technicalVerdict) — la pantalla de resultado hace un único fetch acá una vez que
   * /analysis/:id/status reporta 'Finalizado'. Las rutas de reporte HTML siguen usando
   * findOneOwned "pelado" para no pagar esta consulta extra cuando no la necesitan; el PDF
   * (PR 11D) la resuelve por separado dentro de buildReportPdf, ver más abajo.
   *
   * technicalVerdict es null si todavía no existe fila (análisis 'Procesando', o 'Error' — nunca
   * se genera veredicto para un análisis que no terminó bien, ver AnalysisService.
   * processFieldAnalysisInBackground). No es un estado paralelo a analysis.status: el frontend
   * decide qué mostrar combinando ambos.
   */
  async findOneOwnedWithVerdict(
    id: string,
    userId: string,
  ): Promise<AnalysisWithTechnicalVerdict> {
    const analysis = await this.findOneOwned(id, userId);
    const technicalVerdict =
      await this.analysisVerdictService.findResponseByAnalysisId(analysis.id);

    return { ...analysis, technicalVerdict };
  }

  /**
   * MEASUREMENT GAP P1-03 ("Resultado técnico consultado") — POST /analysis/:id/result-viewed.
   * Confirma que un usuario con ownership recibió y aceptó el resultado completo de un Analysis
   * 'Finalizado' en la pantalla principal (nunca desde polling, report preview o PDF — eso lo
   * decide el caller Web, ver AnalysisResultComponent). Mismo gate de ownership que findOneOwned
   * (AUTH-3/AUTH-4, sin una segunda regla) — 404 genérico si el análisis no existe o no es del
   * usuario, idéntico a cualquier otra ruta de /analysis/:id.
   *
   * Nunca acepta un Analysis 'Procesando'/'Error': Web solo llama a esto después de un
   * GET /analysis/:id exitoso, que a su vez el frontend solo dispara cuando el status liviano ya
   * reportó 'Finalizado' — si de todos modos llega para un análisis que no está Finalizado (un
   * caller directo al endpoint, no el flujo real), se rechaza en vez de escribir cualquier cosa.
   *
   * Set-once atómico: el UPDATE de abajo lleva su propio guard
   * `"firstResultViewedAt" IS NULL` en el WHERE — una sola sentencia SQL es atómica de por sí en
   * Postgres, así que ante dos llamadas concurrentes (doble tab, retry de red) como máximo UNA
   * efectivamente escribe; la otra no encuentra fila que matchee (ya no es NULL) y no hace nada,
   * sin necesitar una transacción explícita ni un lock. El timestamp es SIEMPRE `now()` de
   * Postgres (nunca `new Date()` de Node ni nada provisto por el cliente) — no hay ningún
   * parámetro de timestamp en la firma del método, así que ningún caller puede inyectar uno.
   * Después de la escritura se relee el valor ya commiteado (gane o no la carrera esta llamada
   * puntual) — la respuesta refleja siempre el estado real en DB, nunca un valor fabricado
   * localmente.
   */
  async markResultViewed(
    id: string,
    userId: string,
  ): Promise<{ firstResultViewedAt: string }> {
    const analysis = await this.findOneOwned(id, userId);

    if (analysis.status !== 'Finalizado') {
      throw new BadRequestException(
        'Solo se puede confirmar la vista del resultado de un análisis finalizado.',
      );
    }

    await this.analysisRepository
      .createQueryBuilder()
      .update(Analysis)
      .set({ firstResultViewedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('"firstResultViewedAt" IS NULL')
      .execute();

    const current = await this.analysisRepository.findOne({
      where: { id },
      select: { id: true, firstResultViewedAt: true },
    });

    if (!current?.firstResultViewedAt) {
      // No debería ser alcanzable: el UPDATE de arriba, si no escribió porque otra llamada ya
      // había ganado la carrera, implica que ESA otra llamada ya deja la columna poblada. Un
      // valor todavía null acá señala un bug real — mejor un error explícito que fabricar un
      // timestamp local para no romper la respuesta.
      throw new Error(
        `No se pudo confirmar ni leer firstResultViewedAt para analysisId=${id} tras el UPDATE set-once.`,
      );
    }

    return { firstResultViewedAt: current.firstResultViewedAt.toISOString() };
  }

  /**
   * MEASUREMENT GAP P1-04 ("PDF descargado"). Marca, best-effort y set-once, que el servidor
   * completó con éxito una respuesta PDF para este Analysis.
   *
   * FRONTERA DELIBERADA: a diferencia de markResultViewed, este método NO valida ownership por
   * su cuenta — confía en que el único caller real (AnalysisController.downloadPdfReport) ya
   * validó ownership (findOneOwned) y generó el PDF (buildReportPdf) ANTES de que la respuesta
   * HTTP llegara a su evento `finish`, que es lo único que dispara esta llamada. No expone
   * ningún dato del Analysis ni acepta un timestamp — el único efecto posible de invocarlo fuera
   * de ese flujo es una fila con un timestamp de más en una columna que, por sí sola, no revela
   * nada. No convertir esto en un endpoint ni en un método público de propósito general: sigue
   * existiendo únicamente para ese caller.
   *
   * Nunca lanza: cualquier fallo de la escritura (SQL, conexión) se registra internamente y se
   * resuelve en silencio — para cuando esto corre, la respuesta HTTP YA se completó (`finish` ya
   * emitió), así que ningún fallo de esta señal puede ni debe convertirse en un error HTTP ni
   * reabrir una respuesta ya cerrada.
   */
  async markPdfDownloaded(analysisId: string): Promise<void> {
    try {
      // Mismo patrón atómico set-once que markResultViewed: una sola sentencia UPDATE guardada
      // por "IS NULL" en el WHERE, sin transacción/lock explícito — Postgres serializa cualquier
      // carrera real (dos descargas concurrentes) a nivel de fila.
      await this.analysisRepository
        .createQueryBuilder()
        .update(Analysis)
        .set({ firstPdfDownloadedAt: () => 'now()' })
        .where('id = :id', { id: analysisId })
        .andWhere('"firstPdfDownloadedAt" IS NULL')
        .execute();
    } catch (error) {
      this.logger.error(
        `No se pudo persistir firstPdfDownloadedAt para analysisId=${analysisId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * PERF-2: versión liviana de findOneOwned para GET /analysis/:id/status — mismo chequeo de
   * ownership (AUTH-3/AUTH-4, default-deny vía resolveOwnedFieldId), pero la query a Postgres
   * solo trae ANALYSIS_STATUS_COLUMNS: resultJson (y todo lo que cuelga de él — mapAssets,
   * imageSeries, zones) nunca se lee de la base de datos ni viaja al proceso Node, no solo se
   * omite al responder. Pensado para el polling del frontend mientras status='Procesando'.
   */
  async findOneOwnedStatus(
    id: string,
    userId: string,
  ): Promise<AnalysisStatusDto> {
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

    const field = await this.fieldsService
      .findOne(fieldId, userId)
      .catch(() => null);

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
  async findByField(
    fieldId: string,
    userId: string,
  ): Promise<FieldAnalysisSummary[]> {
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
      // F01: dataAvailability.globalScore ausente (análisis previos al fix del worker) se trata
      // como disponible — mismo criterio que isVigorDataAvailable en report-pdf.helpers.ts. Nunca
      // se deduce de globalScore===0 ni de category: solo de esta señal explícita.
      globalScoreAvailable: analysis.resultJson?.dataAvailability?.globalScore !== false,
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
   *
   * PR 11D: además resuelve el technicalVerdict ya persistido (nunca lo regenera) para que
   * ReportPdfService pueda incluir la sección "Veredicto técnico" — consulta separada en vez de
   * usar findOneOwnedWithVerdict, porque acá ya se parte de un `analysis` que el caller resolvió
   * de otra forma (ver AnalysisController.downloadPdfReport).
   */
  async buildReportPdf(
    analysis: Analysis,
    userId: string,
  ): Promise<{
    stream: NodeJS.ReadableStream & { end(): void };
    filename: string;
  }> {
    const fieldId = this.resolveOwnedFieldId(analysis);

    if (!fieldId) {
      throw new NotFoundException('El análisis no tiene reporte generado.');
    }

    const field = await this.fieldsService.findOne(fieldId, userId);
    const technicalVerdict =
      await this.analysisVerdictService.findResponseByAnalysisId(analysis.id);

    return this.reportPdfService.build(analysis, field, technicalVerdict);
  }

  /**
   * SEC-008: techo de análisis 'Procesando' simultáneos por usuario (ver
   * MAX_CONCURRENT_ANALYSES_PER_USER en analysis-constraints.ts) — cierra el abuso multi-campo que
   * UQ_analysis_running_per_field no cubre (ese índice es por-campo, nunca supo cuántos campos
   * distintos tiene el mismo dueño).
   *
   * Llamado EXPLÍCITAMENTE por los callers manuales (AnalysisController.runFieldAnalysis,
   * ScheduledAnalysisRunnerService.runNow) — NUNCA desde adentro de runFieldAnalysis/triggerRun. A
   * propósito: runFieldAnalysis es también el método que usa el dispatcher automático
   * (processDueSchedules, @Interval), que dispara los schedules vencidos de un usuario
   * SECUENCIALMENTE. Si este techo viviera dentro de runFieldAnalysis, una cuenta con más campos
   * programados que MAX_CONCURRENT_ANALYSES_PER_USER vería sus propios schedules automáticos
   * fallar entre sí la misma noche — una regresión funcional real, no abuso. Manteniendo el chequeo
   * en el caller, el dispatcher automático queda estructuralmente afuera, igual que ya queda afuera
   * de cualquier guard HTTP (no pasa por ningún controller).
   *
   * Atomicidad — carrera conocida y aceptada (no cerrada con lock): dos requests concurrentes del
   * mismo usuario para dos campos distintos podrían ambas leer un count por debajo del techo y
   * pasar, superándolo transitoriamente. No se cierra con pg_advisory_xact_lock porque solo
   * serviría sostenido hasta el INSERT atómico per-campo (que puede ocurrir mucho después,
   * getPipelineInput mediante) — eso exigiría pasar el mismo manager hasta adentro de
   * runAtomicUpsert/resolveOrCreateByClientRequestId, arriesgando el mecanismo per-campo ya
   * probado (6 specs e2e) por una ganancia marginal. Este techo es un gobernador de negocio, no una
   * garantía de integridad como UQ_analysis_running_per_field: superarlo en 1-2 no duplica nada, se
   * autocorrige en cuanto cualquiera de los análisis en curso termina, y el rate limit por usuario
   * en los mismos entry points (ver UserComputeThrottlerGuard) ya acota, de forma independiente,
   * cuántos requests concurrentes pueden siquiera llegar hasta acá.
   *
   * Borde conocido y aceptado: si el usuario reenvía un request para un campo que YA tiene un
   * 'Procesando' propio (doble click, retry de cliente), esto puede rechazarlo igual si está en el
   * techo por OTROS campos, aunque ese request en particular no fuera a consumir un slot nuevo.
   * Caso raro y de bajo impacto (429 claro, reintentable) — no se resuelve acá para no mezclar esta
   * lógica con el dedupe per-campo, que ya vive correctamente más abajo.
   */
  async assertUserBelowConcurrencyCeiling(userId: string): Promise<void> {
    const runningCount = await this.countRunningAnalysesForUser(userId);

    if (runningCount >= MAX_CONCURRENT_ANALYSES_PER_USER) {
      throw new HttpException(
        'Ya tenés varios análisis en curso. Esperá a que alguno termine antes de iniciar otro.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Analysis no tiene columna userId propia — la ownership se resuelve vía Field.userId. Mismo
   * predicado que UQ_analysis_running_per_field (ADR-001: status IN ('Queued','Procesando') AND
   * (scope='field' OR scope IS NULL) — un análisis encolado ya consume un slot del techo) — cuenta exactamente lo que ese índice protege, nunca filas scope='lot' del módulo
   * legacy (bloqueado en AUTH-5, GoneException, no puede crear filas nuevas).
   */
  private async countRunningAnalysesForUser(userId: string): Promise<number> {
    const rows: Array<{ count: string }> = await this.analysisRepository.query(
      `SELECT COUNT(*)::int AS count
       FROM "analysis" a
       INNER JOIN "fields" f ON f."id" = a."fieldId"
       WHERE f."userId" = $1
         AND a."status" IN ('Queued', 'Procesando')
         AND (a."scope" = 'field' OR a."scope" IS NULL)`,
      [userId],
    );

    return Number(rows[0]?.count ?? 0);
  }

  async runFieldAnalysis(
    fieldId: string,
    input: RunFieldAnalysisInput,
    userId: string,
    options: RunFieldAnalysisOptions = {},
  ): Promise<Analysis> {
    // Lanza NotFoundException si el campo no existe o no es del usuario. F04 (revisión
    // independiente, ronda 2): se captura `field` (antes se descartaba) porque provee lotName/
    // resultJson.lots para el INSERT atómico de más abajo SIN depender de getPipelineInput — ver
    // el comentario junto a ese INSERT para el porqué.
    const field = await this.fieldsService.findOne(fieldId, userId);

    // OPS-2: rechaza también la igualdad (antes solo `>`). El Worker exige end > start
    // estrictamente (limits.py: `if end <= start: raise ...`) — permitir startDate === endDate
    // acá dejaba crear un Analysis=Procesando que el Worker siempre terminaba rechazando
    // (RISK-005). No hay evidencia en el código de una necesidad real de análisis de un solo día.
    if (new Date(input.startDate) >= new Date(input.endDate)) {
      throw new BadRequestException(
        'La fecha de inicio debe ser estrictamente anterior a la fecha de fin.',
      );
    }

    // F02: mismo criterio que el chequeo de orden de arriba — rechaza ACÁ, antes de crear
    // cualquier Analysis o tocar el Worker, un rango que el Worker (limits.py, RISK-055) siempre
    // va a rechazar de todos modos. Antes, el recorrido predeterminado de Web (24 meses ≈ 730
    // días) pasaba esta validación y terminaba en Analysis=Error recién después de que el Worker
    // lo rechazaba — un ciclo de fondo entero desperdiciado para un rango que ya se sabía inválido
    // acá. Ver MAX_ANALYSIS_DATE_RANGE_DAYS en analysis-constraints.ts para el alcance exacto de
    // este límite (incluida su relación con Field.startDate/endDate, que NO comparte este tope).
    const rangeDays = daysBetweenIsoDates(input.startDate, input.endDate);

    if (rangeDays > MAX_ANALYSIS_DATE_RANGE_DAYS) {
      throw new BadRequestException(
        `El rango entre la fecha de inicio y la fecha de fin no puede superar ${MAX_ANALYSIS_DATE_RANGE_DAYS} días ` +
          `(elegido: ${rangeDays} días). Elegí un rango más corto.`,
      );
    }

    // F04 (revisión independiente, ronda 5): reverificada la carrera reportada sobre el mecanismo
    // de la ronda 4 — recordClientRequestAssociation ejecutaba su propio RETURNING "analysisId"
    // pero la función devolvía void, así que runFieldAnalysis nunca leía qué asociación había
    // ganado de verdad. Secuencia reproducida: B consulta K (findClientRequestAssociation) y no
    // encuentra nada; A registra K→A, procesa y termina; B, ya "más allá" de su lectura inicial,
    // gana el slot del campo (que quedó libre porque A ya terminó) y crea su propia fila; B
    // intenta registrar K→B, Postgres conserva K→A (el ON CONFLICT de recordClientRequestAssociation
    // es un no-op) y devuelve A por RETURNING — pero como el resultado se ignoraba, B disparaba su
    // propio Worker y devolvía su propia fila de todos modos. Resolver la clave (leer), crear el
    // análisis y registrar la asociación eran tres operaciones separadas en el tiempo — cualquier
    // intervalo entre ellas era exactamente la misma clase de ventana que esta ficha viene
    // cerrando desde la ronda 2, aplicada ahora a la propia coordinación por clave.
    //
    // Unidad transaccional y mecanismo de exclusión (resolveOrCreateByClientRequestId): la
    // resolución completa —¿existe ya (fieldId, clientRequestId)? si no, ¿el campo tiene lugar
    // para una fila nueva?— pasa a ser UNA transacción corta (this.analysisRepository.manager.
    // transaction), nunca una lectura separada de la escritura. Dentro de esa transacción se
    // toman DOS exclusiones, siempre en el MISMO orden:
    //   1. La fila de analysis_client_request para (fieldId, clientRequestId) — vía el mismo
    //      patrón INSERT ... ON CONFLICT ... RETURNING de siempre, con un id "candidato"
    //      (crypto.randomUUID(), generado ANTES de la transacción) como valor tentativo. Dos
    //      transacciones con la MISMA clave contienden acá — Postgres serializa: la primera en
    //      llegar reclama la fila; la segunda queda bloqueada en esa fila específica (contención
    //      real, observable en pg_stat_activity) hasta que la primera confirma o revierte, y
    //      entonces lee, en el mismo RETURNING, el analysisId que la primera efectivamente dejó
    //      — nunca un id "candidato" caducado.
    //   2. Si la clave era nueva (nadie más la tenía), recién ahí se intenta reclamar el slot del
    //      campo — el mismo UQ_analysis_running_per_field de siempre, con el id candidato como id
    //      explícito de la fila. Si el campo ya tiene otra fila 'Procesando' (de otra clave o sin
    //      clave), esta sentencia no inserta nada nuevo — la fila candidata nunca llegó a existir
    //      — y la asociación que se acaba de reclamar en el paso 1 se corrige, todavía dentro de
    //      la misma transacción, para apuntar a la fila real.
    // Orden de bloqueos y por qué no genera deadlocks: TODA ejecución de esta función toma la
    // exclusión (1) antes que la (2), sin excepción — nunca al revés. Dos transacciones con
    // claves DISTINTAS nunca contienden en (1) (son filas distintas de analysis_client_request) y
    // solo pueden contender en (2), un recurso único por campo — cola simple, no ciclo. Dos
    // transacciones con la MISMA clave contienden únicamente en (1) — también cola simple: la
    // perdedora nunca llega a intentar (2) con esa clave, porque ya sabe la respuesta con lo que
    // devuelve (1). Como ninguna transacción retiene la exclusión (2) mientras espera la (1) de
    // otra, no existe la espera circular que produce un deadlock.
    // Commit y autoridad para disparar el Worker: la transacción entera (asociación + fila nueva,
    // si corresponde) confirma o revierte como una sola unidad — un fallo a mitad de camino
    // (entre crear la fila y registrar la asociación) revierte AMBAS, sin dejar ni una fila
    // huérfana ni una asociación parcial. getPipelineInput y processFieldAnalysisInBackground
    // corren SIEMPRE después de que esa transacción ya confirmó — nunca dentro de ella — y solo
    // los dispara la request cuyo INSERT contra UQ_analysis_running_per_field efectivamente
    // insertó la fila (won=true en completeWonSlot, más abajo): la que pierde la decisión
    // (won=false) devuelve el análisis que la propia base asoció, sin iniciar nada.
    // ADR-001: camino durable. Mismas validaciones y la misma coordinación por clave/slot que el
    // camino legacy; la diferencia es QUÉ se confirma en la transacción ganadora (Analysis=Queued +
    // inputSnapshot + outbox) y que este proceso HTTP nunca llama al Worker.
    const trigger = options.trigger ?? 'manual';
    const queueContext: QueuedEnqueueContext | undefined =
      this.isQueueEnabledFor(trigger)
        ? {
            prepared: await this.prepareInputSnapshot(fieldId, input),
            userId,
            trigger,
            scheduledRunId: options.scheduledRunId,
          }
        : undefined;

    if (input.clientRequestId) {
      const resolution = await this.resolveOrCreateByClientRequestId(
        fieldId,
        field,
        input,
        input.clientRequestId,
        queueContext,
      );

      if (!resolution.won) {
        this.logger.warn(
          `clientRequestId=${input.clientRequestId} ya asociada a analysisId=${resolution.analysis.id} ` +
            `(status=${resolution.analysis.status}) para fieldId=${fieldId}; se reutiliza sin ` +
            'disparar procesamiento.',
        );

        return resolution.analysis;
      }

      if (queueContext) {
        this.logEnqueued(resolution.analysis, queueContext);
        return resolution.analysis;
      }

      return this.completeWonSlot(fieldId, input, resolution.analysis);
    }

    // F04: sin clientRequestId, comportamiento sin cambios desde la ronda 2 — este SELECT es un
    // fast-path, no la garantía de deduplicación (dos requests concurrentes pueden pasar acá
    // ambas antes de que cualquiera guarde su Analysis). La garantía real sigue siendo
    // UQ_analysis_running_per_field, en el INSERT atómico de más abajo. Sigue existiendo porque
    // evita el roundtrip de getPipelineInput/armar el payload del Worker para el caso común (ya
    // hay uno corriendo, y no está stale), igual que el chequeo no transaccional de resetPassword
    // en auth.service.ts (F03) es un fast-path, no la garantía. Sin clave, la ventana estructural
    // documentada en la ronda 3 (B puede terminar creando su propio análisis si A ya terminó para
    // cuando B llega a su INSERT) sigue existiendo tal cual — el contrato actual sin identidad no
    // trae información para cerrarla; ver el dictamen de esta ronda.
    const runningAnalysis = await this.analysisRepository.findOne({
      where: [
        { fieldId, scope: 'field', status: In(['Queued', 'Procesando']) },
        {
          lotId: fieldId,
          scope: IsNull(),
          status: In(['Queued', 'Procesando']),
        },
      ],
    });

    if (runningAnalysis) {
      const now = new Date();
      // ADR-001: un Analysis administrado por la cola (inputSnapshot no nulo) nunca se marca Error
      // por edad — su expiración/reintentos los gobierna pg-boss. Solo se consulta cuando la regla
      // de edad aplicaría, para no pagar la lectura en el caso común.
      const staleByAge = isAnalysisStale(
        runningAnalysis,
        now,
        ANALYSIS_STALE_THRESHOLD_MS,
      );
      const staleLegacy =
        staleByAge && !(await this.hasDurableExecution(runningAnalysis.id));

      // OPS-1: si el 'Procesando' existente sigue fresco, mantenemos el dedupe de siempre
      // (reutilizarlo, no crear otro). Si ya superó ANALYSIS_STALE_THRESHOLD_MS, lo tratamos
      // como si el proceso que lo estaba corriendo ya no existe: lo marcamos Error acá mismo
      // (única autoridad que muta Analysis.status por staleness, ver también
      // reconcileStaleAnalyses) y seguimos el flujo normal para crear uno nuevo — así el usuario
      // recupera el campo en su propio próximo intento, sin esperar al reconciliador periódico.
      if (!staleLegacy) {
        this.logger.warn(
          `Ya hay un análisis en curso para fieldId=${fieldId} (analysisId=${runningAnalysis.id}); no se dispara uno nuevo.`,
        );

        return runningAnalysis;
      }

      this.logger.warn(
        `Análisis Procesando stale para fieldId=${fieldId} (analysisId=${runningAnalysis.id}); ` +
          'se marca Error y se inicia uno nuevo.',
      );

      await this.failStaleAnalysis(runningAnalysis, now);
    }

    if (queueContext) {
      const queuedClaim = await this.enqueueWithoutClientRequestId(
        fieldId,
        field,
        input,
        queueContext,
      );

      if (!queuedClaim.inserted) {
        this.logger.warn(
          `Carrera de deduplicación detectada para fieldId=${fieldId}: otra request concurrente ` +
            `ganó (analysisId=${queuedClaim.analysis.id}, status=${queuedClaim.analysis.status}); se ` +
            'reutiliza sin encolar un segundo trabajo.',
        );

        return queuedClaim.analysis;
      }

      this.logEnqueued(queuedClaim.analysis, queueContext);
      return queuedClaim.analysis;
    }

    const insertValues = this.buildAnalysisInsertValues(fieldId, field, input);
    const claim = await this.runAtomicUpsert(insertValues);

    if (!claim.inserted) {
      // Otra request ganó (es la única 'Procesando' del campo en este instante): la fila que
      // Postgres devolvió es la suya (identificada por la propia base de datos en la misma
      // sentencia, no por una lectura posterior), sea cual sea su status actual en este momento.
      // Se reutiliza sin lanzar, y sin llamar a processFieldAnalysisInBackground acá — un segundo
      // Worker duplicado es exactamente lo que esta ficha cierra.
      this.logger.warn(
        `Carrera de deduplicación detectada para fieldId=${fieldId}: otra request concurrente ` +
          `ganó (analysisId=${claim.analysis.id}, status=${claim.analysis.status}); se reutiliza ` +
          'sin disparar un segundo procesamiento.',
      );

      return claim.analysis;
    }

    return this.completeWonSlot(fieldId, input, claim.analysis);
  }

  /**
   * F04 (revisión independiente, ronda 5): esta request ganó el slot — ya existe (confirmada,
   * fuera de cualquier transacción abierta) una fila 'Procesando' propia, sea porque vino de
   * resolveOrCreateByClientRequestId (con clave) o de runAtomicUpsert directo (sin clave).
   * Compartido por ambos caminos para no duplicar esta lógica. TODO lo que sigue hasta disparar
   * el Worker (getPipelineInput, que puede lanzar NotFoundException si el campo se quedó sin
   * lotes cargados; la validación de hasIncludedLot; cualquier otro fallo de preparación no
   * previsto) queda envuelto en el mismo try/catch — si CUALQUIERA de esos pasos falla, la fila
   * recién creada se marca Error de inmediato (markPreparationFailureOnWonSlot, SIN modificar) en
   * vez de quedar abandonada como 'Procesando' hasta que reconcileStaleAnalyses la alcance. La
   * excepción ORIGINAL siempre se repropaga sin modificar — la compensación es una escritura
   * aparte, nunca reemplaza la causa.
   */
  private async completeWonSlot(
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
    savedAnalysis: Analysis,
  ): Promise<Analysis> {
    try {
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
    } catch (error) {
      await this.markPreparationFailureOnWonSlot(savedAnalysis, error);
      throw error;
    }
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
      Object.assign(
        analysis,
        this.buildFinalizedResultFields(result, fieldId, fieldInput.lots),
      );

      await this.analysisRepository.save(analysis);

      this.logger.log(
        `Análisis de campo finalizado (analysisId=${analysisId}, fieldId=${fieldId}, ` +
          `classificationScope=${result.resultJson?.classificationScope ?? 'n/a'}).`,
      );

      await this.generateTechnicalVerdictBestEffort(analysis);
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
        // OPS-3 (RISK-053): un único summarizeError() para errorMessage Y resultJson.error —
        // antes resultJson.error tomaba error.message crudo, sin el truncado de 500 caracteres
        // que sí tenía errorMessage. Ahora ambos campos quedan idénticos y con el mismo límite,
        // y como PythonWorkerService ya lanza mensajes públicos sanitizados (ver
        // handleWorkerError), ninguno de los dos puede terminar con detalle interno del Worker.
        const summarizedError = this.summarizeError(error);

        analysis.status = 'Error';
        analysis.failedAt = failedAt;
        analysis.durationMs = this.computeDurationMs(
          analysis.startedAt,
          failedAt,
        );
        Object.assign(
          analysis,
          this.buildErrorResultFields(fieldId, summarizedError),
        );

        await this.analysisRepository.save(analysis);
      }
    }
  }

  /**
   * OPS-1: reconciliador periódico (ver AnalysisReconcileScheduler, @Interval cada 5 min) —
   * única responsabilidad: 'Procesando' stale → 'Error'. Nunca crea un Analysis nuevo, nunca
   * llama al Worker, nunca toca ScheduledAnalysisRun. El reconcile ya existente de
   * scheduled-analysis (ScheduledAnalysisRunnerService.reconcileRun, @Interval cada 2 min) ya
   * sabe reaccionar a un Analysis que pasó a 'Error' — con esto alcanza para que una corrida
   * programada atada a un análisis colgado se resuelva sola en el próximo tick, sin que este
   * método necesite saber nada de schedules/runs.
   */
  async reconcileStaleAnalyses(now: Date = new Date()): Promise<void> {
    // ADR-001: SOLO filas legacy (sin inputSnapshot = sin ejecución durable). Un Analysis
    // administrado por la cola nunca se marca Error por edad acá: su expiración, heartbeat y
    // reintentos los gobierna pg-boss, y el cierre de un job perdido lo hace el runner
    // (AnalysisJobReconcilerService).
    const candidates = await this.analysisRepository.find({
      where: { status: 'Procesando', inputSnapshot: IsNull() },
    });

    for (const analysis of candidates) {
      if (!isAnalysisStale(analysis, now, ANALYSIS_STALE_THRESHOLD_MS)) {
        continue;
      }

      try {
        await this.failStaleAnalysis(analysis, now);

        this.logger.warn(
          `[analysis-reconcile] analysisId=${analysis.id} marcado Error por staleness ` +
            `(Procesando desde ${(analysis.startedAt ?? analysis.createdAt)?.toISOString?.() ?? 'fecha desconocida'}).`,
        );
      } catch (error) {
        this.logger.error(
          `[analysis-reconcile] Fallo marcando stale analysisId=${analysis.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * F04 (revisión independiente, ronda 6): qué campos se setean al marcar 'Error' por staleness —
   * extraído de failStaleAnalysis para que resolveOrCreateByClientRequestId pueda aplicar
   * EXACTAMENTE la misma definición dentro de su propia transacción (vía manager.query, no
   * this.analysisRepository.save — ver esa función para el porqué), sin reimplementarla ni
   * arriesgar que las dos versiones diverjan. failStaleAnalysis sigue siendo la única función que
   * además persiste (para el camino sin clave y para reconcileStaleAnalyses); esto solo calcula
   * los valores.
   */
  private computeStaleErrorFields(
    startedAt: Date | null | undefined,
    now: Date,
  ): { failedAt: Date; durationMs: number | null; errorMessage: string } {
    return {
      failedAt: now,
      durationMs: this.computeDurationMs(startedAt ?? null, now),
      errorMessage: ANALYSIS_STALE_ERROR_MESSAGE,
    };
  }

  /**
   * OPS-1: única función que persiste la transición 'Procesando' → 'Error' por staleness FUERA de
   * una transacción propia — la llaman tanto el dedupe inline de runFieldAnalysis (camino sin
   * clave) como reconcileStaleAnalyses. Nunca dispara nada más (ni verdict, ni email, ni Worker).
   * El camino CON clave tiene su propio equivalente transaccional dentro de
   * resolveOrCreateByClientRequestId (mismos campos, vía computeStaleErrorFields) porque este
   * `.save()` usa la conexión propia del repositorio, no la de una transacción en curso.
   */
  private async failStaleAnalysis(
    analysis: Analysis,
    now: Date,
  ): Promise<Analysis> {
    const { failedAt, durationMs, errorMessage } = this.computeStaleErrorFields(
      analysis.startedAt,
      now,
    );

    analysis.status = 'Error';
    analysis.failedAt = failedAt;
    analysis.durationMs = durationMs;
    analysis.errorMessage = errorMessage;

    return this.analysisRepository.save(analysis);
  }

  /**
   * F04 (revisión independiente, ronda 4): arma los valores del INSERT atómico de
   * runFieldAnalysis. `field` (fieldsService.findOne, ya cargado con su relación .lots) alcanza
   * para lotName/resultJson.lots sin depender de getPipelineInput — ver el comentario junto a
   * donde se llama esto en runFieldAnalysis. Ya NO incluye clientRequestId: desde esta ronda esa
   * asociación vive exclusivamente en analysis_client_request (ver recordClientRequestAssociation
   * y la migración 1788900000000-2) — la columna analysis.clientRequestId (ronda 3) se deja de
   * escribir para filas nuevas, pero se conserva en el esquema sin tocar para no perder el rastro
   * de las filas viejas que ya la tenían (esas se migran a la tabla nueva, ver la migración
   * siguiente).
   */
  private buildAnalysisInsertValues(
    fieldId: string,
    field: Field,
    input: {
      maxCloudiness: number;
      startDate: string;
      endDate: string;
      includeMapAssets?: boolean;
      includeIndexImages?: boolean;
      includeImageSeries?: boolean;
    },
    queued?: { snapshot: AnalysisInputSnapshot | null },
  ): Record<string, unknown> {
    if (queued) {
      // ADR-001: fila encolada — startedAt queda null hasta que el consumidor reclama el primer
      // intento (Queued → Procesando); resultJson.lots se deriva del MISMO snapshot que va a
      // ejecutar el Worker (nunca de una lectura separada del Field).
      const lots = queued.snapshot
        ? summarizeSnapshotLots(queued.snapshot.lots)
        : (field.lots ?? []).map((lot) => ({
            id: lot.id,
            name: lot.name,
            areaHa: lot.areaHa,
            includeInProductivityClassification:
              lot.includeInProductivityClassification,
          }));

      return {
        scope: 'field',
        fieldId,
        lotId: null,
        lotName: field.name,
        status: 'Queued',
        startedAt: null,
        maxCloudiness: input.maxCloudiness,
        startDate: input.startDate,
        endDate: input.endDate,
        requestedMapAssets: input.includeMapAssets ?? null,
        requestedIndexImages: input.includeIndexImages ?? null,
        requestedImageSeries: input.includeImageSeries ?? null,
        inputSnapshot: queued.snapshot,
        resultJson: {
          mode: 'python-worker-v2',
          message: 'Análisis de campo en cola.',
          fieldId,
          lots,
        },
      };
    }

    return {
      scope: 'field',
      fieldId,
      lotId: null,
      lotName: field.name,
      status: 'Procesando',
      startedAt: new Date(),
      maxCloudiness: input.maxCloudiness,
      startDate: input.startDate,
      endDate: input.endDate,
      // KPI review — instrumentación (ticket 3/3, RISK-024): copia literal de lo que efectivamente
      // llegó a esta ejecución — `?? null`, nunca `?? false`: un flag ausente no es lo mismo que
      // "explícitamente pedido en false". Ver el docstring de estas columnas en Analysis.
      requestedMapAssets: input.includeMapAssets ?? null,
      requestedIndexImages: input.includeIndexImages ?? null,
      requestedImageSeries: input.includeImageSeries ?? null,
      resultJson: {
        mode: 'python-worker-v2',
        message: 'Análisis de campo en procesamiento.',
        fieldId,
        lots: (field.lots ?? []).map((lot) => ({
          id: lot.id,
          name: lot.name,
          areaHa: lot.areaHa,
          includeInProductivityClassification: lot.includeInProductivityClassification,
        })),
      },
    };
  }

  /**
   * F04 (revisión independiente, ronda 2/3, simplificado en la ronda 4): ejecuta el INSERT ... ON
   * CONFLICT ... DO UPDATE ... RETURNING atómico contra UQ_analysis_running_per_field — como
   * máximo una fila 'Procesando' por campo. La ronda 3 le agregaba acá un segundo target posible
   * (por clientRequestId); la ronda 4 lo saca: esa resolución ahora ocurre ANTES, como primer
   * chequeo de runFieldAnalysis (ver findClientRequestAssociation) — mezclar ambas resoluciones en
   * el mismo INSERT fue justamente lo que producía el bug de precedencia de esta ronda. Repite tal
   * cual la expresión/predicado del índice — Postgres exige que coincidan exactamente para
   * reconocerlo como el mismo target de conflicto (ON CONFLICT ON CONSTRAINT solo acepta
   * constraints declaradas con ADD CONSTRAINT, no un índice único parcial como este, confirmado
   * directamente contra Postgres). `DO UPDATE SET "id" = "analysis"."id"` es un no-op deliberado:
   * existe solo porque `DO NOTHING` no puebla RETURNING para la fila con la que chocó, y DO UPDATE
   * sí. `xmax = 0` distingue "esta sentencia insertó la fila" de "esta sentencia solo la tocó vía
   * el DO UPDATE", en el mismo resultado, sin una segunda consulta.
   */
  private async runAtomicUpsert(
    values: Record<string, unknown>,
  ): Promise<{ inserted: boolean; analysis: Analysis }> {
    const insertQuery = this.analysisRepository
      .createQueryBuilder()
      .insert()
      .into(Analysis)
      .values(values);

    const [query, parameters] = insertQuery.getQueryAndParameters();

    const upsertSql = `${query}${LEGACY_UPSERT_CONFLICT_CLAUSE}`;

    const rows: Array<Record<string, unknown>> = await this.analysisRepository.query(
      upsertSql,
      parameters,
    );
    const { inserted, ...rawAnalysis } = rows[0];

    return {
      inserted: Boolean(inserted),
      analysis: this.hydrateAnalysisRow(rawAnalysis),
    };
  }

  /**
   * F04 (revisión independiente, ronda 5, recuperación de vencidos integrada en la ronda 6):
   * resuelve O crea, en UNA transacción corta, la fila de Analysis que le corresponde a
   * `clientRequestId` para este campo — reemplaza el mecanismo de la ronda 4
   * (findClientRequestAssociation + recordClientRequestAssociation como pasos separados, con una
   * ventana real entre "leer" y "escribir" que una revisión independiente reprodujo). Ver el
   * comentario extenso junto a donde se llama esto en runFieldAnalysis para la justificación
   * completa del mecanismo, el orden de bloqueos y por qué no genera deadlocks.
   *
   * `candidateId` (crypto.randomUUID(), generado ANTES de abrir la transacción) es el id que
   * usaría la fila de Analysis SI esta request termina siendo quien la crea — se decide de
   * antemano para poder reclamar la asociación y la fila con el MISMO id, dentro de la misma
   * transacción, sin depender de que Postgres genere el id después. Si la clave ya estaba tomada,
   * o si el campo ya tenía otra fila 'Procesando' vigente, ese id nunca llega a existir como fila
   * real — en ese caso la asociación reclamada se redirige, todavía dentro de la transacción, al
   * analysisId verdadero. Si en cambio esa otra fila 'Procesando' está vencida (ronda 6, ver más
   * abajo), la candidata SÍ termina existiendo: se recupera el slot marcando Error la fila vieja y
   * reintentando la misma inserción, sin salir de esta transacción.
   *
   * Devuelve `won: true` únicamente cuando ESTA transacción efectivamente insertó (de entrada, o
   * tras recuperar un slot vencido) la fila de Analysis con la que queda asociada la clave —
   * equivalente al `inserted` de runAtomicUpsert — es la única señal que completeWonSlot usa para
   * decidir si dispara el Worker.
   */
  private async resolveOrCreateByClientRequestId(
    fieldId: string,
    field: Field,
    input: {
      maxCloudiness: number;
      startDate: string;
      endDate: string;
      includeMapAssets?: boolean;
      includeIndexImages?: boolean;
      includeImageSeries?: boolean;
    },
    clientRequestId: string,
    queueContext?: QueuedEnqueueContext,
  ): Promise<{ won: boolean; analysis: Analysis }> {
    const candidateId = randomUUID();
    const insertValues = {
      ...this.buildAnalysisInsertValues(
        fieldId,
        field,
        input,
        queueContext ? { snapshot: this.snapshotOf(queueContext) } : undefined,
      ),
      id: candidateId,
    };

    // Construido una sola vez, fuera de la transacción (solo genera texto SQL, no toca la base):
    // exclusión (2) puede intentarse dos veces dentro de la MISMA transacción — la segunda,
    // idéntica a la primera, solo cuando la primera chocó contra un 'Procesando' vencido que se
    // acaba de liberar (ver más abajo) — y ambos intentos deben ser exactamente la misma
    // sentencia contra el mismo target/predicado que runAtomicUpsert (UQ_analysis_running_per_field).
    const insertQuery = this.analysisRepository
      .createQueryBuilder()
      .insert()
      .into(Analysis)
      .values(insertValues);
    const [query, parameters] = insertQuery.getQueryAndParameters();

    const upsertSql = `${query}${
      queueContext
        ? QUEUED_UPSERT_CONFLICT_CLAUSE
        : LEGACY_UPSERT_CONFLICT_CLAUSE
    }`;

    return this.analysisRepository.manager.transaction(async (manager) => {
      // Exclusión (1): la fila de analysis_client_request para (fieldId, clientRequestId).
      const assocRows: Array<{ inserted: boolean; analysisId: string }> = await manager.query(
        `INSERT INTO "analysis_client_request" ("fieldId", "clientRequestId", "analysisId")
         VALUES ($1, $2, $3)
         ON CONFLICT ("fieldId", "clientRequestId")
         DO UPDATE SET "fieldId" = "analysis_client_request"."fieldId"
         RETURNING (xmax = 0) AS inserted, "analysisId"`,
        [fieldId, clientRequestId, candidateId],
      );
      const assoc = assocRows[0];

      if (!assoc.inserted) {
        // F04 (ronda 6, objetivo 1): clave YA registrada — se devuelve SIEMPRE el análisis que la
        // asociación ya tenía, sin importar su status (incluso vencido o terminal), y sin volver a
        // evaluar staleness acá. Esta request no está "descubriendo" un Procesando: solo está
        // reconsultando una clave cuya resolución (crear, reutilizar, o recuperar un vencido) ya
        // corrió una única vez en la request que ganó esta misma exclusión (1) originalmente.
        // Reevaluar acá reintroduciría exactamente la duplicación de reemplazos que el objetivo 1
        // prohíbe — ver PRUEBA 1 (K existente apunta a un Procesando vencido → se devuelve tal
        // cual, sin crear ni disparar otro).
        const existing = await manager.findOne(Analysis, { where: { id: assoc.analysisId } });

        if (existing) {
          return { won: false, analysis: existing };
        }

        // Defensivo (huérfana): la FK de analysisId hacia analysis.id hace que esto no debería
        // ser alcanzable en la práctica (ningún código borra filas de Analysis). Si igual
        // ocurriera, se repara redirigiendo la asociación a la candidata de esta request y se
        // continúa como si la clave hubiera sido nueva.
        this.logger.error(
          `Asociación huérfana: clientRequestId=${clientRequestId} apuntaba a analysisId=` +
            `${assoc.analysisId} (fieldId=${fieldId}), que ya no existe. Se redirige.`,
        );
        await manager.query(
          `UPDATE "analysis_client_request" SET "analysisId" = $3
           WHERE "fieldId" = $1 AND "clientRequestId" = $2`,
          [fieldId, clientRequestId, candidateId],
        );
      }

      // Exclusión (2): el slot del campo — mismo target/predicado que runAtomicUpsert
      // (UQ_analysis_running_per_field), ejecutado DENTRO de la misma transacción que la
      // asociación, con la candidata como id explícito.
      const rows: Array<Record<string, unknown>> = await manager.query(upsertSql, parameters);
      const { inserted, ...rawAnalysis } = rows[0] as { inserted: boolean } & Record<string, unknown>;

      if (inserted) {
        if (queueContext) {
          await this.completeQueuedClaimInTransaction(
            manager,
            rawAnalysis,
            queueContext,
          );
        }

        return {
          won: true,
          analysis: this.hydrateAnalysisRow(rawAnalysis),
        };
      }

      // F04 (ronda 6): la candidata chocó contra una fila 'Procesando' YA EXISTENTE — `rawAnalysis`
      // es esa fila, leída por el mismo RETURNING del DO UPDATE que acaba de chocar contra ella.
      // Postgres toma un lock de escritura sobre esa fila al evaluar y aplicar ese DO UPDATE (igual
      // que cualquier UPDATE), lock que esta transacción retiene hasta que confirme o revierta —
      // ninguna otra transacción puede mutarla mientras tanto (ni siquiera el propio Worker que la
      // esté procesando: su UPDATE final en processFieldAnalysisInBackground quedaría bloqueado
      // esperando que ESTA transacción termine). Por eso `rawAnalysis` ya es la lectura "bajo la
      // exclusión adecuada" que pide este pendiente — no una lectura vieja de antes de tomar el
      // lock: nada pudo haberla cambiado entre que la leímos y este punto, y nada puede cambiarla
      // hasta que esta transacción termine (ver PRUEBA 5: si el cambio a terminal de la fila vieja
      // ya había confirmado ANTES de este INSERT, esa fila deja de matchear el predicado del índice
      // parcial — este INSERT ni siquiera choca contra ella, `inserted` da true directamente, y el
      // bloque de abajo nunca se ejecuta).
      const now = new Date();
      // ADR-001: `inputSnapshot` viene en el mismo RETURNING * (columna cruda) — un valor no nulo
      // marca ejecución durable, que nunca se recupera por edad (ver isAnalysisStale).
      const staleCandidate: StaleAnalysisCandidate = {
        status: rawAnalysis.status as AnalysisStatus,
        startedAt: rawAnalysis.startedAt as Date | null,
        createdAt: rawAnalysis.createdAt as Date | null,
        hasDurableExecution:
          rawAnalysis.inputSnapshot !== null &&
          rawAnalysis.inputSnapshot !== undefined,
      };

      if (!isAnalysisStale(staleCandidate, now, ANALYSIS_STALE_THRESHOLD_MS)) {
        // F04 (ronda 6, objetivo 3): clave nueva ante Procesando vigente — comportamiento sin
        // cambios desde la ronda 5: se reutiliza esa fila y se redirige la asociación recién
        // reclamada hacia ella, sin marcarla Error ni crear nada.
        await manager.query(
          `UPDATE "analysis_client_request" SET "analysisId" = $3
           WHERE "fieldId" = $1 AND "clientRequestId" = $2`,
          [fieldId, clientRequestId, rawAnalysis.id],
        );

        return {
          won: false,
          analysis: this.hydrateAnalysisRow(rawAnalysis),
        };
      }

      // F04 (ronda 6, objetivo 2): clave nueva frente a un Procesando vencido — se recupera con la
      // MISMA regla y los MISMOS campos que el camino sin clave (computeStaleErrorFields, la
      // definición compartida que también usa failStaleAnalysis), pero mutando acá vía
      // manager.query dentro de esta transacción — NO con this.analysisRepository.save() (lo que
      // usa failStaleAnalysis para el camino sin clave): esa llamada correría en la conexión propia
      // del repositorio, no en la de esta transacción, así que se bloquearía contra el lock que
      // esta misma transacción ya sostiene sobre la fila (deadlock consigo misma) y, aunque no se
      // bloqueara, confirmaría por fuera de esta unidad atómica — justo lo que "asociación nueva,
      // transición del vencido y creación del reemplazo deben confirmar o revertir coherentemente"
      // prohíbe.
      this.logger.warn(
        `Análisis Procesando stale para fieldId=${fieldId} (analysisId=${rawAnalysis.id}) detectado ` +
          `vía clientRequestId=${clientRequestId}; se marca Error y se crea un reemplazo dentro de la ` +
          'misma transacción.',
      );

      const { failedAt, durationMs, errorMessage } = this.computeStaleErrorFields(
        staleCandidate.startedAt,
        now,
      );

      // OJO: para UPDATE/DELETE (a diferencia de INSERT/SELECT), el driver de Postgres de TypeORM
      // devuelve `[rows, rowCount]` — una tupla, no el array de filas directamente (ver
      // PostgresQueryRunner.query: `result.raw = [raw.rows, raw.rowCount]` para esos dos comandos).
      // Confirmado con un repro directo contra Postgres real antes de este fix.
      const [failedRows]: [Array<{ id: string }>, number] = await manager.query(
        `UPDATE "analysis"
         SET "status" = 'Error', "failedAt" = $2, "durationMs" = $3, "errorMessage" = $4
         WHERE "id" = $1 AND "status" = 'Procesando'
         RETURNING "id"`,
        [rawAnalysis.id, failedAt, durationMs, errorMessage],
      );

      if (failedRows.length !== 1) {
        // Defensivo: bajo el lock que esta transacción sostiene sobre la fila desde el DO UPDATE
        // de arriba, nada más pudo haber tocado su status mientras tanto — esto no debería ser
        // alcanzable. Si igual ocurriera, no hay nada seguro que reparar acá: se prefiere abortar
        // la transacción entera (rollback total — ni transición, ni asociación, ni reemplazo; sin
        // disparar Worker) antes que adivinar sobre una fila cuyo estado ya no es el esperado.
        throw new Error(
          `No se pudo marcar Error transaccionalmente sobre analysisId=${rawAnalysis.id} ` +
            `(fieldId=${fieldId}, clientRequestId=${clientRequestId}): status ya no era 'Procesando' ` +
            'bajo el lock de esta transacción.',
        );
      }

      // El slot ya quedó libre: bajo READ COMMITTED, esta misma transacción ve sus propias
      // escrituras todavía sin confirmar, así que un segundo intento de la MISMA sentencia de
      // exclusión (2), con la MISMA candidata, ya no choca contra la fila que se acaba de marcar
      // Error (dejó de matchear el predicado 'Procesando' del índice parcial) — inserta de verdad.
      const retryRows: Array<Record<string, unknown>> = await manager.query(upsertSql, parameters);
      const { inserted: retryInserted, ...retryRawAnalysis } = retryRows[0] as {
        inserted: boolean;
      } & Record<string, unknown>;

      if (!retryInserted) {
        // Defensivo: bajo el lock que sostenemos desde que liberamos el slot nosotros mismos, nada
        // más pudo haberlo tomado — no debería ser alcanzable. Si igual ocurriera, se corrige la
        // asociación (que sigue apuntando a la candidata, que nunca llegó a existir como fila real)
        // para que apunte a lo que sea que haya ahí de verdad, y se devuelve sin disparar Worker —
        // nunca se asume un reemplazo que no se pudo confirmar.
        await manager.query(
          `UPDATE "analysis_client_request" SET "analysisId" = $3
           WHERE "fieldId" = $1 AND "clientRequestId" = $2`,
          [fieldId, clientRequestId, retryRawAnalysis.id],
        );

        return {
          won: false,
          analysis: this.hydrateAnalysisRow(retryRawAnalysis),
        };
      }

      // La candidata (mismo `candidateId` con el que la asociación ya fue reclamada más arriba)
      // ahora existe de verdad como fila de Analysis 'Procesando' — la asociación ya apunta a este
      // id desde la exclusión (1), no hace falta redirigirla.
      if (queueContext) {
        await this.completeQueuedClaimInTransaction(
          manager,
          retryRawAnalysis,
          queueContext,
        );
      }

      return {
        won: true,
        analysis: this.hydrateAnalysisRow(retryRawAnalysis),
      };
    });
  }

  /**
   * ADR-001: captura el snapshot inmutable ANTES de abrir la transacción (getPipelineInput lee el
   * Field vigente en ese instante). Nunca lanza: un fallo de preparación (campo sin lotes, ningún
   * lote incluido) se devuelve como `{ error }` y solo se relanza si esta request efectivamente
   * gana el slot — ver QueuedEnqueueContext.
   */
  private async prepareInputSnapshot(
    fieldId: string,
    input: RunFieldAnalysisInput,
  ): Promise<QueuedEnqueueContext['prepared']> {
    try {
      const fieldInput = await this.fieldsService.getPipelineInput(fieldId);

      if (
        !fieldInput.lots.some((lot) => lot.includeInProductivityClassification)
      ) {
        throw new BadRequestException(
          'El campo no tiene ningún lote incluido en la clasificación productiva. Habilitá al menos un lote antes de analizar.',
        );
      }

      return {
        snapshot: buildAnalysisInputSnapshot(fieldInput, {
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
        }),
      };
    } catch (error) {
      return { error };
    }
  }

  private snapshotOf(
    queueContext: QueuedEnqueueContext,
  ): AnalysisInputSnapshot | null {
    return 'snapshot' in queueContext.prepared
      ? queueContext.prepared.snapshot
      : null;
  }

  /**
   * ADR-001: se ejecuta DENTRO de la transacción que acaba de insertar la fila Queued. Si la
   * preparación del snapshot había fallado, relanza ese error ORIGINAL → rollback completo (ni
   * Analysis, ni asociación de clientRequestId, ni outbox). Si no, inserta la fila de outbox en la
   * misma transacción: Analysis + inputSnapshot + asociación + outbox confirman juntos o nada.
   */
  private async completeQueuedClaimInTransaction(
    manager: EntityManager,
    rawAnalysis: Record<string, unknown>,
    queueContext: QueuedEnqueueContext,
  ): Promise<void> {
    if ('error' in queueContext.prepared) {
      throw queueContext.prepared.error;
    }

    await this.insertOutboxRow(manager, {
      analysisId: rawAnalysis.id as string,
      fieldId: rawAnalysis.fieldId as string,
      userId: queueContext.userId,
      trigger: queueContext.trigger,
      scheduledRunId: queueContext.scheduledRunId,
    });
  }

  private async insertOutboxRow(
    manager: EntityManager,
    input: {
      analysisId: string;
      fieldId: string;
      userId: string;
      trigger: AnalysisJobTrigger;
      scheduledRunId?: string;
    },
  ): Promise<void> {
    const payload = buildAnalysisExecutePayload({
      analysisId: input.analysisId,
      fieldId: input.fieldId,
      requestedByUserId: input.userId,
      trigger: input.trigger,
      scheduledRunId: input.scheduledRunId,
    });

    // ON CONFLICT DO NOTHING: una sola intención de ejecución por (analysisId, jobType). Dentro de
    // la transacción ganadora nunca debería existir ya, pero una segunda inserción no puede
    // producir un segundo job.
    await manager.query(
      `INSERT INTO "analysis_job_outbox" ("id", "analysisId", "jobType", "payloadVersion", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT ("analysisId", "jobType") DO NOTHING`,
      [
        randomUUID(),
        input.analysisId,
        ANALYSIS_EXECUTE_JOB,
        ANALYSIS_JOB_CONTRACT_VERSION,
        JSON.stringify(payload),
      ],
    );
  }

  /**
   * ADR-001: equivalente encolado de runAtomicUpsert (camino sin clientRequestId) — mismo INSERT
   * ... ON CONFLICT contra UQ_analysis_running_per_field, pero dentro de una transacción que además
   * inserta el outbox (o revierte todo si la preparación del snapshot había fallado).
   */
  private async enqueueWithoutClientRequestId(
    fieldId: string,
    field: Field,
    input: RunFieldAnalysisInput,
    queueContext: QueuedEnqueueContext,
  ): Promise<{ inserted: boolean; analysis: Analysis }> {
    const insertValues = this.buildAnalysisInsertValues(fieldId, field, input, {
      snapshot: this.snapshotOf(queueContext),
    });
    const [query, parameters] = this.analysisRepository
      .createQueryBuilder()
      .insert()
      .into(Analysis)
      .values(insertValues)
      .getQueryAndParameters();
    const upsertSql = `${query}${QUEUED_UPSERT_CONFLICT_CLAUSE}`;

    return this.analysisRepository.manager.transaction(async (manager) => {
      const rows: Array<Record<string, unknown>> = await manager.query(
        upsertSql,
        parameters,
      );
      const { inserted, ...rawAnalysis } = rows[0] as {
        inserted: boolean;
      } & Record<string, unknown>;

      if (inserted) {
        await this.completeQueuedClaimInTransaction(
          manager,
          rawAnalysis,
          queueContext,
        );
      }

      return {
        inserted: Boolean(inserted),
        analysis: this.hydrateAnalysisRow(rawAnalysis),
      };
    });
  }

  private logEnqueued(
    analysis: Analysis,
    queueContext: QueuedEnqueueContext,
  ): void {
    this.logger.log(
      `Análisis encolado de forma durable (analysisId=${analysis.id}, fieldId=${analysis.fieldId}, ` +
        `trigger=${queueContext.trigger}${
          queueContext.scheduledRunId
            ? `, scheduledRunId=${queueContext.scheduledRunId}`
            : ''
        }).`,
    );
  }

  /**
   * Convierte una fila cruda de un RETURNING * en entidad, SIN `inputSnapshot` (ADR-001): esa
   * columna es `select: false` (GeoJSON completo) y nunca debe viajar en una respuesta HTTP ni en
   * objetos que después se re-guarden.
   */
  private hydrateAnalysisRow(raw: Record<string, unknown>): Analysis {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { inputSnapshot, ...rest } = raw;

    return this.analysisRepository.create(rest as Partial<Analysis>);
  }

  /** ADR-001: ¿este Analysis tiene ejecución durable (administrada por la cola)? */
  private async hasDurableExecution(analysisId: string): Promise<boolean> {
    const rows: Array<{ durable: boolean }> =
      await this.analysisRepository.query(
        `SELECT ("inputSnapshot" IS NOT NULL) AS durable FROM "analysis" WHERE "id" = $1`,
        [analysisId],
      );

    return Boolean(rows[0]?.durable);
  }

  /**
   * ADR-001: Analysis activo (Queued/Procesando) de un campo, con la marca de ejecución durable —
   * usado por el scheduler semanal para decidir si bloquear la corrida (un 'Procesando' durable en
   * backoff de reintentos puede superar el umbral de staleness legacy sin estar colgado).
   */
  async findActiveAnalysisForField(
    fieldId: string,
  ): Promise<ActiveFieldAnalysis | null> {
    const rows: Array<ActiveFieldAnalysis> =
      await this.analysisRepository.query(
        `SELECT a."id", a."status", a."startedAt", a."createdAt",
              (a."inputSnapshot" IS NOT NULL) AS "hasDurableExecution"
       FROM "analysis" a
       WHERE a."status" IN ('Queued', 'Procesando')
         AND ((a."scope" = 'field' AND a."fieldId" = $1) OR (a."scope" IS NULL AND a."lotId" = $1))
       ORDER BY a."createdAt" DESC
       LIMIT 1`,
        [fieldId],
      );

    return rows[0] ?? null;
  }

  /**
   * Columnas de resultado de un Analysis finalizado — compartidas por el camino legacy
   * (processFieldAnalysisInBackground) y por el consumidor de la cola (ADR-001), para que ambos
   * persistan exactamente el mismo resultado funcional. `lots` sale del input efectivamente
   * ejecutado (en la cola: el inputSnapshot), nunca de una lectura posterior del Field.
   */
  buildFinalizedResultFields(
    result: WorkerAnalysisResult,
    fieldId: string,
    lots: AnalysisInputSnapshotLot[],
  ): Partial<Analysis> {
    return {
      errorMessage: null,
      globalScore: result.globalScore,
      category: result.category,
      confidenceScore: result.confidenceScore,
      productivityScore: result.productivityScore,
      stabilityScore: result.stabilityScore,
      soilScore: result.soilScore,
      climateScore: result.climateScore,
      ndviAverageMax: result.ndviAverageMax,
      ndviVariability: result.ndviVariability,
      zonesDetected: result.zonesDetected,
      resultJson: {
        ...result.resultJson,
        fieldId,
        fieldLots: summarizeSnapshotLots(lots),
      },
    };
  }

  /** Columnas de un Analysis de campo terminado en Error (legacy y cola comparten la forma). */
  buildErrorResultFields(
    fieldId: string,
    publicErrorMessage: string,
  ): Partial<Analysis> {
    const errorMessage = this.summarizeError(publicErrorMessage);

    return {
      errorMessage,
      category: 'Error al procesar análisis de campo',
      resultJson: {
        mode: 'error',
        message: 'Error al ejecutar el pipeline de campo.',
        error: errorMessage,
        // Sin esto, el frontend no puede distinguir un análisis de campo
        // errado de uno de lote único (isFieldAnalysis se basa en
        // resultJson.fieldId) y el botón "Volver" queda mal armado.
        fieldId,
      },
    };
  }

  /**
   * PR 11A: el veredicto técnico es best-effort — AnalysisVerdictService ya se protege
   * internamente (persiste status='failed' si el generador o el guardado fallan), pero este
   * .catch() es la última red: si incluso guardar el 'failed' tirara, no puede escapar y marcar
   * como 'Error' un análisis que en realidad terminó bien. Compartido por el camino legacy y el
   * consumidor de la cola (ADR-001).
   */
  async generateTechnicalVerdictBestEffort(analysis: Analysis): Promise<void> {
    await this.analysisVerdictService
      .generateAndPersist(analysis)
      .catch((error) => {
        this.logger.error(
          `Generación de veredicto técnico interrumpida de forma inesperada (analysisId=${analysis.id}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /**
   * F04 (revisión independiente, ronda 3): esta request ya ganó el slot (existe una fila
   * 'Procesando' propia, creada por runAtomicUpsert) — cualquier fallo entre ese punto y el
   * disparo real del Worker (getPipelineInput lanzando NotFoundException porque el campo se
   * quedó sin lotes cargados, la validación de hasIncludedLot, o cualquier otro error de
   * preparación no previsto) tiene que liberar ese slot de inmediato, no dejarlo como una reserva
   * 'Procesando' abandonada hasta que reconcileStaleAnalyses la alcance (recién después de
   * ANALYSIS_STALE_THRESHOLD_MS). Esto NO es un rollback: la transacción del INSERT ya confirmó —
   * es una escritura compensatoria posterior y separada, que marca la fila como Error. Nunca toca
   * una fila que en realidad pertenece a otra request: cuando esta request perdió la carrera
   * (!inserted en runAtomicUpsert), ya retornó antes de llegar acá. Si la propia escritura
   * compensatoria falla, se registra ese segundo fallo — nunca reemplaza ni oculta la excepción
   * ORIGINAL, que sigue siendo la que se repropaga al caller sin modificar.
   */
  private async markPreparationFailureOnWonSlot(
    analysis: Analysis,
    error: unknown,
  ): Promise<void> {
    const failedAt = new Date();
    const summarizedError = this.summarizeError(error);

    analysis.status = 'Error';
    analysis.failedAt = failedAt;
    analysis.durationMs = this.computeDurationMs(analysis.startedAt, failedAt);
    analysis.errorMessage = summarizedError;
    analysis.category = 'Error al procesar análisis de campo';
    analysis.resultJson = {
      mode: 'error',
      message: 'Error al preparar el análisis de campo (antes de iniciar el Worker).',
      error: summarizedError,
      fieldId: analysis.fieldId ?? undefined,
    };

    try {
      await this.analysisRepository.save(analysis);
    } catch (saveError) {
      this.logger.error(
        `No se pudo marcar Error el análisis ${analysis.id} (fieldId=${analysis.fieldId}) tras ` +
          `un fallo de preparación — la fila puede seguir 'Procesando' hasta que ` +
          `reconcileStaleAnalyses la alcance. Causa original del fallo de preparación: ` +
          `${summarizedError}. Fallo AL MARCAR Error (no oculta la causa original, que sigue ` +
          `propagándose): ${saveError instanceof Error ? saveError.message : String(saveError)}.`,
      );
    }
  }

  /**
   * ADMIN-1: análisis viejos sin startedAt (creados antes de esta migración)
   * no tienen forma real de calcular duración — se deja null en vez de
   * inventar un número con createdAt como sustituto.
   */
  private computeDurationMs(
    startedAt: Date | null,
    endedAt: Date,
  ): number | null {
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
