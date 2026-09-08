// F04 (revisión independiente, rondas 4-5): asociación duradera de clientRequestId.
//
// PRUEBAS 1-3, 5-8 (ronda 4): precedencia (una clave ya registrada recupera SU análisis
// original, sin importar qué otro análisis esté corriendo en paralelo) y persistencia (toda
// clave que reutiliza el análisis de otra acción queda asociada DURADERAMENTE antes de
// responder).
//
// PRUEBA 9 (ronda 5): resolver la clave, crear el análisis y registrar la asociación pasan a ser
// UNA transacción corta (AnalysisService.resolveOrCreateByClientRequestId), no tres pasos
// separados — la ronda 4 dejaba una ventana real entre "leer si K ya existe" y "escribir la
// asociación", y además ignoraba el resultado de esa escritura (RETURNING) al decidir si disparar
// el Worker. Ver el comentario extenso junto a donde se llama esto en runFieldAnalysis para el
// mecanismo, el orden de bloqueos y por qué no genera deadlocks.
//
// Mismo patrón que analysis-dedup-race.e2e-spec.ts: AnalysisService real (sin DI de Nest) con un
// Repository<Analysis> real por instancia contra una base PostgreSQL aislada y desechable, creada
// por esta misma ejecución con nombre único — nunca `agro_score` ni las DB_* generales. Lo único
// simulado es el Worker y FieldsService (no forman parte del mecanismo de exclusión).
import { DataSource, Repository } from 'typeorm';

import { AnalysisService } from '../src/analysis/analysis.service';
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

/** Idéntica a analysis-dedup-race.e2e-spec.ts / auth-reset-password-atomicity.e2e-spec.ts (F03) —
 * evidencia real de contención vía pg_stat_activity, nunca un sleep fijo usado como prueba. */
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

/** Idéntica a analysis-dedup-race.e2e-spec.ts: corta una espera de barrera de inmediato si la
 * operación observada se asienta antes de lo esperado, en vez de colgarse o esperar un timeout
 * genérico por la razón equivocada. */
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

/** Idéntica a analysis-dedup-race.e2e-spec.ts: señal REAL de que processFieldAnalysisInBackground
 * terminó — poll acotado por timeout, nunca un sleep fijo. */
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
    name: 'Campo de prueba F04',
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

