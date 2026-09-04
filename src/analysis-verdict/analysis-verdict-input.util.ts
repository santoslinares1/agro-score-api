import { Analysis } from '../analysis/entities/analysis.entity';
import { WorkerResultJson } from '../python-worker/types';
import { VerdictGeneratorInput } from './analysis-verdict-generator.util';

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * `resultJson.timeseries[].rows[].values.NDMI_mean` — misma extracción que
 * weekly-analysis-snapshot-metrics.util.ts:extractIndexMean (promedio plano de todas las filas
 * con NDVI_count>0, sin agrupar por campaña), duplicada acá deliberadamente en vez de importada:
 * analysis-verdict es un módulo hermano de scheduled-analysis, no una dependencia suya, y esta
 * función es la única señal NDMI que necesita (a diferencia del snapshot semanal no hace falta
 * ndviMean acá porque Analysis ya trae ndviAverageMax como columna plana).
 */
function extractNdmiMean(resultJson: WorkerResultJson | null): number | null {
  const timeseries = Array.isArray(resultJson?.timeseries)
    ? resultJson.timeseries
    : [];

  const rows: any[] = timeseries.flatMap((serie: any) =>
    Array.isArray(serie?.rows) ? serie.rows : [],
  );

  const values = rows
    .filter((row) => Number(row?.values?.NDVI_count ?? 0) > 0)
    .map((row) => Number(row?.values?.NDMI_mean))
    .filter((value) => !Number.isNaN(value));

  if (!values.length) {
    return null;
  }

  const mean = values.reduce((acc, value) => acc + value, 0) / values.length;
  return round(mean, 4);
}

function hasZoneData(resultJson: WorkerResultJson | null): boolean {
  return (
    Array.isArray(resultJson?.totalsByZone) &&
    (resultJson.totalsByZone as unknown[]).length > 0
  );
}

/**
 * Traduce un Analysis 'Finalizado' a la entrada del generador determinístico. Nunca dispara
 * cálculo nuevo — solo lee columnas ya pobladas por AnalysisService.processFieldAnalysisInBackground
 * y el resultJson que el worker devolvió.
 */
export function buildVerdictGeneratorInput(
  analysis: Analysis,
): VerdictGeneratorInput {
  return {
    globalScore: analysis.globalScore,
    hasZoneData: hasZoneData(analysis.resultJson),
    ndviAverageMax: analysis.ndviAverageMax,
    ndviVariability: analysis.ndviVariability,
    ndmiMean: extractNdmiMean(analysis.resultJson),
    analysisId: analysis.id,
  };
}
