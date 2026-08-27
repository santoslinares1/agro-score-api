/**
 * Plan de borrado ordenado para scripts/cleanup-test-data.ts.
 *
 * Módulo puro: no ejecuta nada, solo construye SQL. El orden de los pasos
 * está derivado del diagnóstico real de FKs (ver
 * docs/admin-cleanup-test-data.md, sección "Diagnóstico del modelo de
 * datos"), no asumido:
 *
 *   weekly_technical_verdicts    -> CASCADE en snapshotId
 *   weekly_lot_index_observations-> CASCADE en weeklyReportId y fieldId
 *   weekly_analysis_snapshots    -> CASCADE en fieldId y userId
 *   weekly_field_reports         -> CASCADE en fieldId (userId es SET NULL)
 *   scheduled_analysis_runs      -> CASCADE en scheduleId, fieldId, userId
 *   field_analysis_schedules     -> CASCADE en fieldId y userId
 *   analysis_technical_verdicts  -> CASCADE en analysisId
 *   analysis                     -> SIN FK real (fieldId/lotId son varchar
 *                                    sueltos, ver analysis.entity.ts) —
 *                                    match manual por igualdad de string,
 *                                    nunca se puede confiar en un cascade acá
 *   field_lots                   -> CASCADE en fieldId
 *   password_reset_tokens        -> CASCADE en userId
 *   user_invitations             -> sin FK obligatoria a users (email
 *                                    propio), match independiente
 *   access_requests              -> sin FK obligatoria a users (email
 *                                    propio), match independiente
 *   fields                       -> CASCADE en userId
 *   users                        -> raíz, siempre al final
 *
 * A propósito NO se usa `DELETE FROM users` esperando que el CASCADE de la
 * DB se encargue del resto: analysis no tiene FK real (se perdería sin
 * borrar explícitamente) y la consigna pide evitar cascades ciegas — cada
 * paso es explícito, auditable y usa el MISMO predicado para contar
 * (dry-run) y borrar (confirm), así no hay forma de que el conteo mostrado
 * difiera de lo que realmente se borra.
 */

export interface CleanupIds {
  userIds: string[];
  fieldIds: string[];
  lotIds: string[];
  analysisIds: string[];
  scheduleIds: string[];
  scheduledRunIds: string[];
  snapshotIds: string[];
  weeklyReportIds: string[];
  invitationIds: string[];
  accessRequestIds: string[];
}

export function emptyCleanupIds(): CleanupIds {
  return {
    userIds: [],
    fieldIds: [],
    lotIds: [],
    analysisIds: [],
    scheduleIds: [],
    scheduledRunIds: [],
    snapshotIds: [],
    weeklyReportIds: [],
    invitationIds: [],
    accessRequestIds: [],
  };
}

export interface SqlQuery {
  sql: string;
  params: unknown[];
}

export interface CleanupStep {
  label: string;
  table: string;
  buildCountQuery: (ids: CleanupIds) => SqlQuery | null;
  buildDeleteQuery: (ids: CleanupIds) => SqlQuery | null;
}

interface ColumnMatch {
  column: string;
  idsKey: keyof CleanupIds;
  /** Tipo real de la columna en Postgres, para el cast de ANY($n::tipo[]). */
  cast: 'uuid[]' | 'varchar[]';
}

function orColumnsStep(
  label: string,
  table: string,
  columns: ColumnMatch[],
): CleanupStep {
  const build = (ids: CleanupIds, forDelete: boolean): SqlQuery | null => {
    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const column of columns) {
      const values = ids[column.idsKey];
      if (!values.length) continue;
      params.push(values);
      conditions.push(
        `"${column.column}" = ANY($${params.length}::${column.cast})`,
      );
    }

    if (!conditions.length) return null;

    const where = conditions.join(' OR ');
    const sql = forDelete
      ? `DELETE FROM ${table} WHERE ${where} RETURNING id`
      : `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${where}`;

    return { sql, params };
  };

  return {
    label,
    table,
    buildCountQuery: (ids) => build(ids, false),
    buildDeleteQuery: (ids) => build(ids, true),
  };
}

/** Orden de borrado real, hijos antes que padres. Ver comentario de arriba. */
export function buildDeletionPlan(): CleanupStep[] {
  return [
    orColumnsStep('Weekly technical verdicts', 'weekly_technical_verdicts', [
      { column: 'snapshotId', idsKey: 'snapshotIds', cast: 'uuid[]' },
    ]),
    orColumnsStep(
      'Weekly lot index observations',
      'weekly_lot_index_observations',
      [
        { column: 'weeklyReportId', idsKey: 'weeklyReportIds', cast: 'uuid[]' },
        { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
      ],
    ),
    orColumnsStep('Weekly analysis snapshots', 'weekly_analysis_snapshots', [
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
      { column: 'userId', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Weekly field reports', 'weekly_field_reports', [
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
      { column: 'userId', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Scheduled analysis runs', 'scheduled_analysis_runs', [
      { column: 'scheduleId', idsKey: 'scheduleIds', cast: 'uuid[]' },
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
      { column: 'userId', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Field analysis schedules', 'field_analysis_schedules', [
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
      { column: 'userId', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
    orColumnsStep(
      'Analysis technical verdicts',
      'analysis_technical_verdicts',
      [{ column: 'analysisId', idsKey: 'analysisIds', cast: 'uuid[]' }],
    ),
    orColumnsStep('Analysis', 'analysis', [
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'varchar[]' },
      { column: 'lotId', idsKey: 'lotIds', cast: 'varchar[]' },
    ]),
    orColumnsStep('Field lots', 'field_lots', [
      { column: 'fieldId', idsKey: 'fieldIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Password reset tokens', 'password_reset_tokens', [
      { column: 'userId', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('User invitations (match por email QA)', 'user_invitations', [
      { column: 'id', idsKey: 'invitationIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Access requests (match por email QA)', 'access_requests', [
      { column: 'id', idsKey: 'accessRequestIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Fields', 'fields', [
      { column: 'id', idsKey: 'fieldIds', cast: 'uuid[]' },
    ]),
    orColumnsStep('Users', 'users', [
      { column: 'id', idsKey: 'userIds', cast: 'uuid[]' },
    ]),
  ];
}
