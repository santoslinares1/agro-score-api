/**
 * Detección y clasificación de usuarios QA/test para
 * scripts/cleanup-test-data.ts (ver docs/admin-cleanup-test-data.md).
 *
 * Módulo puro a propósito: no importa AppDataSource ni nada de TypeORM, solo
 * recibe filas ya consultadas y devuelve una clasificación. Esto permite
 * testear el detector sin una base de datos real (ver
 * cleanup-test-data.rules.spec.ts) y reusar exactamente los mismos patrones
 * tanto para el WHERE de la query SQL como para la clasificación en memoria
 * — un solo lugar de verdad, sin riesgo de que ambos se desincronicen.
 */
import { UserRole } from '../users/user-role.enum';

export interface CandidateUserRow {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  createdAt: Date | string;
}

/**
 * - safe: matchea un patrón QA por email y no está protegido -> se incluye
 *   en el plan de borrado.
 * - blocked: matchea un patrón QA pero está protegido (dominio real u
 *   Owner/Admin) -> nunca se borra, se muestra como bloqueado.
 * - ambiguous: matchea SOLO por nombre (no por email) -> patrón no claro,
 *   requiere revisión manual y bloquea --confirm (ver runCleanup).
 * - excluded: email en la allowlist de protegidos explícitos -> ni siquiera
 *   se considera candidato.
 * - none: no matchea ningún patrón -> no debería llegar acá si la query SQL
 *   usa buildCandidateUserQuery(), pero classifyUser() lo contempla igual
 *   por si se llama a mano con una fila arbitraria.
 */
export type UserCleanupCategory =
  | 'safe'
  | 'blocked'
  | 'ambiguous'
  | 'excluded'
  | 'none';

export interface ClassifiedUser {
  row: CandidateUserRow;
  category: UserCleanupCategory;
  reasons: string[];
}

// --- Patrones QA/test (pedido explícito del ticket de limpieza) ---
export const QA_EMAIL_DOMAIN_SUFFIXES = ['@example.com'];
export const QA_EMAIL_SUBSTRINGS = [
  'dashboard-ux',
  'onboarding.',
  'auth2-check',
  'e2e',
];
export const QA_EMAIL_EXACT = ['usera@example.com', 'userb@example.com'];
export const QA_NAME_SUBSTRINGS = [
  'qa',
  'e2e',
  'test',
  'empty',
  'dashboard',
  'onboarding',
];

// --- Protección explícita: nunca se borran, pase lo que pase ---
export const PROTECTED_EMAILS = [
  'slinares@agroscorelatam.com',
  'no-reply@agroscorelatam.com',
  'contacto@agroscorelatam.com',
  'reportes@agroscorelatam.com',
];

export const PROTECTED_DOMAIN = '@agroscorelatam.com';

/**
 * Allowlist explícita para el caso (hoy inexistente) de un usuario
 * @agroscorelatam.com genuinamente de test que se quiera permitir borrar.
 * Vacía a propósito: agregar un email acá es una decisión humana consciente
 * al editar este archivo antes de correr --confirm, nunca algo que el
 * detector decida solo ni un flag de línea de comandos.
 */
export const QA_DOMAIN_ALLOWLIST_EMAILS: string[] = [];

const ADMIN_ROLES = new Set<string>([UserRole.OWNER, UserRole.ADMIN]);

function normalize(value: string): string {
  return (value ?? '').trim().toLowerCase();
}

export function matchEmailPattern(email: string): string[] {
  const lower = normalize(email);
  const reasons: string[] = [];
  for (const suffix of QA_EMAIL_DOMAIN_SUFFIXES) {
    if (lower.endsWith(suffix)) reasons.push(`email-domain:${suffix}`);
  }
  for (const substring of QA_EMAIL_SUBSTRINGS) {
    if (lower.includes(substring)) reasons.push(`email-substring:${substring}`);
  }
  if (QA_EMAIL_EXACT.map(normalize).includes(lower))
    reasons.push('email-exact-match');
  return reasons;
}

