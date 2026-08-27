import {
  CandidateUserRow,
  buildCandidateUserQuery,
  buildEmailPatternWhereSql,
  classifyUser,
} from './cleanup-test-data.rules';

function makeUser(overrides: Partial<CandidateUserRow>): CandidateUserRow {
  return {
    id: 'user-1',
    email: 'someone@example.com',
    fullName: 'Someone',
    role: 'user',
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cleanup-test-data.rules — classifyUser', () => {
  // 1. Detecta @example.com
  it('detecta emails @example.com como safe', () => {
    const result = classifyUser(makeUser({ email: 'usera@example.com' }));
    expect(result.category).toBe('safe');
    expect(result.reasons.some((r) => r.includes('@example.com'))).toBe(true);
  });

  // 2. Detecta dashboard-ux
  it('detecta emails que contienen dashboard-ux como safe', () => {
    const result = classifyUser(
      makeUser({
        email: 'qa.dashboard-ux@qa-runner.dev',
        fullName: 'QA Runner',
      }),
    );
    expect(result.category).toBe('safe');
    expect(result.reasons.some((r) => r.includes('dashboard-ux'))).toBe(true);
  });

  // 3. Detecta onboarding.
  it('detecta emails que contienen onboarding. como safe', () => {
    const result = classifyUser(
      makeUser({
        email: 'tester.onboarding.flow@qa-runner.dev',
        fullName: 'Tester',
      }),
    );
    expect(result.category).toBe('safe');
    expect(result.reasons.some((r) => r.includes('onboarding.'))).toBe(true);
  });

  // 4. Detecta e2e / auth2-check
  it('detecta emails que contienen e2e como safe', () => {
    const result = classifyUser(
      makeUser({ email: 'runner-e2e@qa-runner.dev' }),
    );
    expect(result.category).toBe('safe');
    expect(result.reasons.some((r) => r.includes('e2e'))).toBe(true);
  });

  it('detecta emails que contienen auth2-check como safe', () => {
    const result = classifyUser(
      makeUser({ email: 'flow.auth2-check@qa-runner.dev' }),
    );
    expect(result.category).toBe('safe');
    expect(result.reasons.some((r) => r.includes('auth2-check'))).toBe(true);
  });

  it('detecta las direcciones exactas usera@example.com / userb@example.com', () => {
    expect(
      classifyUser(makeUser({ email: 'usera@example.com' })).category,
    ).toBe('safe');
    expect(
      classifyUser(makeUser({ email: 'userb@example.com' })).category,
    ).toBe('safe');
  });

  it('detecta nombres que contienen QA/E2E/Test/Empty/Dashboard/Onboarding como ambiguous cuando el email no matchea', () => {
    const names = [
      'QA Bot',
      'E2E Runner',
      'Test User',
      'Empty Field Owner',
      'Dashboard Tester',
      'Onboarding Flow',
    ];
    for (const fullName of names) {
      const result = classifyUser(
        makeUser({ email: 'random@some-real-domain.com', fullName }),
      );
      expect(result.category).toBe('ambiguous');
    }
  });

  // 5. No detecta emails reales
  it('NO detecta usuarios reales (email y nombre sin patrón QA)', () => {
    const result = classifyUser(
      makeUser({
        email: 'productor.real@estanciaelsauce.com.ar',
        fullName: 'Carlos Gómez',
        role: 'user',
      }),
    );
    expect(result.category).toBe('none');
  });

  // 6. Bloquea @agroscorelatam.com
  it('bloquea cualquier email @agroscorelatam.com que matchee un patrón QA', () => {
    const result = classifyUser(
      makeUser({ email: 'qa.e2e@agroscorelatam.com', fullName: 'QA Interno' }),
    );
    expect(result.category).toBe('blocked');
    expect(result.reasons).toContain('blocked:agroscorelatam-domain');
  });

  it('excluye (ni siquiera reporta como candidato distinto) los emails protegidos explícitos', () => {
    const result = classifyUser(
      makeUser({ email: 'no-reply@agroscorelatam.com', fullName: 'Sistema' }),
    );
    expect(result.category).toBe('excluded');
  });

  // 7. Bloquea Owner/Admin
  it('bloquea usuarios con rol owner que matcheen un patrón QA', () => {
    const result = classifyUser(
      makeUser({
        email: 'e2e.owner@qa-runner.dev',
        fullName: 'E2E Owner',
        role: 'owner',
      }),
    );
    expect(result.category).toBe('blocked');
    expect(result.reasons).toContain('blocked:role-owner');
  });

  it('bloquea usuarios con rol admin que matcheen un patrón QA', () => {
    const result = classifyUser(
      makeUser({
        email: 'dashboard-ux.admin@qa-runner.dev',
        fullName: 'Admin QA',
        role: 'admin',
      }),
    );
    expect(result.category).toBe('blocked');
    expect(result.reasons).toContain('blocked:role-admin');
  });

  it('un usuario "user" normal (no owner/admin) con email QA no se bloquea', () => {
    const result = classifyUser(
      makeUser({ email: 'usera@example.com', role: 'user' }),
    );
    expect(result.category).toBe('safe');
  });
});

describe('cleanup-test-data.rules — SQL builders', () => {
  it('buildEmailPatternWhereSql arma un WHERE parametrizado sobre la columna pedida', () => {
    const { sql, params } = buildEmailPatternWhereSql('email');
    expect(sql).toContain('"email" ILIKE');
    expect(sql).toContain('lower("email") = lower(');
    expect(params.length).toBeGreaterThan(0);
    expect(params).toContain('%@example.com');
  });

  it('buildCandidateUserQuery incluye columnas esperadas y patrones de nombre', () => {
    const { sql, params } = buildCandidateUserQuery();
    expect(sql).toContain('FROM users');
    expect(sql).toContain('"fullName" ILIKE');
    expect(sql).toContain('ORDER BY "createdAt" ASC');
    expect(params).toContain('%qa%');
    expect(params).toContain('%test%');
  });
});
