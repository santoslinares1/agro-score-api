import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * KPI review — instrumentación (ticket 2/3, "Recurrencia real de usuario"): agrega la columna
 * nueva `users.lastLoginAt` (aditiva) — NO toca ninguna otra columna/tabla existente. Sin
 * backfill: no existe ningún registro histórico de logins pasados en ningún repo, así que todo
 * usuario preexistente queda con `lastLoginAt = NULL`. El único escritor de esta columna es el
 * UPDATE always-overwrite en `UsersService.recordLogin`, llamado desde `AuthService.login()`
 * tras un login exitoso — nunca esta migración, nunca ningún backfill heurístico.
 *
 * Mismo procedimiento que las migraciones aditivas anteriores de esta tanda (ver
 * 1789156202657-AddUserActivationAssistanceStartedAt y las que la preceden).
 */
export class AddUserLastLoginAt1789164379685 implements MigrationInterface {
  name = 'AddUserLastLoginAt1789164379685';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "lastLoginAt" TIMESTAMP`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lastLoginAt"`);
  }
}
