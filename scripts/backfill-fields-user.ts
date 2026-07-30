/**
 * Backfill de ownership para fields legacy (userId NULL).
 *
 * Uso:
 *   npm run backfill:fields-user -- --email usera@example.com            (dry-run, no modifica nada)
 *   npm run backfill:fields-user -- --email usera@example.com --apply    (ejecuta el UPDATE)
 *
 * También acepta el email por env var BACKFILL_EMAIL en vez de --email.
 *
 * Reglas de diseño:
 * - Dry-run por default: sin --apply solo audita e imprime lo que haría.
 * - Usa la lista explícita de IDs auditada en este mismo run (no un
 *   `WHERE "userId" IS NULL` reevaluado al momento del UPDATE), para
 *   garantizar que se toque exactamente lo mostrado en el preview.
 * - Nunca borra filas ni columnas. Solo hace UPDATE de fields.userId.
 * - Siempre imprime la query de reversión exacta, aplique o no.
 */
import { AppDataSource } from '../src/data-source';

type FieldRow = {
  id: string;
  name: string;
  createdAt: string;
};

function parseArgs(argv: string[]): { email?: string; apply: boolean } {
  let email: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--email') {
      email = argv[i + 1];
      i++;
    } else if (argv[i] === '--apply') {
      apply = true;
    }
  }

  return { email: email ?? process.env.BACKFILL_EMAIL, apply };
}

async function main(): Promise<void> {
  const { email, apply } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error(
      'Falta el email del usuario destino. Uso:\n' +
        '  npm run backfill:fields-user -- --email usera@example.com [--apply]',
    );
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();

  await AppDataSource.initialize();

  try {
    const user = await AppDataSource.query(
      'SELECT id, email, "fullName" FROM users WHERE email = $1',
      [normalizedEmail],
    );

    if (!user.length) {
      console.error(`No existe ningún usuario con email "${normalizedEmail}".`);
      process.exitCode = 1;
      return;
    }

    const targetUserId: string = user[0].id;
    console.log(
      `Usuario destino: ${user[0].email} (${user[0].fullName}) — id ${targetUserId}\n`,
    );

    const totalsBefore = await AppDataSource.query(
      'SELECT COUNT(*) AS total, COUNT("userId") AS owned FROM fields',
    );
    console.log(
      `Estado actual: ${totalsBefore[0].total} fields totales, ` +
        `${totalsBefore[0].owned} con owner, ` +
        `${totalsBefore[0].total - totalsBefore[0].owned} sin owner.\n`,
    );

    const nullFields: FieldRow[] = await AppDataSource.query(
      'SELECT id, name, "createdAt" FROM fields WHERE "userId" IS NULL ORDER BY "createdAt" DESC',
    );

    if (!nullFields.length) {
      console.log(
        'No hay fields con userId NULL. No hace falta backfill — nada para hacer.',
      );
      return;
    }

    const ids = nullFields.map((f) => f.id);

    console.log(`Fields sin owner (${ids.length}):`);
    for (const field of nullFields) {
      console.log(`  - ${field.id}  ${field.name}  (createdAt=${field.createdAt})`);
    }

    const idList = ids.map((id) => `'${id}'`).join(',\n  ');

    const updateSql =
      `UPDATE fields SET "userId" = '${targetUserId}' WHERE id IN (\n  ${idList}\n);`;
    const revertSql =
      `UPDATE fields SET "userId" = NULL WHERE id IN (\n  ${idList}\n);`;

    console.log('\nQuery que se va a ejecutar:\n' + updateSql);
    console.log('\nQuery de reversión (guardala si necesitás deshacer esto):\n' + revertSql);

    if (!apply) {
      console.log(
        '\nDRY-RUN: no se modificó nada. Volvé a correr con --apply para ejecutar el UPDATE de arriba.',
      );
      return;
    }

    const result = await AppDataSource.query(
      'UPDATE fields SET "userId" = $1 WHERE id = ANY($2::uuid[])',
      [targetUserId, ids],
    );

    console.log(`\nUPDATE ejecutado. Filas afectadas: ${result[1]}.`);

    const totalsAfter = await AppDataSource.query(
      'SELECT COUNT(*) AS total, COUNT("userId") AS owned FROM fields',
    );
    console.log(
      `Estado final: ${totalsAfter[0].total} fields totales, ` +
        `${totalsAfter[0].owned} con owner, ` +
        `${totalsAfter[0].total - totalsAfter[0].owned} sin owner.`,
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Backfill falló:', error);
  process.exitCode = 1;
});
