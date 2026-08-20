import { AnalysisScope, AnalysisStatus } from '../entities/analysis.entity';

/**
 * PERF-2: proyección liviana de Analysis para GET /analysis/:id/status — pensada para el
 * polling del frontend mientras un análisis está 'Procesando'. Nunca incluye resultJson (ni
 * ningún campo derivado de él, como mapAssets/imageSeries/zones): AnalysisService.findOneOwnedStatus
 * ni siquiera lo selecciona de la base de datos, no es solo que se omita al armar la respuesta.
 */
export type AnalysisStatusDto = {
  id: string;
  status: AnalysisStatus;
  scope: AnalysisScope | null;
  fieldId: string | null;
  lotId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
  globalScore: number;
  productivityScore: number;
  stabilityScore: number;
  confidenceScore: number;
};
