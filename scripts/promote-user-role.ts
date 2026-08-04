/**
 * Promoción segura de un usuario a un rol dado (típicamente 'owner' o
 * 'admin'), para habilitar acceso a /admin/*.
 *
 * Uso:
 *   npm run promote:user-role -- --email owner@agroscorelatam.com --role owner            (dry-run, no modifica nada)
 *   npm run promote:user-role -- --email owner@agroscorelatam.com --role owner --apply     (ejecuta el UPDATE)
 *
 * También acepta PROMOTE_EMAIL / PROMOTE_ROLE por env var en vez de flags.
 *
 * Reglas de diseño (mismo patrón que scripts/backfill-fields-user.ts):
 * - Dry-run por default: sin --apply solo audita e imprime lo que haría.
 * - Valida el rol contra la lista real de UserRole antes de tocar nada.
 * - Nunca borra filas. Solo hace UPDATE de users.role.
 * - Siempre imprime la query de reversión exacta, aplique o no.
 *
 * Esta es la única forma soportada de crear el primer owner/admin — no hay
 * ningún endpoint HTTP público que permita auto-promoverse un rol.
 */
import { AppDataSource } from '../src/data-source';
import { UserRole } from '../src/users/user-role.enum';

const VALID_ROLES = Object.values(UserRole);

function parseArgs(argv: string[]): {
  email?: string;
  role?: string;
  apply: boolean;
} {
  let email: string | undefined;
  let role: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') {
      email = argv[i + 1];
      i++;
    } else if (argv[i] === '--role') {
      role = argv[i + 1];
      i++;
    } else if (argv[i] === '--apply') {
      apply = true;
    }
  }

  return {
    email: email ?? process.env.PROMOTE_EMAIL,
    role: role ?? process.env.PROMOTE_ROLE,
    apply,
  };
}

async function main(): Promise<void> {
  const { email, role, apply } = parseArgs(process.argv.slice(2));

  if (!email || !role) {
    console.error(
      'Faltan parámetros. Uso:\n' +
        '  npm run promote:user-role -- --email owner@agroscorelatam.com --role owner [--apply]\n' +
        `Roles válidos: ${VALID_ROLES.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!VALID_ROLES.includes(role as UserRole)) {
    console.error(
      `Rol "${role}" inválido. Roles válidos: ${VALID_ROLES.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  await AppDataSource.initialize();

  try {
    const users = await AppDataSource.query(
      'SELECT id, email, "fullName", role, "isActive" FROM users WHERE email = $1',
      [normalizedEmail],
    );

    if (!users.length) {
      console.error(`No existe ningún usuario con email "${normalizedEmail}".`);
      process.exitCode = 1;
      return;
    }

    const user = users[0];
    console.log(
      `Usuario: ${user.email} (${user.fullName}) — id ${user.id}\n` +
        `Rol actual: ${user.role} | isActive: ${user.isActive}\n` +
        `Rol nuevo:  ${role}`,
    );

    const updateSql = `UPDATE users SET role = '${role}' WHERE id = '${user.id}';`;
    const revertSql = `UPDATE users SET role = '${user.role}' WHERE id = '${user.id}';`;

    console.log('\nQuery que se va a ejecutar:\n' + updateSql);
    console.log('\nQuery de reversión (guardala si necesitás deshacer esto):\n' + revertSql);

    if (!apply) {
      console.log(
        '\nDRY-RUN: no se modificó nada. Volvé a correr con --apply para ejecutar el UPDATE de arriba.',
      );
      return;
    }

    await AppDataSource.query('UPDATE users SET role = $1 WHERE id = $2', [
      role,
      user.id,
    ]);

    console.log(`\nUPDATE ejecutado. ${user.email} ahora tiene rol "${role}".`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Promoción falló:', error);
  process.exitCode = 1;
});
