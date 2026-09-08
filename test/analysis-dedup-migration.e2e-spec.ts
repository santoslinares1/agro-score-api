// F04: migración 1788829462102-AddRunningAnalysisPerFieldUniqueIndex contra datos ya existentes.
//
// Prepara filas duplicadas (y no-duplicadas, de control) ANTES de correr la migración REAL, en
// una base PostgreSQL aislada y desechable creada por esta misma ejecución — nunca contra
// `agro_score` ni las variables DB_* generales del backend (mismo mecanismo que
// analysis-dedup-race.e2e-spec.ts, ver test/support/isolated-postgres-database.ts). La migración
// nunca se ejecuta contra una base real como parte de esta suite.
import { DataSource } from 'typeorm';

import { AddRunningAnalysisPerFieldUniqueIndex1788829462102 } from '../src/migrations/1788829462102-AddRunningAnalysisPerFieldUniqueIndex';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

type SeedRow = {
  id: string;
  fieldId: string | null;
  lotId: string | null;
  scope: 'field' | 'lot' | null;
  status: 'Procesando' | 'Finalizado' | 'Error';
  createdAt: Date;
  lotName?: string;
  startDate?: string;
  endDate?: string;
  errorMessage?: string | null;
};

describe('F04 — migración 1788829462102 sobre duplicados preexistentes (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let dataSource: DataSource | undefined;
  let idCounter = 0;

  function nextId(): string {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`;
  }

  async function seed(row: SeedRow): Promise<void> {
    await dataSource!.query(
      `INSERT INTO "analysis"
         ("id", "fieldId", "lotId", "scope", "status", "lotName", "startDate", "endDate", "createdAt", "updatedAt", "errorMessage")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)`,
      [
        row.id,
        row.fieldId,
        row.lotId,
        row.scope,
        row.status,
        row.lotName ?? 'Campo de prueba F04 (migración)',
        row.startDate ?? '2023-01-01',
        row.endDate ?? '2023-06-01',
        row.createdAt,
        row.errorMessage ?? null,
      ],
    );
  }

  async function statusOf(id: string): Promise<{ status: string; errorMessage: string | null; failedAt: Date | null }> {
    const rows: Array<{ status: string; errorMessage: string | null; failedAt: Date | null }> =
      await dataSource!.query(
        `SELECT "status", "errorMessage", "failedAt" FROM "analysis" WHERE "id" = $1`,
        [id],
      );
    if (!rows[0]) {
      throw new Error(`Fila ${id} no encontrada — el seed no la creó o la migración la borró.`);
    }
    return rows[0];
  }

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'f04_dedup_migration');
    createdDatabaseName = created.name;

    dataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
      synchronize: true, // crea el esquema a partir de la entidad real, SIN el índice todavía.
    });
    await dataSource.initialize();
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
        'Fallo(s) durante la limpieza de recursos de la suite de migración F04 — ver causas.',
      );
    }
  });

  it('resuelve duplicados existentes (formato actual + legacy, empate de createdAt) y deja intactas las filas de control, antes de crear el índice; luego el índice rechaza un duplicado posterior; down() no restaura los estados', async () => {
    const now = Date.now();
    const minutesAgo = (m: number) => new Date(now - m * 60_000);

    // --- Campo A: 3 duplicados en formato ACTUAL + 1 duplicado LEGACY, el legacy es el más
    // reciente de los 4 (debe sobrevivir) — verifica que COALESCE(fieldId, lotId) unifica ambos
    // formatos bajo la misma clave, tal como usa el SELECT de dedupe real en
    // AnalysisService.runFieldAnalysis.
    const fieldA_old1 = nextId();
    const fieldA_old2 = nextId();
    const fieldA_old3 = nextId();
    const fieldA_legacyNewest = nextId();
    await seed({ id: fieldA_old1, fieldId: 'field-A', lotId: null, scope: 'field', status: 'Procesando', createdAt: minutesAgo(30) });
    await seed({ id: fieldA_old2, fieldId: 'field-A', lotId: null, scope: 'field', status: 'Procesando', createdAt: minutesAgo(20) });
    await seed({ id: fieldA_old3, fieldId: 'field-A', lotId: null, scope: 'field', status: 'Procesando', createdAt: minutesAgo(10) });
    // Legacy: scope NULL, la clave del campo va en lotId (no en fieldId) — ver el comentario de
    // AnalysisService.findByField sobre este formato histórico.
    await seed({ id: fieldA_legacyNewest, fieldId: null, lotId: 'field-A', scope: null, status: 'Procesando', createdAt: minutesAgo(5) });

    // --- Campo B: empate EXACTO de createdAt — desempate por id (ORDER BY createdAt DESC, id DESC
    // en la migración), ver abajo cuál sobrevive según el id generado.
    const tieTimestamp = minutesAgo(15);
    const fieldB_tieLow = nextId();
    const fieldB_tieHigh = nextId();
    await seed({ id: fieldB_tieLow, fieldId: 'field-B', lotId: null, scope: 'field', status: 'Procesando', createdAt: tieTimestamp });
    await seed({ id: fieldB_tieHigh, fieldId: 'field-B', lotId: null, scope: 'field', status: 'Procesando', createdAt: tieTimestamp });
    const expectedSurvivorB = fieldB_tieLow > fieldB_tieHigh ? fieldB_tieLow : fieldB_tieHigh;
    const expectedLoserB = fieldB_tieLow > fieldB_tieHigh ? fieldB_tieHigh : fieldB_tieLow;

    // --- Campo C: un solo Procesando (sin duplicado real) + un Finalizado — control: nada debe
    // cambiar, porque no hay MÁS de un Procesando para este campo.
    const fieldC_procesando = nextId();
    const fieldC_finalizado = nextId();
    await seed({ id: fieldC_procesando, fieldId: 'field-C', lotId: null, scope: 'field', status: 'Procesando', createdAt: minutesAgo(8) });
    await seed({ id: fieldC_finalizado, fieldId: 'field-C', lotId: null, scope: 'field', status: 'Finalizado', createdAt: minutesAgo(40) });

    // --- Campo D: solo filas terminales — control: nada que resolver, deben quedar intactas.
    const fieldD_finalizado1 = nextId();
    const fieldD_error1 = nextId();
    await seed({ id: fieldD_finalizado1, fieldId: 'field-D', lotId: null, scope: 'field', status: 'Finalizado', createdAt: minutesAgo(60) });
    await seed({ id: fieldD_error1, fieldId: 'field-D', lotId: null, scope: 'field', status: 'Error', createdAt: minutesAgo(50), errorMessage: 'error preexistente, no tocar' });

    // --- Control scope='lot': coincide en lotId con la clave de otro campo real (field-A) a
    // propósito — el contrato de dedupe NUNCA cubre scope='lot' (ver la migración), así que esta
    // fila debe quedar completamente afuera del cálculo, sin importar que su lotId "choque" en
    // valor con el fieldId de otro grupo.
    const scopeLotControl = nextId();
    await seed({ id: scopeLotControl, fieldId: null, lotId: 'field-A', scope: 'lot', status: 'Procesando', createdAt: minutesAgo(1) });

    // --- Corre la migración REAL (nunca contra una base real: esta es la base aislada de esta
    // ejecución) ---
    const queryRunner = dataSource!.createQueryRunner();
    await queryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().up(queryRunner);
    await queryRunner.release();

    // --- Campo A: sobrevive el legacy más nuevo; los 3 de formato actual quedan Error ---
    expect((await statusOf(fieldA_legacyNewest)).status).toBe('Procesando');
    for (const loserId of [fieldA_old1, fieldA_old2, fieldA_old3]) {
      const loser = await statusOf(loserId);
      expect(loser.status).toBe('Error');
      expect(loser.errorMessage).toMatch(/duplicado concurrente/i);
      expect(loser.failedAt).not.toBeNull();
    }

    // --- Campo B: desempate por id — exactamente uno sobrevive, el otro pasa a Error ---
    expect((await statusOf(expectedSurvivorB)).status).toBe('Procesando');
    const loserB = await statusOf(expectedLoserB);
    expect(loserB.status).toBe('Error');
    expect(loserB.errorMessage).toMatch(/duplicado concurrente/i);

    // --- Campo C: sin duplicado real — nada cambia ---
    expect((await statusOf(fieldC_procesando)).status).toBe('Procesando');
    expect((await statusOf(fieldC_finalizado)).status).toBe('Finalizado');

    // --- Campo D: solo filas terminales — intactas, incluido el mensaje de error preexistente
    // (para confirmar que la migración no lo pisa con el suyo) ---
    const d1 = await statusOf(fieldD_finalizado1);
    expect(d1.status).toBe('Finalizado');
    const d2 = await statusOf(fieldD_error1);
    expect(d2.status).toBe('Error');
    expect(d2.errorMessage).toBe('error preexistente, no tocar');

    // --- scope='lot': completamente intacta ---
    const lotControl = await statusOf(scopeLotControl);
    expect(lotControl.status).toBe('Procesando');

    // --- El índice existe tras la migración ---
    const indexRows = await dataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
    );
    expect(indexRows).toHaveLength(1);

    // --- El índice efectivamente rechaza un duplicado posterior para field-A (formato actual),
    // aunque el sobreviviente sea legacy — confirma que la clave del índice (COALESCE) coincide
    // con el criterio real de consulta para AMBOS formatos admitidos ---
    await expect(
      dataSource!.query(
        `INSERT INTO "analysis" ("id", "fieldId", "lotId", "scope", "status", "lotName", "startDate", "endDate")
         VALUES ($1, 'field-A', NULL, 'field', 'Procesando', 'x', '2023-01-01', '2023-06-01')`,
        [nextId()],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // --- Y un duplicado posterior en formato LEGACY para el mismo campo también choca (misma
    // clave lógica, sentido inverso al anterior) ---
    await expect(
      dataSource!.query(
        `INSERT INTO "analysis" ("id", "fieldId", "lotId", "scope", "status", "lotName", "startDate", "endDate")
         VALUES ($1, NULL, 'field-A', NULL, 'Procesando', 'x', '2023-01-01', '2023-06-01')`,
        [nextId()],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // --- Un Procesando NUEVO para un campo sin conflicto (ninguna fila previa) sigue funcionando
    // con normalidad tras la migración ---
    await expect(
      dataSource!.query(
        `INSERT INTO "analysis" ("id", "fieldId", "lotId", "scope", "status", "lotName", "startDate", "endDate")
         VALUES ($1, 'field-nuevo-sin-conflicto', NULL, 'field', 'Procesando', 'x', '2023-01-01', '2023-06-01')`,
        [nextId()],
      ),
    ).resolves.toBeDefined();

    // --- down(): elimina el índice pero NO restaura los estados que up() ya cambió (documentado
    // en la propia migración) ---
    const downQueryRunner = dataSource!.createQueryRunner();
    await downQueryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().down(downQueryRunner);
    await downQueryRunner.release();

    const indexRowsAfterDown = await dataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
    );
    expect(indexRowsAfterDown).toHaveLength(0);

    // Los perdedores marcados Error por up() siguen Error después de down() — down() no es un
    // "deshacer" de los datos, solo del esquema (el índice).
    for (const loserId of [fieldA_old1, fieldA_old2, fieldA_old3, expectedLoserB]) {
      expect((await statusOf(loserId)).status).toBe('Error');
    }
  });
});
