import { AnalysisScope, AnalysisStatus } from '../entities/analysis.entity';

/**
 * P0-A1 (auditoría de performance autenticada, 2026-09-15): resumen liviano de un Analysis para
 * el listado global (GET /analysis, usado por Dashboard y "Mis campos" para mostrar una tarjeta
 * por diagnóstico) — nunca trae resultJson (imageSeries/mapAssets en base64, hasta ~1.4MB por
 * análisis; 11,5MB medidos para 8 análisis de un único usuario de prueba). Mismo patrón que
 * FieldAnalysisSummary (findByField), aplicado acá por primera vez a findAll().
 */
export type AnalysisListItem = {
  id: string;
  status: AnalysisStatus;
  scope: AnalysisScope | null;
  fieldId: string | null;
  lotId: string | null;
  /**
   * Nombre visible del campo. Para análisis scope='field' se persiste en la creación como
   * field.name (ver AnalysisService.buildAnalysisInsertValues) — no requiere resultJson. Dashboard
   * y Fields ya tenían este mismo valor como su tercer fallback (después de mirar el Field ya
   * cargado por separado, y antes de resultJson.fieldName); ese fallback intermedio a
   * resultJson.fieldName se retira acá porque hubiera obligado a traer resultJson completo solo
   * para un caso borde que lotName ya cubre.
   */
  lotName: string;
  createdAt: Date;
  globalScore: number;
  category: string;
  /**
   * F01: misma señal explícita que FieldAnalysisSummary.globalScoreAvailable — ausente/null se
   * trata como disponible, solo `false` explícito en resultJson.dataAvailability.globalScore lo
   * marca no disponible. Nunca se deduce de globalScore===0 ni de category. Se deriva en la propia
   * consulta SQL vía un path JSONB puntual (ver AnalysisService.findAll) para no tener que
   * seleccionar resultJson completo solo por esta señal.
   */
  globalScoreAvailable: boolean;
};
