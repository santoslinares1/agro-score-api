import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 (revisión independiente, ronda 3): cierra la ventana que sobrevive incluso con el INSERT
 * atómico adelantado antes de getPipelineInput (ronda 2) — si la solicitud B completa su SELECT
 * inicial sin encontrar ningún 'Procesando', y para cuando B ejecuta su propio INSERT la
 * solicitud A (que arrancó después, pero corrió más rápido de punta a punta) ya terminó, el índice
 * UQ_analysis_running_per_field ya no cubre la fila de A — B inserta la suya, dos filas y dos
 * disparos al Worker para lo que, en el mundo real, pudo haber sido el mismo click reintentado por
 * el navegador, sin que la aplicación tenga forma de saberlo a partir de fieldId+fechas solamente.
 *
 * No existe forma de cerrar esa ventana con coordinación puramente basada en tiempo/estado sin
 * violar alguna de las restricciones ya establecidas (nada de mutex en memoria, nada de sleeps,
 * nada de ventanas temporales arbitrarias, nada de un lock sostenido durante todo el Worker): dos
 * escrituras cuyo ORDEN relativo en Postgres es lo único que el índice puede observar no alcanzan
 * para decidir si dos requests son "la misma acción reintentada" o dos acciones genuinamente
 * distintas — esa distinción vive en el cliente, no en la base. Ver el comentario extenso junto al
 * INSERT atómico en AnalysisService.runFieldAnalysis para el razonamiento completo.
 *
 * La extensión mínima de contrato que sí alcanza: dejar que el CALLER identifique su propia acción
 * con un clientRequestId opcional (RunFieldAnalysisDto.clientRequestId), generado una vez por
 * acción de usuario y reenviado tal cual si esa MISMA acción se reintenta. Con esa identidad, "¿ya
 * proceso este pedido?" deja de depender de en qué orden llegan los INSERT a Postgres: un segundo
 * INSERT con el MISMO (campo, clientRequestId) SIEMPRE encuentra la fila de la primera, sin
 * importar su status ni cuánto tiempo pasó — a diferencia de UQ_analysis_running_per_field, que
 * solo protege mientras la fila sigue 'Procesando'.
 *
 * Esto NO reemplaza al índice de status (que sigue protegiendo a callers sin clientRequestId,
 * comportamiento sin cambios) ni introduce deduplicación permanente por campo: una clave NUEVA
 * (una acción de usuario genuinamente distinta) nunca choca contra una clave vieja, así que un
 * reintento posterior legítimo sigue pudiendo crear un análisis nuevo con total normalidad — ver
 * los tests de "reintento posterior" en analysis-dedup-race.e2e-spec.ts.
 *
 * Nullable: sin dato para filas existentes ni para callers que no lo envían — su ausencia no activa
 * este índice (WHERE "clientRequestId" IS NOT NULL), así que no hay nada que reconciliar en datos
 * existentes (a diferencia de la migración de UQ_analysis_running_per_field).
 */
export class AddAnalysisClientRequestId1788900000000
  implements MigrationInterface
{
  name = 'AddAnalysisClientRequestId1788900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS: la entidad Analysis ya declara esta columna (ver analysis.entity.ts), así
    // que en cualquier bootstrap de test que use `synchronize: true` (crea el esquema a partir de
    // las entidades reales, no de las migraciones) la columna ya existe antes de llegar acá —
    // mismo patrón que el resto de las suites e2e de F04. Contra una base real sin `synchronize`
    // (el camino de producción), la columna todavía no existe y esto la crea con normalidad.
    await queryRunner.query(`
      ALTER TABLE "analysis" ADD COLUMN IF NOT EXISTS "clientRequestId" varchar NULL
    `);

    // Mismo alcance de "campo lógico" que UQ_analysis_running_per_field (fieldId nuevo o lotId
    // legacy con scope null) — la identidad de la solicitud es POR CAMPO: el mismo
    // clientRequestId para dos campos distintos son dos solicitudes distintas, no una.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_analysis_client_request_per_field"
      ON "analysis" (COALESCE("fieldId", "lotId"), "clientRequestId")
      WHERE "clientRequestId" IS NOT NULL AND ("scope" = 'field' OR "scope" IS NULL)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_analysis_client_request_per_field"`);
    await queryRunner.query(`ALTER TABLE "analysis" DROP COLUMN "clientRequestId"`);
  }
}
