// ADR-001: integración de la cola durable de análisis contra PostgreSQL 15 REAL y pg-boss REAL.
//
// Base aislada y descartable creada por esta ejecución (test/support/isolated-postgres-database.ts,
// variables TEST_DB_* explícitas — nunca las DB_* del backend). Nada de PostgreSQL se mockea en lo
// que prueba atomicidad, unicidad, locking, outbox, pg-boss, retry/DLQ o recuperación. Lo único
// simulado es el Worker FastAPI (PythonWorkerService.runFieldAnalysis, jest.fn que cuenta
// llamadas) y el veredicto técnico (no llama a Claude) — sin Earth Engine, SMTP ni AWS.
//
// pg-boss 12 es ESM-only: esta suite corre con `npm run test:integration`, que agrega
// NODE_OPTIONS=--experimental-vm-modules para permitir su import() dinámico dentro de Jest.
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';

import { AnalysisService } from '../src/analysis/analysis.service';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { ReportPdfService } from '../src/analysis/report-pdf/report-pdf.service';
import { AnalysisExecutionStore } from '../src/analysis-queue/analysis-execution.store';
import { buildAnalysisExecutePayload } from '../src/analysis-queue/analysis-job.contract';
import { AnalysisJobConsumerService } from '../src/analysis-queue/analysis-job-consumer.service';
import {
  AnalysisJobQueue,
  PgBossAnalysisJobQueue,
  QueueJobState,
} from '../src/analysis-queue/analysis-job-queue';
import { AnalysisJobReconcilerService } from '../src/analysis-queue/analysis-job-reconciler.service';
import { AnalysisJobRunnerService } from '../src/analysis-queue/analysis-job-runner.service';
import { AnalysisOutboxDispatcherService } from '../src/analysis-queue/analysis-outbox-dispatcher.service';
import {
  AnalysisQueueConfig,
  resolveAnalysisQueueConfig,
} from '../src/analysis-queue/analysis-queue.config';
import { AnalysisQueueInvariantsService } from '../src/analysis-queue/analysis-queue-invariants.service';
import { AppDataSource } from '../src/data-source';
import { FieldsService } from '../src/fields/fields.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
import { AddDurableAnalysisQueue1789200000000 } from '../src/migrations/1789200000000-AddDurableAnalysisQueue';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { WorkerCallFailure } from '../src/python-worker/worker-call-failure';
import {
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(120_000);

const MIGRATIONS_DIR = path.join(__dirname, '../src/migrations');

function loadMigrations(): Array<new () => unknown> {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(MIGRATIONS_DIR, file)) as Record<
        string,
        unknown
      >;
      return Object.values(mod).find(
        (value) => typeof value === 'function',
      ) as new () => unknown;
    });
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  description: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value as T;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timeout esperando: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const square = (offset: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [-63 + offset, -31],
      [-63 + offset, -31.01],
      [-62.99 + offset, -31.01],
      [-62.99 + offset, -31],
      [-63 + offset, -31],
    ],
  ],
});

const workerResult = (score = 77) => ({
  globalScore: score,
  category: 'Alta',
  confidenceScore: 80,
  productivityScore: 70,
  stabilityScore: 60,
  soilScore: 50,
  climateScore: 40,
  ndviAverageMax: 0.8,
  ndviVariability: 'Media' as const,
  zonesDetected: 3,
  resultJson: { mode: 'python-worker-v2', classificationScope: 'field' },
});

const workerError = (status: number | null, code: string | null = null) =>
  status !== null && status < 500
    ? new BadRequestException('público', {
        cause: new WorkerCallFailure('analyze', status, code),
      })
    : new ServiceUnavailableException('público', {
        cause: new WorkerCallFailure('analyze', status, code),
      });

