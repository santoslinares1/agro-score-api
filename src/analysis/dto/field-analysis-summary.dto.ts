import { AnalysisScope, AnalysisStatus } from '../entities/analysis.entity';

/**
 * Resumen liviano de un Analysis para listados por campo: evita mandar el
 * resultJson completo (zones/timeseries/png) cuando solo hace falta mostrar
 * un historial.
 */
export type FieldAnalysisSummary = {
  id: string;
  status: AnalysisStatus;
  scope: AnalysisScope | null;
  fieldId: string | null;
  lotId: string | null;
  createdAt: Date;
  updatedAt: Date;
  globalScore: number;
  category: string;
  startDate: string;
  endDate: string;
  classificationScope: string | null;
  indexUsed: string | null;
  /**
   * F01: este resumen no trae resultJson completo (por diseño, ver el comentario de arriba), así
   * que se propaga esta única señal booleana en vez del objeto dataAvailability completo — mismo
   * criterio de compatibilidad hacia atrás que resultJson.dataAvailability ausente: true para
   * análisis previos a ese fix del worker (ver AnalysisService.findByField).
   */
  globalScoreAvailable: boolean;
};
