/**
 * Limpieza segura de datos QA/test en producción.
 *
 * Ver docs/admin-cleanup-test-data.md para el detalle completo (por qué
 * existe, qué borra, qué bloquea, checklist antes de producción).
 *
 * Uso:
 *   npm run cleanup:test-data                    (dry-run, no borra nada)
 *   npm run cleanup:test-data -- --dry-run        (dry-run explícito, igual al default)
 *   npm run cleanup:test-data -- --confirm        (ejecuta el borrado real)
 *
 * Reglas de diseño (ver cleanup-test-data.core.ts / .rules.ts / .plan.ts):
 * - Dry-run por default: sin --confirm nunca se abre una transacción de
 *   escritura, pase lo que pase.
 * - Todo el detector/planificador vive en módulos puros sin AppDataSource
 *   (.rules.ts, .plan.ts, .core.ts) para poder testearlos sin DB real — este
 *   archivo es el ÚNICO que abre una conexión real, y nunca lo importa
 *   ningún .spec.ts.
 * - Todo el borrado corre dentro de una única transacción
 *   (AppDataSource.transaction): si cualquier paso falla, se hace rollback
 *   completo, no queda un borrado parcial.
 * - No se usa cascade ciego de la DB: cada tabla se borra explícitamente en
 *   el orden real de sus FKs (ver cleanup-test-data.plan.ts), incluyendo
 *   `analysis`, que NO tiene FK real a fields/lots (columnas varchar
 *   sueltas) y por lo tanto un cascade de la DB nunca la tocaría.
 * - Nunca toca `.env` ni ninguna variable de entorno — reusa AppDataSource
 *   tal cual está configurado hoy para migraciones/otros scripts.
 */
import { AppDataSource } from '../data-source';
import {
  CleanupDb,
  parseArgs,
  printReport,
  runCleanup,
} from './cleanup-test-data.core';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await AppDataSource.initialize();

  try {
    const db: CleanupDb = {
      query: (sql, params) => AppDataSource.query(sql, params),
      transaction: (fn) =>
        AppDataSource.transaction((manager) =>
          fn({ query: (sql, params) => manager.query(sql, params) }),
        ),
    };

    const report = await runCleanup(db, args);
    printReport(report);

    if (args.confirm && !report.executed) {
      // Había advertencias bloqueantes y no se ejecutó nada — el reporte ya
      // lo explica arriba, pero el exit code también debe reflejarlo para
      // que un pipeline/operador no lo confunda con un confirm exitoso.
      process.exitCode = 1;
    }
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error) => {
  console.error('cleanup-test-data falló:', error);
  process.exitCode = 1;
});
