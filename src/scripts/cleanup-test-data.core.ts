/**
 * Orquestación de la limpieza QA/test — separada del entrypoint
 * (cleanup-test-data.ts) a propósito: este archivo NO importa AppDataSource
 * ni nada de TypeORM, así que se puede importar desde los tests sin abrir
 * ninguna conexión real a Postgres (requisito: no ejecutar la limpieza real
 * durante tests). El entrypoint solo hace la wiring contra la DB real y
 * llama a runCleanup() acá definido.
 */
import {
  CandidateUserRow,
  ClassifiedUser,
  buildCandidateUserQuery,
  buildEmailPatternWhereSql,
  classifyUsers,
} from './cleanup-test-data.rules';
import {
  CleanupIds,
  buildDeletionPlan,
  emptyCleanupIds,
} from './cleanup-test-data.plan';

export const DEFAULT_MAX_SAFE_USERS = 200;

/** Superficie mínima de DB que necesita runCleanup — implementada contra
 * AppDataSource real en el entrypoint, y con un fake en los tests. */
export interface CleanupDbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface CleanupDb extends CleanupDbClient {
  transaction<T>(fn: (manager: CleanupDbClient) => Promise<T>): Promise<T>;
}

export interface CleanupArgs {
  /** true = --confirm (borra de verdad si no hay bloqueos). false = dry-run
   * (default, y también --dry-run explícito). */
  confirm: boolean;
  maxUsers: number;
}

export interface AuditLogWarnings {
  /** admin_audit_logs.actorUserId es FK ON DELETE SET NULL: al borrar estos
   * usuarios, la DB va a poner NULL acá sola (no es un borrado nuestro). */
  actorAffected: number;
  /** admin_audit_logs.targetType/targetId son polimórficos sin FK real: si
   * un log apunta a un usuario QA (targetType='user'), va a quedar
   * apuntando a un id que ya no existe. No se toca — se reporta nada más. */
  targetOrphaned: number;
}

export interface CleanupReport {
  mode: 'dry-run' | 'confirm';
  safeUsers: ClassifiedUser[];
  blockedUsers: ClassifiedUser[];
  ambiguousUsers: ClassifiedUser[];
  ids: CleanupIds;
  /** conteo por step.label, mismo predicado que se usaría (o se usó) para borrar. */
  counts: Record<string, number>;
  auditLogWarnings: AuditLogWarnings;
  /** si no está vacío, --confirm se abortó sin tocar nada (o, en dry-run,
   * es lo que impediría correr --confirm hoy). */
  blockingReasons: string[];
  /** true solo si realmente se ejecutó el DELETE dentro de una transacción. */
  executed: boolean;
  deletedCounts?: Record<string, number>;
}

async function selectIds(
  db: CleanupDbClient,
  sql: string,
  params: unknown[],
): Promise<string[]> {
  const rows = await db.query<{ id: string }>(sql, params);
  return rows.map((row) => row.id);
}

/**
 * Resuelve, en cascada y en el orden correcto de dependencia (no el orden de
 * borrado — ahí sí hace falta tener fieldIds antes de poder buscar
 * field_lots, por ejemplo), todos los ids afectados a partir de los
 * usuarios ya clasificados como "safe". Cada query se salta si el array del
 * que depende viene vacío, para no pegarle a la DB de más ni generar
 * `= ANY($1)` con arrays vacíos innecesariamente.
 */