describe('ADR-001 — cola durable de análisis (PostgreSQL + pg-boss reales)', () => {
  let target: TestDatabaseTarget;
  let databaseName: string | null = null;
  const dataSources: DataSource[] = [];
  const queues: AnalysisJobQueue[] = [];
  let fieldCounter = 0;

  const newDataSource = async (): Promise<DataSource> => {
    const ds = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: databaseName as string,
      entities: AppDataSource.options.entities,
      migrations: loadMigrations(),
      migrationsTransactionMode: 'all',
    });
    await ds.initialize();
    dataSources.push(ds);
    return ds;
  };

  const queueConfig = (
    overrides: Record<string, string> = {},
  ): AnalysisQueueConfig =>
    resolveAnalysisQueueConfig(
      (key) =>
        ({
          ANALYSIS_QUEUE_ENABLED: 'true',
          ANALYSIS_QUEUE_WEEKLY_ENABLED: 'true',
          ANALYSIS_JOB_RUNNER_ENABLED: 'true',
          ANALYSIS_JOB_RETRY_DELAY_SECONDS: '1',
          ANALYSIS_JOB_RETRY_DELAY_MAX_SECONDS: '1',
          ANALYSIS_JOB_HEARTBEAT_SECONDS: '10',
          ANALYSIS_JOB_POLLING_INTERVAL_SECONDS: '1',
          ANALYSIS_OUTBOX_DISPATCH_INTERVAL_MS: '200',
          ANALYSIS_JOB_RECONCILE_INTERVAL_MS: '1000',
          ANALYSIS_JOB_SHUTDOWN_TIMEOUT_MS: '1000',
          ...overrides,
        })[key],
    );

  const newQueue = (config: AnalysisQueueConfig): PgBossAnalysisJobQueue => {
    const queue = new PgBossAnalysisJobQueue(config, {
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      database: databaseName as string,
    });
    queues.push(queue);
    return queue;
  };

  type Stack = {
    ds: DataSource;
    repo: Repository<Analysis>;
    worker: { runFieldAnalysis: jest.Mock };
    verdict: {
      generateAndPersist: jest.Mock;
      findResponseByAnalysisId: jest.Mock;
    };
    fieldsService: FieldsService;
    analysisService: AnalysisService;
    store: AnalysisExecutionStore;
    config: AnalysisQueueConfig;
  };

  const buildStack = async (
    config: AnalysisQueueConfig = queueConfig(),
    ds?: DataSource,
  ): Promise<Stack> => {
    const dataSource = ds ?? (await newDataSource());
    const repo = dataSource.getRepository(Analysis);
    const worker = {
      runFieldAnalysis: jest.fn().mockResolvedValue(workerResult()),
    };
    const verdict = {
      generateAndPersist: jest.fn().mockResolvedValue(undefined),
      findResponseByAnalysisId: jest.fn().mockResolvedValue(null),
    };
    const fieldsService = new FieldsService(
      dataSource.getRepository(Field),
      dataSource.getRepository(FieldLot),
    );
    const analysisService = new AnalysisService(
      repo,
      worker as unknown as PythonWorkerService,
      fieldsService,
      { build: jest.fn() } as unknown as ReportPdfService,
      verdict as unknown as AnalysisVerdictService,
      config,
    );

    return {
      ds: dataSource,
      repo,
      worker,
      verdict,
      fieldsService,
      analysisService,
      store: new AnalysisExecutionStore(dataSource),
      config,
    };
  };

  const consumerFor = (stack: Stack) =>
    new AnalysisJobConsumerService(
      stack.store,
      stack.worker as unknown as PythonWorkerService,
      stack.analysisService,
      stack.config,
    );

  const seedField = async (
    ds: DataSource,
    lots: Array<{ name: string; offset: number; include?: boolean }> = [
      { name: 'Lote 1', offset: 0 },
      { name: 'Lote 2', offset: 0.1 },
    ],
  ): Promise<{ fieldId: string; userId: string }> => {
    fieldCounter += 1;
    const [user] = await ds.query(
      `INSERT INTO "users" ("email", "passwordHash", "fullName") VALUES ($1, 'x', 'Test') RETURNING "id"`,
      [`adr001-${fieldCounter}-${Date.now()}@example.com`],
    );
    const [field] = await ds.query(
      `INSERT INTO "fields" ("userId", "name", "startDate", "endDate", "totalAreaHa")
       VALUES ($1, $2, '2025-01-01', '2026-01-01', 20) RETURNING "id"`,
      [user.id, `Campo ${fieldCounter}`],
    );
    for (const [index, lot] of lots.entries()) {
      await ds.query(
        `INSERT INTO "field_lots" ("fieldId", "name", "geojson", "areaHa", "displayOrder", "includeInProductivityClassification")
         VALUES ($1, $2, $3::jsonb, 10, $4, $5)`,
        [
          field.id,
          lot.name,
          JSON.stringify(square(lot.offset)),
          index,
          lot.include ?? true,
        ],
      );
    }
    return { fieldId: field.id, userId: user.id };
  };

  const request = {
    startDate: '2026-01-01',
    endDate: '2026-06-01',
    maxCloudiness: 30,
  };

  // La base es compartida por toda la suite: un runner real también consume los Queued que dejaron
  // pruebas anteriores. Las aserciones de "cuántas veces se llamó al Worker" se miden por campo.
  const workerCallsFor = (stack: Stack, fieldId: string) =>
    stack.worker.runFieldAnalysis.mock.calls.filter(
      ([input]) => input.fieldId === fieldId,
    );

  const countRows = async (
    ds: DataSource,
    sql: string,
    params: unknown[],
  ): Promise<number> => Number((await ds.query(sql, params))[0].count);

  let main: Stack;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();
    databaseName = (await createIsolatedTestDatabase(target, 'adr001_queue'))
      .name;
    const ds = await newDataSource();
    await ds.runMigrations({ transaction: 'all' });
    main = await buildStack(queueConfig(), ds);
  });

  afterAll(async () => {
    for (const queue of queues) {
      await queue.stop(1000).catch(() => undefined);
    }
    for (const ds of dataSources) {
      if (ds.isInitialized) {
        await ds.destroy().catch(() => undefined);
      }
    }
    await dropIsolatedTestDatabase(target, databaseName);
  });

  // ---------------------------------------------------------------------------------------------
  describe('migración 1789200000000', () => {
    it('sube desde el esquema actual: índice activo cubre Queued+Procesando y existen outbox/intentos', async () => {
      const [index] = await main.ds.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
      );
      expect(index.indexdef).toContain("'Queued'");
      expect(index.indexdef).toContain("'Procesando'");

      const tables = await main.ds.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_name IN ('analysis_job_outbox', 'analysis_attempt') ORDER BY table_name`,
      );
      expect(
        tables.map((row: { table_name: string }) => row.table_name),
      ).toEqual(['analysis_attempt', 'analysis_job_outbox']);
    });

    it('precheck: con dos activos para el mismo campo aborta sin tocar datos', async () => {
      const qr = main.ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        await qr.query(`ALTER TABLE "analysis" DROP COLUMN "inputSnapshot"`);
        await qr.query(`DROP INDEX "UQ_analysis_running_per_field"`);
        for (let i = 0; i < 2; i += 1) {
          await qr.query(
            `INSERT INTO "analysis" ("scope", "fieldId", "lotName", "status", "startDate", "endDate")
             VALUES ('field', 'dup-field', 'x', 'Procesando', '2026-01-01', '2026-02-01')`,
          );
        }
        await expect(
          new AddDurableAnalysisQueue1789200000000().up(qr),
        ).rejects.toThrow(/más de un Analysis activo/);
      } finally {
        await qr.rollbackTransaction();
        await qr.release();
      }
    });

    it('la API anterior tolera el esquema expandido: su ON CONFLICT (status=Procesando) infiere el índice nuevo y choca contra un Queued', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const queued = await main.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );

      const rows = await main.ds.query(
        `INSERT INTO "analysis" ("scope", "fieldId", "lotName", "status", "startDate", "endDate")
         VALUES ('field', $1, 'legacy', 'Procesando', '2026-01-01', '2026-02-01')
         ON CONFLICT (COALESCE("fieldId", "lotId"))
         WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
         DO UPDATE SET "id" = "analysis"."id"
         RETURNING (xmax = 0) AS inserted, "id"`,
        [fieldId],
      );

      expect(rows[0]).toEqual({ inserted: false, id: queued.id });
    });

    it('down() se niega con trabajo durable pendiente; sin pendientes revierte y vuelve a subir', async () => {
      await expect(
        main.ds.undoLastMigration({ transaction: 'all' }),
      ).rejects.toThrow(/ejecución durable pendiente/);

      // Aislar el revert en una base aparte para no perder los datos de las demás pruebas.
      const scratch = (
        await createIsolatedTestDatabase(target, 'adr001_revert')
      ).name;
      const ds = new DataSource({
        type: 'postgres',
        host: target.host,
        port: target.port,
        username: target.username,
        password: target.password,
        database: scratch,
        entities: AppDataSource.options.entities,
        migrations: loadMigrations(),
      });
      try {
        await ds.initialize();
        await ds.runMigrations({ transaction: 'all' });
        await ds.undoLastMigration({ transaction: 'all' });
        const [index] = await ds.query(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
        );
        expect(index.indexdef).not.toContain('Queued');
        expect(
          await countRows(
            ds,
            `SELECT COUNT(*) FROM information_schema.tables WHERE table_name = $1`,
            ['analysis_job_outbox'],
          ),
        ).toBe(0);
        await ds.runMigrations({ transaction: 'all' });
        expect(
          await countRows(
            ds,
            `SELECT COUNT(*) FROM information_schema.tables WHERE table_name = $1`,
            ['analysis_job_outbox'],
          ),
        ).toBe(1);
      } finally {
        if (ds.isInitialized) await ds.destroy();
        await dropIsolatedTestDatabase(target, scratch);
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('encolado transaccional (API HTTP)', () => {
    it('crea Analysis=Queued + inputSnapshot + outbox en una transacción y NO llama al Worker', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const calls = main.worker.runFieldAnalysis.mock.calls.length;

      const analysis = await main.analysisService.runFieldAnalysis(
        fieldId,
        {
          ...request,
          indices: ['NDRE'],
          includeMapAssets: true,
          maxZoneCampaigns: 2,
        },
        userId,
      );

      expect(analysis.status).toBe('Queued');
      expect(
        (analysis as { inputSnapshot?: unknown }).inputSnapshot,
      ).toBeUndefined();
      expect(main.worker.runFieldAnalysis.mock.calls.length).toBe(calls);

      const [row] = await main.ds.query(
        `SELECT "status", "startedAt", "inputSnapshot" FROM "analysis" WHERE "id" = $1`,
        [analysis.id],
      );
      expect(row.status).toBe('Queued');
      expect(row.startedAt).toBeNull();
      expect(row.inputSnapshot.snapshotVersion).toBe(1);
      expect(row.inputSnapshot.lots).toHaveLength(2);
      expect(row.inputSnapshot.lots[0].geojson.type).toBe('Polygon');
      expect(row.inputSnapshot.request).toEqual(
        expect.objectContaining({
          indices: ['NDRE'],
          includeMapAssets: true,
          maxZoneCampaigns: 2,
        }),
      );

      const outbox = await main.ds.query(
        `SELECT * FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
        [analysis.id],
      );
      expect(outbox).toHaveLength(1);
      expect(outbox[0].dispatchedAt).toBeNull();
      expect(outbox[0].payload).toEqual({
        analysisId: analysis.id,
        fieldId,
        requestedByUserId: userId,
        trigger: 'manual',
        contractVersion: 1,
        idempotencyKey: `analysis:${analysis.id}`,
      });
      expect(JSON.stringify(outbox[0].payload)).not.toContain('coordinates');
    });

    it('rollback: si falla el INSERT del outbox no queda ni el Analysis ni la asociación de clientRequestId', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      await main.ds.query(
        `ALTER TABLE "analysis_job_outbox" ADD CONSTRAINT "tmp_fail_outbox" CHECK (false) NOT VALID`,
      );
      try {
        await expect(
          main.analysisService.runFieldAnalysis(
            fieldId,
            { ...request, clientRequestId: 'k-outbox-fail' },
            userId,
          ),
        ).rejects.toThrow();
        await expect(
          main.analysisService.runFieldAnalysis(fieldId, request, userId),
        ).rejects.toThrow();
      } finally {
        await main.ds.query(
          `ALTER TABLE "analysis_job_outbox" DROP CONSTRAINT "tmp_fail_outbox"`,
        );
      }

      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis" WHERE "fieldId" = $1`,
          [fieldId],
        ),
      ).toBe(0);
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis_client_request" WHERE "fieldId" = $1`,
          [fieldId],
        ),
      ).toBe(0);
      expect(main.worker.runFieldAnalysis).not.toHaveBeenCalledWith(
        expect.objectContaining({ fieldId }),
      );
    });

    it('rollback: si falla la persistencia del snapshot no queda nada; si falla su preparación tampoco', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      await main.ds.query(
        `ALTER TABLE "analysis" ADD CONSTRAINT "tmp_fail_snapshot" CHECK ("inputSnapshot" IS NULL) NOT VALID`,
      );
      try {
        await expect(
          main.analysisService.runFieldAnalysis(
            fieldId,
            { ...request, clientRequestId: 'k-snap' },
            userId,
          ),
        ).rejects.toThrow();
      } finally {
        await main.ds.query(
          `ALTER TABLE "analysis" DROP CONSTRAINT "tmp_fail_snapshot"`,
        );
      }

      const noIncluded = await seedField(main.ds, [
        { name: 'Excluido', offset: 0, include: false },
      ]);
      await expect(
        main.analysisService.runFieldAnalysis(
          noIncluded.fieldId,
          { ...request, clientRequestId: 'k-prep' },
          noIncluded.userId,
        ),
      ).rejects.toThrow(/ningún lote incluido/);

      for (const id of [fieldId, noIncluded.fieldId]) {
        expect(
          await countRows(
            main.ds,
            `SELECT COUNT(*) FROM "analysis" WHERE "fieldId" = $1`,
            [id],
          ),
        ).toBe(0);
        expect(
          await countRows(
            main.ds,
            `SELECT COUNT(*) FROM "analysis_client_request" WHERE "fieldId" = $1`,
            [id],
          ),
        ).toBe(0);
        expect(
          await countRows(
            main.ds,
            `SELECT COUNT(*) FROM "analysis_job_outbox" o JOIN "analysis" a ON a."id" = o."analysisId" WHERE a."fieldId" = $1`,
            [id],
          ),
        ).toBe(0);
      }
    });

    it('mismo clientRequestId concurrente (dos procesos) → un solo Analysis y un solo outbox', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const other = await buildStack(queueConfig());

      const results = await Promise.all(
        [main, other, main, other].map((stack) =>
          stack.analysisService.runFieldAnalysis(
            fieldId,
            { ...request, clientRequestId: 'k-same' },
            userId,
          ),
        ),
      );

      expect(new Set(results.map((analysis) => analysis.id)).size).toBe(1);
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [results[0].id],
        ),
      ).toBe(1);

      // Repetir la clave más tarde devuelve el mismo Analysis sin crear otro job.
      const again = await main.analysisService.runFieldAnalysis(
        fieldId,
        { ...request, clientRequestId: 'k-same' },
        userId,
      );
      expect(again.id).toBe(results[0].id);
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis" WHERE "fieldId" = $1`,
          [fieldId],
        ),
      ).toBe(1);
    });

    it('requests concurrentes sin clave (y con claves distintas) → un solo Analysis activo por campo, un solo outbox', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const other = await buildStack(queueConfig());

      const results = await Promise.all([
        main.analysisService.runFieldAnalysis(fieldId, request, userId),
        other.analysisService.runFieldAnalysis(fieldId, request, userId),
        main.analysisService.runFieldAnalysis(
          fieldId,
          { ...request, clientRequestId: 'k-a' },
          userId,
        ),
        other.analysisService.runFieldAnalysis(
          fieldId,
          { ...request, clientRequestId: 'k-b' },
          userId,
        ),
      ]);

      expect(new Set(results.map((analysis) => analysis.id)).size).toBe(1);
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis" WHERE "fieldId" = $1 AND "status" IN ('Queued','Procesando')`,
          [fieldId],
        ),
      ).toBe(1);
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [results[0].id],
        ),
      ).toBe(1);
    });

    it('semanal: trigger=weekly + scheduledRunId en el outbox; con la cola semanal deshabilitada sigue el camino legacy', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const analysis = await main.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
        {
          trigger: 'weekly',
          scheduledRunId: '11111111-1111-4111-8111-111111111111',
        },
      );
      const [outbox] = await main.ds.query(
        `SELECT "payload" FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
        [analysis.id],
      );
      expect(outbox.payload).toEqual(
        expect.objectContaining({
          trigger: 'weekly',
          scheduledRunId: '11111111-1111-4111-8111-111111111111',
        }),
      );

      const legacyWeekly = await buildStack(
        queueConfig({ ANALYSIS_QUEUE_WEEKLY_ENABLED: 'false' }),
      );
      const second = await seedField(main.ds);
      const legacy = await legacyWeekly.analysisService.runFieldAnalysis(
        second.fieldId,
        request,
        second.userId,
        { trigger: 'weekly' },
      );
      expect(legacy.status).toBe('Procesando');
      await waitFor(
        async () => legacyWeekly.worker.runFieldAnalysis.mock.calls.length > 0,
        'worker legacy llamado',
      );
      expect(
        await countRows(
          main.ds,
          `SELECT COUNT(*) FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [legacy.id],
        ),
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('dispatcher del outbox (pg-boss real)', () => {
    let runnerStack: Stack;
    let queue: PgBossAnalysisJobQueue;
    let dispatcher: AnalysisOutboxDispatcherService;

    beforeAll(async () => {
      runnerStack = await buildStack(queueConfig());
      queue = newQueue(runnerStack.config);
      await queue.start();
      dispatcher = new AnalysisOutboxDispatcherService(
        runnerStack.ds,
        queue,
        runnerStack.config,
        runnerStack.store,
      );
    });

    const pendingOutbox = async (analysisId: string) =>
      (
        await runnerStack.ds.query(
          `SELECT * FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [analysisId],
        )
      )[0];

    it('restart de la API después del commit y antes de publicar: el trabajo no se pierde y el dispatcher lo publica', async () => {
      const api = await buildStack(queueConfig());
      const { fieldId, userId } = await seedField(api.ds);
      const analysis = await api.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      await api.ds.destroy(); // "la API se reinicia" — ningún estado en memoria sobrevive

      const result = await dispatcher.dispatchPending();
      expect(result.published).toBeGreaterThanOrEqual(1);

      const outbox = await pendingOutbox(analysis.id);
      expect(outbox.dispatchedAt).not.toBeNull();
      expect(outbox.jobId).toBe(outbox.id);
      expect(await queue.getJobState(outbox.id)).toBe('created');

      // Un segundo tick no republica nada.
      const again = await dispatcher.dispatchPending();
      expect(again.claimed).toBe(0);
    });

    it('crash "publicado pero no marcado": la republicación es idempotente (un solo job)', async () => {
      const { fieldId, userId } = await seedField(runnerStack.ds);
      const analysis = await runnerStack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      const outbox = await pendingOutbox(analysis.id);

      await queue.publish(outbox.id, outbox.payload); // el dispatcher anterior publicó y murió

      const result = await dispatcher.dispatchPending();
      expect(result.alreadyPublished).toBe(1);
      expect((await pendingOutbox(analysis.id)).dispatchedAt).not.toBeNull();
      expect(
        await countRows(
          runnerStack.ds,
          `SELECT COUNT(*) FROM pgboss.job WHERE name = 'analysis.execute.v1' AND data->>'analysisId' = $1`,
          [analysis.id],
        ),
      ).toBe(1);
    });

    it('dos dispatchers simultáneos nunca publican la misma fila dos veces (FOR UPDATE SKIP LOCKED)', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { fieldId, userId } = await seedField(runnerStack.ds);
        ids.push(
          (
            await runnerStack.analysisService.runFieldAnalysis(
              fieldId,
              request,
              userId,
            )
          ).id,
        );
      }

      const publishSpy = jest.fn();
      const slowQueue: AnalysisJobQueue = {
        ...queue,
        start: () => queue.start(),
        work: (handler) => queue.work(handler),
        stop: (timeout) => queue.stop(timeout),
        getJobState: (id) => queue.getJobState(id),
        publish: async (jobId, payload) => {
          publishSpy(jobId);
          await new Promise((resolve) => setTimeout(resolve, 300));
          return queue.publish(jobId, payload);
        },
      };
      const secondDs = await newDataSource();
      const d1 = new AnalysisOutboxDispatcherService(
        runnerStack.ds,
        slowQueue,
        runnerStack.config,
        runnerStack.store,
      );
      const d2 = new AnalysisOutboxDispatcherService(
        secondDs,
        slowQueue,
        runnerStack.config,
        new AnalysisExecutionStore(secondDs),
      );

      const [r1, r2] = await Promise.all([
        d1.dispatchPending(),
        d2.dispatchPending(),
      ]);

      expect(r1.claimed + r2.claimed).toBe(4);
      expect(new Set(publishSpy.mock.calls.map(([jobId]) => jobId)).size).toBe(
        publishSpy.mock.calls.length,
      );
      for (const id of ids) {
        expect(
          await countRows(
            runnerStack.ds,
            `SELECT COUNT(*) FROM pgboss.job WHERE name = 'analysis.execute.v1' AND data->>'analysisId' = $1`,
            [id],
          ),
        ).toBe(1);
      }
    });

    it('fila de outbox con versión de payload desconocida: se abandona, nunca se publica, y el Analysis pasa a Error', async () => {
      const { fieldId, userId } = await seedField(runnerStack.ds);
      const analysis = await runnerStack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      await runnerStack.ds.query(
        `UPDATE "analysis_job_outbox" SET "payloadVersion" = 99 WHERE "analysisId" = $1`,
        [analysis.id],
      );

      const result = await dispatcher.dispatchPending();

      expect(result.abandoned).toBe(1);
      const outbox = await pendingOutbox(analysis.id);
      expect(outbox.abandonedAt).not.toBeNull();
      expect(outbox.dispatchedAt).toBeNull();
      expect(await queue.getJobState(outbox.id)).toBeNull();
      const [row] = await runnerStack.ds.query(
        `SELECT "status", "errorMessage" FROM "analysis" WHERE "id" = $1`,
        [analysis.id],
      );
      expect(row.status).toBe('Error');
      expect(row.errorMessage).toContain('versión de contrato');
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('consumidor end-to-end (pg-boss real)', () => {
    const startRunner = async (stack: Stack) => {
      const queue = newQueue(stack.config);
      const runner = new AnalysisJobRunnerService(
        queue,
        stack.config,
        new AnalysisOutboxDispatcherService(
          stack.ds,
          queue,
          stack.config,
          stack.store,
        ),
        consumerFor(stack),
        new AnalysisJobReconcilerService(stack.ds, queue, stack.store),
      );
      await runner.start();
      return { runner, queue };
    };

    const statusOf = async (ds: DataSource, id: string) =>
      (await ds.query(`SELECT * FROM "analysis" WHERE "id" = $1`, [id]))[0];
    const attemptsOf = async (ds: DataSource, id: string) =>
      ds.query(
        `SELECT "attemptNumber", "outcome", "errorCode", "retryable" FROM "analysis_attempt"
         WHERE "analysisId" = $1 ORDER BY "attemptNumber"`,
        [id],
      );
    const jobIdOf = async (ds: DataSource, id: string): Promise<string> =>
      (
        await ds.query(
          `SELECT "id" FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [id],
        )
      )[0].id;

    it('éxito: Queued → Procesando (antes del Worker) → Finalizado, con el input ORIGINAL aunque se editen/borren/agreguen lotes', async () => {
      const stack = await buildStack(queueConfig());
      const { fieldId, userId } = await seedField(stack.ds, [
        { name: 'Lote A', offset: 0 },
        { name: 'Lote B', offset: 0.2 },
      ]);
      const analysis = await stack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      const [{ inputSnapshot: original }] = await stack.ds.query(
        `SELECT "inputSnapshot" FROM "analysis" WHERE "id" = $1`,
        [analysis.id],
      );

      // Ediciones posteriores del campo (no se bloquean): redibujar A, excluir A, borrar B, agregar C.
      await stack.ds.query(
        `UPDATE "field_lots" SET "geojson" = $2::jsonb, "includeInProductivityClassification" = false
         WHERE "fieldId" = $1 AND "name" = 'Lote A'`,
        [fieldId, JSON.stringify(square(5))],
      );
      await stack.ds.query(
        `DELETE FROM "field_lots" WHERE "fieldId" = $1 AND "name" = 'Lote B'`,
        [fieldId],
      );
      await stack.ds.query(
        `INSERT INTO "field_lots" ("fieldId", "name", "geojson", "areaHa") VALUES ($1, 'Lote C', $2::jsonb, 3)`,
        [fieldId, JSON.stringify(square(9))],
      );

      let stateAtWorkerCall: { status: string; running: number } | null = null;
      stack.worker.runFieldAnalysis.mockImplementation(
        async (input: { fieldId: string }) => {
          if (input.fieldId !== fieldId) {
            return workerResult();
          }
          const row = await statusOf(stack.ds, analysis.id);
          const running = await countRows(
            stack.ds,
            `SELECT COUNT(*) FROM "analysis_attempt" WHERE "analysisId" = $1 AND "outcome" = 'running'`,
            [analysis.id],
          );
          stateAtWorkerCall = { status: row.status, running };
          return workerResult(91);
        },
      );

      const { runner } = await startRunner(stack);
      try {
        await waitFor(
          async () =>
            (await statusOf(stack.ds, analysis.id)).status === 'Finalizado',
          'Analysis Finalizado',
        );
      } finally {
        await runner.stop();
      }

      expect(stateAtWorkerCall).toEqual({ status: 'Procesando', running: 1 });
      expect(workerCallsFor(stack, fieldId)).toHaveLength(1);
      const workerInput = workerCallsFor(stack, fieldId)[0][0];
      expect(workerInput.lots).toEqual(original.lots);
      expect(workerInput.lots.map((lot: { name: string }) => lot.name)).toEqual(
        ['Lote A', 'Lote B'],
      );
      expect(workerInput.lots[0].geojson).toEqual(square(0));
      expect(workerInput.lots[0].includeInProductivityClassification).toBe(
        true,
      );

      const finalRow = await statusOf(stack.ds, analysis.id);
      expect(finalRow.globalScore).toBe(91);
      expect(finalRow.completedAt).not.toBeNull();
      expect(
        finalRow.resultJson.fieldLots.map((lot: { name: string }) => lot.name),
      ).toEqual(['Lote A', 'Lote B']);
      expect(finalRow.resultJson.fieldLots[0]).not.toHaveProperty('geojson');
      expect(await attemptsOf(stack.ds, analysis.id)).toEqual([
        {
          attemptNumber: 1,
          outcome: 'succeeded',
          errorCode: null,
          retryable: null,
        },
      ]);
      expect(
        stack.verdict.generateAndPersist.mock.calls.filter(
          ([row]) => row.id === analysis.id,
        ),
      ).toHaveLength(1);
      expect(stack.verdict.generateAndPersist).toHaveBeenCalledWith(
        expect.objectContaining({ id: analysis.id, status: 'Finalizado' }),
      );
      const queue = newQueue(stack.config);
      await queue.start();
      expect(
        await queue.getJobState(await jobIdOf(stack.ds, analysis.id)),
      ).toBe('completed');

      // Retry tardío / entrega duplicada sobre el Analysis Finalizado: sin Worker, sin sobrescritura.
      const late = await consumerFor(stack).handle({
        id: await jobIdOf(stack.ds, analysis.id),
        data: buildAnalysisExecutePayload({
          analysisId: analysis.id,
          fieldId,
          requestedByUserId: userId,
          trigger: 'manual',
        }),
        retryCount: 1,
        retryLimit: 2,
      });
      expect(late).toBe('completed');
      expect(workerCallsFor(stack, fieldId)).toHaveLength(1);
      expect((await statusOf(stack.ds, analysis.id)).globalScore).toBe(91);
    });

    it('job más largo que 2× heartbeatSeconds: pg-boss mantiene el claim (sin reintento ni segunda llamada al Worker)', async () => {
      const stack = await buildStack(queueConfig());
      const { fieldId, userId } = await seedField(stack.ds);
      stack.worker.runFieldAnalysis.mockImplementation(
        async (input: { fieldId: string }) => {
          if (input.fieldId === fieldId) {
            await new Promise((resolve) => setTimeout(resolve, 25_000)); // heartbeat = 10s
          }
          return workerResult(66);
        },
      );
      const analysis = await stack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );

      const { runner } = await startRunner(stack);
      try {
        await waitFor(
          async () =>
            (await statusOf(stack.ds, analysis.id)).status === 'Finalizado',
          'Finalizado tras un job largo',
          60_000,
        );
      } finally {
        await runner.stop();
      }

      expect(workerCallsFor(stack, fieldId)).toHaveLength(1);
      expect(await attemptsOf(stack.ds, analysis.id)).toEqual([
        {
          attemptNumber: 1,
          outcome: 'succeeded',
          errorCode: null,
          retryable: null,
        },
      ]);
    });

    it('fallas transitorias: respeta el máximo de intentos y termina en Error + job en el dead-letter queue', async () => {
      const stack = await buildStack(queueConfig());
      const { fieldId, userId } = await seedField(stack.ds);
      stack.worker.runFieldAnalysis.mockImplementation(
        async (input: { fieldId: string }) => {
          if (input.fieldId === fieldId) throw workerError(503);
          return workerResult();
        },
      );
      const analysis = await stack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );

      const { runner, queue } = await startRunner(stack);
      try {
        await waitFor(
          async () =>
            (await statusOf(stack.ds, analysis.id)).status === 'Error',
          'Analysis Error',
        );
        await waitFor(
          async () =>
            (await queue.getJobState(await jobIdOf(stack.ds, analysis.id))) ===
            'failed',
          'job failed',
        );
      } finally {
        await runner.stop();
      }

      expect(workerCallsFor(stack, fieldId)).toHaveLength(3);
      expect(await attemptsOf(stack.ds, analysis.id)).toEqual([
        {
          attemptNumber: 1,
          outcome: 'failed_retryable',
          errorCode: 'worker_server_error',
          retryable: true,
        },
        {
          attemptNumber: 2,
          outcome: 'failed_retryable',
          errorCode: 'worker_server_error',
          retryable: true,
        },
        {
          attemptNumber: 3,
          outcome: 'failed_terminal',
          errorCode: 'worker_server_error',
          retryable: true,
        },
      ]);
      const row = await statusOf(stack.ds, analysis.id);
      expect(row.errorMessage).toBe(
        'El análisis no pudo completarse después de varios intentos.',
      );
      expect(row.resultJson).toEqual(
        expect.objectContaining({ mode: 'error', fieldId }),
      );
      expect(
        await countRows(
          stack.ds,
          `SELECT COUNT(*) FROM pgboss.job WHERE name = 'analysis.execute.v1.dlq' AND data->>'analysisId' = $1`,
          [analysis.id],
        ),
      ).toBe(1);
    });

    it('error no reintentable (400): una sola llamada al Worker, Error inmediato y DLQ', async () => {
      const stack = await buildStack(queueConfig());
      const { fieldId, userId } = await seedField(stack.ds);
      stack.worker.runFieldAnalysis.mockImplementation(
        async (input: { fieldId: string }) => {
          if (input.fieldId === fieldId) throw workerError(400);
          return workerResult();
        },
      );
      const analysis = await stack.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );

      const { runner, queue } = await startRunner(stack);
      try {
        await waitFor(
          async () =>
            (await countRows(
              stack.ds,
              `SELECT COUNT(*) FROM pgboss.job WHERE name = 'analysis.execute.v1.dlq' AND data->>'analysisId' = $1`,
              [analysis.id],
            )) === 1,
          'job en DLQ',
        );
        expect(
          await queue.getJobState(await jobIdOf(stack.ds, analysis.id)),
        ).toBe('failed');
        await new Promise((resolve) => setTimeout(resolve, 2500)); // tiempo de sobra para un retry indebido
      } finally {
        await runner.stop();
      }

      expect(workerCallsFor(stack, fieldId)).toHaveLength(1);
      expect((await statusOf(stack.ds, analysis.id)).status).toBe('Error');
      expect(await attemptsOf(stack.ds, analysis.id)).toEqual([
        {
          attemptNumber: 1,
          outcome: 'failed_terminal',
          errorCode: 'worker_bad_request',
          retryable: false,
        },
      ]);
    });

    it('SIGTERM durante un job: el runner libera el lease, otro runner completa; el resultado tardío del primero no sobrescribe', async () => {
      const stackA = await buildStack(
        queueConfig({ ANALYSIS_JOB_SHUTDOWN_TIMEOUT_MS: '1000' }),
      );
      let releaseFirst: (value: unknown) => void = () => undefined;
      const { fieldId, userId } = await seedField(stackA.ds);
      stackA.worker.runFieldAnalysis.mockImplementation(
        (input: { fieldId: string }) =>
          input.fieldId === fieldId
            ? new Promise((resolve) => (releaseFirst = resolve))
            : Promise.resolve(workerResult()),
      );
      const analysis = await stackA.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );

      const a = await startRunner(stackA);
      await waitFor(
        async () => workerCallsFor(stackA, fieldId).length === 1,
        'primer intento en curso',
      );
      await a.runner.stop(); // camino de SIGTERM

      const jobId = await jobIdOf(stackA.ds, analysis.id);
      expect(
        await (async () => {
          const probe = newQueue(stackA.config);
          await probe.start();
          return probe.getJobState(jobId);
        })(),
      ).toBe('retry');

      const stackB = await buildStack(queueConfig());
      stackB.worker.runFieldAnalysis.mockResolvedValue(workerResult(55));
      const b = await startRunner(stackB);
      try {
        await waitFor(
          async () =>
            (await statusOf(stackB.ds, analysis.id)).status === 'Finalizado',
          'Finalizado por B',
        );
      } finally {
        await b.runner.stop();
      }

      releaseFirst(workerResult(11)); // el Worker del runner detenido responde tarde
      await waitFor(
        async () =>
          (await countRows(
            stackA.ds,
            `SELECT COUNT(*) FROM "analysis_attempt" WHERE "analysisId" = $1 AND "outcome" = 'running'`,
            [analysis.id],
          )) === 0,
        'sin intentos running',
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect((await statusOf(stackB.ds, analysis.id)).globalScore).toBe(55);
      expect(await attemptsOf(stackB.ds, analysis.id)).toEqual([
        {
          attemptNumber: 1,
          outcome: 'lease_lost',
          errorCode: 'lease_lost',
          retryable: true,
        },
        {
          attemptNumber: 2,
          outcome: 'succeeded',
          errorCode: null,
          retryable: null,
        },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  describe('idempotencia del consumidor y recuperación (PostgreSQL real, cola simulada)', () => {
    const fakeJob = (
      analysisId: string,
      fieldId: string,
      userId: string,
      id: string,
      retryCount = 0,
    ) => ({
      id,
      data: buildAnalysisExecutePayload({
        analysisId,
        fieldId,
        requestedByUserId: userId,
        trigger: 'manual',
      }),
      retryCount,
      retryLimit: 2,
    });

    it('dos consumidores con jobs equivalentes (ids distintos) → una sola llamada efectiva al Worker', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const analysis = await main.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      const other = await buildStack(queueConfig());
      let release: (value: unknown) => void = () => undefined;
      const worker = jest.fn(
        () => new Promise((resolve) => (release = resolve)),
      );
      main.worker.runFieldAnalysis.mockImplementation(worker);
      other.worker.runFieldAnalysis.mockImplementation(worker);

      const first = consumerFor(main).handle(
        fakeJob(
          analysis.id,
          fieldId,
          userId,
          '00000000-0000-4000-8000-00000000000a',
        ),
      );
      await waitFor(
        async () => worker.mock.calls.length === 1,
        'primer consumidor llamando al Worker',
      );
      const second = await consumerFor(other).handle(
        fakeJob(
          analysis.id,
          fieldId,
          userId,
          '00000000-0000-4000-8000-00000000000b',
        ),
      );
      release(workerResult());

      expect(second).toBe('completed');
      expect(await first).toBe('completed');
      expect(worker).toHaveBeenCalledTimes(1);
      main.worker.runFieldAnalysis
        .mockReset()
        .mockResolvedValue(workerResult());
    });

    it('runner caído antes de llamar al Worker / mientras esperaba: el reintento marca lease_lost y ejecuta una vez', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const analysis = await main.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      const jobId = '00000000-0000-4000-8000-0000000000c1';

      const claim = await main.store.claimAttempt({
        analysisId: analysis.id,
        jobId,
        attemptNumber: 1,
        now: new Date(),
        heartbeatStaleMs: 20_000,
      });
      expect(claim.kind).toBe('claimed');
      // El proceso murió: su heartbeat deja de avanzar.
      await main.ds.query(
        `UPDATE "analysis_attempt" SET "heartbeatAt" = $2 WHERE "analysisId" = $1`,
        [analysis.id, new Date(Date.now() - 60_000)],
      );
      main.worker.runFieldAnalysis.mockClear();

      const disposition = await consumerFor(main).handle(
        fakeJob(analysis.id, fieldId, userId, jobId, 1),
      );

      expect(disposition).toBe('completed');
      expect(main.worker.runFieldAnalysis).toHaveBeenCalledTimes(1);
      const attempts = await main.ds.query(
        `SELECT "attemptNumber", "outcome" FROM "analysis_attempt" WHERE "analysisId" = $1 ORDER BY "attemptNumber"`,
        [analysis.id],
      );
      expect(attempts).toEqual([
        { attemptNumber: 1, outcome: 'lease_lost' },
        { attemptNumber: 2, outcome: 'succeeded' },
      ]);
    });

    it('campo borrado entre el enqueue y la ejecución → Error + intento terminal, sin Worker', async () => {
      const { fieldId, userId } = await seedField(main.ds);
      const analysis = await main.analysisService.runFieldAnalysis(
        fieldId,
        request,
        userId,
      );
      await main.ds.query(`DELETE FROM "fields" WHERE "id" = $1`, [fieldId]);
      main.worker.runFieldAnalysis.mockClear();

      const disposition = await consumerFor(main).handle(
        fakeJob(
          analysis.id,
          fieldId,
          userId,
          '00000000-0000-4000-8000-0000000000d1',
        ),
      );

      expect(disposition).toBe('deadletter');
      expect(main.worker.runFieldAnalysis).not.toHaveBeenCalled();
      const [row] = await main.ds.query(
        `SELECT "status" FROM "analysis" WHERE "id" = $1`,
        [analysis.id],
      );
      expect(row.status).toBe('Error');
    });

    it('reconciliador durable: job failed (runner muerto en el último intento) → Error; job vivo → no se toca', async () => {
      const failing = await seedField(main.ds);
      const alive = await seedField(main.ds);
      const failed = await main.analysisService.runFieldAnalysis(
        failing.fieldId,
        request,
        failing.userId,
      );
      const living = await main.analysisService.runFieldAnalysis(
        alive.fieldId,
        request,
        alive.userId,
      );
      for (const id of [failed.id, living.id]) {
        await main.ds.query(
          `UPDATE "analysis_job_outbox" SET "dispatchedAt" = now(), "jobId" = "id" WHERE "analysisId" = $1`,
          [id],
        );
      }
      await main.store.claimAttempt({
        analysisId: failed.id,
        jobId: '00000000-0000-4000-8000-0000000000e1',
        attemptNumber: 3,
        now: new Date(),
        heartbeatStaleMs: 20_000,
      });
      const failedJobId = (
        await main.ds.query(
          `SELECT "id" FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [failed.id],
        )
      )[0].id;
      const states: Record<string, QueueJobState> = { [failedJobId]: 'failed' };
      const stubQueue = {
        getJobState: async (id: string) => states[id] ?? 'active',
      } as AnalysisJobQueue;

      await new AnalysisJobReconcilerService(
        main.ds,
        stubQueue,
        main.store,
      ).reconcile();

      const rows = await main.ds.query(
        `SELECT "id", "status" FROM "analysis" WHERE "id" = ANY($1::uuid[])`,
        [[failed.id, living.id]],
      );
      const byId = Object.fromEntries(
        rows.map((row: { id: string; status: string }) => [row.id, row.status]),
      );
      expect(byId[failed.id]).toBe('Error');
      expect(byId[living.id]).toBe('Queued');
      const [attempt] = await main.ds.query(
        `SELECT "outcome" FROM "analysis_attempt" WHERE "analysisId" = $1`,
        [failed.id],
      );
      expect(attempt.outcome).toBe('lease_lost');
    });

    it('reconciliador legacy: marca stale un Procesando legacy viejo pero nunca uno durable', async () => {
      const durableField = await seedField(main.ds);
      const durable = await main.analysisService.runFieldAnalysis(
        durableField.fieldId,
        request,
        durableField.userId,
      );
      const legacyField = await seedField(main.ds);
      const [legacy] = await main.ds.query(
        `INSERT INTO "analysis" ("scope", "fieldId", "lotName", "status", "startDate", "endDate", "startedAt")
         VALUES ('field', $1, 'legacy', 'Procesando', '2026-01-01', '2026-02-01', $2) RETURNING "id"`,
        [legacyField.fieldId, new Date(Date.now() - 2 * 60 * 60 * 1000)],
      );
      await main.ds.query(
        `UPDATE "analysis" SET "status" = 'Procesando', "startedAt" = $2 WHERE "id" = $1`,
        [durable.id, new Date(Date.now() - 2 * 60 * 60 * 1000)],
      );

      await main.analysisService.reconcileStaleAnalyses();

      const rows = await main.ds.query(
        `SELECT "id", "status" FROM "analysis" WHERE "id" = ANY($1::uuid[])`,
        [[durable.id, legacy.id]],
      );
      const byId = Object.fromEntries(
        rows.map((row: { id: string; status: string }) => [row.id, row.status]),
      );
      expect(byId[legacy.id]).toBe('Error');
      expect(byId[durable.id]).toBe('Procesando');
    });

    it('chequeo de invariantes: detecta Queued sin outbox, Procesando sin intento, terminal con intento activo y outbox sin job', async () => {
      const invariants = new AnalysisQueueInvariantsService(main.ds);
      const seed = async () => {
        const { fieldId, userId } = await seedField(main.ds);
        return main.analysisService.runFieldAnalysis(fieldId, request, userId);
      };

      const queuedNoOutbox = await seed();
      await main.ds.query(
        `ALTER TABLE "analysis_job_outbox" DROP CONSTRAINT "CHK_analysis_job_outbox_dispatched_has_job"`,
      );
      try {
        await main.ds.query(
          `DELETE FROM "analysis_job_outbox" WHERE "analysisId" = $1`,
          [queuedNoOutbox.id],
        );
        const processingNoAttempt = await seed();
        await main.ds.query(
          `UPDATE "analysis" SET "status" = 'Procesando' WHERE "id" = $1`,
          [processingNoAttempt.id],
        );
        const finalizedWithRunning = await seed();
        await main.store.claimAttempt({
          analysisId: finalizedWithRunning.id,
          jobId: '00000000-0000-4000-8000-0000000000f1',
          attemptNumber: 1,
          now: new Date(),
          heartbeatStaleMs: 20_000,
        });
        await main.ds.query(
          `UPDATE "analysis" SET "status" = 'Finalizado' WHERE "id" = $1`,
          [finalizedWithRunning.id],
        );
        const dispatchedNoJob = await seed();
        await main.ds.query(
          `UPDATE "analysis_job_outbox" SET "dispatchedAt" = now() WHERE "analysisId" = $1`,
          [dispatchedNoJob.id],
        );

        const violations = await invariants.check();
        const has = (code: string, id: string) =>
          violations.some(
            (violation) =>
              violation.code === code && violation.analysisId === id,
          );

        expect(has('queued_without_outbox', queuedNoOutbox.id)).toBe(true);
        expect(
          has('processing_without_active_attempt', processingNoAttempt.id),
        ).toBe(true);
        expect(
          has('terminal_with_active_attempt', finalizedWithRunning.id),
        ).toBe(true);
        expect(has('dispatched_outbox_without_job', dispatchedNoJob.id)).toBe(
          true,
        );

        for (const id of [
          queuedNoOutbox.id,
          processingNoAttempt.id,
          finalizedWithRunning.id,
          dispatchedNoJob.id,
        ]) {
          await main.ds.query(`DELETE FROM "analysis" WHERE "id" = $1`, [id]);
        }
      } finally {
        await main.ds.query(
          `ALTER TABLE "analysis_job_outbox" ADD CONSTRAINT "CHK_analysis_job_outbox_dispatched_has_job"
           CHECK ("dispatchedAt" IS NULL OR "jobId" IS NOT NULL)`,
        );
      }
    });
  });
});
