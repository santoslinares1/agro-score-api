/**
 * Baseline de la migración InitialSchema contra una DB que YA tiene ese
 * esquema aplicado por TypeORM `synchronize: true` (nuestro caso local:
 * AUTH-1 corrió con synchronize antes de que existieran migrations).
 *
 * Ejecutar el `up()` de InitialSchema ahí adentro fallaría ("relation
 * already exists"), porque las tablas ya están. Lo correcto en ese caso
 * (técnica estándar al adoptar migrations sobre una DB existente) es
 * marcar la migración como ya ejecutada en la tabla de tracking de
 * TypeORM, sin correr su SQL. Las migraciones que vengan después de esta
 * (como FieldsUserIdNotNull) sí corren de verdad con `migration:run`.
 *
 * Este script es idempotente: si ya está marcada, no hace nada.
 *
 * Uso:
 *   npm run migration:baseline
 */
import { AppDataSource } from '../src/data-source';
import { InitialSchema1785445140411 } from '../src/migrations/1785445140411-InitialSchema';

async function main(): Promise<void> {
  const migrationName = new InitialSchema1785445140411().name;
  const match = migrationName.match(/(\d+)$/);

  if (!match) {
    throw new Error(`No pude extraer el timestamp de "${migrationName}".`);
  }

  const timestamp = Number(match[1]);

  await AppDataSource.initialize();

  try {
    // Efecto secundario deliberado: showMigrations() crea la tabla
    // "migrations" con el mismo esquema que usa TypeORM internamente, si
    // todavía no existe — sin ejecutar ninguna migración.
    await AppDataSource.showMigrations();

    const existing = await AppDataSource.query(
      'SELECT id FROM migrations WHERE name = $1',
      [migrationName],
    );

    if (existing.length) {
      console.log(
        `"${migrationName}" ya estaba marcada como aplicada (id=${existing[0].id}). No hago nada.`,
      );
      return;
    }

    const tablesToCheck = ['users', 'fields', 'field_lots', 'lots', 'analysis'];
    const existingTables: string[] = (
      await AppDataSource.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [tablesToCheck],
      )
    ).map((row: { table_name: string }) => row.table_name);

    const missing = tablesToCheck.filter((t) => !existingTables.includes(t));

    if (missing.length) {
      throw new Error(
        `No hago el baseline: faltan tablas que "${migrationName}" debería crear (${missing.join(
          ', ',
        )}). Esta DB no matchea el supuesto de "ya sincronizada" — correr la migración de verdad en vez de baselinearla.`,
      );
    }

    await AppDataSource.query(
      'INSERT INTO migrations(timestamp, name) VALUES ($1, $2)',
      [timestamp, migrationName],
    );

    console.log(
      `Marcada "${migrationName}" (timestamp=${timestamp}) como ya aplicada. ` +
        'No se ejecutó ningún DDL: las tablas ya existían de antes (synchronize).',
    );
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('Baseline falló:', error);
  process.exitCode = 1;
});