export async function resolveCascadeIds(
  db: CleanupDbClient,
  userIds: string[],
): Promise<CleanupIds> {
  if (!userIds.length) {
    const ids = emptyCleanupIds();
    const invitationWhere = buildEmailPatternWhereSql('email');
    const accessRequestWhere = buildEmailPatternWhereSql('email');
    ids.invitationIds = await selectIds(
      db,
      `SELECT id FROM user_invitations WHERE ${invitationWhere.sql}`,
      invitationWhere.params,
    );
    ids.accessRequestIds = await selectIds(
      db,
      `SELECT id FROM access_requests WHERE ${accessRequestWhere.sql}`,
      accessRequestWhere.params,
    );
    return ids;
  }

  const fieldIds = await selectIds(
    db,
    'SELECT id FROM fields WHERE "userId" = ANY($1::uuid[])',
    [userIds],
  );

  const lotIds = fieldIds.length
    ? await selectIds(
        db,
        'SELECT id FROM field_lots WHERE "fieldId" = ANY($1::uuid[])',
        [fieldIds],
      )
    : [];

  const analysisIds =
    fieldIds.length || lotIds.length
      ? await selectIds(
          db,
          'SELECT id FROM analysis WHERE "fieldId" = ANY($1::varchar[]) OR "lotId" = ANY($2::varchar[])',
          [fieldIds, lotIds],
        )
      : [];

  const scheduleIds = await selectIds(
    db,
    'SELECT id FROM field_analysis_schedules WHERE "fieldId" = ANY($1::uuid[]) OR "userId" = ANY($2::uuid[])',
    [fieldIds, userIds],
  );

  const scheduledRunIds = await selectIds(
    db,
    'SELECT id FROM scheduled_analysis_runs WHERE "scheduleId" = ANY($1::uuid[]) OR "fieldId" = ANY($2::uuid[]) OR "userId" = ANY($3::uuid[])',
    [scheduleIds, fieldIds, userIds],
  );

  const snapshotIds = await selectIds(
    db,
    'SELECT id FROM weekly_analysis_snapshots WHERE "fieldId" = ANY($1::uuid[]) OR "userId" = ANY($2::uuid[])',
    [fieldIds, userIds],
  );

  const weeklyReportIds = await selectIds(
    db,
    'SELECT id FROM weekly_field_reports WHERE "fieldId" = ANY($1::uuid[]) OR "userId" = ANY($2::uuid[])',
    [fieldIds, userIds],
  );

  const invitationWhere = buildEmailPatternWhereSql('email');
  const invitationIds = await selectIds(
    db,
    `SELECT id FROM user_invitations WHERE ${invitationWhere.sql}`,
    invitationWhere.params,
  );

  const accessRequestWhere = buildEmailPatternWhereSql('email');
  const accessRequestIds = await selectIds(
    db,
    `SELECT id FROM access_requests WHERE ${accessRequestWhere.sql}`,
    accessRequestWhere.params,
  );

  return {
    userIds,
    fieldIds,
    lotIds,
    analysisIds,
    scheduleIds,
    scheduledRunIds,
    snapshotIds,
    weeklyReportIds,
    invitationIds,
    accessRequestIds,
  };
}

