import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * MEASUREMENT GAP P1-01 ("Dispatcher automático vs 'Ejecutar ahora'"): hasta acá,
 * `scheduled_analysis_runs` no distinguía si una fila la creó el dispatcher automático
 * (processDueSchedules) o "Ejecutar ahora" (runNow) — ambos convergen en
 * ScheduledAnalysisRunnerService.triggerRun y el origen se perdía. Esta migración solo agrega la
 * columna nueva (aditiva, ver ticket) — NO toca metadata, status, fechas ni ninguna otra columna
 * o tabla existente. Las filas preexistentes quedan con `triggerSource = NULL` (desconocido a
 * propósito, nunca un default como 'automatic_dispatcher' que mentiría sobre el histórico).
 *
 * Generada con `migration:generate` contra una base descartable con el resto de las migraciones ya
 * aplicadas (mismo procedimiento que 1789129703443-CreateFieldAnalysisScheduleStatusTransitions),
 * y editada a mano para sacar un DROP/CREATE INDEX de "UQ_analysis_client_request_per_field" que
 * el diff volvió a proponer por su cuenta — ese índice parcial preexistente (creado por SQL crudo
 * en 1788900000000-AddAnalysisClientRequestId, sin `@Index` en la entidad Analysis) no tiene
 * metadata que lo describa, así que TypeORM lo sigue marcando como "extra" cada vez que se
 * regenera un diff. Sin relación con este cambio — no se toca (ver "no sobrescribir cambios
 * ajenos" / "la migration no debe tocar objetos no relacionados" del ticket).
 */
export class AddScheduledAnalysisRunTriggerSource1789138907179 implements MigrationInterface {
  name = 'AddScheduledAnalysisRunTriggerSource1789138907179';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_analysis_runs" ADD "triggerSource" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a5145bb1c366ea91272815ea01" ON "scheduled_analysis_runs"  ("triggerSource") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a5145bb1c366ea91272815ea01"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_analysis_runs" DROP COLUMN "triggerSource"`,
    );
  }
}
