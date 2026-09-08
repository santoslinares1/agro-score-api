import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import {
  daysBetweenIsoDates,
  MAX_ANALYSIS_DATE_RANGE_DAYS,
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
      clientRequestId?: string;
    },
    userId: string,
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
    if (input.clientRequestId) {
      const resolution = await this.resolveOrCreateByClientRequestId(
        fieldId,
        field,
        input,
        input.clientRequestId,
      );

      if (!resolution.won) {
        this.logger.warn(
          `clientRequestId=${input.clientRequestId} ya asociada a analysisId=${resolution.analysis.id} ` +
            `(status=${resolution.analysis.status}) para fieldId=${fieldId}; se reutiliza sin ` +
            'disparar procesamiento.',
        );

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
        { fieldId, scope: 'field', status: 'Procesando' },
        { lotId: fieldId, scope: IsNull(), status: 'Procesando' },
      ],
    });

    if (runningAnalysis) {
      const now = new Date();

      // OPS-1: si el 'Procesando' existente sigue fresco, mantenemos el dedupe de siempre
      // (reutilizarlo, no crear otro). Si ya superó ANALYSIS_STALE_THRESHOLD_MS, lo tratamos
      // como si el proceso que lo estaba corriendo ya no existe: lo marcamos Error acá mismo
      // (única autoridad que muta Analysis.status por staleness, ver también
      // reconcileStaleAnalyses) y seguimos el flujo normal para crear uno nuevo — así el usuario
      // recupera el campo en su propio próximo intento, sin esperar al reconciliador periódico.
      if (!isAnalysisStale(runningAnalysis, now, ANALYSIS_STALE_THRESHOLD_MS)) {
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

      // PR 11A: el veredicto técnico es best-effort — AnalysisVerdictService ya se protege
      // internamente (persiste status='failed' si el generador o el guardado fallan), pero este
      // .catch() es la última red: si incluso guardar el 'failed' tirara, no puede escapar hacia
      // el catch de abajo y marcar como 'Error' un análisis que en realidad terminó bien.
      await this.analysisVerdictService
        .generateAndPersist(analysis)
        .catch((error) => {
          this.logger.error(
            `Generación de veredicto técnico interrumpida de forma inesperada (analysisId=${analysisId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
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
        analysis.errorMessage = summarizedError;
        analysis.category = 'Error al procesar análisis de campo';
        analysis.resultJson = {
          mode: 'error',
          message: 'Error al ejecutar el pipeline de campo.',
          error: summarizedError,
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
   * OPS-1: reconciliador periódico (ver AnalysisReconcileScheduler, @Interval cada 5 min) —
   * única responsabilidad: 'Procesando' stale → 'Error'. Nunca crea un Analysis nuevo, nunca
   * llama al Worker, nunca toca ScheduledAnalysisRun. El reconcile ya existente de
   * scheduled-analysis (ScheduledAnalysisRunnerService.reconcileRun, @Interval cada 2 min) ya
   * sabe reaccionar a un Analysis que pasó a 'Error' — con esto alcanza para que una corrida
   * programada atada a un análisis colgado se resuelva sola en el próximo tick, sin que este
   * método necesite saber nada de schedules/runs.
   */
  async reconcileStaleAnalyses(now: Date = new Date()): Promise<void> {
    const candidates = await this.analysisRepository.find({
      where: { status: 'Procesando' },
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
    input: { maxCloudiness: number; startDate: string; endDate: string },
  ): Record<string, unknown> {
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

    const upsertSql = `${query}
      ON CONFLICT (COALESCE("fieldId", "lotId"))
      WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
      DO UPDATE SET "id" = "analysis"."id"
      RETURNING (xmax = 0) AS inserted, *`;

    const rows: Array<Record<string, unknown>> = await this.analysisRepository.query(
      upsertSql,
      parameters,
    );
    const { inserted, ...rawAnalysis } = rows[0];

    return {
      inserted: Boolean(inserted),
      analysis: this.analysisRepository.create(rawAnalysis as Partial<Analysis>),
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
    input: { maxCloudiness: number; startDate: string; endDate: string },
    clientRequestId: string,
  ): Promise<{ won: boolean; analysis: Analysis }> {
    const candidateId = randomUUID();
    const insertValues = {
      ...this.buildAnalysisInsertValues(fieldId, field, input),
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

    const upsertSql = `${query}
      ON CONFLICT (COALESCE("fieldId", "lotId"))
      WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
      DO UPDATE SET "id" = "analysis"."id"
      RETURNING (xmax = 0) AS inserted, *`;

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
        return {
          won: true,
          analysis: manager.create(Analysis, rawAnalysis as Partial<Analysis>),
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
      const staleCandidate: StaleAnalysisCandidate = {
        status: rawAnalysis.status as AnalysisStatus,
        startedAt: rawAnalysis.startedAt as Date | null,
        createdAt: rawAnalysis.createdAt as Date | null,
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
          analysis: manager.create(Analysis, rawAnalysis as Partial<Analysis>),
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
          analysis: manager.create(Analysis, retryRawAnalysis as Partial<Analysis>),
        };
      }

      // La candidata (mismo `candidateId` con el que la asociación ya fue reclamada más arriba)
      // ahora existe de verdad como fila de Analysis 'Procesando' — la asociación ya apunta a este
      // id desde la exclusión (1), no hace falta redirigirla.
      return {
        won: true,
        analysis: manager.create(Analysis, retryRawAnalysis as Partial<Analysis>),
      };
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
