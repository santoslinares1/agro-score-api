import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-2: mismo criterio que user_invitations — solo tokenHash, nunca el
// token crudo. userId con FK CASCADE (a diferencia de las demás FKs de esta
// ficha): un reset token sin usuario dueño no tiene sentido.
export class CreatePasswordResetTokens1786026385139 implements MigrationInterface {
    name = 'CreatePasswordResetTokens1786026385139'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "password_reset_tokens" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid NOT NULL, "tokenHash" character varying NOT NULL, "expiresAt" TIMESTAMP NOT NULL, "usedAt" TIMESTAMP, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_d16bebd73e844c48bca50ff8d3d" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_1143abb8c3fad8b06dd857a8c9" ON "password_reset_tokens"  ("tokenHash") `);
        await queryRunner.query(`ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "FK_d6a19d4b4f6c62dcd29daa497e2" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "password_reset_tokens" DROP CONSTRAINT "FK_d6a19d4b4f6c62dcd29daa497e2"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_1143abb8c3fad8b06dd857a8c9"`);
        await queryRunner.query(`DROP TABLE "password_reset_tokens"`);
    }

}
