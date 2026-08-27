import {
  CleanupDb,
  CleanupDbClient,
  runCleanup,
} from './cleanup-test-data.core';

interface RecordedCall {
  sql: string;
  params: unknown[];
}

/**
 * DB falsa en memoria: nunca toca Postgres. Ruteamos por nombre de tabla
 * (extraído de "FROM <tabla>", presente tanto en SELECT como en DELETE FROM)
 * para no tener que reimplementar el WHERE real de cada query — alcanza
 * para testear ORDEN y si se ejecuta o no, que es lo que nos importa acá
 * (la corrección de cada predicado SQL ya está cubierta en
 * cleanup-test-data.plan.spec.ts y .rules.spec.ts).
 */
function createFakeDb(tableRows: Record<string, Array<{ id: string }>>) {
  const calls: RecordedCall[] = [];
  let transactionCalled = false;

  function extractTable(sql: string): string | undefined {
    return sql.match(/FROM\s+"?(\w+)"?/i)?.[1];
  }

  function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    calls.push({ sql, params });
    const table = extractTable(sql);
    const rows = (table ? tableRows[table] : undefined) ?? [];

    if (/^\s*DELETE/i.test(sql)) {
      return Promise.resolve(rows as unknown as T[]);
    }
    if (/COUNT\(\*\)/i.test(sql)) {
      return Promise.resolve([{ count: rows.length } as unknown as T]);
    }
    return Promise.resolve(rows as unknown as T[]);
  }

  const client: CleanupDbClient = { query };

  const db: CleanupDb = {
    query,
    async transaction(fn) {
      transactionCalled = true;
      return fn(client);
    },
  };

  return {
    db,
    calls,
    wasTransactionCalled: () => transactionCalled,
    deleteCalls: () => calls.filter((c) => /^\s*DELETE/i.test(c.sql)),
  };
}

