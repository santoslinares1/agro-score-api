// F01-F05 (entrega, ronda de preparación para staging): ensayo de la cadena real de migraciones
// de esta entrega contra un esquema PRE-EXISTENTE (las 15 migraciones anteriores a esta entrega,
// NUNCA `synchronize`) con datos SINTÉTICOS representativos — no una base vacía.
//
// Complementa (no reemplaza) a los otros dos archivos de migración de F04:
//   - analysis-dedup-migration.e2e-spec.ts: corre 1788829462102 sola contra datos preexistentes,
//     con foco en el índice único parcial.
//   - analysis-dedup-client-request-migration.e2e-spec.ts (PRUEBA 7): backfill de
//     analysis.clientRequestId (columna legacy, ronda 3) hacia analysis_client_request, arrancando
//     desde un estado INTERMEDIO (después de 1788900000000, antes de 1788900000001) — no desde el
//     baseline real de staging.
//
// Este archivo arranca desde el baseline REAL: las 20-5=15 migraciones que staging ya tiene HOY
// (antes de esta entrega), con `DataSource.runMigrations()` real (no llamadas sueltas a .up()) —
// para que la tabla `migrations` quede exactamente como en una base real recién actualizada hasta
// ahí. Sobre esa base, siembra datos sintéticos representativos (usuarios, análisis actuales y
// legacy, DUPLICADOS 'Procesando' — el bug que 1788829462102 reconcilia — y controles que no
// deben tocarse) y recién ahí aplica las 5 migraciones de esta entrega, también con
// runMigrations() real. No hay evidencia disponible en este entorno de la versión EXACTA del
// esquema de staging: este ensayo es representativo de "staging ya corrió las migraciones hasta
// CreateWeeklyTechnicalVerdicts inclusive" (el estado que describe el propio código de esta
// entrega, ver los migrations existentes) — no una comprobación contra el esquema real de
// staging.
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';

import { InitialSchema1785445140411 } from '../src/migrations/1785445140411-InitialSchema';
import { FieldsUserIdNotNull1785445240864 } from '../src/migrations/1785445240864-FieldsUserIdNotNull';
import { AddUserRolesAndActive1785848336701 } from '../src/migrations/1785848336701-AddUserRolesAndActive';
import { AddAnalysisTimingFields1785848336702 } from '../src/migrations/1785848336702-AddAnalysisTimingFields';
import { CreateAccessRequests1785848336703 } from '../src/migrations/1785848336703-CreateAccessRequests';
import { ExtendAccessRequestWorkflow1786026385135 } from '../src/migrations/1786026385135-ExtendAccessRequestWorkflow';
import { AddAnalysisReviewFields1786026385136 } from '../src/migrations/1786026385136-AddAnalysisReviewFields';
import { CreateAdminAuditLogs1786026385137 } from '../src/migrations/1786026385137-CreateAdminAuditLogs';
import { CreateUserInvitations1786026385138 } from '../src/migrations/1786026385138-CreateUserInvitations';
import { CreatePasswordResetTokens1786026385139 } from '../src/migrations/1786026385139-CreatePasswordResetTokens';
import { CreateWeeklyReports1787357251748 } from '../src/migrations/1787357251748-CreateWeeklyReports';
import { CreateScheduledAnalysis1787403339340 } from '../src/migrations/1787403339340-CreateScheduledAnalysis';
import { CreateWeeklyAnalysisSnapshots1787603472055 } from '../src/migrations/1787603472055-CreateWeeklyAnalysisSnapshots';
import { CreateAnalysisTechnicalVerdicts1787696465873 } from '../src/migrations/1787696465873-CreateAnalysisTechnicalVerdicts';
import { CreateWeeklyTechnicalVerdicts1787750070944 } from '../src/migrations/1787750070944-CreateWeeklyTechnicalVerdicts';
import { AddUserTokenVersion1788555653620 } from '../src/migrations/1788555653620-AddUserTokenVersion';
import { AddRunningAnalysisPerFieldUniqueIndex1788829462102 } from '../src/migrations/1788829462102-AddRunningAnalysisPerFieldUniqueIndex';
import { AddAnalysisClientRequestId1788900000000 } from '../src/migrations/1788900000000-AddAnalysisClientRequestId';
import { AddAnalysisClientRequestAssociationTable1788900000001 } from '../src/migrations/1788900000001-AddAnalysisClientRequestAssociationTable';
import { MakeAnalysisClientRequestForeignKeyDeferrable1788900000002 } from '../src/migrations/1788900000002-MakeAnalysisClientRequestForeignKeyDeferrable';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(60_000);

