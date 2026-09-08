import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 (auditoría): cierra la carrera de deduplicación de AnalysisService.runFieldAnalysis —
 * antes, "¿ya hay un análisis 'Procesando' para este campo?" era un SELECT sin exclusión, sin
 * nada que impidiera que dos requests concurrentes lo pasaran ambas antes de que cualquiera
 * guardara su Analysis, terminando en dos filas 'Procesando' y dos disparos al Worker para el
 * mismo campo.
 *
 * Este índice único parcial es la única garantía real: Postgres serializa las dos INSERT
 * concurrentes a nivel del índice (una espera a que la otra confirme o revierta), y si la primera
 * confirmó, la segunda falla con unique_violation (23505) — AnalysisService la atrapa y reutiliza
 * la fila ganadora en vez de propagar el error (ver isUniqueViolation/runFieldAnalysis).
 *
 * Alcance exacto (mismo criterio que ya usaba el SELECT de la aplicación, no uno nuevo/más
 * amplio): como máximo una fila con status='Procesando' por "campo lógico" —
 * COALESCE("fieldId", "lotId") — considerando tanto los análisis nuevos (scope='field', fieldId
 * seteado) como los legacy (scope IS NULL, que reutilizaban lotId para guardar el fieldId; ver el
 * comentario de findByField en analysis.service.ts). Los análisis scope='lot' (legacy, no
 * relacionados a un campo) NO quedan cubiertos por este índice — no se amplía la deduplicación a
 * un caso que hoy no la tiene. Cualquier cantidad de filas en estados terminales
 * (Finalizado/Error) por campo sigue permitida sin límite: el índice es parcial, solo mira
 * status='Procesando'.
 *
 * Tratamiento de datos existentes: si ya hubiera más de un 'Procesando' para el mismo campo
 * (residuo del propio bug que este índice cierra), crear el índice fallaría. El UPDATE de abajo
 * lo resuelve ANTES de crear el índice: conserva como 'Procesando' solo la fila más reciente
 * (createdAt DESC) por campo y marca las demás 'Error' con un mensaje explícito — mismo criterio
 * de "duplicado obsoleto → Error, el usuario puede reintentar" que ya usa
 * AnalysisService.failStaleAnalysis para análisis stale, no una regla nueva. No se tocan filas en
 * otro status. En una base sin el bug (el caso esperado), este UPDATE no afecta ninguna fila.
 *
 * Reversibilidad: `down()` solo borra el índice — no revierte el UPDATE de datos (no hay forma de
 * saber cuál de las filas marcadas Error "debería" volver a Procesando, y dejar un análisis
 * fantasma en Procesando sin un Worker corriendo detrás sería peor). Downgrade seguro en el
 * sentido de que el esquema vuelve a como estaba; los datos ya reconciliados no vuelven atrás.
 *
 * No se ejecutó esta migración contra ninguna base real como parte de esta ficha — ver la entrega
 * de F04 para la verificación contra una base de pruebas aislada y descartable.
 */
export class AddRunningAnalysisPerFieldUniqueIndex1788829462102
  implements MigrationInterface
{
  name = 'AddRunningAnalysisPerFieldUniqueIndex1788829462102';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "analysis" a
      SET "status" = 'Error',
          "errorMessage" = 'Marcado automáticamente como duplicado concurrente al aplicar la migración de deduplicación (F04).',
          "failedAt" = now()
      WHERE a."status" = 'Procesando'
        AND (a."scope" = 'field' OR a."scope" IS NULL)
        AND a."id" <> (
          SELECT a2."id"
          FROM "analysis" a2
          WHERE COALESCE(a2."fieldId", a2."lotId") = COALESCE(a."fieldId", a."lotId")
            AND a2."status" = 'Procesando'
            AND (a2."scope" = 'field' OR a2."scope" IS NULL)
          ORDER BY a2."createdAt" DESC, a2."id" DESC
          LIMIT 1
        )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_running_per_field"
      ON "analysis" (COALESCE("fieldId", "lotId"))
      WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_analysis_running_per_field"`);
  }
}
