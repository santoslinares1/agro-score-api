import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KPI review — instrumentación (ticket 3/3, "Modo de análisis solicitado no persistido",
 * RISK-024): agrega tres columnas nuevas (aditivas) — `analysis.requestedMapAssets`,
 * `analysis.requestedIndexImages`, `analysis.requestedImageSeries` — NO toca ninguna otra
 * columna/tabla existente. Sin backfill: no existe forma confiable de reconstruir qué se pidió
 * para un Analysis creado antes de este rollout (ver el docstring de las columnas en
 * Analysis). El único escritor es `AnalysisService.buildAnalysisInsertValues`, en el INSERT
 * inicial de cada Analysis nuevo — nunca esta migración, nunca ningún backfill heurístico desde
 * `resultJson`.
 *
 * Mismo procedimiento que las migraciones aditivas anteriores de esta tanda (ver
 * 1789164379685-AddUserLastLoginAt y las que la preceden).
 */
export class AddAnalysisRequestedAssetsFlags1789164871683
  implements MigrationInterface
{
  name = 'AddAnalysisRequestedAssetsFlags1789164871683';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" ADD "requestedMapAssets" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "analysis" ADD "requestedIndexImages" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "analysis" ADD "requestedImageSeries" boolean`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "requestedImageSeries"`,
    );
    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "requestedIndexImages"`,
    );
    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "requestedMapAssets"`,
    );
  }
}
