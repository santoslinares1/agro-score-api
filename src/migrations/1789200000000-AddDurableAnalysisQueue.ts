import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ADR-001: cola durable de análisis (PostgreSQL + pg-boss con outbox). Migración ADITIVA:
 *
 * 1. `analysis."inputSnapshot"` (jsonb, nullable) — snapshot inmutable del input capturado al
 *    encolar. Sin backfill: los análisis históricos quedan con null (no se inventa un input que no
 *    se guardó).
 * 2. `UQ_analysis_running_per_field` pasa a cubrir `Queued` Y `Procesando` (como máximo un Analysis
 *    activo por campo lógico). El swap ocurre DENTRO de la transacción de la migración: se crea el
 *    índice nuevo con nombre temporal, se borra el viejo y se renombra — en ningún instante
 *    visible para otra transacción el campo queda sin protección de unicidad. El predicado
 *    `status = 'Procesando'` que todavía usa la versión anterior de la API en su ON CONFLICT sigue
 *    infiriendo este índice (Postgres prueba que implica `status IN ('Queued','Procesando')`), así
 *    que la API anterior tolera el esquema expandido.
 * 3. `analysis_job_outbox` — intención durable de ejecución (solo IDs/metadata de entrega).
 * 4. `analysis_attempt` — intentos de ejecución del consumidor.
 *
 * Precheck: si ya existiera más de un Analysis activo por campo lógico, la migración ABORTA con un
 * mensaje explícito en vez de modificar datos (a diferencia de 1788829462102, no se "resuelve"
 * nada automáticamente: con el índice vigente eso no debería ser posible, así que un duplicado es
 * una anomalía que un humano tiene que mirar). No convierte históricos 'Procesando' en 'Queued' ni
 * inventa intentos.
 *
 * `analysis.status` es varchar sin CHECK: agregar 'Queued' no requiere DDL.
 *
 * down(): solo es seguro en una base SIN trabajo durable pendiente — aborta si existe algún
 * Analysis 'Queued' o algún 'Procesando' con inputSnapshot (no hay forma de reconstruir su
 * ejecución en el camino legacy). Si pasa ese guard, borra outbox/intentos (se pierde el historial
 * de entrega: irreversible), restaura el predicado original del índice y borra inputSnapshot (se
 * pierde el input auditado de análisis ya terminados: irreversible). En producción el rollback
 * operativo NO usa down() — ver docs/analysis-queue.md.
 */
