// F04 (revisión independiente, ronda 6): recuperación de análisis 'Procesando' vencidos dentro
// del camino CON clientRequestId.
//
// Regresión reportada: resolveOrCreateByClientRequestId (ver analysis.service.ts) integra desde
// la ronda 5 la asociación y la creación/reutilización del análisis en una única transacción
// corta, pero su rama "perdí la exclusión (2) contra una fila 'Procesando' ya existente" nunca
// evaluaba isAnalysisStale/ANALYSIS_STALE_THRESHOLD_MS antes de esta ronda — a diferencia del
// camino SIN clave (runFieldAnalysis, más arriba en el mismo archivo), que sí lo hacía desde la
// ronda 2. Resultado: con clave, un 'Procesando' vencido se reutilizaba para siempre (nunca se
// marcaba Error, nunca se creaba un reemplazo) — justo lo que el camino sin clave sí resolvía. El
// flujo Web (ronda 3) siempre envía clave, así que esta diferencia le afectaba en la práctica.
//
// Estas 7 pruebas cubren, una a una, los 7 escenarios pedidos para esta ronda (ver el objetivo de
// la ronda en la conversación) — numeradas ESCENARIO 1-7 para que la correspondencia sea directa,
// deliberadamente separadas de la numeración PRUEBA 1-9 de analysis-dedup-client-request.e2e-spec.ts
// (rondas 4-5, sin tocar en esta ronda).
//
// Mismo patrón que el resto de la suite F04: AnalysisService real (sin DI de Nest) con un
// Repository<Analysis> real por instancia contra una base PostgreSQL aislada y desechable, creada
// por esta misma ejecución con nombre único — nunca `agro_score` ni las DB_* generales. Lo único
// simulado es el Worker y FieldsService (no forman parte del mecanismo de exclusión). Los análisis
// 'Procesando' vencidos se siembran DIRECTAMENTE (startedAt en el pasado, más allá de
// ANALYSIS_STALE_THRESHOLD_MS) en vez de esperar el umbral real de 20 minutos.
import { DataSource, Repository } from 'typeorm';

import { AnalysisService } from '../src/analysis/analysis.service';
import { ANALYSIS_STALE_THRESHOLD_MS } from '../src/analysis/analysis-stale.util';
import { AddRunningAnalysisPerFieldUniqueIndex1788829462102 } from '../src/migrations/1788829462102-AddRunningAnalysisPerFieldUniqueIndex';
import { AddAnalysisClientRequestId1788900000000 } from '../src/migrations/1788900000000-AddAnalysisClientRequestId';
import { AddAnalysisClientRequestAssociationTable1788900000001 } from '../src/migrations/1788900000001-AddAnalysisClientRequestAssociationTable';
import { MakeAnalysisClientRequestForeignKeyDeferrable1788900000002 } from '../src/migrations/1788900000002-MakeAnalysisClientRequestForeignKeyDeferrable';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { FieldsService } from '../src/fields/fields.service';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { ReportPdfService } from '../src/analysis/report-pdf/report-pdf.service';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

// Mismo mensaje literal que ANALYSIS_STALE_ERROR_MESSAGE en analysis.service.ts — no se exporta
// (const de módulo, alcance privado), así que se duplica acá, igual que ya hace
// analysis.service.spec.ts. Un negative control (ver el informe de esta ronda) confirma que este
// test falla si el fix no aplica el mensaje real.
const ANALYSIS_STALE_ERROR_MESSAGE =
  'El análisis superó el tiempo máximo de procesamiento y fue marcado automáticamente como Error.';

/** Idéntica a analysis-dedup-client-request.e2e-spec.ts — evidencia real de contención vía
 * pg_stat_activity, nunca un sleep fijo usado como prueba. */
