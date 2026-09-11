import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Gap P0 (auditoría de KPIs — "denominador histórico de campos esperados"): hasta acá,
 * `field_analysis_schedules.enabled` vivía únicamente en la fila mutable del schedule
 * (unique(fieldId)) — cada activación/desactivación pisaba el mismo valor sin dejar rastro, así
 * que no había forma de reconstruir qué campos estuvieron habilitados en una semana pasada sin
 * inferirlo (incorrectamente) del `enabled`/`updatedAt` actuales. Esta migración solo agrega el
 * historial append-only nuevo — NO toca `field_analysis_schedules` ni `scheduled_analysis_runs`
 * (aditiva, ver ticket).
 *
 * Generada con `migration:generate` contra una base con el resto del esquema ya aplicado (para que
 * nombres de constraints/índices sigan exactamente la convención de TypeORM), y luego editada a
 * mano en dos puntos:
 *   1. se sacaron un DROP/CREATE INDEX de "UQ_analysis_client_request_per_field" que el diff
 *      propuso por su cuenta — ese índice parcial (creado por SQL crudo en
 *      1788900000000-AddAnalysisClientRequestId, nunca declarado con `@Index` en la entidad
 *      Analysis) no tiene metadata de entidad que lo describa, así que TypeORM lo mira como
 *      "extra" y lo marca para recrear. Preexistente y sin relación con este cambio — no se toca
 *      acá (ver "no sobrescribir cambios ajenos" del ticket).
 *   2. se agregó el backfill de baseline (`up`, al final) — `migration:generate` nunca propone
 *      datos, solo esquema.
 */
export class CreateFieldAnalysisScheduleStatusTransitions1789129703443 implements MigrationInterface {
    name = 'CreateFieldAnalysisScheduleStatusTransitions1789129703443'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "field_analysis_schedule_status_transitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "scheduleId" uuid NOT NULL, "fieldId" uuid NOT NULL, "enabled" boolean NOT NULL, "effectiveAt" TIMESTAMP NOT NULL, "source" character varying NOT NULL, "actorUserId" uuid, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_b3a948492fdbdd73fe5527b61b8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_a5ca761315755a5c43a0d78041" ON "field_analysis_schedule_status_transitions"  ("scheduleId", "effectiveAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_bfc81560aa102e9dcff4cfdd5d" ON "field_analysis_schedule_status_transitions"  ("effectiveAt") `);
        await queryRunner.query(`CREATE INDEX "IDX_5e2ec14ef5c220bcc97b07b0eb" ON "field_analysis_schedule_status_transitions"  ("fieldId") `);
        await queryRunner.query(`CREATE INDEX "IDX_8ca5e04e154afe7c637482e500" ON "field_analysis_schedule_status_transitions"  ("scheduleId") `);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" ADD CONSTRAINT "FK_8ca5e04e154afe7c637482e500a" FOREIGN KEY ("scheduleId") REFERENCES "field_analysis_schedules"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" ADD CONSTRAINT "FK_5e2ec14ef5c220bcc97b07b0eb1" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" ADD CONSTRAINT "FK_19e56313a10bc33e415641dee2f" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);

        // Baseline de rollout: UNA fila por schedule preexistente, marcada inequívocamente con
        // source='migration_baseline' (nunca 'schedule_upsert' — no se pasó por
        // FieldAnalysisScheduleService.upsert) y actorUserId NULL (no hay actor humano detrás de
        // esto). `effectiveAt` es el momento de ESTA migración (now(), constante dentro de la
        // transacción de la migración — un solo valor para todas las filas del backfill), nunca
        // `createdAt` del schedule: no se afirma que el estado actual rigiera desde la creación,
        // solo que es el estado conocido a partir de este instante. Antes de esta fila, el estado
        // histórico de cada schedule queda explícitamente desconocido — esta migración no
        // reconstruye transiciones pasadas.
        await queryRunner.query(`
            INSERT INTO "field_analysis_schedule_status_transitions"
                ("scheduleId", "fieldId", "enabled", "effectiveAt", "source", "actorUserId")
            SELECT "id", "fieldId", "enabled", now(), 'migration_baseline', NULL
            FROM "field_analysis_schedules"
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" DROP CONSTRAINT "FK_19e56313a10bc33e415641dee2f"`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" DROP CONSTRAINT "FK_5e2ec14ef5c220bcc97b07b0eb1"`);
        await queryRunner.query(`ALTER TABLE "field_analysis_schedule_status_transitions" DROP CONSTRAINT "FK_8ca5e04e154afe7c637482e500a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8ca5e04e154afe7c637482e500"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_5e2ec14ef5c220bcc97b07b0eb"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bfc81560aa102e9dcff4cfdd5d"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a5ca761315755a5c43a0d78041"`);
        await queryRunner.query(`DROP TABLE "field_analysis_schedule_status_transitions"`);
    }

}
