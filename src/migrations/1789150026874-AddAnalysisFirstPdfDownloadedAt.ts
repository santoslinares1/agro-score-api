import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-04 ("PDF descargado"): hasta acá no existía ninguna señal de cuándo el
 * servidor completó, por primera vez, una respuesta HTTP PDF autorizada para un Analysis. Esta
 * migración solo agrega la columna nueva (aditiva, ver ticket) — NO toca `status`, `resultJson`,
 * `firstResultViewedAt` (P1-03) ni ninguna otra columna o tabla existente. Los Analysis
 * preexistentes quedan con `firstPdfDownloadedAt = NULL` (sin cobertura histórica conocida, a
 * propósito, nunca inferido desde report preview/email/resultJson — ver el ticket).
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones
 * ya aplicadas (mismo procedimiento que 1789147059035-AddAnalysisFirstResultViewedAt), y editada
 * a mano para sacar el mismo DROP/CREATE INDEX de "UQ_analysis_client_request_per_field" que el
 * diff vuelve a proponer cada vez (índice parcial preexistente sin `@Index` en la entidad
 * Analysis, ya documentado en migraciones anteriores del repo) — sin relación con este cambio,
 * no se toca.
 */
export class AddAnalysisFirstPdfDownloadedAt1789150026874 implements MigrationInterface {
  name = 'AddAnalysisFirstPdfDownloadedAt1789150026874';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" ADD "firstPdfDownloadedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "firstPdfDownloadedAt"`,
    );
  }
}
