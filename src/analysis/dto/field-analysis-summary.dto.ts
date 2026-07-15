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
};
