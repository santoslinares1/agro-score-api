import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * PROFILE-SEC-1: agrega `tokenVersion` a `users` — contador de invalidación
 * de JWT usado por "cambiar contraseña" y "cerrar otras sesiones" en
 * /app/profile. JwtStrategy compara este valor contra el del payload
 * (tratando un payload sin el claim como 0, por compatibilidad con tokens
 * ya emitidos) — mismo criterio de "revalidar en cada request" que ya usa
 * `isActive` (ver AddUserRolesAndActive). DEFAULT 0 dejal columna
 * consistente con todos los usuarios existentes sin ningún backfill manual.
 */
export class AddUserTokenVersion1788555653620 implements MigrationInterface {
    name = 'AddUserTokenVersion1788555653620'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "tokenVersion" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "tokenVersion"`);
    }

}