export function matchNamePattern(fullName: string): string[] {
  const lower = normalize(fullName);
  const reasons: string[] = [];
  for (const substring of QA_NAME_SUBSTRINGS) {
    if (lower.includes(substring)) reasons.push(`name-substring:${substring}`);
  }
  return reasons;
}

export function classifyUser(row: CandidateUserRow): ClassifiedUser {
  const email = normalize(row.email);

  if (PROTECTED_EMAILS.map(normalize).includes(email)) {
    return { row, category: 'excluded', reasons: ['protected-email'] };
  }

  const emailReasons = matchEmailPattern(row.email);
  const nameReasons = matchNamePattern(row.fullName);
  const reasons = [...emailReasons, ...nameReasons];

  const isProtectedDomain =
    email.endsWith(PROTECTED_DOMAIN) &&
    !QA_DOMAIN_ALLOWLIST_EMAILS.map(normalize).includes(email);
  const isAdminRole = ADMIN_ROLES.has(row.role);

  if (isProtectedDomain) {
    return {
      row,
      category: 'blocked',
      reasons: [...reasons, 'blocked:agroscorelatam-domain'],
    };
  }

  if (isAdminRole) {
    return {
      row,
      category: 'blocked',
      reasons: [...reasons, `blocked:role-${row.role}`],
    };
  }

  if (emailReasons.length > 0) {
    return { row, category: 'safe', reasons };
  }

  if (nameReasons.length > 0) {
    return {
      row,
      category: 'ambiguous',
      reasons: [...reasons, 'ambiguous:name-only-match'],
    };
  }

  return { row, category: 'none', reasons: [] };
}

export function classifyUsers(rows: CandidateUserRow[]): ClassifiedUser[] {
  return rows.map(classifyUser);
}

/**
 * WHERE parametrizado que matchea los mismos patrones de email que
 * matchEmailPattern(), para usar contra cualquier tabla con columna de
 * email (users, user_invitations, access_requests). `column` siempre es un
 * literal fijo pasado por nuestro propio código (nunca input externo), así
 * que interpolarlo en el SQL es seguro — los valores van parametrizados.
 */
export function buildEmailPatternWhereSql(column: string): {
  sql: string;
  params: string[];
} {
  const params: string[] = [];
  const conditions: string[] = [];

  for (const suffix of QA_EMAIL_DOMAIN_SUFFIXES) {
    params.push(`%${suffix}`);
    conditions.push(`"${column}" ILIKE $${params.length}`);
  }
  for (const substring of QA_EMAIL_SUBSTRINGS) {
    params.push(`%${substring}%`);
    conditions.push(`"${column}" ILIKE $${params.length}`);
  }
  for (const exact of QA_EMAIL_EXACT) {
    params.push(exact);
    conditions.push(`lower("${column}") = lower($${params.length})`);
  }

  return { sql: `(${conditions.join(' OR ')})`, params };
}

/**
 * Query de candidatos de `users`: mismos patrones de email +
 * QA_NAME_SUBSTRINGS sobre fullName. Deliberadamente amplia (OR de todo) —
 * la clasificación fina (safe/blocked/ambiguous) pasa después en
 * classifyUser(), esta query solo acota qué filas vale la pena traer de la
 * tabla completa de usuarios.
 */
export function buildCandidateUserQuery(): { sql: string; params: string[] } {
  const emailWhere = buildEmailPatternWhereSql('email');
  const params = [...emailWhere.params];
  const nameConditions: string[] = [];

  for (const substring of QA_NAME_SUBSTRINGS) {
    params.push(`%${substring}%`);
    nameConditions.push(`"fullName" ILIKE $${params.length}`);
  }

  const sql =
    'SELECT id, email, "fullName", role, "isActive", "createdAt" FROM users ' +
    `WHERE ${emailWhere.sql} OR ${nameConditions.join(' OR ')} ORDER BY "createdAt" ASC`;

  return { sql, params };
}
