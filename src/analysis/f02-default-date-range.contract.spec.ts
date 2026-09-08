/**
 * F02 — prueba de CONTRATO del recorrido predeterminado de rango de fechas, entre repos.
 *
 * Objetivo: hoy existen tests por separado para (a) la generación del default en
 * field-create.component.ts (Web), (b) la validación del modal en field-detail.component.ts
 * (Web), (c) la validación + mapeo en AnalysisService/PythonWorkerService (API) y (d) el límite
 * en app/limits.py (Worker) — pero ninguno conecta esos cuatro tramos con el MISMO payload. Este
 * archivo ejercita esa cadena con la menor infraestructura posible, sin levantar HTTP real entre
 * repos ni Earth Engine.
 *
 * ESTO NO ES UN END-TO-END HTTP COMPLETO. Tramos reales vs. simulados, explícitos:
 *
 *   REAL (se ejecuta código productivo, no se reimplementa ni se copia la lógica al test):
 *     - Web: date-utils.ts (`isoDateMonthsAgo`, `todayIsoDate`) — el archivo real se lee de disco
 *       y se transpila/ejecuta en este proceso (ver `loadWebPureModule`), no se reimplementa acá.
 *     - Web: el VALOR de `DEFAULT_RANGE_MONTHS` de field-create.component.ts se lee del código
 *       fuente real por regex (ver `extractNumericConst`) — no se hardcodea "12" en este test. Si
 *       la constante se renombra o reformatea, `extractNumericConst` falla ruidosamente en vez de
 *       asumir un valor viejo.
 *     - API: AnalysisService.runFieldAnalysis() completo — orden de fechas, duración máxima
 *       (daysBetweenIsoDates + MAX_ANALYSIS_DATE_RANGE_DAYS, analysis-constraints.ts), dedupe,
 *       creación/guardado de la entidad Analysis (con un repositorio simulado, ver abajo) y el
 *       disparo del trabajo de background.
 *     - API → Worker: PythonWorkerService.mapFieldInputToWorkerPayload() real (privado, se
 *       ejercita a través de runFieldAnalysis/postToWorker, no se llama por reflexión) — produce
 *       el payload snake_case real que viajaría al Worker.
 *     - Worker: app.limits.validate_analyze_payload real, corrida en un subproceso Python aparte
 *       (mismo patrón de aislación que tests/test_limits.py::_run_in_isolated_process en
 *       agro-score-worker) contra el payload EXACTO que produjo el paso anterior.
 *
 *   SIMULADO (infraestructura, no reglas de negocio):
 *     - Persistencia: Analysis/Field se representan con dobles en memoria (mismo patrón que
 *       analysis.service.spec.ts: repositorio con jest.fn(), FieldsService mockeado). No hay
 *       Postgres real.
 *     - Transporte HTTP API→Worker: se mockea únicamente `HttpService.post` (un nivel POR DEBAJO
 *       del mapeo real) para capturar el payload sin abrir un socket real ni levantar el Worker
 *       como servidor — la llamada real a POST /analyze nunca ocurre; en su lugar, el payload
 *       capturado se valida corriendo el módulo Python real en un subproceso (ver arriba).
 *     - Transporte Web→API: no se levanta ni Angular (TestBed/HttpClient) ni Nest HTTP — no se
 *       instancia FieldCreateComponent/FieldDetailComponent (requieren contexto de inyección de
 *       Angular, fuera del alcance de "mínima infraestructura"). En su lugar, la preservación de
 *       fechas entre el formulario y el payload de creación, y entre el Field y el modal de
 *       análisis, se verifica como una propiedad de copia-sin-transformación, verificada contra
 *       el código fuente real (ver comentarios en cada test) — no se re-ejecuta el método
 *       `saveField()`/`openAnalysisModal()` completos.
 *
 * LÍMITES DOCUMENTADOS de este mecanismo:
 *   1. Asume que agro-score-web y agro-score-worker están checked out como directorios hermanos
 *      de agro-score-api (como en este entorno). Configurable vía AGROSCORE_WEB_REPO_PATH /
 *      AGROSCORE_WORKER_REPO_PATH / AGROSCORE_WORKER_PYTHON si el layout es otro. Si no encuentra
 *      los repos, este describe se salta (con un console.warn), no falla — un layout de checkout
 *      distinto no es en sí mismo un defecto de F02.
 *   2. Requiere el venv de agro-score-worker con sus dependencias instaladas (fastapi, pydantic,
 *      python-dotenv) — no instala nada, no toca Earth Engine, no hace red.
 *   3. No cubre serialización HTTP real (content-type, límites de body, CORS, auth) en ningún
 *      salto — eso es contrato de infraestructura, no de reglas de fechas, y queda fuera de esta
 *      ficha (F02).
 */

