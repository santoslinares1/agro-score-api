import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAnalysisTechnicalVerdicts1787696465873 implements MigrationInterface {
  name = 'CreateAnalysisTechnicalVerdicts1787696465873';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "analysis_technical_verdicts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "analysisId" uuid NOT NULL, "status" character varying NOT NULL, "verdict" character varying, "confidence" character varying, "summary" text, "keyFindings" jsonb, "possibleCauses" jsonb, "recommendations" jsonb, "limitations" jsonb, "inputSnapshot" jsonb, "generator" character varying NOT NULL, "promptVersion" character varying, "errorMessage" character varying, "generatedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9a4d2a07180739ce3d9f8d984aa" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_analysis_technical_verdicts_analysis" ON "analysis_technical_verdicts"  ("analysisId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "analysis_technical_verdicts" ADD CONSTRAINT "FK_d2c60564a48f10b4caa2d84c2ba" FOREIGN KEY ("analysisId") REFERENCES "analysis"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "analysis_technical_verdicts" DROP CONSTRAINT "FK_d2c60564a48f10b4caa2d84c2ba"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."UQ_analysis_technical_verdicts_analysis"`,
    );
    await queryRunner.query(`DROP TABLE "analysis_technical_verdicts"`);
  }
}
