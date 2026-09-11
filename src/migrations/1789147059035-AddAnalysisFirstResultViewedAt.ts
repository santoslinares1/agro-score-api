import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-03 ("Resultado técnico consultado"): hasta acá no existía ninguna señal de
 * cuándo un usuario con ownership recibió y aceptó el resultado completo de un Analysis
 * 'Finalizado' en la pantalla principal — `completedAt` mide entrega técnica del pipeline, no
 * consulta humana. Esta migración solo agrega la columna nueva (aditiva, ver ticket) — NO toca
 * `status`, `completedAt`, `resultJson` ni ninguna otra columna o tabla existente. Los Analysis
 * preexistentes quedan con `firstResultViewedAt = NULL` (sin cobertura histórica conocida, a
 * propósito, nunca inferido desde completedAt/snapshot/PDF/email — ver el ticket).
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones
 * ya aplicadas (mismo procedimiento que 1789140136424-AddWeeklyFieldReportExpectedLotIds), y
 * editada a mano para sacar el mismo DROP/CREATE INDEX de "UQ_analysis_client_request_per_field"
 * que el diff vuelve a proponer cada vez (índice parcial preexistente sin `@Index` en la entidad
 * Analysis, ya documentado en migraciones anteriores del repo) — sin relación con este cambio, no
 * se toca.
 */
export class AddAnalysisFirstResultViewedAt1789147059035 implements MigrationInterface {
  name = 'AddAnalysisFirstResultViewedAt1789147059035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" ADD "firstResultViewedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "firstResultViewedAt"`,
    );
  }
}
