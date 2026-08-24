import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateScheduledAnalysis1787403339340 implements MigrationInterface {
    name = 'CreateScheduledAnalysis1787403339340'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "field_analysis_schedules" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fieldId" uuid NOT NULL, "userId" uuid NOT NULL, "enabled" boolean NOT NULL DEFAULT true, "frequency" character varying NOT NULL DEFAULT 'weekly', "dayOfWeek" integer NOT NULL DEFAULT '1', "hour" integer NOT NULL DEFAULT '9', "minute" integer NOT NULL DEFAULT '0', "timezone" character varying NOT NULL DEFAULT 'America/Argentina/Cordoba', "analysisScope" character varying NOT NULL DEFAULT 'field', "includeMapAssets" boolean NOT NULL DEFAULT true, "includeIndexImages" boolean NOT NULL DEFAULT true, "includeImageSeries" boolean NOT NULL DEFAULT true, "lastAnalysisId" uuid, "lastRunAt" TIMESTAMP, "nextRunAt" TIMESTAMP, "lastStatus" character varying, "lastErrorMessage" text, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_29f7af9e302daa063235ae44f6b" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_field_analysis_schedules_field" ON "field_analysis_schedules"  ("fieldId") `);
        await queryRunner.query(`CREATE INDEX "IDX_1a61ec8d82c631a2c6f44ac965" ON "field_analysis_schedules"  ("nextRunAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_a731d14f1bfe4b3b4eb4df3513" ON "field_analysis_schedules"  ("enabled") `);
        await queryRunner.query(`CREATE INDEX "IDX_d5f55747a5e3d9c793c9b4f0ef" ON "field_analysis_schedules"  ("userId") `);
        await queryRunner.query(`CREATE TABLE "scheduled_analysis_runs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "scheduleId" uuid NOT NULL, "fieldId" uuid NOT NULL, "userId" uuid NOT NULL, "analysisId" uuid, "status" character varying NOT NULL DEFAULT 'pending', "scheduledFor" date NOT NULL, "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "emailSentAt" TIMESTAMP, "errorMessage" text, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_5b2e783b91b6711c15c090c13bf" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_scheduled_analysis_runs_schedule_week" ON "scheduled_analysis_runs"  ("scheduleId", "scheduledFor") `);
        await queryRunner.query(`CREATE INDEX "IDX_1afbf49367c14fbe5ee614b0be" ON "scheduled_analysis_runs"  ("scheduledFor") `);
        await queryRunner.query(`CREATE INDEX "IDX_44188f129edd3b76475c88b586" ON "scheduled_analysis_runs"  ("startedAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_57e5b425b63de16838368c3da6" ON "scheduled_analysis_runs"  ("createdAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_1b40392a008ad0b715516ae81e" ON "scheduled_analysis_runs"  ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_59fdc4a85e47c650a0d155982e" ON "scheduled_analysis_runs"  ("analysisId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d037fe419ada93ad731c888d04" ON "scheduled_analysis_runs"  ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0119cb9d5719ec589d15a8c2f9" ON "scheduled_analysis_runs"  ("fieldId") `);
        await queryRunner.query(`CREATE INDEX "IDX_5476d4ebf9ba31b1f0d07c13aa" ON "scheduled_analysis_runs"  ("scheduleId") `);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" ADD CONSTRAINT "FK_2dbad377bf04478d1fe55d3a655" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" ADD CONSTRAINT "FK_d5f55747a5e3d9c793c9b4f0efa" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" ADD CONSTRAINT "FK_4e6b9bc76e5a951efbb323deb3c" FOREIGN KEY ("lastAnalysisId") REFERENCES "analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" ADD CONSTRAINT "FK_5476d4ebf9ba31b1f0d07c13aaa" FOREIGN KEY ("scheduleId") REFERENCES "field_analysis_schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" ADD CONSTRAINT "FK_0119cb9d5719ec589d15a8c2f9c" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" ADD CONSTRAINT "FK_d037fe419ada93ad731c888d046" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" ADD CONSTRAINT "FK_59fdc4a85e47c650a0d155982e3" FOREIGN KEY ("analysisId") REFERENCES "analysis"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" DROP CONSTRAINT "FK_59fdc4a85e47c650a0d155982e3"`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" DROP CONSTRAINT "FK_d037fe419ada93ad731c888d046"`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" DROP CONSTRAINT "FK_0119cb9d5719ec589d15a8c2f9c"`);
        await queryRunner.query(`ALTER TABLE "scheduled_analysis_runs" DROP CONSTRAINT "FK_5476d4ebf9ba31b1f0d07c13aaa"`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" DROP CONSTRAINT "FK_4e6b9bc76e5a951efbb323deb3c"`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" DROP CONSTRAINT "FK_d5f55747a5e3d9c793c9b4f0efa"`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedules" DROP CONSTRAINT "FK_2dbad377bf04478d1fe55d3a655"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5476d4ebf9ba31b1f0d07c13aa"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0119cb9d5719ec589d15a8c2f9"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d037fe419ada93ad731c888d04"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_59fdc4a85e47c650a0d155982e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1b40392a008ad0b715516ae81e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_57e5b425b63de16838368c3da6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_44188f129edd3b76475c88b586"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1afbf49367c14fbe5ee614b0be"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_scheduled_analysis_runs_schedule_week"`);
        await queryRunner.query(`DROP TABLE "scheduled_analysis_runs"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d5f55747a5e3d9c793c9b4f0ef"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a731d14f1bfe4b3b4eb4df3513"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1a61ec8d82c631a2c6f44ac965"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_field_analysis_schedules_field"`);
        await queryRunner.query(`DROP TABLE "field_analysis_schedules"`);
    }

}
