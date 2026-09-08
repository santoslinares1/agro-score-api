import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 (revisión independiente, ronda 5): resolveOrCreateByClientRequestId (ver analysis.service.ts)
 * necesita, dentro de UNA sola transacción corta, reclamar la fila de analysis_client_request
 * ANTES de saber con certeza si la fila de Analysis a la que apunta (el id "candidato",
 * crypto.randomUUID() generado de antemano) va a terminar existiendo de verdad — puede que el
 * INSERT de Analysis choque contra UQ_analysis_running_per_field y la candidata nunca llegue a
 * insertarse, en cuyo caso la asociación se redirige al análisis real ANTES de confirmar. Todo
 * esto pasa en el mismo commit.
 *
 * La FK original (migración 1788900000001) se declaró NOT DEFERRABLE — el default de Postgres —
 * lo que hace que se valide de inmediato, sentencia por sentencia, no al confirmar la transacción.
 * Eso rompe exactamente el flujo de arriba: el INSERT de la asociación con el id candidato falla
 * ahí mismo con "violates foreign key constraint", porque en ESE instante la fila de Analysis con
 * ese id todavía no existe (se inserta recién en el paso siguiente, dentro de la misma
 * transacción).
 *
 * DEFERRABLE INITIALLY DEFERRED pospone la validación de esta FK al momento del COMMIT — para
 * entonces, la transacción ya insertó (o redirigió) todo lo necesario para que la asociación
 * apunte a una fila de Analysis real y existente. La ÚNICA tabla que escribe en
 * analysis_client_request es este mecanismo (ver AnalysisService.resolveOrCreateByClientRequestId
 * y la migración 1788900000001, cuyo backfill inserta contra filas de Analysis YA existentes, así
 * que el momento de validación no le cambia nada) — no hay otro caller para el que este cambio
 * relaje una garantía que estuviera usando.
 */
export class MakeAnalysisClientRequestForeignKeyDeferrable1788900000002
  implements MigrationInterface
{
  name = 'MakeAnalysisClientRequestForeignKeyDeferrable1788900000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "analysis_client_request"
      DROP CONSTRAINT IF EXISTS "analysis_client_request_analysisId_fkey"
    `);
    await queryRunner.query(`
      ALTER TABLE "analysis_client_request"
      ADD CONSTRAINT "analysis_client_request_analysisId_fkey"
      FOREIGN KEY ("analysisId") REFERENCES "analysis"("id")
      DEFERRABLE INITIALLY DEFERRED
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "analysis_client_request"
      DROP CONSTRAINT IF EXISTS "analysis_client_request_analysisId_fkey"
    `);
    await queryRunner.query(`
      ALTER TABLE "analysis_client_request"
      ADD CONSTRAINT "analysis_client_request_analysisId_fkey"
      FOREIGN KEY ("analysisId") REFERENCES "analysis"("id")
    `);
  }
}
