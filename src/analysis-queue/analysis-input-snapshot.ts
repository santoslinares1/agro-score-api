/**
 * ADR-001 (decisión de producto, opción 1): snapshot inmutable del input agronómico, capturado al
 * encolar y persistido en Analysis.inputSnapshot dentro de la MISMA transacción que crea el
 * Analysis y su fila de outbox. Todos los intentos y reintentos usan exactamente este snapshot —
 * nunca se reconstruye desde el Field vigente. Ediciones posteriores del campo (redibujar,
 * agregar/borrar lotes, cambiar inclusión) no se bloquean y solo afectan análisis futuros.
 *
 * Contiene GeoJSON: vive SOLO en la tabla analysis — nunca en analysis_job_outbox ni en el payload
 * del job de pg-boss, y nunca se loguea.
 */
export const ANALYSIS_INPUT_SNAPSHOT_VERSION = 1;

export type AnalysisInputSnapshotLot = {
  id: string;
  name: string;
  geojson: unknown;
  areaHa: number;
  includeInProductivityClassification: boolean;
};

export type AnalysisInputSnapshot = {
  snapshotVersion: 1;
  capturedAt: string;
  field: {
    fieldId: string;
    name: string;
    location?: string;
    totalAreaHa?: number;
  };
  lots: AnalysisInputSnapshotLot[];
  request: {
    startDate: string;
    endDate: string;
    maxCloudiness: number;
    indices: string[] | null;
    zoneIndices: string[] | null;
    indexImageIndices: string[] | null;
    includeMapAssets: boolean | null;
    includeIndexImages: boolean | null;
    includeImageSeries: boolean | null;
    maxZoneCampaigns: number | null;
  };
};

export type AnalysisRequestParameters = {
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  indices?: string[];
  zoneIndices?: string[];
  indexImageIndices?: string[];
  includeMapAssets?: boolean;
  includeIndexImages?: boolean;
  includeImageSeries?: boolean;
  maxZoneCampaigns?: number;
};

export type FieldPipelineInputLike = {
  fieldId: string;
  name: string;
  location?: string;
  totalAreaHa?: number;
  lots: AnalysisInputSnapshotLot[];
};

/**
 * Copia profunda vía JSON: el snapshot no comparte referencias con entidades TypeORM ni con el
 * objeto devuelto por FieldsService, así que nada que mute esas instancias después puede alterar
 * lo que se persiste.
 */
export function buildAnalysisInputSnapshot(
  pipelineInput: FieldPipelineInputLike,
  request: AnalysisRequestParameters,
  capturedAt: Date = new Date(),
): AnalysisInputSnapshot {
  const snapshot: AnalysisInputSnapshot = {
    snapshotVersion: ANALYSIS_INPUT_SNAPSHOT_VERSION,
    capturedAt: capturedAt.toISOString(),
    field: {
      fieldId: pipelineInput.fieldId,
      name: pipelineInput.name,
      ...(pipelineInput.location !== undefined &&
      pipelineInput.location !== null
        ? { location: pipelineInput.location }
        : {}),
      ...(pipelineInput.totalAreaHa !== undefined &&
      pipelineInput.totalAreaHa !== null
        ? { totalAreaHa: pipelineInput.totalAreaHa }
        : {}),
    },
    lots: pipelineInput.lots.map((lot) => ({
      id: lot.id,
      name: lot.name,
      geojson: lot.geojson,
      areaHa: lot.areaHa,
      includeInProductivityClassification:
        lot.includeInProductivityClassification,
    })),
    request: {
      startDate: request.startDate,
      endDate: request.endDate,
      maxCloudiness: request.maxCloudiness,
      indices: request.indices ?? null,
      zoneIndices: request.zoneIndices ?? null,
      indexImageIndices: request.indexImageIndices ?? null,
      includeMapAssets: request.includeMapAssets ?? null,
      includeIndexImages: request.includeIndexImages ?? null,
      includeImageSeries: request.includeImageSeries ?? null,
      maxZoneCampaigns: request.maxZoneCampaigns ?? null,
    },
  };

  return JSON.parse(JSON.stringify(snapshot)) as AnalysisInputSnapshot;
}

export function isSupportedAnalysisInputSnapshot(
  value: unknown,
): value is AnalysisInputSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshot = value as Partial<AnalysisInputSnapshot>;

  return (
    snapshot.snapshotVersion === ANALYSIS_INPUT_SNAPSHOT_VERSION &&
    Array.isArray(snapshot.lots) &&
    Boolean(snapshot.field?.fieldId) &&
    Boolean(snapshot.request?.startDate) &&
    Boolean(snapshot.request?.endDate)
  );
}

/** Input que espera PythonWorkerService.runFieldAnalysis, derivado SOLO del snapshot. */
export type FieldWorkerInputFromSnapshot = {
  fieldId: string;
  name: string;
  location?: string;
  startDate: string;
  endDate: string;
  maxCloudiness: number;
  indices?: string[];
  zoneIndices?: string[];
  indexImageIndices?: string[];
  includeMapAssets?: boolean;
  includeIndexImages?: boolean;
  includeImageSeries?: boolean;
  maxZoneCampaigns?: number;
  lots: AnalysisInputSnapshotLot[];
};

export function snapshotToWorkerInput(
  snapshot: AnalysisInputSnapshot,
): FieldWorkerInputFromSnapshot {
  const { request } = snapshot;
  const optional = <T>(value: T | null): T | undefined =>
    value === null ? undefined : value;

  return {
    fieldId: snapshot.field.fieldId,
    name: snapshot.field.name,
    location: snapshot.field.location,
    startDate: request.startDate,
    endDate: request.endDate,
    maxCloudiness: request.maxCloudiness,
    indices: optional(request.indices),
    zoneIndices: optional(request.zoneIndices),
    indexImageIndices: optional(request.indexImageIndices),
    includeMapAssets: optional(request.includeMapAssets),
    includeIndexImages: optional(request.includeIndexImages),
    includeImageSeries: optional(request.includeImageSeries),
    maxZoneCampaigns: optional(request.maxZoneCampaigns),
    lots: snapshot.lots.map((lot) => ({ ...lot })),
  };
}

/** Resumen liviano de lotes (sin GeoJSON) para resultJson.lots / resultJson.fieldLots. */
export function summarizeSnapshotLots(lots: AnalysisInputSnapshotLot[]): Array<{
  id: string;
  name: string;
  areaHa: number;
  includeInProductivityClassification: boolean;
}> {
  return lots.map((lot) => ({
    id: lot.id,
    name: lot.name,
    areaHa: lot.areaHa,
    includeInProductivityClassification:
      lot.includeInProductivityClassification,
  }));
}
