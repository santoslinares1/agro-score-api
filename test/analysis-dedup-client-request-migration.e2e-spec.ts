// F04 (revisión independiente, ronda 4): migración 1788900000001-AddAnalysisClientRequestAssociationTable
// contra datos YA existentes con analysis.clientRequestId poblado (ronda 3) — verifica que el
// backfill conserva cada asociación, sin perder ninguna ni inventar otras, y que el mecanismo de
// resolución (AnalysisService.runFieldAnalysis) las encuentra de verdad después de migrar.
//
// Prepara filas ANTES de correr la migración REAL, en una base PostgreSQL aislada y desechable
// creada por esta misma ejecución — nunca contra `agro_score` ni las variables DB_* generales del
// backend (mismo mecanismo que el resto de las suites de F04, ver
// test/support/isolated-postgres-database.ts). La migración nunca se ejecuta contra una base real
// como parte de esta suite.
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

describe('F04 (revisión independiente, ronda 4) — migración 1788900000001 (asociación de clientRequestId) sobre datos preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;
  let idCounter = 0;

  function nextId(): string {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
  }

  async function seed(row: {
    id: string;
    fieldId: string | null;
    lotId: string | null;
    scope: 'field' | 'lot' | null;
    status: 'Procesando' | 'Finalizado' | 'Error';
    clientRequestId: string | null;
  }): Promise<void> {
    await dataSource!.query(
      `INSERT INTO "analysis"
         ("id", "fieldId", "lotId", "scope", "status", "clientRequestId", "lotName", "startDate", "endDate", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'Campo de prueba F04 (migración clientRequestId)', '2023-01-01', '2023-06-01', now(), now())`,
      [row.id, row.fieldId, row.lotId, row.scope, row.status, row.clientRequestId],
    );
  }

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'f04_dedup_cr_migration');
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
      synchronize: true, // crea el esquema (incluida analysis.clientRequestId) a partir de la entidad real.
    });
    await dataSource.initialize();

    // Simula el estado de una base real que ya pasó por la ronda 3: el índice de status y la
    // columna+índice de clientRequestId ya aplicados, ANTES de que exista analysis_client_request.
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().up(queryRunner);
    await new AddAnalysisClientRequestId1788900000000().up(queryRunner);
    await queryRunner.release();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
      } catch (error) {
        cleanupErrors.push(error);
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

  it('PRUEBA 7 — el backfill conserva cada asociación clientRequestId → analysisId existente, sin perder ninguna ni inventar otras, y AnalysisService las resuelve después de migrar', async () => {
    // Campo 1: dos claves DISTINTAS, cada una en su propia fila (dos análisis históricos
    // separados, cada uno creado por su propia acción con su propia clave — ronda 3).
    const field1AnalysisX = nextId();
    const field1AnalysisY = nextId();
    await seed({
      id: field1AnalysisX,
      fieldId: 'field-migracion-1',
      lotId: null,
      scope: 'field',
      status: 'Finalizado',
      clientRequestId: 'clave-vieja-1-x',
    });
    await seed({
      id: field1AnalysisY,
      fieldId: 'field-migracion-1',
      lotId: null,
      scope: 'field',
      status: 'Error',
      clientRequestId: 'clave-vieja-1-y',
    });

    // Campo 2 (legacy): scope=null, fieldId guardado en lotId — mismo patrón que
    // UQ_analysis_running_per_field ya contemplaba antes de esta ronda.
    const field2Analysis = nextId();
    await seed({
      id: field2Analysis,
      fieldId: null,
      lotId: 'field-migracion-2-legacy',
      scope: null,
      status: 'Procesando',
      clientRequestId: 'clave-vieja-2-legacy',
    });

    // Controles: NO deben aparecer en analysis_client_request tras la migración.
    const controlSinClave = nextId();
    await seed({
      id: controlSinClave,
      fieldId: 'field-migracion-3',
      lotId: null,
      scope: 'field',
      status: 'Finalizado',
      clientRequestId: null,
    });

    const controlScopeLot = nextId();
    await seed({
      id: controlScopeLot,
      fieldId: null,
      lotId: 'lote-suelto',
      scope: 'lot',
      status: 'Finalizado',
      clientRequestId: 'clave-de-un-lote-suelto',
    });

    // Corre la migración REAL bajo prueba.
    const queryRunner = dataSource!.createQueryRunner();
    await queryRunner.connect();
    await new AddAnalysisClientRequestAssociationTable1788900000001().up(queryRunner);
    await new MakeAnalysisClientRequestForeignKeyDeferrable1788900000002().up(queryRunner);
    await queryRunner.release();

    const allAssociations: Array<{
      fieldId: string;
      clientRequestId: string;
      analysisId: string;
    }> = await dataSource!.query(
      `SELECT "fieldId", "clientRequestId", "analysisId" FROM "analysis_client_request" ORDER BY "clientRequestId"`,
    );

    expect(allAssociations).toHaveLength(3); // ni las 2 de control, ni de más.

    const byKey = Object.fromEntries(allAssociations.map((row) => [row.clientRequestId, row]));

    expect(byKey['clave-vieja-1-x']).toEqual(
      expect.objectContaining({ fieldId: 'field-migracion-1', analysisId: field1AnalysisX }),
    );
    expect(byKey['clave-vieja-1-y']).toEqual(
      expect.objectContaining({ fieldId: 'field-migracion-1', analysisId: field1AnalysisY }),
    );
    expect(byKey['clave-vieja-2-legacy']).toEqual(
      expect.objectContaining({ fieldId: 'field-migracion-2-legacy', analysisId: field2Analysis }),
    );
    expect(byKey['clave-de-un-lote-suelto']).toBeUndefined();

    // Prueba de punta a punta: el mecanismo de resolución REAL (no solo una consulta SQL directa)
    // encuentra la asociación migrada y devuelve la fila histórica correcta, sin disparar Worker.
    const pythonWorkerServiceMock = { runFieldAnalysis: jest.fn() };
    const fieldsServiceMock = {
      findOne: jest.fn().mockResolvedValue({
        id: 'field-migracion-1',
        userId: 'user-A',
        name: 'Campo de prueba F04 (migración clientRequestId)',
        lots: [],
      }),
      getPipelineInput: jest.fn(),
    };
    const repo: Repository<Analysis> = dataSource!.getRepository(Analysis);
    const service = new AnalysisService(
      repo,
      pythonWorkerServiceMock as unknown as PythonWorkerService,
      fieldsServiceMock as unknown as FieldsService,
      { build: jest.fn() } as unknown as ReportPdfService,
      { generateAndPersist: jest.fn() } as unknown as AnalysisVerdictService,
    );

    const resolved = await service.runFieldAnalysis(
      'field-migracion-1',
      {
        startDate: '2024-01-01',
        endDate: '2024-06-01',
        maxCloudiness: 30,
        clientRequestId: 'clave-vieja-1-x',
      },
      'user-A',
    );

    expect(resolved.id).toBe(field1AnalysisX);
    expect(resolved.status).toBe('Finalizado');
    expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();
    expect(fieldsServiceMock.getPipelineInput).not.toHaveBeenCalled();
  });
});
