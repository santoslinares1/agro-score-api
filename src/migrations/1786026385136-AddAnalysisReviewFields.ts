import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-2: nullable + default seguro para analysis viejos (retryCount
// arranca en 0, el resto queda null hasta que se revise/reintente).
export class AddAnalysisReviewFields1786026385136 implements MigrationInterface {
    name = 'AddAnalysisReviewFields1786026385136'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "analysis" ADD "reviewedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "reviewedByUserId" uuid`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "retryCount" integer NOT NULL DEFAULT '0'`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD "lastRetriedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "analysis" ADD CONSTRAINT "FK_55b8505ecd037903a4d695e42fa" FOREIGN KEY ("reviewedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "analysis" DROP CONSTRAINT "FK_55b8505ecd037903a4d695e42fa"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "lastRetriedAt"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "retryCount"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "reviewedByUserId"`);
        await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "reviewedAt"`);
    }

}
