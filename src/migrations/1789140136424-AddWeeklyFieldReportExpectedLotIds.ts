import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-02 ("Cobertura completa lote × índice"): hasta acá, `weekly_field_reports`
 * no conservaba qué lotes fueron efectivamente enviados a PythonWorkerService.runWeeklyReport —
 * solo `indices`. Esta migración solo agrega la columna nueva (aditiva, ver ticket) — NO toca
 * `indices`, `status`, fechas ni ninguna otra columna o tabla existente. Los reportes
 * preexistentes quedan con `expectedLotIds = NULL` (sin cobertura histórica conocida, a
 * propósito, nunca un backfill heurístico desde las observaciones existentes — ver el ticket).
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones
 * ya aplicadas (mismo procedimiento que 1789138907179-AddScheduledAnalysisRunTriggerSource), y
 * editada a mano para sacar el mismo DROP/CREATE INDEX de "UQ_analysis_client_request_per_field"
 * que el diff vuelve a proponer cada vez (índice parcial preexistente sin `@Index` en la entidad
 * Analysis, ya documentado en migraciones anteriores del repo) — sin relación con este cambio, no
 * se toca.
 */
export class AddWeeklyFieldReportExpectedLotIds1789140136424 implements MigrationInterface {
  name = 'AddWeeklyFieldReportExpectedLotIds1789140136424';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "weekly_field_reports" ADD "expectedLotIds" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "weekly_field_reports" DROP COLUMN "expectedLotIds"`,
    );
  }
}