describe('F04 (revisión independiente, rondas 4-5) — asociación duradera de clientRequestId (PostgreSQL real, base aislada por ejecución)', () => {
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
    return `field-f04-cr-${fieldCounter}`;
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

    const created = await createIsolatedTestDatabase(target, 'f04_dedup_client_request');
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

  describe.each([['Finalizado'] as const, ['Error'] as const])(
    'PRUEBA 1 — precedencia: K ya resuelta contra A (%s) devuelve A aunque B (otra acción, sin clave) esté Procesando para el mismo campo',
    (terminalStatus) => {
      it('reintentar K devuelve A tal cual, sin mutarla ni disparar procesamiento, y sin tocar a B', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const K = `client-req-${fieldId}`;
        const inputWithK = { ...baseInput, clientRequestId: K };

        if (terminalStatus === 'Error') {
          pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
            throw new Error('Worker rechazado deliberadamente por este test (A).');
          });
        }

        const analysisA = await serviceA.runFieldAnalysis(fieldId, inputWithK, userId);
        const finalA = await waitForTerminalStatus(repoA, analysisA.id);
        expect(finalA.status).toBe(terminalStatus);

        // B: otra acción, SIN clave, para el MISMO campo — se retiene su Worker para que quede
        // Procesando de forma determinista mientras se hace el reintento de K.
        let releaseBWorkerGate!: () => void;
        const bWorkerGate = new Promise<void>((resolve) => {
          releaseBWorkerGate = resolve;
        });
        pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
          await bWorkerGate;
          return buildWorkerResult();
        });

        const analysisB = await serviceB.runFieldAnalysis(fieldId, baseInput, userId);
        expect(analysisB.id).not.toBe(analysisA.id);
        expect(analysisB.status).toBe('Procesando');

        // Reintento de K MIENTRAS B sigue Procesando: antes de esta ronda, el fast-path por
        // status encontraba a B primero y lo devolvía — acá debe devolver A, tal cual quedó.
        const retryResult = await serviceA.runFieldAnalysis(fieldId, inputWithK, userId);

        expect(retryResult.id).toBe(analysisA.id);
        expect(retryResult.status).toBe(terminalStatus);

        // B queda intacta: no se mutó ni se le disparó nada por culpa del reintento de K.
        const bAfterRetry = await repoB.findOne({ where: { id: analysisB.id } });
        expect(bAfterRetry?.status).toBe('Procesando');

        // Ningún procesamiento adicional: 1 disparo por A, 1 por B — nunca un tercero por el
        // reintento de K.
        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2);

        releaseBWorkerGate();
        await waitForTerminalStatus(repoB, analysisB.id);
      });
    },
  );

  describe.each([['Finalizado'] as const, ['Error'] as const])(
    'PRUEBA 2 — persistencia: clave K nueva reutiliza A (que ya tiene su PROPIA clave K_A); tras terminar A (%s), reintentar K devuelve A sin disparar otro Worker',
    (terminalStatus) => {
      it('la asociación K → A quedó persistida en el momento de la reutilización, no se pierde cuando A termina', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const K_A = `client-req-a-${fieldId}`;
        const K = `client-req-nueva-${fieldId}`;

        let releaseWorkerGate!: () => void;
        const workerGate = new Promise<void>((resolve) => {
          releaseWorkerGate = resolve;
        });
        pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
          await workerGate;
          if (terminalStatus === 'Error') {
            throw new Error('Worker rechazado deliberadamente por este test.');
          }
          return buildWorkerResult();
        });

        const analysisA = await serviceA.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K_A },
          userId,
        );
        expect(analysisA.status).toBe('Procesando');

        // K es nueva: reutiliza a A (todavía Procesando) vía el fast-path por status.
        const analysisB = await serviceB.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K },
          userId,
        );
        expect(analysisB.id).toBe(analysisA.id);

        // La asociación (fieldId, K) → A.id debe existir YA, antes de que A termine — es lo que
        // se verifica acá, no solo el resultado final.
        const rows = await associationRows(fieldId, K);
        expect(rows).toHaveLength(1);
        expect(rows[0].analysisId).toBe(analysisA.id);

        releaseWorkerGate();
        const finalA = await waitForTerminalStatus(repoA, analysisA.id);
        expect(finalA.status).toBe(terminalStatus);

        // Reintento de K DESPUÉS de que A ya terminó: debe devolver A, sin disparar un segundo
        // Worker — este es exactamente el bug reproducido por la revisión independiente.
        const retryResult = await serviceA.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K },
          userId,
        );
        expect(retryResult.id).toBe(analysisA.id);
        expect(retryResult.status).toBe(terminalStatus);

        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

        const rowsAfter = await repoA.find({ where: { fieldId } });
        expect(rowsAfter).toHaveLength(1); // ninguna fila nueva.
      });
    },
  );

  describe.each([['Finalizado'] as const, ['Error'] as const])(
    'PRUEBA 3 — igual que la anterior, pero A arranca SIN ninguna clave',
    (terminalStatus) => {
      it('la asociación K → A quedó persistida aunque A no tenga clientRequestId propia', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const K = `client-req-nueva-${fieldId}`;

        let releaseWorkerGate!: () => void;
        const workerGate = new Promise<void>((resolve) => {
          releaseWorkerGate = resolve;
        });
        pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
          await workerGate;
          if (terminalStatus === 'Error') {
            throw new Error('Worker rechazado deliberadamente por este test.');
          }
          return buildWorkerResult();
        });

        const analysisA = await serviceA.runFieldAnalysis(fieldId, baseInput, userId); // sin clave.
        expect(analysisA.status).toBe('Procesando');

        const analysisB = await serviceB.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K },
          userId,
        );
        expect(analysisB.id).toBe(analysisA.id);

        const rows = await associationRows(fieldId, K);
        expect(rows).toHaveLength(1);
        expect(rows[0].analysisId).toBe(analysisA.id);

        releaseWorkerGate();
        const finalA = await waitForTerminalStatus(repoA, analysisA.id);
        expect(finalA.status).toBe(terminalStatus);

        const retryResult = await serviceA.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K },
          userId,
        );
        expect(retryResult.id).toBe(analysisA.id);

        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

        const rowsAfter = await repoA.find({ where: { fieldId } });
        expect(rowsAfter).toHaveLength(1);
      });
    },
  );

  /**
   * F04 (revisión independiente, ronda 5): resolveOrCreateByClientRequestId corre TODAS sus
   * sentencias dentro de UNA transacción propia (this.analysisRepository.manager.transaction) —
   * espiar repo.query (como hacía la ronda 4) ya NO alcanza, porque esas sentencias se ejecutan
   * contra el QueryRunner que esa transacción abre internamente, no contra la conexión que usa
   * repo.query() para llamadas sueltas. Este helper intercepta un nivel más abajo: envuelve
   * dataSource.createQueryRunner para devolver un QueryRunner cuyo .query() reacciona ante la
   * PRIMERA sentencia que matchee `predicate` — todo lo demás (incluidas las sentencias de
   * BEGIN/COMMIT/ROLLBACK que TypeORM emite por su cuenta) pasa sin tocar por
   * `originalQuery`. Como el QueryRunner devuelto es el que la transacción real usa de punta a
   * punta, la conexión/lock sigue siendo real: si `onMatch` retiene la promesa antes de
   * resolverla, la transacción de Postgres queda genuinamente abierta (BEGIN ya emitido, sin
   * COMMIT/ROLLBACK) mientras tanto — contención real y observable en pg_stat_activity, igual que
   * CASO 1 de analysis-dedup-race.e2e-spec.ts, solo que ahora aplicada dentro de una transacción
   * explícita en lugar de una sentencia autocommit suelta.
   */
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

  describe.each([['Finalizado'] as const, ['Error'] as const])(
    'PRUEBA 4 — dos instancias registran SIMULTÁNEAMENTE la misma K (contención real de Postgres, %s)',
    (terminalStatus) => {
      it('una sola asociación, mismo id, un solo disparo al Worker', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const K = `client-req-${fieldId}`;
        const input = { ...baseInput, clientRequestId: K };

        if (terminalStatus === 'Error') {
          pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
            throw new Error('Worker rechazado deliberadamente por este test.');
          });
        }

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

        // Retiene, con contención REAL de Postgres, la PRIMERA exclusión que toma
        // resolveOrCreateByClientRequestId — el INSERT ... ON CONFLICT contra
        // analysis_client_request. Es el punto correcto para "dos instancias registran
        // simultáneamente la misma K": esa sentencia (no el INSERT contra "analysis", que ni
        // siquiera llega a ejecutarse todavía en este instante) es la que decide, entre A y B,
        // quién reclama (fieldId, K) primero.
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

        const analysisA = (outcomeA as PromiseFulfilledResult<Analysis>).value;
        const analysisB = (outcomeB as PromiseFulfilledResult<Analysis>).value;
        expect(analysisA.id).toBe(analysisB.id);

        await waitForTerminalStatus(repoA, analysisA.id);

        const rows = await repoA.find({ where: { fieldId } });
        expect(rows).toHaveLength(1);

        const assocRows = await associationRows(fieldId, K);
        expect(assocRows).toHaveLength(1); // una sola asociación, no dos.
        expect(assocRows[0].analysisId).toBe(analysisA.id);

        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);
      });
    },
  );

  it('PRUEBA 5 — claves DIFERENTES que reutilizan A conservan cada una su propia asociación (ninguna pisa a la otra ni a la de A)', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K_A = `client-req-a-${fieldId}`;
    const K1 = `client-req-1-${fieldId}`;
    const K2 = `client-req-2-${fieldId}`;

    let releaseWorkerGate!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkerGate = resolve;
    });
    pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
      await workerGate;
      return buildWorkerResult();
    });

    const analysisA = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K_A },
      userId,
    );

    const analysisB = await serviceB.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K1 },
      userId,
    );
    expect(analysisB.id).toBe(analysisA.id);

    const analysisC = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K2 },
      userId,
    );
    expect(analysisC.id).toBe(analysisA.id);

    releaseWorkerGate();
    await waitForTerminalStatus(repoA, analysisA.id);

    // Las TRES claves siguen resolviendo, cada una por su cuenta, al mismo análisis — ninguna se
    // pisó con las otras dos.
    for (const key of [K_A, K1, K2]) {
      const rows = await associationRows(fieldId, key);
      expect(rows).toHaveLength(1);
      expect(rows[0].analysisId).toBe(analysisA.id);

      const retryResult = await serviceA.runFieldAnalysis(
        fieldId,
        { ...baseInput, clientRequestId: key },
        userId,
      );
      expect(retryResult.id).toBe(analysisA.id);
    }

    // Ningún reintento disparó un Worker adicional.
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(1);
  });

  it('PRUEBA 6 — una acción posterior con clave nueva puede crear un análisis nuevo', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const K_A = `client-req-a-${fieldId}`;
    const K_NUEVA = `client-req-nueva-${fieldId}`;

    const analysisA = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K_A },
      userId,
    );
    await waitForTerminalStatus(repoA, analysisA.id);

    const analysisNueva = await serviceA.runFieldAnalysis(
      fieldId,
      { ...baseInput, clientRequestId: K_NUEVA },
      userId,
    );

    expect(analysisNueva.id).not.toBe(analysisA.id);
    expect(analysisNueva.status).toBe('Procesando');
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2);

    await waitForTerminalStatus(repoA, analysisNueva.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // la original + la nueva, ninguna pisada.

    const assocA = await associationRows(fieldId, K_A);
    expect(assocA[0].analysisId).toBe(analysisA.id); // la vieja asociación no se tocó.

    const assocNueva = await associationRows(fieldId, K_NUEVA);
    expect(assocNueva[0].analysisId).toBe(analysisNueva.id);
  });

  describe('PRUEBA 8 — fallo real DENTRO de la transacción de resolveOrCreateByClientRequestId: rollback real, sin análisis ni asociación parcial y sin Worker', () => {
    it('variante "gana el slot": falla el INSERT contra "analysis" (después de reclamar la asociación con la candidata) — la transacción entera revierte, incluida la asociación tentativa', async () => {
      const fieldId = freshFieldId();
      const userId = 'user-A';
      const K = `client-req-${fieldId}`;
      const input = { ...baseInput, clientRequestId: K };

      const injectionError = new Error('DB caída al crear la fila de análisis.');
      const querySpy = interceptTransactionQuery(
        dataSourceA as DataSource,
        (sql) => sql.includes('INSERT INTO "analysis"') && !sql.includes('analysis_client_request'),
        async () => {
          throw injectionError;
        },
      );

      await expect(serviceA.runFieldAnalysis(fieldId, input, userId)).rejects.toBe(injectionError);
      querySpy.mockRestore();

      // Rollback real: ni la fila de Analysis (nunca llegó a confirmarse) ni la asociación
      // tentativa (candidateId, reclamada un instante antes en la MISMA transacción) sobreviven —
      // markPreparationFailureOnWonSlot ni siquiera llega a ejecutarse, porque la transacción que
      // hubiera creado savedAnalysis jamás confirmó.
      const rows = await repoA.find({ where: { fieldId } });
      expect(rows).toHaveLength(0);

      const rowsAssoc = await associationRows(fieldId, K);
      expect(rowsAssoc).toHaveLength(0);

      expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();

      // Recuperación posterior: reintentar la MISMA clave, ya sin el fallo inyectado, crea y
      // procesa un análisis con normalidad.
      const retryResult = await serviceA.runFieldAnalysis(fieldId, input, userId);
      expect(retryResult.status).toBe('Procesando');
      expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

      const rowsAssocAfterRetry = await associationRows(fieldId, K);
      expect(rowsAssocAfterRetry).toHaveLength(1);
      expect(rowsAssocAfterRetry[0].analysisId).toBe(retryResult.id);

      await waitForTerminalStatus(repoA, retryResult.id);
    });

    it('variante "reutiliza fila ajena": falla el UPDATE que redirige la asociación tentativa al análisis real — la transacción entera revierte, la fila ajena queda intacta, sin Worker propio', async () => {
      const fieldId = freshFieldId();
      const userId = 'user-A';
      const K = `client-req-${fieldId}`;
      const input = { ...baseInput, clientRequestId: K };

      // Otra acción, sin clave, deja una fila Procesando para que ESTA request la encuentre y
      // pierda la carrera por el slot del campo dentro de su propia transacción — el fallo
      // inyectado ocurre JUSTO en el paso que corrige la asociación tentativa hacia esta fila.
      let releaseForeignWorkerGate!: () => void;
      const foreignGate = new Promise<void>((resolve) => {
        releaseForeignWorkerGate = resolve;
      });
      pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
        await foreignGate;
        return buildWorkerResult();
      });
      const foreign = await serviceB.runFieldAnalysis(fieldId, baseInput, userId);

      const injectionError = new Error('DB caída al redirigir la asociación.');
      const querySpy = interceptTransactionQuery(
        dataSourceA as DataSource,
        (sql) =>
          sql.includes('UPDATE "analysis_client_request"') && sql.includes('"analysisId" = $3'),
        async () => {
          throw injectionError;
        },
      );

      await expect(serviceA.runFieldAnalysis(fieldId, input, userId)).rejects.toBe(injectionError);
      querySpy.mockRestore();

      // La fila ajena sigue EXACTAMENTE como estaba — nunca fue nuestra, y el fallo ocurrió
      // dentro de nuestra propia transacción, que revirtió sin tocarla en ningún momento.
      const foreignRow = await repoA.findOne({ where: { id: foreign.id } });
      expect(foreignRow?.status).toBe('Procesando');

      // Ni la asociación tentativa (candidateId) ni ninguna fila nueva de Analysis sobrevivieron.
      const rows = await repoA.find({ where: { fieldId } });
      expect(rows).toHaveLength(1); // solo la fila ajena — nada nuestro.
      expect(rows[0].id).toBe(foreign.id);

      const rowsAssoc = await associationRows(fieldId, K);
      expect(rowsAssoc).toHaveLength(0);

      expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // solo la ajena.

      releaseForeignWorkerGate();
      await waitForTerminalStatus(repoA, foreign.id);

      // Recuperación posterior: reintentar la MISMA clave, ya sin el fallo inyectado. Para
      // entonces la ajena ya terminó (se esperó arriba), así que esta clave —que nunca llegó a
      // asociarse por el fallo inyectado— crea su PROPIO análisis nuevo, con normalidad.
      const retryResult = await serviceA.runFieldAnalysis(fieldId, input, userId);
      expect(retryResult.status).toBe('Procesando');
      expect(retryResult.id).not.toBe(foreign.id);
      expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2); // ajena + reintento.

      const rowsAssocAfterRetry = await associationRows(fieldId, K);
      expect(rowsAssocAfterRetry).toHaveLength(1);
      expect(rowsAssocAfterRetry[0].analysisId).toBe(retryResult.id);

      await waitForTerminalStatus(repoA, retryResult.id);
    });
  });

  /**
   * F04 (revisión independiente, ronda 5): prueba determinista obligatoria — cierra la carrera
   * reportada: recordClientRequestAssociation (ronda 4) ejecutaba su propio RETURNING pero
   * devolvía void, así que runFieldAnalysis nunca leía qué asociación había ganado de verdad.
   * Reproducida: B consulta K, no encuentra nada, queda demorada; A registra K→A, confirma,
   * procesa y termina; B retoma, gana el slot del campo (libre porque A ya terminó) y crea su
   * propia fila; B intenta registrar K→B, Postgres conserva K→A y devuelve A — pero el resultado
   * se ignoraba, así que B disparaba su propio Worker y devolvía su propia fila.
   *
   * Este mecanismo (resolveOrCreateByClientRequestId) ya NO tiene una "lectura inicial" separada
   * de la decisión atómica — leer y decidir son la MISMA transacción corta (ver el comentario
   * junto a donde se llama esto en runFieldAnalysis). Siguiendo la instrucción para ese caso: la
   * barrera se adapta al punto equivalente ANTERIOR a que B intente adquirir la coordinación —
   * la entrada misma a runFieldAnalysis, reteniendo fieldsServiceMock.findOne específicamente
   * para la llamada de B (el primer await de toda la función, antes de cualquier validación o
   * intento de coordinación).
   */
  describe.each([['Finalizado'] as const, ['Error'] as const])(
    'PRUEBA 9 — B retenida ANTES de intentar adquirir la coordinación por clave; A registra K, confirma, procesa y termina de punta a punta; al reanudar B, misma respuesta (%s)',
    (terminalStatus) => {
      it('mismo id para A y B, una sola asociación, una sola fila nueva de Analysis, un solo disparo al Worker — y un pedido posterior con clave nueva sigue pudiendo crear otro análisis', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const K = `client-req-${fieldId}`;
        const input = { ...baseInput, clientRequestId: K };

        if (terminalStatus === 'Error') {
          pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
            throw new Error('Worker rechazado deliberadamente por este test.');
          });
        }

        let releaseBGate!: () => void;
        const bGate = new Promise<void>((resolve) => {
          releaseBGate = resolve;
        });
        let resolveBReached!: () => void;
        const bReached = new Promise<void>((resolve) => {
          resolveBReached = resolve;
        });

        const defaultFindOneImpl = fieldsServiceMock.findOne.getMockImplementation()!;
        fieldsServiceMock.findOne.mockImplementationOnce(async (...args: unknown[]) => {
          resolveBReached();
          await bGate;
          return defaultFindOneImpl(...args);
        });

        const promiseB = serviceB.runFieldAnalysis(fieldId, input, userId);

        await raceBarrierWithEarlyFailure(
          bReached,
          promiseB,
          'promiseB (retenida antes de adquirir la coordinación)',
        );

        // A: corre de punta a punta, sin ningún gate, con la MISMA clave — mientras B sigue
        // retenida antes de siquiera empezar a coordinar nada.
        const analysisA = await serviceA.runFieldAnalysis(fieldId, input, userId);
        const finalA = await waitForTerminalStatus(repoA, analysisA.id);
        expect(finalA.status).toBe(terminalStatus);

        // Recién ahora se libera a B.
        releaseBGate();
        const analysisB = await promiseB;

        expect(analysisB.id).toBe(analysisA.id);

        const rows = await repoA.find({ where: { fieldId } });
        expect(rows).toHaveLength(1); // una sola fila nueva — no la de B además de la de A.

        const assocRows = await associationRows(fieldId, K);
        expect(assocRows).toHaveLength(1); // una sola asociación.
        expect(assocRows[0].analysisId).toBe(analysisA.id);

        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // un solo disparo.

        // Verificación separada: una acción NUEVA (clientRequestId distinto), ya con A y B
        // resueltas, sigue pudiendo crear su propio análisis.
        const K_NUEVA = `client-req-nueva-${fieldId}`;
        const independentRetry = await serviceA.runFieldAnalysis(
          fieldId,
          { ...baseInput, clientRequestId: K_NUEVA },
          userId,
        );
        expect(independentRetry.id).not.toBe(analysisA.id);
        expect(independentRetry.status).toBe('Procesando');
        expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2);

        await waitForTerminalStatus(repoA, independentRetry.id);

        const rowsAfterRetry = await repoA.find({ where: { fieldId } });
        expect(rowsAfterRetry).toHaveLength(2);
      });
    },
  );
});
