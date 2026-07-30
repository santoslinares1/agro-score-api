/**
 * Backfill puntual (Fase 7C) para Analysis viejos de campo que todavía usan
 * la convención pre-Fase-7A (fieldId guardado en lotId, scope/fieldId null).
 *
 * Regla: si scope IS NULL, fieldId IS NULL, resultJson.fieldId existe, y
 * lotId === resultJson.fieldId -> se actualiza a scope='field',
 * fieldId=resultJson.fieldId, lotId=null. Si lotId no coincide, se salta
 * (dato ambiguo) y se loguea para revisión manual. No borra nada, no toca
 * análisis de lote sin evidencia de ser de campo.
 *
 * Uso:
 *   npx ts-node scripts/backfill-field-analysis-scope.ts            (dry-run)
 *   npx ts-node scripts/backfill-field-analysis-scope.ts --apply    (aplica)
 *
 * Idempotente: una vez migrada, una fila deja de matchear el WHERE y no
 * vuelve a aparecer en corridas futuras.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';

function loadEnvFile(path: string): void {
  let content: string;

  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return; // sin .env en disco: se asume que las vars ya están en el entorno
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');

    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function run(): Promise<void> {
  loadEnvFile(join(__dirname, '..', '.env'));

  const apply = process.argv.includes('--apply');

  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await dataSource.initialize();

  try {
    const rows: Array<{ id: string; lotId: string | null; resultJson: any }> =
      await dataSource.query(
        `SELECT id, "lotId", "resultJson" FROM analysis WHERE scope IS NULL AND "fieldId" IS NULL`,
      );

    let candidateCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const skippedDetails: Array<{ id: string; lotId: string | null; resultFieldId: unknown }> = [];

    for (const row of rows) {
      const resultFieldId = row.resultJson?.fieldId;

      if (!resultFieldId) {
        continue; // sin evidencia de ser análisis de campo -> no es candidato
      }

      candidateCount++;

      if (row.lotId === resultFieldId) {
        updatedCount++;
        console.log(
          `[${apply ? 'APPLY' : 'DRY-RUN'}] Analysis ${row.id}: scope=null->'field', fieldId=null->'${resultFieldId}', lotId='${row.lotId}'->null`,
        );

        if (apply) {
          await dataSource.query(
            `UPDATE analysis SET scope = 'field', "fieldId" = $1, "lotId" = NULL WHERE id = $2`,
            [resultFieldId, row.id],
          );
        }
      } else {
        skippedCount++;
        skippedDetails.push({ id: row.id, lotId: row.lotId, resultFieldId });
        console.warn(
          `[SKIP] Analysis ${row.id}: lotId ('${row.lotId}') !== resultJson.fieldId ('${resultFieldId}') - dato ambiguo, no se toca.`,
        );
      }
    }

    console.log('--- Resumen backfill Analysis.scope/fieldId ---');
    console.log(`Modo: ${apply ? 'APLICADO' : 'DRY-RUN (sin cambios; correr con --apply para aplicar)'}`);
    console.log(`Filas con scope=null y fieldId=null revisadas: ${rows.length}`);
    console.log(`Candidatos con resultJson.fieldId presente: ${candidateCount}`);
    console.log(`Actualizados: ${updatedCount}`);
    console.log(`Saltados por ambigüedad: ${skippedCount}`);

    if (skippedDetails.length) {
      console.log('Detalle de saltados:', JSON.stringify(skippedDetails, null, 2));
    }
  } finally {
    await dataSource.destroy();
  }
}

run().catch((error) => {
  console.error('Error corriendo el backfill:', error);
  process.exit(1);
});
