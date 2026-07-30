import { MigrationInterface, QueryRunner } from "typeorm";

export class FieldsUserIdNotNull1785445240864 implements MigrationInterface {
    name = 'FieldsUserIdNotNull1785445240864'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "fields" DROP CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b"`);
        await queryRunner.query(`ALTER TABLE "fields" ALTER COLUMN "userId" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "fields" ADD CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "fields" DROP CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b"`);
        await queryRunner.query(`ALTER TABLE "fields" ALTER COLUMN "userId" DROP NOT NULL`);
        await queryRunner.query(`ALTER TABLE "fields" ADD CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
