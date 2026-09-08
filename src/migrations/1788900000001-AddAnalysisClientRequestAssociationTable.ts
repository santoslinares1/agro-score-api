import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F04 (revisión independiente, ronda 4): la ronda 3 guardaba la asociación clientRequestId →
 * analysisId directamente en analysis.clientRequestId (una columna, un valor por fila) — eso
 * alcanza SOLO para la clave que efectivamente creó esa fila. Cuando una clave NUEVA reutiliza el
 * análisis 'Procesando' de OTRA acción (vía el fast-path por status, o vía el fallback del INSERT
 * atómico), esa reutilización nunca tenía dónde persistirse: la fila reutilizada ya tiene SU
 * PROPIA clientRequestId (o ninguna), y pisarla ahí rompería la asociación de quien la creó. Dos
 * revisiones independientes encontraron el resultado concreto: la asociación se perdía, y un
 * reintento posterior de esa clave nueva podía terminar creando OTRO análisis y disparando OTRO
 * Worker — exactamente lo que clientRequestId existe para evitar.
 *
 * La corrección es un modelo muchos-a-uno explícito: esta tabla permite que VARIAS claves
 * distintas apunten al MISMO analysisId, cada una con su propia fila, sin pisarse entre sí. Es la
 * fuente de verdad para "¿esta clave ya fue resuelta?" desde esta ronda (ver
 * AnalysisService.findClientRequestAssociation, el PRIMER chequeo de runFieldAnalysis cuando hay
 * clave) — analysis.clientRequestId (ronda 3) se deja de escribir para filas nuevas pero NO se
 * borra de la entidad ni del esquema: sigue siendo la fuente de verdad para las filas viejas que
 * esta migración lee para poblar la tabla nueva, así que ninguna asociación existente se pierde.
 *
 * Unicidad y atomicidad: PRIMARY KEY ("fieldId", "clientRequestId") es el target del INSERT ... ON
 * CONFLICT ... RETURNING de recordClientRequestAssociation — mismo mecanismo (un solo índice único
 * de Postgres, válido entre instancias, sin SELECT-then-INSERT) que UQ_analysis_running_per_field
 * desde la ronda 1. La FK sobre "analysisId" hace que, a nivel de esquema, sea imposible insertar
 * una asociación que apunte a una fila de analysis inexistente — no depende únicamente de que el
 * código nunca lo intente.
 *
 * fieldId acá es el fieldId literal (nunca requiere el COALESCE con lotId que usan los índices
 * sobre "analysis"): esta tabla es enteramente nueva, y clientRequestId solo lo acepta
 * runFieldAnalysis, que SIEMPRE inserta con scope='field' y fieldId real — nunca con el patrón
 * legacy scope=null/lotId-guarda-el-fieldId. El backfill de abajo, aun así, usa
 * COALESCE("fieldId","lotId") por prolijidad (coincide exactamente con lo que el índice de la
 * ronda 3 protegía) — en la práctica, para filas con clientRequestId no nulo, ambas expresiones
 * dan el mismo valor.
 */
export class AddAnalysisClientRequestAssociationTable1788900000001
  implements MigrationInterface
{
  name = 'AddAnalysisClientRequestAssociationTable1788900000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "analysis_client_request" (
        "fieldId" varchar NOT NULL,
        "clientRequestId" varchar NOT NULL,
        "analysisId" uuid NOT NULL REFERENCES "analysis"("id"),
        "createdAt" timestamp NOT NULL DEFAULT now(),
        PRIMARY KEY ("fieldId", "clientRequestId")
      )
    `);

    // Preserva las asociaciones ya existentes (ronda 3): una fila por cada Analysis que ya tenía
    // clientRequestId seteado — esa clave siempre apuntó, y sigue apuntando, a esa misma fila.
    // ON CONFLICT DO NOTHING es defensivo (no debería haber colisiones en una tabla recién creada);
    // no reconcilia nada, solo evita que una corrida repetida de esta migración falle.
    await queryRunner.query(`
      INSERT INTO "analysis_client_request" ("fieldId", "clientRequestId", "analysisId")
      SELECT COALESCE("fieldId", "lotId"), "clientRequestId", "id"
      FROM "analysis"
      WHERE "clientRequestId" IS NOT NULL
        AND ("scope" = 'field' OR "scope" IS NULL)
      ON CONFLICT DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "analysis_client_request"`);
  }
}