import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { Module } from 'module';
import * as path from 'path';
import { of } from 'rxjs';
import * as ts from 'typescript';

import { AnalysisVerdictService } from '../analysis-verdict/analysis-verdict.service';
import { FieldsService } from '../fields/fields.service';
import { PythonWorkerService } from '../python-worker/python-worker.service';
import { AnalysisService } from './analysis.service';
import { Analysis } from './entities/analysis.entity';
import { ReportPdfService } from './report-pdf/report-pdf.service';

const API_REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_CONTAINER = path.resolve(API_REPO_ROOT, '..');

const WEB_REPO_ROOT =
  process.env.AGROSCORE_WEB_REPO_PATH || path.join(REPO_CONTAINER, 'agro-score-web');
const WORKER_REPO_ROOT =
  process.env.AGROSCORE_WORKER_REPO_PATH || path.join(REPO_CONTAINER, 'agro-score-worker');
const WORKER_PYTHON =
  process.env.AGROSCORE_WORKER_PYTHON || path.join(WORKER_REPO_ROOT, 'venv', 'bin', 'python3');

const REPOS_AVAILABLE =
  fs.existsSync(WEB_REPO_ROOT) && fs.existsSync(WORKER_REPO_ROOT) && fs.existsSync(WORKER_PYTHON);

if (!REPOS_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'F02 contract test: se salta (describe.skip) porque no se encontraron agro-score-web/' +
      'agro-score-worker como repos hermanos ni el venv del Worker. Esto NO es un fallo de F02: ' +
      'es un límite documentado de este mecanismo de contrato (ver el header de este archivo). ' +
      `Rutas evaluadas: WEB=${WEB_REPO_ROOT} WORKER=${WORKER_REPO_ROOT} PYTHON=${WORKER_PYTHON}`,
  );
}

/**
 * Lee y ejecuta un archivo .ts REAL de otro repo en este proceso (transpilación con el compilador
 * de TypeScript, sin ts-node ni build previo) — para funciones puras sin dependencias de Angular.
 * No reimplementa la lógica: el `source` que se transpila es exactamente el archivo del repo Web.
 */
function loadWebPureModule(relativePathFromWebRoot: string): Record<string, unknown> {
  const absPath = path.join(WEB_REPO_ROOT, relativePathFromWebRoot);
  const source = fs.readFileSync(absPath, 'utf8');

  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: absPath,
  });

  const mod = new Module(absPath, module);
  mod.filename = absPath;
  mod.paths = (Module as unknown as { _nodeModulePaths(p: string): string[] })._nodeModulePaths(
    path.dirname(absPath),
  );
  (mod as unknown as { _compile(code: string, filename: string): void })._compile(
    outputText,
    absPath,
  );

  return mod.exports as Record<string, unknown>;
}

/** Lee el VALOR de una const numérica del código fuente real, sin ejecutarlo (evita instanciar
 * el componente Angular, que requiere contexto de inyección). Falla ruidosamente si no matchea,
 * a propósito: mejor un test roto y visible que un valor viejo asumido en silencio. */
function extractNumericConst(absPath: string, constName: string): number {
  const source = fs.readFileSync(absPath, 'utf8');
  const match = source.match(new RegExp(`const\\s+${constName}\\s*=\\s*(\\d+)\\s*;`));

  if (!match) {
    throw new Error(
      `F02 contract test: no se pudo extraer "${constName}" de ${absPath}. El patrón esperado ` +
        '(`const NOMBRE = <número>;`) no matcheó — probablemente la constante se renombró o ' +
        'reformateó. Actualizá extractNumericConst/este test en vez de asumir un valor viejo.',
    );
  }

  return Number(match[1]);
}

const WORKER_VALIDATION_SCRIPT = `
import json
import sys

import app.limits as limits
from app.main import AnalyzePayload, LotPayload

data = json.loads(sys.stdin.read())
lots_raw = data.pop("lots")
lots = [LotPayload(**lot) for lot in lots_raw]
payload = AnalyzePayload(lots=lots, **data)

try:
    limits.validate_analyze_payload(payload)
    print("ACCEPTED")
except limits.PayloadValidationError as exc:
    print(f"REJECTED: {exc}")
`;

