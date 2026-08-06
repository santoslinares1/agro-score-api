import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-2: tabla nueva, append-only. `actorUserId` con FK ON DELETE SET
// NULL — nunca debería dispararse (los usuarios no se borran físicamente)
// pero da integridad referencial gratis. `targetType`/`targetId` son
// polimórficos a propósito (user/access_request/analysis/invitation), sin
// FK posible ahí.
export class CreateAdminAuditLogs1786026385137 implements MigrationInterface {
    name = 'CreateAdminAuditLogs1786026385137'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "admin_audit_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "actorUserId" uuid, "action" character varying NOT NULL, "targetType" character varying NOT NULL, "targetId" character varying, "before" jsonb, "after" jsonb, "ip" character varying, "userAgent" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_de7a8fc2fbb525484c71a86bb96" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "FK_3066f3a8f1bceb8eb51d48fa479" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "admin_audit_logs" DROP CONSTRAINT "FK_3066f3a8f1bceb8eb51d48fa479"`);
        await queryRunner.query(`DROP TABLE "admin_audit_logs"`);
    }

}