export async function resolveAuditLogWarnings(
  db: CleanupDbClient,
  userIds: string[],
): Promise<AuditLogWarnings> {
  if (!userIds.length) return { actorAffected: 0, targetOrphaned: 0 };

  const actorResult = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM admin_audit_logs WHERE "actorUserId" = ANY($1::uuid[])',
    [userIds],
  );
  const targetResult = await db.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM admin_audit_logs WHERE "targetType" = 'user' AND "targetId" = ANY($1::text[])`,
    [userIds],
  );

  return {
    actorAffected: Number(actorResult[0]?.count ?? 0),
    targetOrphaned: Number(targetResult[0]?.count ?? 0),
  };
}

function buildBlockingReasons(
  safeUsers: ClassifiedUser[],
  blockedUsers: ClassifiedUser[],
  ambiguousUsers: ClassifiedUser[],
  maxUsers: number,
): string[] {
  const reasons: string[] = [];

  if (blockedUsers.length > 0) {
    reasons.push(
      `${blockedUsers.length} usuario(s) bloqueado(s) (dominio @agroscorelatam.com u Owner/Admin) ` +
        'coinciden con un patrón QA. Revisar manualmente antes de continuar.',
    );
  }

  if (ambiguousUsers.length > 0) {
    reasons.push(
      `${ambiguousUsers.length} usuario(s) ambiguo(s): coinciden solo por nombre, no por email. ` +
        'Patrón no claro — revisar manualmente antes de continuar.',
    );
  }

  if (safeUsers.length > maxUsers) {
    reasons.push(
      `Se detectaron ${safeUsers.length} usuarios seguros para borrar, por encima del máximo ` +
        `esperado (${maxUsers}). Esto es inusual para una limpieza QA puntual — abortando por seguridad.`,
    );
  }

  return reasons;
}

/**
 * Punto de entrada puro de la limpieza. No decide nada de I/O (no lee
 * argv, no imprime nada) — eso es responsabilidad del entrypoint. Siempre
 * calcula el reporte completo (candidatos, bloqueados, ambiguos, conteos);
 * solo ejecuta el DELETE real si args.confirm=true Y no hay
 * blockingReasons.
 */
export async function runCleanup(
  db: CleanupDb,
  args: CleanupArgs,
): Promise<CleanupReport> {
  const candidateQuery = buildCandidateUserQuery();
  const candidateRows = await db.query<CandidateUserRow>(
    candidateQuery.sql,
    candidateQuery.params,
  );
  const classified = classifyUsers(candidateRows);

  const safeUsers = classified.filter((c) => c.category === 'safe');
  const blockedUsers = classified.filter((c) => c.category === 'blocked');
  const ambiguousUsers = classified.filter((c) => c.category === 'ambiguous');

  const blockingReasons = buildBlockingReasons(
    safeUsers,
    blockedUsers,
    ambiguousUsers,
    args.maxUsers,
  );

  const userIds = safeUsers.map((u) => u.row.id);
  const ids = await resolveCascadeIds(db, userIds);
  const auditLogWarnings = await resolveAuditLogWarnings(db, userIds);

  const steps = buildDeletionPlan();
  const counts: Record<string, number> = {};
  for (const step of steps) {
    const query = step.buildCountQuery(ids);
    if (!query) {
      counts[step.label] = 0;
      continue;
    }
    const result = await db.query<{ count: number }>(query.sql, query.params);
    counts[step.label] = Number(result[0]?.count ?? 0);
  }

  const shouldExecute = args.confirm && blockingReasons.length === 0;
  let deletedCounts: Record<string, number> | undefined;

  if (shouldExecute) {
    deletedCounts = {};
    const executedCounts = deletedCounts;
    await db.transaction(async (manager) => {
      for (const step of steps) {
        const query = step.buildDeleteQuery(ids);
        if (!query) {
          executedCounts[step.label] = 0;
          continue;
        }
        const result = await manager.query<{ id: string }>(
          query.sql,
          query.params,
        );
        executedCounts[step.label] = Array.isArray(result) ? result.length : 0;
      }
    });
  }

  return {
    mode: args.confirm ? 'confirm' : 'dry-run',
    safeUsers,
    blockedUsers,
    ambiguousUsers,
    ids,
    counts,
    auditLogWarnings,
    blockingReasons,
    executed: shouldExecute,
    deletedCounts,
  };
}

export function parseArgs(argv: string[]): CleanupArgs {
  let confirm = false;
  let maxUsers = DEFAULT_MAX_SAFE_USERS;

  for (const arg of argv) {
    if (arg === '--confirm') {
      confirm = true;
    } else if (arg === '--dry-run') {
      confirm = false;
    } else if (arg.startsWith('--max-users=')) {
      const value = Number(arg.split('=')[1]);
      if (Number.isFinite(value) && value > 0) maxUsers = value;
    }
  }

  return { confirm, maxUsers };
}

function formatUserLine(entry: ClassifiedUser): string {
  const createdAt = String(entry.row.createdAt);
  return (
    `  - ${entry.row.email}  (${entry.row.fullName || 'sin nombre'})  ` +
    `id=${entry.row.id}  role=${entry.row.role}  isActive=${entry.row.isActive}  ` +
    `createdAt=${createdAt}\n` +
    `      razones: ${entry.reasons.join(', ') || '—'}`
  );
}

export function printReport(report: CleanupReport): void {
  const line = '─'.repeat(70);

  console.log(line);
  console.log(`cleanup-test-data — modo: ${report.mode.toUpperCase()}`);
  console.log(line);

  console.log(
    `\nUsuarios detectados para borrar (safe): ${report.safeUsers.length}`,
  );
  report.safeUsers.forEach((entry) => console.log(formatUserLine(entry)));

  console.log(
    `\nUsuarios bloqueados por seguridad: ${report.blockedUsers.length}`,
  );
  report.blockedUsers.forEach((entry) => console.log(formatUserLine(entry)));

  console.log(
    `\nUsuarios ambiguos (requieren revisión manual): ${report.ambiguousUsers.length}`,
  );
  report.ambiguousUsers.forEach((entry) => console.log(formatUserLine(entry)));

  console.log('\nConteos por tabla (orden de borrado):');
  for (const [label, count] of Object.entries(report.counts)) {
    console.log(`  - ${label}: ${count}`);
  }

  console.log(
    '\nAudit logs (admin_audit_logs) — NUNCA se borran, solo se reportan:',
  );
  console.log(
    `  - Referencian a un usuario QA como actor (actorUserId): ${report.auditLogWarnings.actorAffected} ` +
      '(la DB los va a poner en NULL sola al borrar el usuario — FK ON DELETE SET NULL, no es un borrado nuestro).',
  );
  console.log(
    `  - Referencian a un usuario QA como target (targetType='user'): ${report.auditLogWarnings.targetOrphaned} ` +
      '(sin FK real — van a quedar apuntando a un id que ya no existe, no se tocan).',
  );

  if (report.blockingReasons.length > 0) {
    console.log('\n⚠ ADVERTENCIAS (bloquean --confirm):');
    report.blockingReasons.forEach((reason) => console.log(`  - ${reason}`));
  }

  console.log('\n' + line);
  if (report.mode === 'dry-run') {
    console.log(
      'DRY-RUN: no se borró nada. Corré con -- --confirm para ejecutar el plan de arriba.',
    );
  } else if (report.executed) {
    console.log(
      'CONFIRM: se ejecutó el borrado dentro de una transacción. Filas borradas por tabla:',
    );
    for (const [label, count] of Object.entries(report.deletedCounts ?? {})) {
      console.log(`  - ${label}: ${count}`);
    }
  } else {
    console.log(
      'CONFIRM ABORTADO: había advertencias bloqueantes (ver arriba). No se borró nada.',
    );
  }
  console.log(line);
}
