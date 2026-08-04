import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-1: columnas nullable — los análisis viejos quedan con estos campos
// en NULL (no hay backfill posible, el dato no se guardaba antes). Migración
// segura: no reescribe filas existentes, `status` sigue siendo la fuente de
// verdad de estado.
export class AddAnalysisTimingFields1785848336702 implements MigrationInterface {
    name = 'AddAnalysisTimingFields1785848336702'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "analysis" ADD "startedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "completedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "failedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "durationMs" integer`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "errorMessage" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "errorMessage"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "durationMs"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "failedAt"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "completedAt"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "startedAt"`);
    }

}
