import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-1: hasta ahora /access-request solo enviaba un email (ver
// docs/audits/access-request-flow.md); esta tabla es aditiva para que
// /admin/access-requests tenga historial. No toca el flujo de envío de mail.
export class CreateAccessRequests1785848336703 implements MigrationInterface {
    name = 'CreateAccessRequests1785848336703'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "access_requests" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "email" character varying NOT NULL, "organization" character varying NOT NULL, "profile" character varying NOT NULL, "estimatedSurface" character varying, "message" character varying, "status" character varying NOT NULL DEFAULT 'new', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_f89e51c15e3dbea13aa248fe128" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "access_requests"`);
    }

}
