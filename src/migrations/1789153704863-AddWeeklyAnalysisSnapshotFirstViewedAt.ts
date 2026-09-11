import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-05 ("Monitoreo semanal consultado"): hasta acá no existía ninguna señal de
 * cuándo un usuario confirmó, por primera vez, que un WeeklyAnalysisSnapshot fue efectivamente
 * presentado como el destacado en la sección "Monitoreo semanal" de field-detail. Esta migración
 * solo agrega la columna nueva (aditiva, ver ticket) — NO toca `score`, `comparisonVsPrevious`,
 * `metrics` ni ninguna otra columna o tabla existente. Los snapshots preexistentes quedan con
 * `firstViewedAt = NULL` (sin cobertura histórica conocida, a propósito, nunca inferido desde
 * `updatedAt`, emails o GETs históricos — ver el ticket).
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones
 * ya aplicadas (mismo procedimiento que 1789150026874-AddAnalysisFirstPdfDownloadedAt), y editada
 * a mano para sacar el mismo DROP/CREATE INDEX de "UQ_analysis_client_request_per_field" que el
 * diff vuelve a proponer cada vez (índice parcial preexistente sin `@Index` en la entidad
 * Analysis, ya documentado en migraciones anteriores del repo) — sin relación con este cambio,
 * no se toca.
 */
export class AddWeeklyAnalysisSnapshotFirstViewedAt1789153704863 implements MigrationInterface {
  name = 'AddWeeklyAnalysisSnapshotFirstViewedAt1789153704863';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "weekly_analysis_snapshots" ADD "firstViewedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "weekly_analysis_snapshots" DROP COLUMN "firstViewedAt"`,
    );
  }
}
