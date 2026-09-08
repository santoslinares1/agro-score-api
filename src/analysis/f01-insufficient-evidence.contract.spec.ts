/**
 * F01 — contrato Worker → API: un resultado "sin evidencia satelital suficiente" tiene que
 * conservar su significado al cruzar la frontera de proceso entre el Worker (Python) y los
 * consumidores de la API (TypeScript) que lo presentan.
 *
 * REAL (se ejecuta código productivo, no se reimplementa ni se copia la lógica al test):
 *   - Worker: app.pipeline.response_mapper.map_worker_result_to_legacy_response, corrida en un
 *     subproceso Python aparte (mismo patrón que agro-score-worker/tests/test_limits.py y
 *     f02-default-date-range.contract.spec.ts) con un input de "cero observaciones" — el mismo
 *     escenario reverificado contra la auditoría (antes: globalScore=46/confidence=75/
 *     stability=100).
 *   - API: isVigorDataAvailable, scoreInterpretation (report-pdf.helpers.ts) y
 *     generateTechnicalVerdict + buildVerdictGeneratorInput-equivalente (vía un Analysis armado a
 *     mano con el resultJson real que devolvió el paso anterior), todas llamadas de verdad, sin
 *     mocks que siempre acepten.
 *
 * SIMULADO (declarado explícitamente, no es un end-to-end HTTP):
 *   - No hay persistencia real (Postgres): el "Analysis" que consumen los helpers de la API es un
 *     objeto plano en memoria, con el resultJson REAL que produjo el Worker.
 *   - No hay transporte HTTP real entre Worker y API (ni POST /analyze, ni ningún servidor HTTP
 *     levantado): el "cruce de la frontera" es el límite del proceso Python vs. el proceso
 *     Node/Jest, comunicados por stdout/JSON — igual que hace PythonWorkerService.postToWorker en
 *     producción (HTTP), pero sin la capa HTTP en sí.
 *   - No se ejercita Web (Angular): Web no tiene lógica propia que inspeccione dataAvailability,
 *     solo muestra `analysis.category` tal cual llega — ver el informe de entrega para el
 *     razonamiento completo.
 *
 * Límite documentado: si agro-score-worker no está disponible como repo hermano (o no tiene su
 * venv), este describe se salta (con un warning), igual que en el contrato de F02.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { Analysis } from './entities/analysis.entity';
import {
  isVigorDataAvailable,
  scoreInterpretation,
} from './report-pdf/report-pdf.helpers';
import { buildVerdictGeneratorInput } from '../analysis-verdict/analysis-verdict-input.util';
import { generateTechnicalVerdict } from '../analysis-verdict/analysis-verdict-generator.util';

const API_REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_CONTAINER = path.resolve(API_REPO_ROOT, '..');
const WORKER_REPO_ROOT =
  process.env.AGROSCORE_WORKER_REPO_PATH || path.join(REPO_CONTAINER, 'agro-score-worker');
const WORKER_PYTHON =
  process.env.AGROSCORE_WORKER_PYTHON || path.join(WORKER_REPO_ROOT, 'venv', 'bin', 'python3');

const REPOS_AVAILABLE = fs.existsSync(WORKER_REPO_ROOT) && fs.existsSync(WORKER_PYTHON);

if (!REPOS_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'F01 contract test: se salta (describe.skip) porque no se encontró agro-score-worker como ' +
      `repo hermano ni su venv. Rutas evaluadas: WORKER=${WORKER_REPO_ROOT} PYTHON=${WORKER_PYTHON}`,
  );
}

const WORKER_SCRIPT = `
import json
from app.pipeline.response_mapper import map_worker_result_to_legacy_response

result = {
    "field_name": "Campo de prueba",
    "indices": ["NDVI"],
    "timeseries": [
        {"lot": "Lote 1", "lot_id": "lot-1", "image_count": 0, "rows": [], "warnings": ["Sin imágenes Sentinel-2 para el período."]}
    ],
    "zones": [],
    "totals_by_zone": [],
    "warnings": [],
    "zone_classification": None,
    "map_assets": None,
    "image_series": None,
}

print(json.dumps(map_worker_result_to_legacy_response(result)))
`;

function runRealWorkerMapping(): any {
  const result = spawnSync(WORKER_PYTHON, ['-c', WORKER_SCRIPT], {
    cwd: WORKER_REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.status !== 0) {
    throw new Error(
      `El Worker real falló (exit=${result.status}): ${result.stderr || result.error}`,
    );
  }

  return JSON.parse(result.stdout);
}

const describeContract = REPOS_AVAILABLE ? describe : describe.skip;

describeContract(
  'F01 (contrato Worker → API): "sin evidencia satelital suficiente" cruza la frontera de proceso sin perder su significado',
  () => {
    let mapped: any;

    beforeAll(() => {
      mapped = runRealWorkerMapping();
    });

    it('el Worker real (sin observaciones) reproduce la ausencia de evidencia, no el bug histórico de la auditoría', () => {
      expect(mapped.globalScore).toBe(0);
      expect(mapped.confidenceScore).toBe(0);
      expect(mapped.stabilityScore).toBe(0);
      // Antecedente reverificado de la auditoría: ANTES del fix esto daba (46, 75, 100).
      expect([mapped.globalScore, mapped.confidenceScore, mapped.stabilityScore]).not.toEqual([
        46, 75, 100,
      ]);
      expect(mapped.resultJson.dataAvailability.globalScore).toBe(false);
    });

    it('isVigorDataAvailable (API, real) lee el resultJson real del Worker y dice "no disponible"', () => {
      expect(isVigorDataAvailable(mapped.resultJson)).toBe(false);
    });

    it('scoreInterpretation (API, real) no fabrica una interpretación de "bajo desempeño" a partir del score en 0', () => {
      const text = scoreInterpretation(mapped.globalScore, isVigorDataAvailable(mapped.resultJson));

      expect(text).toMatch(/no hay evidencia satelital suficiente/i);
      expect(text).not.toMatch(/menor desempeño/i);
    });

    it('el veredicto técnico (API, real) clasifica insufficient_data en vez de "critical" a partir de un score fabricado', () => {
      // Analysis en memoria (persistencia simulada): mismas columnas que
      // AnalysisService.processFieldAnalysisInBackground asignaría desde `mapped`, con el
      // resultJson REAL que produjo el Worker.
      const analysis = {
        id: 'analysis-1',
        globalScore: mapped.globalScore,
        ndviAverageMax: mapped.ndviAverageMax,
        ndviVariability: mapped.ndviVariability,
        resultJson: {
          ...mapped.resultJson,
          // Igual que AnalysisService.processFieldAnalysisInBackground: zonas SÍ detectadas
          // (hasZoneData=true) para aislar que el gate nuevo (evidencia de vigor) es el que
          // realmente está evitando el falso "critical" — si dependiera de hasZoneData=false,
          // este test no probaría nada nuevo respecto del comportamiento que ya existía.
          totalsByZone: [{ zone: 1, name: 'Alta', hectares: 10, percent: 100 }],
        },
      } as unknown as Analysis;

      const verdictInput = buildVerdictGeneratorInput(analysis);
      expect(verdictInput.hasSufficientVigorData).toBe(false);
      expect(verdictInput.hasZoneData).toBe(true); // confirma que el gate que actuó fue el de vigor.

      const verdict = generateTechnicalVerdict(verdictInput);

      expect(verdict.verdict).toBe('insufficient_data');
      expect(verdict.confidence).toBe('low');
      expect(verdict.possibleCauses).toEqual([]);
    });
  },
);