// Las 15 migraciones que esta entrega asume que staging YA tiene aplicadas — orden real, mismo
// orden que TypeORM aplicaría por timestamp. Ninguna de esta lista pertenece a F01-F05.
const PRE_EXISTING_MIGRATIONS = [
  InitialSchema1785445140411,
  FieldsUserIdNotNull1785445240864,
  AddUserRolesAndActive1785848336701,
  AddAnalysisTimingFields1785848336702,
  CreateAccessRequests1785848336703,
  ExtendAccessRequestWorkflow1786026385135,
  AddAnalysisReviewFields1786026385136,
  CreateAdminAuditLogs1786026385137,
  CreateUserInvitations1786026385138,
  CreatePasswordResetTokens1786026385139,
  CreateWeeklyReports1787357251748,
  CreateScheduledAnalysis1787403339340,
  CreateWeeklyAnalysisSnapshots1787603472055,
  CreateAnalysisTechnicalVerdicts1787696465873,
  CreateWeeklyTechnicalVerdicts1787750070944,
];

// Las 5 migraciones nuevas de esta entrega — mismo orden real.
const NEW_MIGRATIONS = [
  AddUserTokenVersion1788555653620,
  AddRunningAnalysisPerFieldUniqueIndex1788829462102,
  AddAnalysisClientRequestId1788900000000,
  AddAnalysisClientRequestAssociationTable1788900000001,
  MakeAnalysisClientRequestForeignKeyDeferrable1788900000002,
];