export class AddDurableAnalysisQueue1789200000000 implements MigrationInterface {
  name = 'AddDurableAnalysisQueue1789200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const duplicates = (await queryRunner.query(`
      SELECT COALESCE("fieldId", "lotId") AS "logicalFieldId", COUNT(*)::int AS count
      FROM "analysis"
      WHERE "status" IN ('Queued', 'Procesando')
        AND ("scope" = 'field' OR "scope" IS NULL)
      GROUP BY COALESCE("fieldId", "lotId")
      HAVING COUNT(*) > 1
    `)) as Array<{ logicalFieldId: string; count: number }>;

    if (duplicates.length > 0) {
      throw new Error(
        `AddDurableAnalysisQueue: hay ${duplicates.length} campo(s) con más de un Analysis activo ` +
          `(Queued/Procesando): ${duplicates
            .slice(0, 10)
            .map((row) => row.logicalFieldId)
            .join(', ')}. Resolverlo manualmente antes de migrar.`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "analysis" ADD COLUMN "inputSnapshot" jsonb`,
    );

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_active_per_field_tmp"
      ON "analysis" (COALESCE("fieldId", "lotId"))
      WHERE "status" IN ('Queued', 'Procesando') AND ("scope" = 'field' OR "scope" IS NULL)
    `);
    await queryRunner.query(`DROP INDEX "UQ_analysis_running_per_field"`);
    await queryRunner.query(
      `ALTER INDEX "UQ_analysis_active_per_field_tmp" RENAME TO "UQ_analysis_running_per_field"`,
    );

    await queryRunner.query(`
      CREATE TABLE "analysis_job_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "analysisId" uuid NOT NULL,
        "jobType" varchar NOT NULL,
        "payloadVersion" integer NOT NULL,
        "payload" jsonb NOT NULL,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        "dispatchedAt" timestamp,
        "jobId" uuid,
        "dispatchAttempts" integer NOT NULL DEFAULT 0,
        "lastDispatchError" varchar(500),
        "lockedAt" timestamp,
        "abandonedAt" timestamp,
        CONSTRAINT "PK_analysis_job_outbox" PRIMARY KEY ("id"),
        CONSTRAINT "FK_analysis_job_outbox_analysis" FOREIGN KEY ("analysisId")
          REFERENCES "analysis"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_analysis_job_outbox_dispatched_has_job"
          CHECK ("dispatchedAt" IS NULL OR "jobId" IS NOT NULL),
        CONSTRAINT "CHK_analysis_job_outbox_not_dispatched_and_abandoned"
          CHECK ("dispatchedAt" IS NULL OR "abandonedAt" IS NULL)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_job_outbox_analysis_job_type"
      ON "analysis_job_outbox" ("analysisId", "jobType")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_analysis_job_outbox_pending"
      ON "analysis_job_outbox" ("createdAt")
      WHERE "dispatchedAt" IS NULL AND "abandonedAt" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "analysis_attempt" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "analysisId" uuid NOT NULL,
        "jobId" uuid NOT NULL,
        "attemptNumber" integer NOT NULL,
        "startedAt" timestamp NOT NULL,
        "heartbeatAt" timestamp,
        "finishedAt" timestamp,
        "outcome" varchar NOT NULL,
        "errorCode" varchar,
        "errorMessage" varchar(500),
        "retryable" boolean,
        "durationMs" integer,
        "workerVersion" varchar,
        "createdAt" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "PK_analysis_attempt" PRIMARY KEY ("id"),
        CONSTRAINT "FK_analysis_attempt_analysis" FOREIGN KEY ("analysisId")
          REFERENCES "analysis"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_analysis_attempt_number_positive" CHECK ("attemptNumber" >= 1),
        CONSTRAINT "CHK_analysis_attempt_outcome" CHECK ("outcome" IN (
          'running', 'succeeded', 'superseded', 'failed_retryable', 'failed_terminal', 'lease_lost'
        )),
        CONSTRAINT "CHK_analysis_attempt_finished_iff_not_running"
          CHECK (("outcome" = 'running') = ("finishedAt" IS NULL))
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_attempt_job_attempt"
      ON "analysis_attempt" ("jobId", "attemptNumber")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_attempt_running_per_analysis"
      ON "analysis_attempt" ("analysisId")
      WHERE "outcome" = 'running'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_analysis_attempt_analysis_started"
      ON "analysis_attempt" ("analysisId", "startedAt")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const pending = (await queryRunner.query(`
      SELECT COUNT(*)::int AS count
      FROM "analysis"
      WHERE "status" = 'Queued'
         OR ("status" = 'Procesando' AND "inputSnapshot" IS NOT NULL)
    `)) as Array<{ count: number }>;

    if (Number(pending[0]?.count ?? 0) > 0) {
      throw new Error(
        'AddDurableAnalysisQueue.down: existen análisis con ejecución durable pendiente ' +
          '(Queued, o Procesando con inputSnapshot). Drenarlos o cerrarlos explícitamente antes de ' +
          'revertir: el camino legacy no puede reconstruir su ejecución.',
      );
    }

    await queryRunner.query(`DROP TABLE "analysis_attempt"`);
    await queryRunner.query(`DROP TABLE "analysis_job_outbox"`);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_running_per_field_tmp"
      ON "analysis" (COALESCE("fieldId", "lotId"))
      WHERE "status" = 'Procesando' AND ("scope" = 'field' OR "scope" IS NULL)
    `);
    await queryRunner.query(`DROP INDEX "UQ_analysis_running_per_field"`);
    await queryRunner.query(
      `ALTER INDEX "UQ_analysis_running_per_field_tmp" RENAME TO "UQ_analysis_running_per_field"`,
    );

    await queryRunner.query(
      `ALTER TABLE "analysis" DROP COLUMN "inputSnapshot"`,
    );
  }
}
