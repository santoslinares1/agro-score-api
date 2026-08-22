import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWeeklyReports1787357251748 implements MigrationInterface {
    name = 'CreateWeeklyReports1787357251748'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "weekly_lot_index_observations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "weeklyReportId" uuid NOT NULL, "fieldId" uuid NOT NULL, "lotId" uuid, "lotName" character varying, "index" character varying NOT NULL, "experimental" boolean NOT NULL DEFAULT false, "available" boolean NOT NULL, "weekAnchorDate" date NOT NULL, "imageDate" date, "cloudPct" numeric, "scaleM" numeric, "mean" numeric, "stdDev" numeric, "min" numeric, "max" numeric, "validPixelCount" integer, "deltaVsPrevious" numeric, "deltaDirection" character varying, "unavailableReason" text, "metadata" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_4c2456b9be3a4923a32cd2a3b52" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_d1cba292c2bd13f6756074d510" ON "weekly_lot_index_observations"  ("lotId", "index", "weekAnchorDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_0cc0ab1cf440e13422fb254ac0" ON "weekly_lot_index_observations"  ("fieldId", "index", "weekAnchorDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_8090544df400274ca3340faf72" ON "weekly_lot_index_observations"  ("weekAnchorDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_7480fdf8e40abc007c4ea64a57" ON "weekly_lot_index_observations"  ("index") `);
        await queryRunner.query(`CREATE INDEX "IDX_779743b2aabf1bc2e9624468c4" ON "weekly_lot_index_observations"  ("lotId") `);
        await queryRunner.query(`CREATE INDEX "IDX_3565210bb1440b2d1c9489af8a" ON "weekly_lot_index_observations"  ("fieldId") `);
        await queryRunner.query(`CREATE INDEX "IDX_da26d324b784c4b1eab966ec66" ON "weekly_lot_index_observations"  ("weeklyReportId") `);
        await queryRunner.query(`CREATE TABLE "weekly_field_reports" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fieldId" uuid NOT NULL, "userId" uuid, "campaignStart" date NOT NULL, "campaignEnd" date, "targetDate" date NOT NULL, "weekAnchorDate" date NOT NULL, "stepDays" integer NOT NULL DEFAULT '7', "methodologyVersion" character varying NOT NULL DEFAULT 'weekly-v1', "status" character varying NOT NULL DEFAULT 'pending', "source" character varying NOT NULL DEFAULT 'manual', "includeNdreExperimental" boolean NOT NULL DEFAULT false, "indices" jsonb NOT NULL, "warnings" jsonb, "errorMessage" text, "startedAt" TIMESTAMP, "completedAt" TIMESTAMP, "failedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_7ab6af217d3eb88317c52ad759f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "UQ_weekly_field_reports_field_week_version" ON "weekly_field_reports"  ("fieldId", "weekAnchorDate", "methodologyVersion") WHERE "status" <> 'failed'`);
        await queryRunner.query(`CREATE INDEX "IDX_33d7a807de02bc8635c17a29a1" ON "weekly_field_reports"  ("fieldId", "weekAnchorDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_31c0b8eb2384cbe1ec5d7eb8e1" ON "weekly_field_reports"  ("status") `);
        await queryRunner.query(`CREATE INDEX "IDX_008f755cc0afd06e83d123bcb8" ON "weekly_field_reports"  ("weekAnchorDate") `);
        await queryRunner.query(`CREATE INDEX "IDX_0beb57c0179888d82eb4d5adeb" ON "weekly_field_reports"  ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_96ae92424b66569a3992a50f30" ON "weekly_field_reports"  ("fieldId") `);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" ADD CONSTRAINT "FK_da26d324b784c4b1eab966ec660" FOREIGN KEY ("weeklyReportId") REFERENCES "weekly_field_reports"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" ADD CONSTRAINT "FK_3565210bb1440b2d1c9489af8a4" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" ADD CONSTRAINT "FK_779743b2aabf1bc2e9624468c4f" FOREIGN KEY ("lotId") REFERENCES "field_lots"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_field_reports" ADD CONSTRAINT "FK_96ae92424b66569a3992a50f309" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "weekly_field_reports" ADD CONSTRAINT "FK_0beb57c0179888d82eb4d5adebd" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "weekly_field_reports" DROP CONSTRAINT "FK_0beb57c0179888d82eb4d5adebd"`);
        await queryRunner.query(`ALTER TABLE "weekly_field_reports" DROP CONSTRAINT "FK_96ae92424b66569a3992a50f309"`);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" DROP CONSTRAINT "FK_779743b2aabf1bc2e9624468c4f"`);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" DROP CONSTRAINT "FK_3565210bb1440b2d1c9489af8a4"`);
        await queryRunner.query(`ALTER TABLE "weekly_lot_index_observations" DROP CONSTRAINT "FK_da26d324b784c4b1eab966ec660"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_96ae92424b66569a3992a50f30"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0beb57c0179888d82eb4d5adeb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_008f755cc0afd06e83d123bcb8"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_31c0b8eb2384cbe1ec5d7eb8e1"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_33d7a807de02bc8635c17a29a1"`);
        await queryRunner.query(`DROP INDEX "public"."UQ_weekly_field_reports_field_week_version"`);
        await queryRunner.query(`DROP TABLE "weekly_field_reports"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_da26d324b784c4b1eab966ec66"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_3565210bb1440b2d1c9489af8a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_779743b2aabf1bc2e9624468c4"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7480fdf8e40abc007c4ea64a57"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8090544df400274ca3340faf72"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0cc0ab1cf440e13422fb254ac0"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_d1cba292c2bd13f6756074d510"`);
        await queryRunner.query(`DROP TABLE "weekly_lot_index_observations"`);
    }

}
