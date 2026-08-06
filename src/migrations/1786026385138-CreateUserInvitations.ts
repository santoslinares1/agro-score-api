import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-2: solo se persiste tokenHash (índice único para el lookup en
// accept-invitation) — el token crudo nunca toca la DB, ver
// src/auth/token.util.ts.
export class CreateUserInvitations1786026385138 implements MigrationInterface {
    name = 'CreateUserInvitations1786026385138'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "user_invitations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "role" character varying NOT NULL, "invitedByUserId" uuid, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "acceptedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c8005acb91c3ce9a7ae581eca8f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1bd83bea480593536e6549b666" ON "user_invitations"  ("tokenHash") `);
        await queryRunner.query(`ALTER TABLE "user_invitations" ADD CONSTRAINT "FK_4c48a15d8802fa02cad0928aef6" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "user_invitations" DROP CONSTRAINT "FK_4c48a15d8802fa02cad0928aef6"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1bd83bea480593536e6549b666"`);
        await queryRunner.query(`DROP TABLE "user_invitations"`);
    }

}
