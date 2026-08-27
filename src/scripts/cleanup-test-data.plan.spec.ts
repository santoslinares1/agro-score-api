import {
  CleanupIds,
  buildDeletionPlan,
  emptyCleanupIds,
} from './cleanup-test-data.plan';

describe('cleanup-test-data.plan — buildDeletionPlan', () => {
  it('respeta el orden real de dependencias: hijos antes que padres', () => {
    const labels = buildDeletionPlan().map((step) => step.table);
    expect(labels).toEqual([
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
  });

  it('cada tabla hija aparece antes que su(s) tabla(s) padre', () => {
    const labels = buildDeletionPlan().map((step) => step.table);
    const indexOf = (t: string) => labels.indexOf(t);

    expect(indexOf('weekly_technical_verdicts')).toBeLessThan(
      indexOf('weekly_analysis_snapshots'),
    );
    expect(indexOf('weekly_lot_index_observations')).toBeLessThan(
      indexOf('weekly_field_reports'),
    );
    expect(indexOf('weekly_lot_index_observations')).toBeLessThan(
      indexOf('fields'),
    );
    expect(indexOf('scheduled_analysis_runs')).toBeLessThan(
      indexOf('field_analysis_schedules'),
    );
    expect(indexOf('analysis_technical_verdicts')).toBeLessThan(
      indexOf('analysis'),
    );
    expect(indexOf('field_lots')).toBeLessThan(indexOf('fields'));
    expect(indexOf('field_analysis_schedules')).toBeLessThan(indexOf('fields'));
    expect(indexOf('fields')).toBeLessThan(indexOf('users'));
    expect(indexOf('password_reset_tokens')).toBeLessThan(indexOf('users'));
  });

  it('devuelve null (no genera SQL) cuando el array de ids del que depende está vacío', () => {
    const ids = emptyCleanupIds();
    for (const step of buildDeletionPlan()) {
      expect(step.buildCountQuery(ids)).toBeNull();
      expect(step.buildDeleteQuery(ids)).toBeNull();
    }
  });

  it('genera SELECT COUNT en dry-run y DELETE...RETURNING en confirm con el MISMO predicado', () => {
    const ids: CleanupIds = {
      ...emptyCleanupIds(),
      fieldIds: ['field-1'],
    };

    const fieldsStep = buildDeletionPlan().find((s) => s.table === 'fields')!;
    const count = fieldsStep.buildCountQuery(ids)!;
    const del = fieldsStep.buildDeleteQuery(ids)!;

    expect(count.sql).toMatch(
      /^SELECT COUNT\(\*\)::int AS count FROM fields WHERE/,
    );
    expect(del.sql).toMatch(/^DELETE FROM fields WHERE/);
    expect(del.sql).toContain('RETURNING id');

    // mismo WHERE en ambos
    const whereOf = (sql: string) =>
      sql.split('WHERE')[1].replace('RETURNING id', '').trim();
    expect(whereOf(count.sql)).toBe(whereOf(del.sql));
    expect(count.params).toEqual(del.params);
  });

  it('el step de `analysis` castea a varchar[] (no tiene FK real, columnas sueltas)', () => {
    const ids: CleanupIds = {
      ...emptyCleanupIds(),
      fieldIds: ['field-1'],
      lotIds: ['lot-1'],
    };
    const analysisStep = buildDeletionPlan().find(
      (s) => s.table === 'analysis',
    )!;
    const query = analysisStep.buildCountQuery(ids)!;
    expect(query.sql).toContain('::varchar[]');
    expect(query.sql).toContain('"fieldId"');
    expect(query.sql).toContain('"lotId"');
  });

  it('user_invitations y access_requests filtran por id ya resuelto (match independiente por email)', () => {
    const ids: CleanupIds = {
      ...emptyCleanupIds(),
      invitationIds: ['inv-1'],
      accessRequestIds: ['ar-1'],
    };
    const invitationsStep = buildDeletionPlan().find(
      (s) => s.table === 'user_invitations',
    )!;
    const accessRequestsStep = buildDeletionPlan().find(
      (s) => s.table === 'access_requests',
    )!;

    expect(invitationsStep.buildDeleteQuery(ids)!.params).toEqual([['inv-1']]);
    expect(accessRequestsStep.buildDeleteQuery(ids)!.params).toEqual([
      ['ar-1'],
    ]);
  });
});
