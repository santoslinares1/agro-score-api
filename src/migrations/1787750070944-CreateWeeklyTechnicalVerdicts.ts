import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWeeklyTechnicalVerdicts1787750070944 implements MigrationInterface {
  name = 'CreateWeeklyTechnicalVerdicts1787750070944';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "weekly_technical_verdicts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "snapshotId" uuid NOT NULL, "analysisId" uuid, "scheduledRunId" uuid, "status" character varying NOT NULL, "verdict" character varying, "trend" character varying, "confidence" character varying, "summary" text, "keyChanges" jsonb, "areasToReview" jsonb, "recommendations" jsonb, "limitations" jsonb, "previousSnapshotId" uuid, "inputSnapshot" jsonb, "generator" character varying NOT NULL, "promptVersion" character varying, "errorMessage" text, "generatedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_0bc879fdc364537236488c102d1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_weekly_technical_verdicts_snapshot" ON "weekly_technical_verdicts"  ("snapshotId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" ADD CONSTRAINT "FK_fbc4ecc386139bdccce025c427a" FOREIGN KEY ("snapshotId") REFERENCES "weekly_analysis_snapshots"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" ADD CONSTRAINT "FK_cd76174a015508c33da9d4e8796" FOREIGN KEY ("analysisId") REFERENCES "analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" ADD CONSTRAINT "FK_340c6965de8525a5607a27eac1d" FOREIGN KEY ("scheduledRunId") REFERENCES "scheduled_analysis_runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" DROP CONSTRAINT "FK_340c6965de8525a5607a27eac1d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" DROP CONSTRAINT "FK_cd76174a015508c33da9d4e8796"`,
    );
    await queryRunner.query(
      `ALTER TABLE "weekly_technical_verdicts" DROP CONSTRAINT "FK_fbc4ecc386139bdccce025c427a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_weekly_technical_verdicts_snapshot"`,
    );
    await queryRunner.query(`DROP TABLE "weekly_technical_verdicts"`);
  }
}
