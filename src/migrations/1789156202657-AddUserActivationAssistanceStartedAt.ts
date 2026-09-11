import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-06 ("Self-service frente a asistencia"): agrega la columna nueva
 * `users.activationAssistanceStartedAt` (aditiva) — NO toca ninguna otra columna/tabla existente.
 * Sin backfill: todo usuario preexistente queda con `activationAssistanceStartedAt = NULL`, que
 * NO significa "self-service" — significa "sin cobertura histórica" o "el equipo todavía no marcó
 * la asistencia", indistinguible a propósito (ver User.activationAssistanceStartedAt y el ticket
 * de origen). El único escritor de esta columna es el UPDATE set-once guardado por
 * `"activationAssistanceStartedAt" IS NULL` en UsersService.markActivationAssistanceStarted —
 * nunca esta migración, nunca ningún backfill heurístico.
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones ya
 * aplicadas (mismo procedimiento que 1789153704863-AddWeeklyAnalysisSnapshotFirstViewedAt y las
 * anteriores), y editada a mano para sacar el mismo DROP/CREATE INDEX de
 * "UQ_analysis_client_request_per_field" que el diff vuelve a proponer cada vez (índice parcial
 * preexistente sin `@Index` en la entidad Analysis, ya documentado en migraciones anteriores del
 * repo) — sin relación con este cambio, no se toca.
 */
export class AddUserActivationAssistanceStartedAt1789156202657 implements MigrationInterface {
  name = 'AddUserActivationAssistanceStartedAt1789156202657';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "activationAssistanceStartedAt" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "activationAssistanceStartedAt"`,
    );
  }
}