const SAFE_USER_ROW = {
  id: 'user-qa-1',
  email: 'usera@example.com',
  fullName: 'QA Bot',
  role: 'user',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const AMBIGUOUS_USER_ROW = {
  id: 'user-ambiguous-1',
  email: 'random@some-real-domain.com',
  fullName: 'Test Producer',
  role: 'user',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const BLOCKED_ADMIN_ROW = {
  id: 'user-blocked-1',
  email: 'e2e.owner@qa-runner.dev',
  fullName: 'E2E Owner',
  role: 'owner',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const FULL_TABLE_ROWS: Record<string, Array<{ id: string }>> = {
  users: [SAFE_USER_ROW],
  fields: [{ id: 'field-1' }],
  field_lots: [{ id: 'lot-1' }],
  analysis: [{ id: 'analysis-1' }],
  field_analysis_schedules: [{ id: 'schedule-1' }],
  scheduled_analysis_runs: [{ id: 'run-1' }],
  weekly_analysis_snapshots: [{ id: 'snapshot-1' }],
  weekly_field_reports: [{ id: 'report-1' }],
  weekly_lot_index_observations: [{ id: 'obs-1' }],
  weekly_technical_verdicts: [{ id: 'verdict-1' }],
  analysis_technical_verdicts: [{ id: 'atv-1' }],
  user_invitations: [{ id: 'inv-1' }],
  access_requests: [{ id: 'ar-1' }],
  admin_audit_logs: [],
};

describe('cleanup-test-data.core — runCleanup', () => {
  // 8. Dry-run no ejecuta delete
  it('en dry-run nunca ejecuta ningún DELETE ni abre una transacción', async () => {
    const { db, wasTransactionCalled, deleteCalls } =
      createFakeDb(FULL_TABLE_ROWS);

    const report = await runCleanup(db, { confirm: false, maxUsers: 200 });

    expect(report.mode).toBe('dry-run');
    expect(report.executed).toBe(false);
    expect(wasTransactionCalled()).toBe(false);
    expect(deleteCalls()).toHaveLength(0);
    expect(report.safeUsers).toHaveLength(1);
    expect(report.counts['Fields']).toBe(1);
  });

  // 9. Confirm ejecutaría el plan en orden
  it('con --confirm y sin bloqueos, ejecuta el DELETE de cada tabla en el orden real del plan', async () => {
    const { db, wasTransactionCalled, deleteCalls } =
      createFakeDb(FULL_TABLE_ROWS);

    const report = await runCleanup(db, { confirm: true, maxUsers: 200 });

    expect(report.executed).toBe(true);
    expect(wasTransactionCalled()).toBe(true);
    expect(report.blockingReasons).toHaveLength(0);

    const deletedTables = deleteCalls().map(
      (c) => c.sql.match(/DELETE FROM\s+"?(\w+)"?/i)?.[1],
    );

    expect(deletedTables).toEqual([
      'weekly_technical_verdicts',
      'weekly_lot_index_observations',
      'weekly_analysis_snapshots',
      'weekly_field_reports',
      'scheduled_analysis_runs',
      'field_analysis_schedules',
      'analysis_technical_verdicts',
      'analysis',
      'field_lots',
      'password_reset_tokens',
      'user_invitations',
      'access_requests',
      'fields',
      'users',
    ]);

    expect(report.deletedCounts?.['Fields']).toBe(1);
    expect(report.deletedCounts?.['Users']).toBe(1);
  });

  // 10. Si hay un usuario sospechoso (ambiguo) no permitido, aborta
  it('aborta --confirm sin borrar nada si hay un usuario ambiguo (match solo por nombre)', async () => {
    const { db, wasTransactionCalled, deleteCalls } = createFakeDb({
      ...FULL_TABLE_ROWS,
      users: [SAFE_USER_ROW, AMBIGUOUS_USER_ROW],
    });

    const report = await runCleanup(db, { confirm: true, maxUsers: 200 });

    expect(report.executed).toBe(false);
    expect(wasTransactionCalled()).toBe(false);
    expect(deleteCalls()).toHaveLength(0);
    expect(report.ambiguousUsers).toHaveLength(1);
    expect(report.blockingReasons.length).toBeGreaterThan(0);
  });

  it('aborta --confirm sin borrar nada si hay un Owner/Admin bloqueado', async () => {
    const { db, wasTransactionCalled, deleteCalls } = createFakeDb({
      ...FULL_TABLE_ROWS,
      users: [SAFE_USER_ROW, BLOCKED_ADMIN_ROW],
    });

    const report = await runCleanup(db, { confirm: true, maxUsers: 200 });

    expect(report.executed).toBe(false);
    expect(wasTransactionCalled()).toBe(false);
    expect(deleteCalls()).toHaveLength(0);
    expect(report.blockedUsers).toHaveLength(1);
    expect(report.blockingReasons.length).toBeGreaterThan(0);
  });

  it('aborta --confirm si la cantidad de usuarios "safe" supera el máximo esperado', async () => {
    const manyUsers = Array.from({ length: 5 }, (_, i) => ({
      ...SAFE_USER_ROW,
      id: `user-qa-${i}`,
      email: `qa-${i}@example.com`,
    }));
    const { db, wasTransactionCalled } = createFakeDb({
      ...FULL_TABLE_ROWS,
      users: manyUsers,
    });

    const report = await runCleanup(db, { confirm: true, maxUsers: 2 });

    expect(report.executed).toBe(false);
    expect(wasTransactionCalled()).toBe(false);
    expect(
      report.blockingReasons.some((r) => r.includes('por encima del máximo')),
    ).toBe(true);
  });

  it('dry-run reporta los mismos bloqueos que --confirm, pero nunca ejecuta nada', async () => {
    const { db, wasTransactionCalled } = createFakeDb({
      ...FULL_TABLE_ROWS,
      users: [SAFE_USER_ROW, AMBIGUOUS_USER_ROW],
    });

    const report = await runCleanup(db, { confirm: false, maxUsers: 200 });

    expect(report.mode).toBe('dry-run');
    expect(report.blockingReasons.length).toBeGreaterThan(0);
    expect(wasTransactionCalled()).toBe(false);
  });

  it('reporta las advertencias de audit logs sin borrarlos nunca', async () => {
    const { db, calls } = createFakeDb({
      ...FULL_TABLE_ROWS,
      admin_audit_logs: [{ id: 'log-1' }],
    });

    const report = await runCleanup(db, { confirm: true, maxUsers: 200 });

    expect(report.auditLogWarnings.actorAffected).toBe(1);
    expect(report.auditLogWarnings.targetOrphaned).toBe(1);
    expect(
      calls.some((c) => /DELETE FROM\s+"?admin_audit_logs/i.test(c.sql)),
    ).toBe(false);
  });

  it('cuando no hay ningún usuario QA detectado, no borra ningún usuario/campo (los pasos dependientes de userIds dan 0)', async () => {
    const { db } = createFakeDb({
      ...FULL_TABLE_ROWS,
      users: [],
    });

    const report = await runCleanup(db, { confirm: true, maxUsers: 200 });

    expect(report.safeUsers).toHaveLength(0);
    expect(report.executed).toBe(true);
    // fields/users (y todo lo que depende de userIds) no tienen nada que borrar.
    expect(report.deletedCounts?.['Fields']).toBe(0);
    expect(report.deletedCounts?.['Users']).toBe(0);
    expect(report.deletedCounts?.['Field lots']).toBe(0);
    expect(report.deletedCounts?.['Analysis']).toBe(0);
  });
});
