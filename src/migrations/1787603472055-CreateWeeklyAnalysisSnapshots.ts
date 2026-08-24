import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWeeklyAnalysisSnapshots1787603472055 implements MigrationInterface {
    name = 'CreateWeeklyAnalysisSnapshots1787603472055'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "weekly_analysis_snapshots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fieldId" uuid NOT NULL, "userId" uuid NOT NULL, "analysisId" uuid, "scheduledRunId" uuid, "weekStart" date NOT NULL, "weekEnd" date NOT NULL, "source" character varying NOT NULL DEFAULT 'scheduled_analysis', "score" integer, "scoreLabel" character varying, "analyzedAreaHa" double precision, "lotCount" integer, "dominantZone" character varying, "dominantZonePercentage" double precision, "ndviMean" double precision, "ndmiMean" double precision, "hasRgbImage" boolean NOT NULL DEFAULT false, "hasNdviImage" boolean NOT NULL DEFAULT false, "hasNdmiImage" boolean NOT NULL DEFAULT false, "hasImageSeries" boolean NOT NULL DEFAULT false, "hasEnoughData" boolean NOT NULL DEFAULT false, "dataQualityStatus" character varying NOT NULL DEFAULT 'insufficient', "limitations" text, "comparisonVsPrevious" jsonb, "metrics" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4503fe8d8201e7982b895cfd6d7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_weekly_analysis_snapshots_field_week" ON "weekly_analysis_snapshots"  ("fieldId", "weekStart", "weekEnd") `);
        await queryRunner.query(`CREATE INDEX "IDX_fde0ebd5d41bda2af87bdc3cf9" ON "weekly_analysis_snapshots"  ("weekEnd") `);
        await queryRunner.query(`CREATE INDEX "IDX_27297391b08699aaeedcfa7cff" ON "weekly_analysis_snapshots"  ("weekStart") `);
        await queryRunner.query(`CREATE INDEX "IDX_daea883bd1f6c75b1b2b5fae54" ON "weekly_analysis_snapshots"  ("scheduledRunId") `);
        await queryRunner.query(`CREATE INDEX "IDX_94512ce69151eea58a80709d31" ON "weekly_analysis_snapshots"  ("analysisId") `);
        await queryRunner.query(`CREATE INDEX "IDX_2c31702e810f6a7b713e1c210f" ON "weekly_analysis_snapshots"  ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_42857d10ec73cb57267885d08f" ON "weekly_analysis_snapshots"  ("fieldId") `);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" ADD CONSTRAINT "FK_42857d10ec73cb57267885d08fa" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" ADD CONSTRAINT "FK_2c31702e810f6a7b713e1c210fb" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" ADD CONSTRAINT "FK_94512ce69151eea58a80709d31f" FOREIGN KEY ("analysisId") REFERENCES "analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" ADD CONSTRAINT "FK_daea883bd1f6c75b1b2b5fae544" FOREIGN KEY ("scheduledRunId") REFERENCES "scheduled_analysis_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" DROP CONSTRAINT "FK_daea883bd1f6c75b1b2b5fae544"`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" DROP CONSTRAINT "FK_94512ce69151eea58a80709d31f"`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" DROP CONSTRAINT "FK_2c31702e810f6a7b713e1c210fb"`);
        await queryRunner.query(`ALTER TABLE "weekly_analysis_snapshots" DROP CONSTRAINT "FK_42857d10ec73cb57267885d08fa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_42857d10ec73cb57267885d08f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_2c31702e810f6a7b713e1c210f"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_94512ce69151eea58a80709d31"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_daea883bd1f6c75b1b2b5fae54"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_27297391b08699aaeedcfa7cff"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_fde0ebd5d41bda2af87bdc3cf9"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_weekly_analysis_snapshots_field_week"`);
        await queryRunner.query(`DROP TABLE "weekly_analysis_snapshots"`);
    }

}