async function waitForLockContention(
  observer: DataSource,
  databaseName: string,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const rows: Array<{ count: string }> = await observer.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = $1
         AND wait_event_type = 'Lock'`,
      [databaseName],
    );

    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `No se observó ninguna conexión de "${databaseName}" esperando un lock en ` +
          `pg_stat_activity dentro de ${options.timeoutMs}ms — la contención esperada no se ` +
          'produjo (o no se pudo observar), así que este test no puede afirmar que hubo una ' +
          'carrera real.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

/** Idéntica a analysis-dedup-client-request.e2e-spec.ts: corta una espera de barrera de inmediato
 * si la operación observada se asienta antes de lo esperado. */
function raceBarrierWithEarlyFailure<T>(
  barrier: Promise<T>,
  watched: Promise<unknown>,
  watchedLabel: string,
): Promise<T> {
  return Promise.race([
    barrier,
    watched.then(
      () =>
        Promise.reject(
          new Error(
            `${watchedLabel} se asentó antes de lo esperado (antes de que la barrera se activara) — ` +
              'la instrumentación de este test no siguió el camino esperado.',
          ),
        ),
      (error) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    ),
  ]);
}

/** Idéntica a analysis-dedup-client-request.e2e-spec.ts: señal REAL de que
 * processFieldAnalysisInBackground terminó — poll acotado por timeout, nunca un sleep fijo. */
async function waitForTerminalStatus(
  repo: Repository<Analysis>,
  analysisId: string,
  options: { timeoutMs: number; pollIntervalMs: number } = { timeoutMs: 5_000, pollIntervalMs: 25 },
): Promise<Analysis> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const current = await repo.findOne({ where: { id: analysisId } });

    if (current && current.status !== 'Procesando') {
      return current;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `El análisis ${analysisId} no alcanzó un estado terminal dentro de ${options.timeoutMs}ms — ` +
          'el procesamiento de fondo podría seguir corriendo.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

function buildPipelineInput(fieldId: string) {
  return {
    fieldId,
    name: 'Campo de prueba F04 (ronda 6)',
    location: 'Pergamino',
    totalAreaHa: 10,
    lots: [
      {
        id: 'lot-1',
        name: 'Lote 1',
        geojson: { type: 'Polygon', coordinates: [] },
        areaHa: 10,
        includeInProductivityClassification: true,
      },
    ],
  };
}

function buildWorkerResult() {
  return {
    globalScore: 42,
    category: 'Aptitud media con limitantes a revisar',
    confidenceScore: 50,
    productivityScore: 50,
    stabilityScore: 50,
    soilScore: 0,
    climateScore: 0,
    ndviAverageMax: 0.5,
    ndviVariability: 'Media' as const,
    zonesDetected: 0,
    resultJson: { mode: 'python-worker-v2', message: 'test' } as any,
  };
}

describe('F04 (revisión independiente, ronda 6) — recuperación de Procesando vencidos dentro de resolveOrCreateByClientRequestId (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let observerDataSource: DataSource | undefined;
  let bootstrapDataSource: DataSource | undefined;
  let dataSourceA: DataSource | undefined;
  let dataSourceB: DataSource | undefined;

  let repoA: Repository<Analysis>;
  let repoB: Repository<Analysis>;
  let serviceA: AnalysisService;
  let serviceB: AnalysisService;

  let pythonWorkerServiceMock: { runFieldAnalysis: jest.Mock };
  let fieldsServiceMock: { findOne: jest.Mock; getPipelineInput: jest.Mock };
  let fieldCounter = 0;

  function freshFieldId(): string {
    fieldCounter += 1;
    return `field-f04-cr-stale-${fieldCounter}`;
  }

  function buildAnalysisService(repo: Repository<Analysis>): AnalysisService {
    return new AnalysisService(
      repo,
      pythonWorkerServiceMock as unknown as PythonWorkerService,
      fieldsServiceMock as unknown as FieldsService,
      { build: jest.fn() } as unknown as ReportPdfService,
      {
        generateAndPersist: jest.fn().mockResolvedValue(undefined),
      } as unknown as AnalysisVerdictService,
    );
  }

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'f04_dedup_cr_stale');
    createdDatabaseName = created.name;

    observerDataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: target.adminDatabase,
    });
    await observerDataSource.initialize();

    bootstrapDataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
      synchronize: true,
    });
    await bootstrapDataSource.initialize();

    const queryRunner = bootstrapDataSource.createQueryRunner();
    await queryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().up(queryRunner);
    await new AddAnalysisClientRequestId1788900000000().up(queryRunner);
    await new AddAnalysisClientRequestAssociationTable1788900000001().up(queryRunner);
    await new MakeAnalysisClientRequestForeignKeyDeferrable1788900000002().up(queryRunner);
    await queryRunner.release();

    dataSourceA = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
    });
    await dataSourceA.initialize();

    dataSourceB = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
    });
    await dataSourceB.initialize();

    repoA = dataSourceA.getRepository(Analysis);
    repoB = dataSourceB.getRepository(Analysis);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    for (const ds of [dataSourceA, dataSourceB, bootstrapDataSource, observerDataSource]) {
      if (ds?.isInitialized) {
        try {
          await ds.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (createdDatabaseName) {
      try {
        await dropIsolatedTestDatabase(target, createdDatabaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Fallo(s) durante la limpieza de recursos de esta suite — ver causas.',
      );
    }
  });

  beforeEach(() => {
    pythonWorkerServiceMock = { runFieldAnalysis: jest.fn().mockResolvedValue(buildWorkerResult()) };
    fieldsServiceMock = {
      findOne: jest.fn().mockImplementation((id: string, userId: string) =>
        Promise.resolve({ id, userId, ...buildPipelineInput(id) } as any),
      ),
      getPipelineInput: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(buildPipelineInput(id)),
      ),
    };
    serviceA = buildAnalysisService(repoA);
    serviceB = buildAnalysisService(repoB);
  });

  async function associationRows(fieldId: string, clientRequestId: string) {
    return repoA.query(
      `SELECT * FROM "analysis_client_request" WHERE "fieldId" = $1 AND "clientRequestId" = $2`,
      [fieldId, clientRequestId],
    );
  }

  const baseInput = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };
  const staleStartedAt = () => new Date(Date.now() - ANALYSIS_STALE_THRESHOLD_MS - 60_000);
  const freshStartedAt = () => new Date();

  /** Siembra una fila 'Procesando' directamente (sin pasar por el servicio) — startedAt
   * controlable para simular tanto un vencido (por defecto) como uno vigente. */
  async function seedProcesando(
    repo: Repository<Analysis>,
    fieldId: string,
    overrides: Partial<Analysis> = {},
  ): Promise<Analysis> {
    const entity = repo.create({
      scope: 'field',
      fieldId,
      lotId: null,
      lotName: 'Campo de prueba F04 (ronda 6, sembrado)',
      status: 'Procesando',
      startDate: baseInput.startDate,
      endDate: baseInput.endDate,
      maxCloudiness: baseInput.maxCloudiness,
      startedAt: staleStartedAt(),
      resultJson: {
        mode: 'python-worker-v2',
        message: 'Análisis de campo en procesamiento.',
        fieldId,
        lots: [],
      } as any,
      ...overrides,
    });

    return repo.save(entity);
  }

  /** Igual que analysis-dedup-client-request.e2e-spec.ts: spía createQueryRunner de `dataSource`
   * para interceptar la PRIMERA sentencia dentro de CUALQUIER transacción que matchee `predicate`.
   * `predicate` puede llevar su propio estado (closure) para elegir, p. ej., la N-ésima ocurrencia
   * de un mismo texto de sentencia (ver ESCENARIO 6, variante "falla en el reintento"). */
  function interceptTransactionQuery(
    dataSource: DataSource,
    predicate: (sql: string) => boolean,
    onMatch: (executeReal: () => Promise<any>) => Promise<any>,
  ): jest.SpiedFunction<typeof dataSource.createQueryRunner> {
    const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource);

    return jest
      .spyOn(dataSource, 'createQueryRunner')
      .mockImplementation((...runnerArgs: unknown[]) => {
        const queryRunner = (originalCreateQueryRunner as (...a: unknown[]) => ReturnType<typeof dataSource.createQueryRunner>)(
          ...runnerArgs,
        );
        const originalQuery = queryRunner.query.bind(queryRunner);
        let matched = false;

        queryRunner.query = (async (...queryArgs: unknown[]) => {
          const [sql] = queryArgs as [string, unknown[]?];

          if (!matched && typeof sql === 'string' && predicate(sql)) {
            matched = true;
            return onMatch(() => originalQuery(...(queryArgs as [string, unknown[]?])));
          }

          return originalQuery(...(queryArgs as [string, unknown[]?]));
        }) as typeof queryRunner.query;

        return queryRunner;
      });
  }

  it('ESCENARIO 1 — K existente apunta a A Procesando vencido: devuelve A, conserva K → A, no inicia procesamiento nuevo', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K = `client-req-${fieldId}`;

    const analysisA = await seedProcesando(repoA, fieldId); // vencido por defecto.
    await repoA.query(
      `INSERT INTO "analysis_client_request" ("fieldId", "clientRequestId", "analysisId")
       VALUES ($1, $2, $3)`,
      [fieldId, K, analysisA.id],
    );

    const result = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K },
      userId,
    );

    // Se devuelve A tal cual — vencido, todavía 'Procesando', sin marcar Error ni tocar ningún
    // campo (objetivo 1: "incluso si está vencido... no crea ni dispara otro").
    expect(result.id).toBe(analysisA.id);
    expect(result.status).toBe('Procesando');
    expect(result.errorMessage).toBeNull();

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(1); // ninguna fila nueva.

    const assocRows = await associationRows(fieldId, K);
    expect(assocRows).toHaveLength(1);
    expect(assocRows[0].analysisId).toBe(analysisA.id); // la asociación no se redirigió.

    expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();
    expect(fieldsServiceMock.getPipelineInput).not.toHaveBeenCalled();

    const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
    expect(aAfter?.status).toBe('Procesando'); // confirmado también fuera del valor devuelto.
  });

  it('ESCENARIO 2 — K nueva encuentra A vencido: A queda Error según la regla existente, se crea un reemplazo B y K → B, un solo disparo del Worker', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K = `client-req-nueva-${fieldId}`;

    const analysisA = await seedProcesando(repoA, fieldId); // vencido, SIN asociación K previa.

    const result = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K },
      userId,
    );

    expect(result.id).not.toBe(analysisA.id);
    expect(result.status).toBe('Procesando'); // B recién creada.

    // A quedó Error, con exactamente los mismos campos que failStaleAnalysis/computeStaleErrorFields.
    const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
    expect(aAfter?.status).toBe('Error');
    expect(aAfter?.errorMessage).toBe(ANALYSIS_STALE_ERROR_MESSAGE);
    expect(aAfter?.failedAt).not.toBeNull();
    expect(aAfter?.durationMs).not.toBeNull();
    expect(aAfter?.durationMs).toBeGreaterThan(0);

    const assocRows = await associationRows(fieldId, K);
    expect(assocRows).toHaveLength(1);
    expect(assocRows[0].analysisId).toBe(result.id); // K → B, no K → A.

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // A (Error) + B (reemplazo).

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // un solo disparo.

    await waitForTerminalStatus(repoA, result.id);
  });

  it('ESCENARIO 3 — dos instancias con la MISMA K nueva frente a A vencido (contención real): mismo B, una asociación, un reemplazo, un disparo', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K = `client-req-${fieldId}`;
    const input = { ...baseInput, clientRequestId: K };

    const analysisA = await seedProcesando(repoA, fieldId); // vencido.

    let releaseGate!: () => void;
    let gateReleased = false;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const ensureGateReleased = () => {
      if (!gateReleased) {
        gateReleased = true;
        releaseGate();
      }
    };

    let resolveInsertedSignal!: () => void;
    const insertedSignal = new Promise<void>((resolve) => {
      resolveInsertedSignal = resolve;
    });

    // Retiene, con contención REAL de Postgres, la exclusión (1) — el INSERT ... ON CONFLICT
    // contra analysis_client_request. Es el punto correcto: con la MISMA K, A y B contienden ACÁ
    // primero, antes de que cualquiera llegue siquiera a mirar el 'Procesando' vencido.
    const querySpy = interceptTransactionQuery(
      dataSourceA as DataSource,
      (sql) => sql.includes('INSERT INTO "analysis_client_request"'),
      async (executeReal) => {
        const result = await executeReal();
        resolveInsertedSignal();
        await gate;
        return result;
      },
    );

    const promiseA = serviceA.runFieldAnalysis(fieldId, input, userId);
    let promiseB: Promise<Analysis> | undefined;
    let earlyError: unknown;

    try {
      await raceBarrierWithEarlyFailure(insertedSignal, promiseA, 'promiseA (instrumentada, A)');

      promiseB = serviceB.runFieldAnalysis(fieldId, input, userId); // MISMA K.

      await raceBarrierWithEarlyFailure(
        waitForLockContention(observerDataSource as DataSource, createdDatabaseName as string, {
          timeoutMs: 5_000,
          pollIntervalMs: 50,
        }),
        promiseB,
        'promiseB',
      );
    } catch (error) {
      earlyError = error;
    } finally {
      ensureGateReleased();
    }

    const settled = await Promise.allSettled([promiseA, promiseB ?? Promise.resolve(undefined)]);
    querySpy.mockRestore();

    if (earlyError) {
      throw earlyError;
    }

    const [outcomeA, outcomeB] = settled as [
      PromiseSettledResult<Analysis>,
      PromiseSettledResult<Analysis>,
    ];

    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const resultA = (outcomeA as PromiseFulfilledResult<Analysis>).value;
    const resultB = (outcomeB as PromiseFulfilledResult<Analysis>).value;
    expect(resultA.id).toBe(resultB.id);
    expect(resultA.id).not.toBe(analysisA.id); // ninguna de las dos devolvió el vencido.

    await waitForTerminalStatus(repoA, resultA.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // A (Error) + el único reemplazo B.

    const aAfter = rows.find((r) => r.id === analysisA.id);
    expect(aAfter?.status).toBe('Error');
    expect(aAfter?.errorMessage).toBe(ANALYSIS_STALE_ERROR_MESSAGE);

    const assocRows = await associationRows(fieldId, K);
    expect(assocRows).toHaveLength(1); // una sola asociación.
    expect(assocRows[0].analysisId).toBe(resultA.id);

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // un solo disparo.
  });

  it('ESCENARIO 4 — dos claves NUEVAS distintas frente a A vencido, con el Worker de B retenido: ambas convergen en B, se conservan ambas asociaciones, un solo disparo', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K1 = `client-req-1-${fieldId}`;
    const K2 = `client-req-2-${fieldId}`;

    const analysisA = await seedProcesando(repoA, fieldId); // vencido.

    let releaseWorkerGate!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkerGate = resolve;
    });
    pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
      await workerGate;
      return buildWorkerResult();
    });

    // Request 1 (K1): recupera el slot de A vencido, crea B y dispara su Worker — pero
    // completeWonSlot NUNCA espera a que el Worker termine (fire-and-forget, ver
    // processFieldAnalysisInBackground): esta llamada resuelve apenas B queda confirmada, con el
    // Worker todavía retenido en `workerGate` — así que B queda 'Procesando' en la base de forma
    // determinista para el resto de este test, sin necesidad de ninguna barrera adicional.
    const result1 = await serviceA.runFieldAnalysis(fieldId, { ...baseInput, clientRequestId: K1 }, userId);
    expect(result1.status).toBe('Procesando');
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // ya invocado (aunque retenido).

    // Todavía con B 'Procesando' (Worker retenido): request 2 (K2), clave DISTINTA y también
    // nueva, debe encontrar a B (fresca, NO vencida) y reutilizarla — nunca crear un segundo
    // reemplazo ni volver a tocar a A.
    const result2 = await serviceB.runFieldAnalysis(fieldId, { ...baseInput, clientRequestId: K2 }, userId);

    releaseWorkerGate();

    expect(result2.id).toBe(result1.id);
    expect(result2.id).not.toBe(analysisA.id);

    await waitForTerminalStatus(repoA, result1.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // A (Error) + el único reemplazo B — ninguna fila de más.

    const aAfter = rows.find((r) => r.id === analysisA.id);
    expect(aAfter?.status).toBe('Error');

    const assoc1 = await associationRows(fieldId, K1);
    expect(assoc1).toHaveLength(1);
    expect(assoc1[0].analysisId).toBe(result1.id);

    const assoc2 = await associationRows(fieldId, K2);
    expect(assoc2).toHaveLength(1);
    expect(assoc2[0].analysisId).toBe(result1.id); // ambas asociaciones apuntan a B.

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // un solo disparo.
  });

  it('ESCENARIO 5 — A cambia a estado terminal ANTES de que la recuperación obtenga la exclusión: no se sobrescribe ese estado ni sus datos de finalización', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K = `client-req-nueva-${fieldId}`;

    const analysisA = await seedProcesando(repoA, fieldId); // vencido — candidato "natural" a recuperación.

    const finalizedGlobalScore = 77;
    const finalizedCategory = 'Finalizada de forma independiente antes de la recuperación';

    // Intercepta la PRIMERA sentencia de exclusión (2) — el INSERT ... ON CONFLICT contra
    // "analysis" — DENTRO de la transacción de A. Justo antes de ejecutarla de verdad, una
    // conexión INDEPENDIENTE (dataSourceB) finaliza a A de punta a punta y confirma — simulando
    // que el Worker real de A terminó exitosamente en el instante exacto anterior a que esta
    // recuperación intentara tomar la exclusión.
    const querySpy = interceptTransactionQuery(
      dataSourceA as DataSource,
      (sql) => sql.includes('INSERT INTO "analysis"') && !sql.includes('analysis_client_request'),
      async (executeReal) => {
        const independent = await repoB.findOne({ where: { id: analysisA.id } });
        if (!independent) {
          throw new Error('Setup inválido: A no se encontró para finalizarla independientemente.');
        }
        independent.status = 'Finalizado';
        independent.completedAt = new Date();
        independent.globalScore = finalizedGlobalScore;
        independent.category = finalizedCategory;
        independent.errorMessage = null;
        await repoB.save(independent); // conexión independiente — confirma ANTES de executeReal().

        return executeReal();
      },
    );

    const result = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K },
      userId,
    );
    querySpy.mockRestore();

    // La recuperación por staleness nunca se activó: al llegar la sentencia de exclusión (2), A ya
    // no matcheaba el predicado 'Procesando' del índice parcial (estaba Finalizado, ya confirmado)
    // — el INSERT de la candidata no chocó con nada, se insertó directo. Se creó una fila NUEVA,
    // sin tocar a A en absoluto.
    expect(result.id).not.toBe(analysisA.id);
    expect(result.status).toBe('Procesando');

    const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
    expect(aAfter?.status).toBe('Finalizado'); // conservado.
    expect(aAfter?.globalScore).toBe(finalizedGlobalScore); // datos de finalización intactos.
    expect(aAfter?.category).toBe(finalizedCategory);
    expect(aAfter?.errorMessage).toBeNull(); // nunca se le aplicó el mensaje de staleness.

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // A (Finalizado, ajena) + la nueva.

    const assocRows = await associationRows(fieldId, K);
    expect(assocRows).toHaveLength(1);
    expect(assocRows[0].analysisId).toBe(result.id);

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // solo la nueva.

    await waitForTerminalStatus(repoA, result.id);
  });

  describe('ESCENARIO 6 — fallo DENTRO de la recuperación transaccional: sin transición, asociación ni reemplazo parcialmente confirmados; sin Worker', () => {
    it('variante "falla al marcar Error": la fila vencida vuelve a quedar exactamente como estaba, ninguna asociación ni reemplazo', async () => {
      const fieldId = freshFieldId();
      const userId = 'user-A';
      const K = `client-req-nueva-${fieldId}`;

      const analysisA = await seedProcesando(repoA, fieldId); // vencido.
      const startedAtBefore = analysisA.startedAt;

      const injectionError = new Error('DB caída al marcar Error la fila vencida.');
      const querySpy = interceptTransactionQuery(
        dataSourceA as DataSource,
        (sql) => sql.includes('UPDATE "analysis"') && sql.includes(`SET "status" = 'Error'`),
        async () => {
          throw injectionError;
        },
      );

      await expect(
        serviceA.runFieldAnalysis(fieldId, { ...baseInput, clientRequestId: K }, userId),
      ).rejects.toBe(injectionError);
      querySpy.mockRestore();

      const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
      expect(aAfter?.status).toBe('Procesando'); // nunca se confirmó la transición a Error.
      expect(aAfter?.errorMessage).toBeNull();
      expect(aAfter?.startedAt?.getTime()).toBe(startedAtBefore?.getTime());

      const rows = await repoA.find({ where: { fieldId } });
      expect(rows).toHaveLength(1); // solo A — ningún reemplazo sobrevivió.

      const assocRows = await associationRows(fieldId, K);
      expect(assocRows).toHaveLength(0); // ninguna asociación parcial.

      expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();

      // Recuperación posterior: reintentar la MISMA clave, ya sin el fallo inyectado, recupera el
      // slot con normalidad.
      const retryResult = await serviceA.runFieldAnalysis(
        fieldId,
        { ...baseInput, clientRequestId: K },
        userId,
      );
      expect(retryResult.id).not.toBe(analysisA.id);
      expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

      const aAfterRetry = await repoA.findOne({ where: { id: analysisA.id } });
      expect(aAfterRetry?.status).toBe('Error');

      await waitForTerminalStatus(repoA, retryResult.id);
    });

    it('variante "falla al reintentar la inserción del reemplazo": ni la transición a Error ni el reemplazo sobreviven', async () => {
      const fieldId = freshFieldId();
      const userId = 'user-A';
      const K = `client-req-nueva-${fieldId}`;

      const analysisA = await seedProcesando(repoA, fieldId); // vencido.

      // La sentencia de exclusión (2) es idéntica en el primer intento y en el reintento (misma
      // candidata) — este predicate lleva su propio contador para fallar específicamente la
      // SEGUNDA ocurrencia (el reintento posterior a marcar Error), no la primera (la que
      // descubre el vencido).
      let attemptCount = 0;
      const injectionError = new Error('DB caída al reintentar el INSERT del reemplazo.');
      const querySpy = interceptTransactionQuery(
        dataSourceA as DataSource,
        (sql) => {
          if (sql.includes('INSERT INTO "analysis"') && !sql.includes('analysis_client_request')) {
            attemptCount += 1;
            return attemptCount === 2;
          }
          return false;
        },
        async () => {
          throw injectionError;
        },
      );

      await expect(
        serviceA.runFieldAnalysis(fieldId, { ...baseInput, clientRequestId: K }, userId),
      ).rejects.toBe(injectionError);
      querySpy.mockRestore();
      expect(attemptCount).toBe(2); // confirma que sí llegó a intentar el reintento.

      // Rollback TOTAL: la transición a Error de A (ejecutada ANTES del fallo, en la misma
      // transacción) tampoco sobrevivió — vuelve a estar exactamente como estaba.
      const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
      expect(aAfter?.status).toBe('Procesando');
      expect(aAfter?.errorMessage).toBeNull();

      const rows = await repoA.find({ where: { fieldId } });
      expect(rows).toHaveLength(1); // solo A — el reemplazo nunca se confirmó.

      const assocRows = await associationRows(fieldId, K);
      expect(assocRows).toHaveLength(0);

      expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();

      const retryResult = await serviceA.runFieldAnalysis(
        fieldId,
        { ...baseInput, clientRequestId: K },
        userId,
      );
      expect(retryResult.id).not.toBe(analysisA.id);
      expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

      await waitForTerminalStatus(repoA, retryResult.id);
    });
  });

  it('ESCENARIO 7 — Procesando VIGENTE: conserva la reutilización normal, sin marcarlo Error', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K = `client-req-nueva-${fieldId}`;

    const analysisA = await seedProcesando(repoA, fieldId, { startedAt: freshStartedAt() }); // vigente.

    const result = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K },
      userId,
    );

    expect(result.id).toBe(analysisA.id);
    expect(result.status).toBe('Procesando');

    const aAfter = await repoA.findOne({ where: { id: analysisA.id } });
    expect(aAfter?.status).toBe('Procesando'); // nunca se marcó Error.
    expect(aAfter?.errorMessage).toBeNull();
    expect(aAfter?.failedAt).toBeNull();

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(1); // ningún reemplazo.

    const assocRows = await associationRows(fieldId, K);
    expect(assocRows).toHaveLength(1);
    expect(assocRows[0].analysisId).toBe(analysisA.id);

    expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();
    expect(fieldsServiceMock.getPipelineInput).not.toHaveBeenCalled();
  });
});
