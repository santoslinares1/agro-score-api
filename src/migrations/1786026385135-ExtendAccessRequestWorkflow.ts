import { MigrationInterface, QueryRunner } from "typeorm";

// ADMIN-2: columnas nullable/con default seguro — filas existentes de
// access_requests quedan válidas sin backfill. `status` sigue sin CHECK
// constraint en DB (ver AccessRequestStatus en la entity); los valores
// nuevos ('interested'/'converted') son solo aplicación, no requieren DDL.
export class ExtendAccessRequestWorkflow1786026385135 implements MigrationInterface {
    name = 'ExtendAccessRequestWorkflow1786026385135'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "access_requests" ADD "internalNotes" text`);
        await queryRunner.query(`ALTER TABLE "access_requests" ADD "assignedToUserId" uuid`);
        await queryRunner.query(`ALTER TABLE "access_requests" ADD "contactedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "access_requests" ADD "convertedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "access_requests" ADD "discardedAt" TIMESTAMP`);
        await queryRunner.query(`ALTER TABLE "access_requests" ADD CONSTRAINT "FK_5429236d08d5fbf62a9bf7b31e6" FOREIGN KEY ("assignedToUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "access_requests" DROP CONSTRAINT "FK_5429236d08d5fbf62a9bf7b31e6"`);
        await queryRunner.query(`ALTER TABLE "access_requests" DROP COLUMN "discardedAt"`);
        await queryRunner.query(`ALTER TABLE "access_requests" DROP COLUMN "convertedAt"`);
        await queryRunner.query(`ALTER TABLE "access_requests" DROP COLUMN "contactedAt"`);
        await queryRunner.query(`ALTER TABLE "access_requests" DROP COLUMN "assignedToUserId"`);
        await queryRunner.query(`ALTER TABLE "access_requests" DROP COLUMN "internalNotes"`);
    }

}