type WorkerVerdict = { status: 'ACCEPTED' | 'REJECTED' | 'ERROR'; detail: string };

/** Corre app.limits.validate_analyze_payload REAL, en un proceso Python aparte (mismo patrón de
 * aislación que _run_in_isolated_process en agro-score-worker/tests/test_limits.py), contra el
 * payload exacto que produjo PythonWorkerService.mapFieldInputToWorkerPayload. No se llama a
 * Earth Engine: validate_analyze_payload corre antes de eso en el pipeline real. */
function validateWithRealWorker(workerPayload: unknown): WorkerVerdict {
  const result = spawnSync(WORKER_PYTHON, ['-c', WORKER_VALIDATION_SCRIPT], {
    cwd: WORKER_REPO_ROOT,
    input: JSON.stringify(workerPayload),
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.error || result.status !== 0) {
    return {
      status: 'ERROR',
      detail: result.stderr || String(result.error) || `exit code ${result.status}`,
    };
  }

  const firstLine = result.stdout.trim().split('\n')[0] ?? '';

  if (firstLine === 'ACCEPTED') {
    return { status: 'ACCEPTED', detail: firstLine };
  }

  if (firstLine.startsWith('REJECTED')) {
    return { status: 'REJECTED', detail: firstLine };
  }

  return {
    status: 'ERROR',
    detail: `Salida inesperada del validador real del Worker: stdout=${result.stdout} stderr=${result.stderr}`,
  };
}

const describeContract = REPOS_AVAILABLE ? describe : describe.skip;

describeContract('F02 (contrato entre repos): default de Web → validación/mapeo de API → validador real del Worker', () => {
  let dateUtils: {
    todayIsoDate: (referenceDate?: Date) => string;
    isoDateMonthsAgo: (months: number, referenceDate?: Date) => string;
  };
  let DEFAULT_RANGE_MONTHS: number;

  let service: AnalysisService;
  let analysisRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
    query: jest.Mock;
  };
  let fieldsService: { findOne: jest.Mock; getPipelineInput: jest.Mock; findByIdOrFail: jest.Mock };
  let httpServicePostMock: jest.Mock;
  /** F04 (revisión independiente): última carga pasada a values() del query builder simulado del
   * INSERT ... ON CONFLICT — permite que el mock de analysisRepository.query "eco" esos mismos
   * campos en la fila devuelta, igual que el viejo mock de save((entity) => ({ id, ...entity }))
   * hacía. No es SQL real: solo mantiene el contrato (forma de los datos) que este contrato F02 ya
   * asumía. Ver el mismo patrón en analysis.service.spec.ts. */
  let lastInsertValues: Record<string, unknown> = {};

  beforeAll(() => {
    dateUtils = loadWebPureModule('src/app/shared/utils/date-utils.ts') as typeof dateUtils;
    DEFAULT_RANGE_MONTHS = extractNumericConst(
      path.join(WEB_REPO_ROOT, 'src/app/features/app/field-create/field-create.component.ts'),
      'DEFAULT_RANGE_MONTHS',
    );
  });

  beforeEach(async () => {
    lastInsertValues = {};
    httpServicePostMock = jest.fn().mockReturnValue(
      of({
        data: {
          globalScore: 70,
          category: 'stub',
          zonesDetected: 0,
        },
      }),
    );

    const httpServiceStub = { post: httpServicePostMock } as unknown as HttpService;
    const configServiceStub = {
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    // REAL PythonWorkerService: solo se reemplaza HttpService (transporte), no la lógica de
    // mapeo — mapFieldInputToWorkerPayload/postToWorker corren de verdad.
    const realPythonWorkerService = new PythonWorkerService(httpServiceStub, configServiceStub);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalysisService,
        {
          provide: getRepositoryToken(Analysis),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            create: jest.fn((data) => ({ ...data })),
            save: jest.fn((entity) =>
              Promise.resolve({ id: entity.id ?? 'analysis-1', ...entity }),
            ),
            // F04 (revisión independiente): la creación del Analysis ya no pasa por
            // create()+save() — es un INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING atómico
            // vía createQueryBuilder().insert()...values() + query() (ver analysis.service.ts).
            // save() sigue mockeado arriba porque otras escrituras del pipeline (marcar Error,
            // pasar a Finalizado en background) siguen usándolo, pero no la creación inicial.
            createQueryBuilder: jest.fn(() => {
              const builder: {
                insert: jest.Mock;
                into: jest.Mock;
                values: jest.Mock;
                getQueryAndParameters: jest.Mock;
              } = {
                insert: jest.fn(() => builder),
                into: jest.fn(() => builder),
                values: jest.fn((values: Record<string, unknown>) => {
                  lastInsertValues = values;
                  return builder;
                }),
                getQueryAndParameters: jest.fn(() => [
                  'INSERT INTO "analysis" (...) VALUES (...)',
                  [],
                ]),
              };
              return builder;
            }),
            query: jest.fn(() =>
              Promise.resolve([{ id: 'analysis-1', ...lastInsertValues, inserted: true }]),
            ),
          },
        },
        { provide: PythonWorkerService, useValue: realPythonWorkerService },
        {
          provide: FieldsService,
          useValue: {
            findOne: jest.fn(),
            findByIdOrFail: jest.fn(),
            getPipelineInput: jest.fn(),
          },
        },
        { provide: ReportPdfService, useValue: { build: jest.fn() } },
        {
          provide: AnalysisVerdictService,
          useValue: {
            generateAndPersist: jest.fn().mockResolvedValue(undefined),
            findResponseByAnalysisId: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get(AnalysisService);
    analysisRepository = module.get(getRepositoryToken(Analysis));
    fieldsService = module.get(FieldsService);
  });

  const flushBackgroundWork = () => new Promise((resolve) => setImmediate(resolve));

  // Polígono real (mismas coordenadas que agro-score-worker/tests/test_limits.py::_lot), para que
  // la validación de geometría del Worker (parte de validate_analyze_payload) también corra de
  // verdad, no solo la de fechas.
  const REAL_LOT_GEOJSON = {
    type: 'Polygon',
    coordinates: [
      [
        [-64.2, -33.1],
        [-64.19, -33.1],
        [-64.19, -33.09],
        [-64.2, -33.09],
      ],
    ],
  };

  function buildFieldStub(startDate: string, endDate: string) {
    return {
      id: 'field-1',
      userId: 'user-A',
      name: 'Campo contrato F02',
      startDate,
      endDate,
      maxCloudiness: 30,
    } as any;
  }

  function buildPipelineInputStub(startDate: string, endDate: string) {
    return {
      fieldId: 'field-1',
      name: 'Campo contrato F02',
      startDate,
      endDate,
      maxCloudiness: 30,
      lots: [
        {
          id: 'lot-1',
          name: 'Lote 1',
          geojson: REAL_LOT_GEOJSON,
          areaHa: 10,
          includeInProductivityClassification: true,
        },
      ],
    };
  }

  /**
   * Ejercita el tramo completo para un caso que se espera ACEPTADO de punta a punta, y devuelve
   * el payload real capturado en el límite HttpService.post (para aserciones adicionales).
   */
  async function exerciseAcceptedContractCase(startDate: string, endDate: string) {
    // --- "Field creation": preservación de fechas sin transformación --------------------------
    // SIMULADO: no se re-ejecuta FieldCreateComponent.saveField() (requiere Angular DI). Se
    // verifica la propiedad real de esa función: CreateFieldPayload copia
    // startDate/endDate del formulario SIN transformarlos (grep-verificado contra
    // field-create.component.ts: `startDate: this.form.startDate, endDate: this.form.endDate`,
    // sin ningún cálculo intermedio) — por eso alcanza con afirmar la identidad acá.
    const creationPayload = { startDate, endDate };
    expect(creationPayload.startDate).toBe(startDate);
    expect(creationPayload.endDate).toBe(endDate);

    // --- "Modal init": field.startDate/endDate ya están seteados (vienen de la creación) -------
    // SIMULADO por la misma razón que arriba: openAnalysisModal() usa
    // `field.startDate || isoDateMonthsAgo(...)` — con field.startDate presente (nuestro caso,
    // siempre lo está desde la creación), el fallback nunca se ejecuta, así que el valor que llega
    // al pedido de Analysis es el mismo field.startDate/endDate sin transformación.
    const field = buildFieldStub(startDate, endDate);
    fieldsService.findOne.mockResolvedValue(field);
    fieldsService.getPipelineInput.mockResolvedValue(buildPipelineInputStub(startDate, endDate));

    // --- API: validación + creación de Analysis + disparo de background (TODO REAL) -----------
    const result = await service.runFieldAnalysis(
      'field-1',
      { startDate: field.startDate, endDate: field.endDate, maxCloudiness: 30 },
      'user-A',
    );

    expect(result).toBeDefined();
    // F04 (revisión independiente): la creación ya no pasa por save() — ver comentario en el
    // mock de arriba.
    expect(analysisRepository.query).toHaveBeenCalled();

    await flushBackgroundWork();

    // --- API → Worker: mapeo real, transporte simulado (solo HttpService.post) -----------------
    expect(httpServicePostMock).toHaveBeenCalledTimes(1);
    const [, workerPayload] = httpServicePostMock.mock.calls[0];

    // "Rango predeterminado aceptado sin cambios silenciosos": las fechas que salen hacia el
    // Worker son EXACTAMENTE las que generó Web, en cada tramo — no se recortaron ni redondearon.
    expect(workerPayload.campaign_start).toBe(startDate);
    expect(workerPayload.campaign_end).toBe(endDate);

    // --- Worker: validador real, en subproceso aparte ------------------------------------------
    const verdict = validateWithRealWorker(workerPayload);
    expect(verdict.status).toBe('ACCEPTED');

    return workerPayload;
  }

  it('fecha de sistema normal: el default real de Web llega intacto hasta el validador real del Worker', async () => {
    const referenceDate = new Date(Date.UTC(2025, 5, 15)); // 2025-06-15: fecha de sistema "normal".

    const startDate = dateUtils.isoDateMonthsAgo(DEFAULT_RANGE_MONTHS, referenceDate);
    const endDate = dateUtils.todayIsoDate(referenceDate);

    await exerciseAcceptedContractCase(startDate, endDate);
  });

  it('fecha de sistema 29 de febrero: el default real de Web sigue siendo válido de punta a punta', async () => {
    const referenceDate = new Date(Date.UTC(2024, 1, 29)); // 2024-02-29: 2024 es bisiesto.

    const startDate = dateUtils.isoDateMonthsAgo(DEFAULT_RANGE_MONTHS, referenceDate);
    const endDate = dateUtils.todayIsoDate(referenceDate);

    // Ni siquiera necesitamos calcular acá cuántos días da: el propio validador real del Worker,
    // ejecutado en exerciseAcceptedContractCase, es quien decide ACCEPTED/REJECTED.
    await exerciseAcceptedContractCase(startDate, endDate);
  });

  it('rango excesivo (regresión histórica de F02, 2024-09-05 → 2026-09-05, 730 días): la API rechaza ANTES de persistir Analysis o iniciar background — nunca llega al Worker', async () => {
    const startDate = '2024-09-05';
    const endDate = '2026-09-05';

    fieldsService.findOne.mockResolvedValue(buildFieldStub(startDate, endDate));

    await expect(
      service.runFieldAnalysis('field-1', { startDate, endDate, maxCloudiness: 30 }, 'user-A'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(fieldsService.getPipelineInput).not.toHaveBeenCalled();
    expect(analysisRepository.create).not.toHaveBeenCalled();
    expect(analysisRepository.save).not.toHaveBeenCalled();
    expect(analysisRepository.query).not.toHaveBeenCalled();

    await flushBackgroundWork();
    expect(httpServicePostMock).not.toHaveBeenCalled();
  });

  it('CONTROL NEGATIVO AISLADO: si el default de Web volviera a ser de ~24 meses (el bug histórico de F02), este mecanismo de contrato lo detecta y lo rechaza en la API', async () => {
    // No toca DEFAULT_RANGE_MONTHS real (sigue siendo 12, extraído del código fuente arriba) ni
    // ningún archivo productivo: usa la MISMA función real de Web (isoDateMonthsAgo) con un
    // argumento de meses que representa el default histórico previo a este fix, para demostrar
    // que este mecanismo de contrato es sensible a una incompatibilidad temporal real — no un
    // test que "siempre pasa" pase lo que pase el default de Web.
    const HISTORICAL_REGRESSED_DEFAULT_MONTHS = 24;
    const referenceDate = new Date(Date.UTC(2026, 8, 5)); // fecha fija arbitraria.

    const startDate = dateUtils.isoDateMonthsAgo(HISTORICAL_REGRESSED_DEFAULT_MONTHS, referenceDate);
    const endDate = dateUtils.todayIsoDate(referenceDate);

    fieldsService.findOne.mockResolvedValue(buildFieldStub(startDate, endDate));

    await expect(
      service.runFieldAnalysis('field-1', { startDate, endDate, maxCloudiness: 30 }, 'user-A'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(analysisRepository.save).not.toHaveBeenCalled();
    expect(analysisRepository.query).not.toHaveBeenCalled();

    await flushBackgroundWork();
    expect(httpServicePostMock).not.toHaveBeenCalled();
  });
});