describe('Ensayo de actualización — esquema existente (15 migraciones previas) + datos sintéticos representativos + cadena nueva de esta entrega (PostgreSQL real, base aislada y descartable)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;

  async function connectDataSource(migrations: unknown[]): Promise<DataSource> {
    const ds = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName!,
      migrations: migrations as never,
      migrationsTableName: 'migrations',
      synchronize: false,
    });
    await ds.initialize();
    return ds;
  }

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();
    const created = await createIsolatedTestDatabase(target, 'f01f05_existing_schema_upgrade');
    createdDatabaseName = created.name;

    // Hallazgo (no de esta entrega): InitialSchema1785445140411 usa uuid_generate_v4(), de la
    // extensión uuid-ossp — nunca la crea ella misma. `template1` de este servidor no la trae, así
    // que cualquier base NUEVA (como esta, creada por createIsolatedTestDatabase) no la tiene
    // hasta que algo la pida explícitamente; la base real `agro_score` sí la tiene (creada en
    // algún momento fuera de las migraciones versionadas). Se crea acá, en la base descartable de
    // este ensayo — nunca en agro_score ni en ninguna base real — para poder correr la migración
    // real tal cual está, sin reescribirla.
    const extensionSetup = await connectDataSource([]);
    try {
      await extensionSetup.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    } finally {
      await extensionSetup.destroy();
    }

    // Fase 1: baseline REAL — exactamente las migraciones que staging ya tiene hoy, con
    // runMigrations() real (no .up() sueltos) para que `migrations` quede como en un ambiente
    // real recién actualizado hasta acá. try/finally: si runMigrations() fallara, igual hay que
    // cerrar esta conexión — de lo contrario el DROP DATABASE de afterAll queda bloqueado por una
    // conexión propia todavía abierta, dejando la base descartable huérfana.
    const baseline = await connectDataSource(PRE_EXISTING_MIGRATIONS);
    try {
      const appliedBaseline = await baseline.runMigrations();
      expect(appliedBaseline).toHaveLength(15);
    } finally {
      await baseline.destroy();
    }
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
      throw new AggregateError(cleanupErrors, 'Fallo(s) en la limpieza.');
    }
  });

  // IDs fijos para poder referenciarlos por nombre en las verificaciones de abajo.
  const ids = {
    userOwner: randomUUID(),
    userInactive: randomUUID(),
    analysisCurrentFinalizado: randomUUID(),
    analysisCurrentError: randomUUID(),
    analysisLegacyFinalizado: randomUUID(),
    dupFieldWinner: randomUUID(), // el más reciente — debe sobrevivir Procesando.
    dupFieldLoser1: randomUUID(),
    dupFieldLoser2: randomUUID(),
    dupLegacyWinner: randomUUID(),
    dupLegacyLoser: randomUUID(),
    controlLotScopeA: randomUUID(),
    controlLotScopeB: randomUUID(),
    singleFreshProcesando: randomUUID(),
  };

  it('siembra datos sintéticos representativos sobre el baseline (usuarios, análisis actuales/legacy, duplicados Procesando, controles)', async () => {
    dataSource = await connectDataSource([]); // sin migrations acá — solo se usa para sembrar/leer.

    // ---- Usuarios existentes ----
    await dataSource.query(
      `INSERT INTO "users" ("id","email","passwordHash","fullName","role","isActive","createdAt","updatedAt")
       VALUES
        ($1,'owner@ensayo.test','hash-1','Owner Ensayo','owner',true, now() - interval '400 days', now() - interval '10 days'),
        ($2,'inactivo@ensayo.test','hash-2','Usuario Desactivado','user',false, now() - interval '200 days', now() - interval '5 days')`,
      [ids.userOwner, ids.userInactive],
    );

    // ---- Análisis actuales (scope='field') en estados terminales — no deben tocarse ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","fieldId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES ($1,'field-actual-1','field','Finalizado','Campo actual','2024-01-01','2024-06-01', now() - interval '30 days', now() - interval '29 days')`,
      [ids.analysisCurrentFinalizado],
    );
    await dataSource.query(
      `INSERT INTO "analysis" ("id","fieldId","scope","status","lotName","startDate","endDate","errorMessage","createdAt","updatedAt")
       VALUES ($1,'field-actual-2','field','Error','Campo con error real','2024-01-01','2024-06-01','Fallo real de negocio, no de la migración', now() - interval '20 days', now() - interval '19 days')`,
      [ids.analysisCurrentError],
    );

    // ---- Análisis legacy (scope IS NULL, fieldId histórico guardado en lotId) — terminal ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","lotId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES ($1,'field-legacy-1',NULL,'Finalizado','Campo legacy','2023-06-01','2023-12-01', now() - interval '300 days', now() - interval '299 days')`,
      [ids.analysisLegacyFinalizado],
    );

    // ---- DUPLICADOS 'Procesando' en un campo actual — el residuo del propio bug que
    // 1788829462102 reconcilia. 3 filas para el MISMO field-duplicado-1: la más nueva
    // (dupFieldWinner) debe sobrevivir; las otras dos deben quedar 'Error'. ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","fieldId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES
        ($1,'field-duplicado-1','field','Procesando','Dup A (vieja)','2024-01-01','2024-06-01', now() - interval '3 days', now() - interval '3 days'),
        ($2,'field-duplicado-1','field','Procesando','Dup A (media)','2024-01-01','2024-06-01', now() - interval '2 days', now() - interval '2 days'),
        ($3,'field-duplicado-1','field','Procesando','Dup A (más nueva — debe sobrevivir)','2024-01-01','2024-06-01', now() - interval '1 days', now() - interval '1 days')`,
      [ids.dupFieldLoser1, ids.dupFieldLoser2, ids.dupFieldWinner],
    );

    // ---- Mismo duplicado, pero en la variante LEGACY (scope IS NULL, lotId=fieldId) — confirma
    // que la reconciliación cubre también esa rama del predicado, no solo scope='field'. ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","lotId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES
        ($1,'field-duplicado-legacy',NULL,'Procesando','Dup legacy (vieja)','2024-01-01','2024-06-01', now() - interval '2 days', now() - interval '2 days'),
        ($2,'field-duplicado-legacy',NULL,'Procesando','Dup legacy (más nueva — debe sobrevivir)','2024-01-01','2024-06-01', now() - interval '1 days', now() - interval '1 days')`,
      [ids.dupLegacyLoser, ids.dupLegacyWinner],
    );

    // ---- Control: análisis scope='lot' (legacy standalone, fuera del alcance del índice) — DOS
    // 'Procesando' para lo que sería el "mismo" lote si el índice los mirara. Deben sobrevivir
    // AMBOS intactos: scope='lot' nunca estuvo cubierto por el dedupe de campo, ni antes ni con
    // esta entrega. ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","lotId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES
        ($1,'lote-suelto','lot','Procesando','Lote standalone A','2024-01-01','2024-06-01', now() - interval '2 days', now() - interval '2 days'),
        ($2,'lote-suelto','lot','Procesando','Lote standalone B','2024-01-01','2024-06-01', now() - interval '1 days', now() - interval '1 days')`,
      [ids.controlLotScopeA, ids.controlLotScopeB],
    );

    // ---- Control: un único 'Procesando' fresco y legítimo (sin duplicar) — no debe tocarse. ----
    await dataSource.query(
      `INSERT INTO "analysis" ("id","fieldId","scope","status","lotName","startDate","endDate","createdAt","updatedAt")
       VALUES ($1,'field-sano-1','field','Procesando','Campo sano, un solo Procesando','2024-01-01','2024-06-01', now(), now())`,
      [ids.singleFreshProcesando],
    );

    const totalRows: Array<{ count: string }> = await dataSource.query(
      `SELECT count(*)::int AS count FROM "analysis"`,
    );
    // 1 (actual Finalizado) + 1 (actual Error) + 1 (legacy Finalizado) + 3 (dup field) +
    // 2 (dup legacy) + 2 (control scope='lot') + 1 (Procesando único sano) = 11.
    expect(Number(totalRows[0].count)).toBe(11);
  });

  it('aplica las 5 migraciones nuevas de esta entrega sobre el baseline sembrado, sin error', async () => {
    await dataSource!.destroy();
    dataSource = await connectDataSource(NEW_MIGRATIONS);

    const applied = await dataSource.runMigrations();
    expect(applied).toHaveLength(5);
    expect(applied.map((m) => m.name)).toEqual([
      'AddUserTokenVersion1788555653620',
      'AddRunningAnalysisPerFieldUniqueIndex1788829462102',
      'AddAnalysisClientRequestId1788900000000',
      'AddAnalysisClientRequestAssociationTable1788900000001',
      'MakeAnalysisClientRequestForeignKeyDeferrable1788900000002',
    ]);

    const migrationsRows: Array<{ name: string }> = await dataSource.query(
      `SELECT name FROM migrations ORDER BY id`,
    );
    expect(migrationsRows).toHaveLength(20); // 15 preexistentes + 5 nuevas.
  });

  it('preservación de datos: usuarios y análisis terminales/controles quedan exactamente iguales', async () => {
    const owner: Array<{ email: string; role: string; isActive: boolean; tokenVersion: number }> =
      await dataSource!.query(
        `SELECT "email","role","isActive","tokenVersion" FROM "users" WHERE "id" = $1`,
        [ids.userOwner],
      );
    expect(owner[0]).toEqual(
      expect.objectContaining({ email: 'owner@ensayo.test', role: 'owner', isActive: true, tokenVersion: 0 }),
    );

    const inactive: Array<{ isActive: boolean; tokenVersion: number }> = await dataSource!.query(
      `SELECT "isActive","tokenVersion" FROM "users" WHERE "id" = $1`,
      [ids.userInactive],
    );
    expect(inactive[0]).toEqual({ isActive: false, tokenVersion: 0 });

    const terminal: Array<{ status: string; errorMessage: string | null }> = await dataSource!.query(
      `SELECT "status","errorMessage" FROM "analysis" WHERE "id" = ANY($1::uuid[])`,
      [[ids.analysisCurrentFinalizado, ids.analysisCurrentError, ids.analysisLegacyFinalizado]],
    );
    expect(terminal.find((r) => r.status === 'Error')?.errorMessage).toBe(
      'Fallo real de negocio, no de la migración',
    ); // el mensaje de error REAL no se pisó con el de la migración.
    expect(terminal.filter((r) => r.status === 'Finalizado')).toHaveLength(2);

    const lotScope: Array<{ id: string; status: string }> = await dataSource!.query(
      `SELECT "id","status" FROM "analysis" WHERE "id" = ANY($1::uuid[])`,
      [[ids.controlLotScopeA, ids.controlLotScopeB]],
    );
    expect(lotScope.every((r) => r.status === 'Procesando')).toBe(true); // scope='lot': AMBOS intactos.

    const freshSingle: Array<{ status: string }> = await dataSource!.query(
      `SELECT "status" FROM "analysis" WHERE "id" = $1`,
      [ids.singleFreshProcesando],
    );
    expect(freshSingle[0].status).toBe('Procesando'); // único, sano: no tocado.
  });

  it('reconciliación esperada: en cada grupo de duplicados Procesando, solo el más reciente sigue Procesando y el resto quedó Error con el mensaje de la migración', async () => {
    const dupField: Array<{ id: string; status: string; errorMessage: string | null }> =
      await dataSource!.query(
        `SELECT "id","status","errorMessage" FROM "analysis" WHERE "fieldId" = 'field-duplicado-1' ORDER BY "createdAt"`,
      );
    expect(dupField).toHaveLength(3);
    expect(dupField.filter((r) => r.status === 'Procesando')).toHaveLength(1);
    expect(dupField.find((r) => r.id === ids.dupFieldWinner)?.status).toBe('Procesando');
    for (const loser of dupField.filter((r) => r.id !== ids.dupFieldWinner)) {
      expect(loser.status).toBe('Error');
      expect(loser.errorMessage).toBe(
        'Marcado automáticamente como duplicado concurrente al aplicar la migración de deduplicación (F04).',
      );
    }

    const dupLegacy: Array<{ id: string; status: string }> = await dataSource!.query(
      `SELECT "id","status" FROM "analysis" WHERE "lotId" = 'field-duplicado-legacy' AND "scope" IS NULL ORDER BY "createdAt"`,
    );
    expect(dupLegacy).toHaveLength(2);
    expect(dupLegacy.find((r) => r.id === ids.dupLegacyWinner)?.status).toBe('Procesando');
    expect(dupLegacy.find((r) => r.id === ids.dupLegacyLoser)?.status).toBe('Error');
  });

  it('índice único parcial: se creó y ya rechaza un segundo Procesando para un campo que quedó con exactamente uno tras la reconciliación', async () => {
    const idx: Array<{ indexdef: string }> = await dataSource!.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
    );
    expect(idx).toHaveLength(1);

    await expect(
      dataSource!.query(
        `INSERT INTO "analysis" ("fieldId","scope","status","lotName","startDate","endDate")
         VALUES ('field-duplicado-1','field','Procesando','Otro intento','2024-01-01','2024-06-01')`,
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/i);
  });

  it('asociaciones: analysis_client_request existe, vacía (no había clientRequestId preexistente en este baseline), lista para uso normal', async () => {
    const rows: Array<{ count: string }> = await dataSource!.query(
      `SELECT count(*)::int AS count FROM "analysis_client_request"`,
    );
    expect(Number(rows[0].count)).toBe(0);

    // Uso normal post-migración: una asociación nueva se puede crear sin error.
    await dataSource!.query(
      `INSERT INTO "analysis_client_request" ("fieldId","clientRequestId","analysisId")
       VALUES ('field-sano-1','clave-post-migracion',$1)`,
      [ids.singleFreshProcesando],
    );
    const after: Array<{ count: string }> = await dataSource!.query(
      `SELECT count(*)::int AS count FROM "analysis_client_request"`,
    );
    expect(Number(after[0].count)).toBe(1);
  });

  it('FK diferida: analysisId -> analysis.id es DEFERRABLE INITIALLY DEFERRED también en una base migrada desde datos existentes', async () => {
    const rows: Array<{ condeferrable: boolean; condeferred: boolean }> = await dataSource!.query(
      `SELECT condeferrable, condeferred FROM pg_constraint
       WHERE conname = 'analysis_client_request_analysisId_fkey'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].condeferrable).toBe(true);
    expect(rows[0].condeferred).toBe(true);
  });

  it('rollback de las 5 migraciones nuevas: el esquema vuelve a las 15 preexistentes; los datos ya reconciliados NO vuelven atrás (down documentado, no mágico)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await dataSource!.undoLastMigration();
    }

    const migrationsRows: Array<{ name: string }> = await dataSource!.query(
      `SELECT name FROM migrations ORDER BY id`,
    );
    expect(migrationsRows).toHaveLength(15);

    const tables: Array<{ table_name: string }> = await dataSource!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'analysis_client_request'`,
    );
    expect(tables).toHaveLength(0);

    const tokenVersionCol: Array<{ column_name: string }> = await dataSource!.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'tokenVersion'`,
    );
    expect(tokenVersionCol).toHaveLength(0);

    // Los duplicados marcados 'Error' por la reconciliación de 1788829462102 NO vuelven a
    // 'Procesando' — down() de esa migración documentadamente solo borra el índice (ver su
    // docstring). Esto es evidencia directa de "efecto no reversible sobre datos" para el
    // procedimiento de staging.
    const dupField: Array<{ status: string }> = await dataSource!.query(
      `SELECT "status" FROM "analysis" WHERE "fieldId" = 'field-duplicado-1' AND "status" = 'Procesando'`,
    );
    expect(dupField).toHaveLength(1); // sigue habiendo exactamente 1 Procesando — el ganador —
    // no 3: el rollback no revive a los perdedores, tal como documenta la migración.
  });
});
