// F04: carrera de deduplicación de AnalysisService.runFieldAnalysis.
//
// Esta suite atraviesa AnalysisService.runFieldAnalysis() REAL (sin mockear el repositorio de
// Analysis, la transacción real de Postgres, ni el índice único parcial que cierra la carrera)
// contra una base PostgreSQL aislada y desechable, creada por esta misma ejecución con un nombre
// único (ver test/support/isolated-postgres-database.ts) — nunca contra `agro_score` ni contra
// las variables DB_* generales del backend. El destino de test se configura explícitamente vía
// TEST_DB_HOST/TEST_DB_PORT/TEST_DB_USER/TEST_DB_PASSWORD; sin esas variables, la suite falla al
// arrancar con un mensaje accionable en vez de improvisar sobre un servidor desconocido.
//
// Lo único simulado es el Worker (PythonWorkerService.runFieldAnalysis, un jest.fn() que cuenta
// llamadas) y FieldsService (no forma parte del mecanismo de exclusión: solo entrega un field/lote
// fijo). AnalysisService se instancia directamente (sin DI de Nest) con un Repository<Analysis>
// REAL por instancia — dos instancias, cada una con su propio DataSource/pool de conexión propio,
// para simular dos procesos/instancias de API distintos compitiendo por el mismo campo.
import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { AnalysisService } from '../src/analysis/analysis.service';
import { AddRunningAnalysisPerFieldUniqueIndex1788829462102 } from '../src/migrations/1788829462102-AddRunningAnalysisPerFieldUniqueIndex';
import { AddAnalysisClientRequestId1788900000000 } from '../src/migrations/1788900000000-AddAnalysisClientRequestId';
import { AddAnalysisClientRequestAssociationTable1788900000001 } from '../src/migrations/1788900000001-AddAnalysisClientRequestAssociationTable';
import { MakeAnalysisClientRequestForeignKeyDeferrable1788900000002 } from '../src/migrations/1788900000002-MakeAnalysisClientRequestForeignKeyDeferrable';
import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { FieldsService } from '../src/fields/fields.service';
import { PythonWorkerService } from '../src/python-worker/python-worker.service';
import { ReportPdfService } from '../src/analysis/report-pdf/report-pdf.service';
import { User } from '../src/users/user.entity';
import {
  createIsolatedTestDatabase,
  dropIsolatedTestDatabase,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './support/isolated-postgres-database';

jest.setTimeout(30_000);

/** Idéntica a la de auth-reset-password-atomicity.e2e-spec.ts (F03) — evidencia real de
 * contención vía pg_stat_activity, nunca un sleep fijo usado como prueba en sí. Postgres hace
 * esperar (wait_event_type='Lock') a la segunda transacción que intenta insertar una fila que
 * chocaría contra un índice único mientras la primera todavía no confirmó ni revirtió — el mismo
 * mecanismo observable que un SELECT ... FOR UPDATE, aplicado acá a un conflicto INSERT vs INSERT
 * en vez de una fila preexistente. */
async function waitForLockContention(
  observer: DataSource,
  databaseName: string,
  options: { timeoutMs: number; pollIntervalMs: number },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const rows: Array<{ count: string }> = await observer.query(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = $1
         AND wait_event_type = 'Lock'`,
      [databaseName],
    );

    if (Number(rows[0]?.count ?? 0) > 0) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `No se observó ninguna conexión de "${databaseName}" esperando un lock en ` +
          `pg_stat_activity dentro de ${options.timeoutMs}ms — la contención esperada no se ` +
          'produjo (o no se pudo observar), así que este test no puede afirmar que hubo una ' +
          'carrera real por el índice único.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

/**
 * F04 (pendiente de la revisión independiente): si `watched` se asienta (resuelve O rechaza)
 * ANTES que `barrier`, esperar `barrier` sin más se cuelga indefinidamente — `barrier` nunca va a
 * llegar porque la operación que la iba a disparar ya terminó (falló temprano, antes de alcanzar
 * el punto de instrumentación que dispara la barrera). Esta función corta esa espera de inmediato
 * con la causa real en vez de dejar el test colgado o esperando el timeout genérico de
 * waitForLockContention por una razón equivocada.
 */
function raceBarrierWithEarlyFailure<T>(
  barrier: Promise<T>,
  watched: Promise<unknown>,
  watchedLabel: string,
): Promise<T> {
  return Promise.race([
    barrier,
    watched.then(
      () =>
        Promise.reject(
          new Error(
            `${watchedLabel} se asentó antes de lo esperado (antes de que la barrera se activara) — ` +
              'la instrumentación de este test no siguió el camino esperado.',
          ),
        ),
      (error) => Promise.reject(error instanceof Error ? error : new Error(String(error))),
    ),
  ]);
}

/** Señal REAL de que processFieldAnalysisInBackground (fire-and-forget) terminó — nunca un sleep
 * fijo: poll acotado por timeout hasta que el status deje de ser 'Procesando'. Sin esto, trabajo
 * de fondo puede seguir intentando usar las conexiones de dataSourceA/B después de que el
 * siguiente test (o afterAll) ya las cerró. */
async function waitForTerminalStatus(
  repo: Repository<Analysis>,
  analysisId: string,
  options: { timeoutMs: number; pollIntervalMs: number } = { timeoutMs: 5_000, pollIntervalMs: 25 },
): Promise<Analysis> {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    const current = await repo.findOne({ where: { id: analysisId } });

    if (current && current.status !== 'Procesando') {
      return current;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `El análisis ${analysisId} no alcanzó un estado terminal dentro de ${options.timeoutMs}ms — ` +
          'el procesamiento de fondo podría seguir corriendo.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
}

function buildPipelineInput(fieldId: string, overrides: { name?: string | null } = {}) {
  return {
    fieldId,
    name: overrides.name === undefined ? 'Campo de prueba F04' : (overrides.name as any),
    location: 'Pergamino',
    totalAreaHa: 10,
    lots: [
      {
        id: 'lot-1',
        name: 'Lote 1',
        geojson: { type: 'Polygon', coordinates: [] },
        areaHa: 10,
        includeInProductivityClassification: true,
      },
    ],
  };
}

function buildWorkerResult() {
  return {
    globalScore: 42,
    category: 'Aptitud media con limitantes a revisar',
    confidenceScore: 50,
    productivityScore: 50,
    stabilityScore: 50,
    soilScore: 0,
    climateScore: 0,
    ndviAverageMax: 0.5,
    ndviVariability: 'Media' as const,
    zonesDetected: 0,
    resultJson: { mode: 'python-worker-v2', message: 'test' } as any,
  };
}

describe('F04 — deduplicación de AnalysisService.runFieldAnalysis (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let observerDataSource: DataSource | undefined;
  let bootstrapDataSource: DataSource | undefined;
  let dataSourceA: DataSource | undefined;
  let dataSourceB: DataSource | undefined;

  let repoA: Repository<Analysis>;
  let repoB: Repository<Analysis>;
  let serviceA: AnalysisService;
  let serviceB: AnalysisService;

  let pythonWorkerServiceMock: { runFieldAnalysis: jest.Mock };
  let fieldsServiceMock: { findOne: jest.Mock; getPipelineInput: jest.Mock };
  let fieldCounter = 0;

  function freshFieldId(): string {
    fieldCounter += 1;
    return `field-f04-${fieldCounter}`;
  }

  function buildAnalysisService(repo: Repository<Analysis>): AnalysisService {
    return new AnalysisService(
      repo,
      pythonWorkerServiceMock as unknown as PythonWorkerService,
      fieldsServiceMock as unknown as FieldsService,
      { build: jest.fn() } as unknown as ReportPdfService,
      {
        generateAndPersist: jest.fn().mockResolvedValue(undefined),
      } as unknown as AnalysisVerdictService,
    );
  }

  beforeAll(async () => {
    // Configuración EXPLÍCITA del destino de test — nunca las DB_* generales del backend.
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'f04_dedup_race');
    createdDatabaseName = created.name;

    observerDataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: target.adminDatabase,
    });
    await observerDataSource.initialize();

    // Bootstrap: crea el esquema (synchronize, a partir de la entidad Analysis real) y aplica el
    // índice único parcial corriendo la migración REAL (no una copia de su SQL) — si la migración
    // en sí tuviera un error, este test lo detectaría acá.
    bootstrapDataSource = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
      synchronize: true,
    });
    await bootstrapDataSource.initialize();

    const queryRunner = bootstrapDataSource.createQueryRunner();
    await queryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().up(queryRunner);
    // F04 (revisión independiente, ronda 3): clientRequestId (la columna ya la crea
    // `synchronize` arriba, por ser parte de la entidad Analysis) + su índice único parcial —
    // ver AddAnalysisClientRequestId1788900000000. Ya no se usa como mecanismo de resolución (ver
    // ronda 4 abajo), pero se conserva en el esquema.
    await new AddAnalysisClientRequestId1788900000000().up(queryRunner);
    // F04 (revisión independiente, ronda 4): tabla de asociación muchos-a-uno — ver
    // AddAnalysisClientRequestAssociationTable1788900000001 y el comentario junto a
    // findClientRequestAssociation/recordClientRequestAssociation en AnalysisService.
    await new AddAnalysisClientRequestAssociationTable1788900000001().up(queryRunner);
    await new MakeAnalysisClientRequestForeignKeyDeferrable1788900000002().up(queryRunner);
    await queryRunner.release();

    // Dos DataSource independientes (dos pools de conexión propios) simulando dos
    // procesos/instancias de API distintas compitiendo por el mismo campo.
    dataSourceA = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
    });
    await dataSourceA.initialize();

    dataSourceB = new DataSource({
      type: 'postgres',
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      database: createdDatabaseName,
      entities: [Analysis, User],
    });
    await dataSourceB.initialize();

    repoA = dataSourceA.getRepository(Analysis);
    repoB = dataSourceB.getRepository(Analysis);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    for (const ds of [dataSourceA, dataSourceB, bootstrapDataSource, observerDataSource]) {
      if (ds?.isInitialized) {
        try {
          await ds.destroy();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }

    if (createdDatabaseName) {
      try {
        await dropIsolatedTestDatabase(target, createdDatabaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        'Fallo(s) durante la limpieza de recursos de la suite F04 — ver causas.',
      );
    }
  });

  beforeEach(() => {
    pythonWorkerServiceMock = { runFieldAnalysis: jest.fn().mockResolvedValue(buildWorkerResult()) };
    fieldsServiceMock = {
      // F04 (revisión independiente, ronda 2): incluye name/lots — desde esta ronda,
      // runFieldAnalysis usa field.name/field.lots (no getPipelineInput) para el placeholder del
      // INSERT atómico, así que este mock necesita esos campos para reflejar el contrato real de
      // FieldsService.findOne (que siempre carga la relación .lots).
      findOne: jest.fn().mockImplementation((id: string, userId: string) =>
        Promise.resolve({ id, userId, ...buildPipelineInput(id) } as any),
      ),
      getPipelineInput: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(buildPipelineInput(id)),
      ),
    };
    serviceA = buildAnalysisService(repoA);
    serviceB = buildAnalysisService(repoB);
  });

  it('CASO 1 — misma solicitud lógica con contención REAL y determinista en el índice único: la ganadora retiene el lock, la perdedora queda observablemente esperando en pg_stat_activity, y al confirmar la ganadora la perdedora reutiliza su fila sin lanzar y sin disparar un segundo procesamiento', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    // Instrumentación de TEST (no de producción): intercepta repoA.query (el método que
    // runFieldAnalysis usa para el INSERT ... ON CONFLICT ... RETURNING atómico, ver
    // analysis.service.ts) y lo re-ejecuta dentro de una transacción REAL que retiene el lock
    // hasta que se libera el gate — mientras tanto, la transacción sigue abierta, así que la
    // perdedora queda bloqueada de verdad esperando en pg_stat_activity, no simulada.
    //
    // `insertedSignal` (interno al proceso de test, NO es la evidencia de la carrera) asegura que
    // A ya ejecutó su sentencia real (transacción abierta, sin confirmar) antes de que B arranque
    // su propio intento — sin esto, cuál de las dos gana la carrera física queda a merced del
    // scheduling del event loop. La EVIDENCIA de la carrera sigue siendo, exclusivamente,
    // waitForLockContention sobre pg_stat_activity más abajo.
    let releaseGate!: () => void;
    let gateReleased = false;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const ensureGateReleased = () => {
      if (!gateReleased) {
        gateReleased = true;
        releaseGate();
      }
    };

    let resolveInsertedSignal!: () => void;
    const insertedSignal = new Promise<void>((resolve) => {
      resolveInsertedSignal = resolve;
    });

    const querySpy = jest
      .spyOn(repoA, 'query')
      .mockImplementationOnce((sql: string, params?: unknown[]) =>
        dataSourceA!.transaction(async (manager) => {
          const result = await manager.query(sql, params);
          resolveInsertedSignal();
          await gate;
          return result;
        }),
      );

    const promiseA = serviceA.runFieldAnalysis(fieldId, input, userId);
    let promiseB: Promise<Analysis> | undefined;
    let earlyError: unknown;

    try {
      await raceBarrierWithEarlyFailure(insertedSignal, promiseA, 'promiseA (instrumentada, A)');

      promiseB = serviceB.runFieldAnalysis(fieldId, input, userId);

      await raceBarrierWithEarlyFailure(
        waitForLockContention(observerDataSource as DataSource, createdDatabaseName as string, {
          timeoutMs: 5_000,
          pollIntervalMs: 50,
        }),
        promiseB,
        'promiseB',
      );
    } catch (error) {
      earlyError = error;
    } finally {
      // F04 (pendiente de la revisión independiente): esta liberación, el await de abajo y el
      // mockRestore ya NO dependen de que la observación del bloqueo haya tenido éxito — antes,
      // un fallo de waitForLockContention saltaba directo a este finally y el resto del cuerpo del
      // test (esperar el asentamiento de las promesas, restaurar el spy) quedaba sin ejecutarse.
      ensureGateReleased();
    }

    // SIEMPRE se ejecuta, haya fallado o no la observación de arriba: nunca se dejan promesas
    // colgando ni el spy sin restaurar.
    const settled = await Promise.allSettled([promiseA, promiseB ?? Promise.resolve(undefined)]);
    querySpy.mockRestore();

    if (earlyError) {
      throw earlyError;
    }

    const [outcomeA, outcomeB] = settled as [
      PromiseSettledResult<Analysis>,
      PromiseSettledResult<Analysis>,
    ];

    // Comportamiento explícito de la segunda llamada: NINGUNA de las dos rechaza — la perdedora
    // reutiliza el análisis ganador, misma semántica pública que "ya hay uno corriendo".
    expect(outcomeA.status).toBe('fulfilled');
    expect(outcomeB.status).toBe('fulfilled');

    const analysisA = (outcomeA as PromiseFulfilledResult<Analysis>).value;
    const analysisB = (outcomeB as PromiseFulfilledResult<Analysis>).value;
    expect(analysisA.id).toBe(analysisB.id); // misma fila para las dos.

    // Señal real de finalización del procesamiento en background — nunca un sleep fijo.
    await waitForTerminalStatus(repoA, analysisA.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(1); // una sola entidad nueva, no dos.

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1); // un solo disparo.
  });

  it('CASO 2 — solicitudes distintas (campos distintos) siguen permitidas: dos análisis, dos disparos', async () => {
    const fieldIdX = freshFieldId();
    const fieldIdY = freshFieldId();
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    const [analysisX, analysisY] = await Promise.all([
      serviceA.runFieldAnalysis(fieldIdX, input, 'user-A'),
      serviceB.runFieldAnalysis(fieldIdY, input, 'user-A'),
    ]);

    expect(analysisX.fieldId).toBe(fieldIdX);
    expect(analysisY.fieldId).toBe(fieldIdY);
    expect(analysisX.id).not.toBe(analysisY.id);
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2);

    await Promise.all([
      waitForTerminalStatus(repoA, analysisX.id),
      waitForTerminalStatus(repoB, analysisY.id),
    ]);
  });

  it('CASO 3 — estado terminal (Finalizado) admite reintento: no choca contra el índice único, crea un análisis nuevo', async () => {
    const fieldId = freshFieldId();
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    await repoA.save(
      repoA.create({
        scope: 'field',
        fieldId,
        lotId: null,
        lotName: 'Campo de prueba F04',
        status: 'Finalizado',
        startDate: '2023-01-01',
        endDate: '2023-06-01',
      }),
    );

    const result = await serviceA.runFieldAnalysis(fieldId, input, 'user-A');

    expect(result.status).toBe('Procesando');
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

    await waitForTerminalStatus(repoA, result.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(2); // el Finalizado previo + el nuevo Procesando, ninguno pisado.
  });

  it('CASO 4 — fallo real antes del commit (violación NOT NULL, no la del dedupe): no dispara procesamiento ni deja una reserva que bloquee un pedido válido posterior', async () => {
    const fieldId = freshFieldId();
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    // lotName es NOT NULL en el esquema real — forzar name=null hace que el INSERT falle de
    // verdad contra Postgres (23502, not_null_violation), nunca el conflicto del índice de
    // deduplicación (23505 contra UQ_analysis_running_per_field específicamente).
    //
    // F04 (revisión independiente, ronda 2): lotName sale ahora de field.name (fieldsService.
    // findOne), no de fieldInput.name (getPipelineInput) — el INSERT atómico se adelantó a ANTES
    // de getPipelineInput, así que hay que forzar el NOT NULL en la fuente que el código
    // efectivamente usa a esa altura.
    fieldsServiceMock.findOne.mockImplementationOnce((id: string, userId: string) =>
      Promise.resolve({ id, userId, ...buildPipelineInput(id, { name: null }) } as any),
    );

    await expect(serviceA.runFieldAnalysis(fieldId, input, 'user-A')).rejects.toThrow();

    const rowsAfterFailure = await repoA.find({ where: { fieldId } });
    expect(rowsAfterFailure).toHaveLength(0); // nada quedó persistido.
    expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();

    // Sin ninguna reserva/bloqueo persistente: un pedido válido posterior para el MISMO campo
    // funciona con normalidad.
    const result = await serviceA.runFieldAnalysis(fieldId, input, 'user-A');
    expect(result.status).toBe('Procesando');
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

    await waitForTerminalStatus(repoA, result.id);
  });

  it('CASO 6 — fallo real DESPUÉS del commit (getPipelineInput lanza porque el campo se quedó sin lotes, ya con el slot ganado): la fila queda Error de verdad en la base (no solo "se llamó a save()"), no dispara el Worker, y un pedido posterior para el mismo campo crea y procesa un análisis nuevo con normalidad', async () => {
    const fieldId = freshFieldId();
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    // A diferencia de CASO 4 (falla ANTES del commit, en el propio INSERT), acá el INSERT
    // atómico prospera de verdad (existe una fila 'Procesando' real, committeada) y el fallo
    // ocurre DESPUÉS, en getPipelineInput — el recorrido que markPreparationFailureOnWonSlot
    // cubre. Se verifica el ESTADO PERSISTIDO leyendo la fila de vuelta desde Postgres, no solo
    // que un mock haya sido invocado.
    const preparationError = new NotFoundException('El campo no tiene lotes internos cargados.');
    fieldsServiceMock.getPipelineInput.mockRejectedValueOnce(preparationError);

    await expect(serviceA.runFieldAnalysis(fieldId, input, 'user-A')).rejects.toThrow(
      'El campo no tiene lotes internos cargados.',
    );

    const rowsAfterFailure = await repoA.find({ where: { fieldId } });
    expect(rowsAfterFailure).toHaveLength(1); // el INSERT sí prosperó — existe la fila.
    expect(rowsAfterFailure[0].status).toBe('Error'); // pero quedó Error, no colgada 'Procesando'.
    expect(rowsAfterFailure[0].errorMessage).toBe('El campo no tiene lotes internos cargados.');
    expect(rowsAfterFailure[0].failedAt).not.toBeNull();
    expect(pythonWorkerServiceMock.runFieldAnalysis).not.toHaveBeenCalled();

    // Sin ninguna reserva persistente bloqueando: un pedido válido posterior para el MISMO campo
    // crea y procesa un análisis nuevo con normalidad.
    const result2 = await serviceA.runFieldAnalysis(fieldId, input, 'user-A');
    expect(result2.status).toBe('Procesando');
    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

    await waitForTerminalStatus(repoA, result2.id);

    const rowsAfterRetry = await repoA.find({ where: { fieldId } });
    expect(rowsAfterRetry).toHaveLength(2); // la Error original + la nueva, ninguna pisada.
  });

  /**
   * F04 (revisión independiente, ronda 2): la versión anterior de este caso instrumentaba a A
   * para transicionar a estado terminal DENTRO de la MISMA transacción que hacía su INSERT — bajo
   * MVCC, una fila insertada y modificada dentro de una transacción que todavía no confirmó es
   * INVISIBLE para todas las demás transacciones hasta el commit final, así que B nunca llegaba a
   * ver a A como 'Procesando': la primera vez que B podía verla, ya estaba terminal. Eso no
   * representa el orden productivo real (el INSERT confirma solo, como una sentencia autocommit
   * separada; la transición a terminal ocurre DESPUÉS, en un UPDATE completamente distinto que
   * dispara processFieldAnalysisInBackground una vez que el Worker responde) — y al no
   * representarlo, "probaba" que dos solicitudes genuinamente concurrentes podían terminar en dos
   * filas y dos disparos al Worker, que es exactamente lo que la revisión independiente identificó
   * como inaceptable para ese escenario.
   *
   * Esta versión corrige la instrumentación para reflejar el orden real de punta a punta, sin
   * tocar la transacción de inserción de A más allá del INSERT en sí (igual que CASO 1):
   *   1. A inserta con una sentencia envuelta en una transacción que SOLO contiene el INSERT
   *      (igual mecanismo que CASO 1: sirve para producir contención REAL y observable con B, no
   *      para ocultar una transición de estado). El Worker de A queda detenido en un gate propio
   *      de este test — A sigue genuinamente 'Procesando' hasta que este test lo libera.
   *   2. B ejecuta su propia sentencia atómica CONTRA POSTGRES DE VERDAD (misma contención real
   *      que CASO 1, verificada vía pg_stat_activity): como A todavía no confirmó, la sentencia de
   *      B queda bloqueada esperando el lock.
   *   3. Se libera el INSERT de A: confirma («A persiste y confirma su análisis»). Postgres
   *      resuelve, EN ESE MISMO INSTANTE, la sentencia bloqueada de B contra la fila de A — que en
   *      ese instante exacto sigue 'Procesando' (el Worker de A sigue detenido). Este es el punto
   *      verificable de "B queda registrada como competidora mientras A sigue Procesando": ocurrió
   *      de verdad, contra la base, independientemente de cuánto tiempo pase después.
   *   4. El resultado YA RESUELTO de B queda retenido con una barrera de test (nada de contención
   *      real a esta altura: la sentencia ya corrió y ya devolvió su resultado) ANTES de que ese
   *      resultado llegue al código de runFieldAnalysis.
   *   5. Con B pausada ahí (ya sabe la respuesta, todavía no la devolvió), se libera el Worker de
   *      A: A pasa a Finalizado/Error DESPUÉS del commit de su INSERT, en un UPDATE separado
   *      disparado por processFieldAnalysisInBackground — exactamente como en producción, nunca
   *      dentro de la transacción de inserción de A (que ya cerró en el paso 3).
   *   6. Recién ahí se libera la barrera de B.
   *
   * Con esto, cuánto tardó A en terminar deja de importar: la identidad que B devuelve quedó
   * fijada en el paso 3, antes de que A terminara — el código de runFieldAnalysis nunca vuelve a
   * consultar el estado de A para decidir la respuesta de B (ver el comentario junto al INSERT
   * atómico en analysis.service.ts).
   */
  describe.each([
    ['Finalizado', 'resuelve normalmente'] as const,
    ['Error', 'rechaza'] as const,
  ])(
    'CASO EXTRA — B queda registrada como competidora de A mientras A sigue Procesando, y el Worker de A %s recién DESPUÉS de que B ya se registró (A termina en %s)',
    (terminalStatus, _workerBehaviorLabel) => {
      it('A y B devuelven el mismo id, se crea una sola fila y el Worker se dispara una sola vez — y un pedido posterior independiente, ya con ambas llamadas resueltas, sigue pudiendo crear un análisis nuevo', async () => {
        const fieldId = freshFieldId();
        const userId = 'user-A';
        const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

        let releaseInsertGate!: () => void;
        let insertGateReleased = false;
        const insertGate = new Promise<void>((resolve) => {
          releaseInsertGate = resolve;
        });
        const ensureInsertGateReleased = () => {
          if (!insertGateReleased) {
            insertGateReleased = true;
            releaseInsertGate();
          }
        };

        let releaseWorkerGate!: () => void;
        let workerGateReleased = false;
        const workerGate = new Promise<void>((resolve) => {
          releaseWorkerGate = resolve;
        });
        const ensureWorkerGateReleased = () => {
          if (!workerGateReleased) {
            workerGateReleased = true;
            releaseWorkerGate();
          }
        };

        let releaseBBarrier!: () => void;
        let bBarrierReleased = false;
        const bBarrier = new Promise<void>((resolve) => {
          releaseBBarrier = resolve;
        });
        const ensureBBarrierReleased = () => {
          if (!bBarrierReleased) {
            bBarrierReleased = true;
            releaseBBarrier();
          }
        };

        let resolveInsertedSignal!: () => void;
        const insertedSignal = new Promise<void>((resolve) => {
          resolveInsertedSignal = resolve;
        });

        // A: idéntico mecanismo que CASO 1 — la transacción SOLO contiene el INSERT, nunca una
        // transición de estado (esa llega después, por su cuenta, vía processFieldAnalysisInBackground).
        const querySpyA = jest
          .spyOn(repoA, 'query')
          .mockImplementationOnce((sql: string, params?: unknown[]) =>
            dataSourceA!.transaction(async (manager) => {
              const result = await manager.query(sql, params);
              resolveInsertedSignal();
              await insertGate;
              return result;
            }),
          );

        // El Worker de A queda detenido acá hasta que este test decida soltarlo — controla, con
        // precisión, el instante en que A puede pasar a estado terminal.
        pythonWorkerServiceMock.runFieldAnalysis.mockImplementationOnce(async () => {
          await workerGate;
          if (terminalStatus === 'Error') {
            throw new Error('Worker rechazado deliberadamente por este test.');
          }
          return buildWorkerResult();
        });

        // B: su sentencia atómica corre contra Postgres DE VERDAD, sin transacción propia ni nada
        // simulado — lo único que se instrumenta es retener, con una barrera de test, el resultado
        // YA RESUELTO antes de que vuelva al código de runFieldAnalysis.
        const querySpyB = jest
          .spyOn(repoB, 'query')
          .mockImplementationOnce(async (sql: string, params?: unknown[]) => {
            const result = await dataSourceB!.query(sql, params);
            await bBarrier;
            return result;
          });

        const promiseA = serviceA.runFieldAnalysis(fieldId, input, userId);
        let promiseB: Promise<Analysis> | undefined;
        let earlyError: unknown;

        try {
          await raceBarrierWithEarlyFailure(insertedSignal, promiseA, 'promiseA (instrumentada, A)');

          promiseB = serviceB.runFieldAnalysis(fieldId, input, userId);

          // Misma evidencia de contención real que CASO 1 — B está genuinamente bloqueada
          // esperando el lock de la fila de A en este punto, no simulada.
          await raceBarrierWithEarlyFailure(
            waitForLockContention(observerDataSource as DataSource, createdDatabaseName as string, {
              timeoutMs: 5_000,
              pollIntervalMs: 50,
            }),
            promiseB,
            'promiseB',
          );

          ensureInsertGateReleased(); // Paso 3: A confirma.

          const analysisA = await promiseA;

          if (analysisA.status !== 'Procesando') {
            throw new Error(
              `Se esperaba que A siguiera 'Procesando' en este punto (el Worker todavía no se liberó); status real: ${analysisA.status}.`,
            );
          }

          ensureWorkerGateReleased(); // Paso 5: A transiciona DESPUÉS del commit, como en producción.
          const finalA = await waitForTerminalStatus(repoA, analysisA.id);

          if (finalA.status !== terminalStatus) {
            throw new Error(
              `Se esperaba que A terminara en '${terminalStatus}'; terminó en '${finalA.status}'.`,
            );
          }

          ensureBBarrierReleased(); // Paso 6: recién ahora se deja resolver a B.
          const analysisB = await promiseB;

          // Las aserciones centrales que pidió la revisión independiente: mismo id, una sola fila
          // nueva, un solo disparo al Worker — incluso con el ganador ya terminado (rápido) para
          // cuando B efectivamente resuelve.
          expect(analysisB.id).toBe(analysisA.id);

          const rows = await repoA.find({ where: { fieldId } });
          expect(rows).toHaveLength(1);

          expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);

          // Verificación separada: un pedido POSTERIOR e independiente (ambas llamadas ya
          // resueltas) sigue pudiendo crear un análisis nuevo — misma regla que CASO 3, sin
          // cambios en el criterio de reintento.
          const independentRetry = await serviceA.runFieldAnalysis(fieldId, input, userId);
          expect(independentRetry.id).not.toBe(analysisA.id);
          expect(independentRetry.status).toBe('Procesando');
          expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(2);

          await waitForTerminalStatus(repoA, independentRetry.id);

          const rowsAfterRetry = await repoA.find({ where: { fieldId } });
          expect(rowsAfterRetry).toHaveLength(2); // la original (terminal) + el reintento, ninguna pisada.
        } catch (error) {
          earlyError = error;
        } finally {
          // F04: limpieza incondicional — libera los tres gates, espera el asentamiento de ambas
          // promesas y restaura ambos spies, sin importar en qué paso falló (o si no falló nada).
          ensureInsertGateReleased();
          ensureWorkerGateReleased();
          ensureBBarrierReleased();

          await Promise.allSettled([promiseA, promiseB ?? Promise.resolve(undefined)]);
          querySpyA.mockRestore();
          querySpyB.mockRestore();
        }

        if (earlyError) {
          throw earlyError;
        }
      });
    },
  );

  /**
   * F04 (revisión independiente, ronda 2): a diferencia del CASO EXTRA de arriba (que fuerza
   * contención real vía locks, y por eso ya funcionaba incluso ANTES de este fix — ver el
   * control negativo de esta ronda), este caso ejercita específicamente la ventana que el
   * reordenamiento cierra: getPipelineInput() pasó de estar ANTES del INSERT atómico a estar
   * DESPUÉS, solo en la rama ganadora (ver analysis.service.ts). Antes del fix, una request cuyo
   * fast-path SELECT llegaba un instante demasiado temprano (sin encontrar todavía a su
   * competidora) podía quedar esperando ese roundtrip mientras la OTRA request —que arrancó
   * después pero no tuvo que esperar nada— ganaba, procesaba y terminaba de punta a punta; para
   * cuando la primera retomaba, ya no había ninguna fila 'Procesando' con la que competir y
   * terminaba creando la suya propia. Este caso reproduce esa secuencia con un gate real sobre
   * getPipelineInput (no un sleep) y verifica que, de todos modos, coalescen en un único análisis.
   */
  it('CASO EXTRA 2 — el fast-path de B no encuentra nada todavía (arrancó primero, pero se le retiene getPipelineInput con un gate) mientras A arranca después y corre de punta a punta sin ningún gate: aun así coalescen en un único análisis y un único disparo al Worker', async () => {
    const fieldId = freshFieldId();
    const userId = 'user-A';
    const input = { startDate: '2024-01-01', endDate: '2024-06-01', maxCloudiness: 30 };

    let releasePipelineGate!: () => void;
    let pipelineGateReleased = false;
    const pipelineGate = new Promise<void>((resolve) => {
      releasePipelineGate = resolve;
    });
    const ensurePipelineGateReleased = () => {
      if (!pipelineGateReleased) {
        pipelineGateReleased = true;
        releasePipelineGate();
      }
    };

    let resolveReachedGate!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      resolveReachedGate = resolve;
    });

    // Retiene getPipelineInput SOLO para la primera llamada que lo alcance (la de B, que arranca
    // primero acá abajo) — simula la latencia real e inevitable de ese roundtrip, exactamente el
    // tramo que este fix mueve DESPUÉS del INSERT atómico en vez de ANTES.
    fieldsServiceMock.getPipelineInput.mockImplementationOnce(async (id: string) => {
      resolveReachedGate();
      await pipelineGate;
      return buildPipelineInput(id);
    });

    const promiseB = serviceB.runFieldAnalysis(fieldId, input, userId);
    let promiseA: Promise<Analysis> | undefined;
    let earlyError: unknown;

    try {
      await raceBarrierWithEarlyFailure(reachedGate, promiseB, 'promiseB (retenida en getPipelineInput)');

      // A arranca recién ahora, con getPipelineInput usando el mock por default (sin gate) — se
      // deja correr de punta a punta.
      promiseA = serviceA.runFieldAnalysis(fieldId, input, userId);
      const analysisAInitial = await promiseA;

      // Ventana breve y ACOTADA (no indefinida) para que A termine de punta a punta antes de
      // soltar a B, si es que ganó su propia fila — información, no una aserción: si en cambio A
      // reutilizó la fila de B (que sigue retenida en el gate), esta espera simplemente vence sin
      // novedad, y las aserciones que importan vienen después de soltar a B.
      await waitForTerminalStatus(repoA, analysisAInitial.id, {
        timeoutMs: 300,
        pollIntervalMs: 20,
      }).catch(() => undefined);
    } catch (error) {
      earlyError = error;
    } finally {
      ensurePipelineGateReleased();
      await Promise.allSettled([promiseA ?? Promise.resolve(undefined), promiseB]);
    }

    if (earlyError) {
      throw earlyError;
    }

    const analysisA = await promiseA!;
    const analysisB = await promiseB;

    expect(analysisA.id).toBe(analysisB.id);

    await waitForTerminalStatus(repoA, analysisA.id);

    const rows = await repoA.find({ where: { fieldId } });
    expect(rows).toHaveLength(1);

    expect(pythonWorkerServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(1);
  });

  // Corre última a propósito: down() saca el índice único de esta base de test descartable (no
  // se restaura después — la base entera se borra en afterAll). Verifica que la migración es
  // reversible de verdad (down() ejecuta sin error y el índice deja de existir), no solo que el
  // archivo lo declara.
  it('CASO 5 — las tres migraciones de F04 son reversibles: down() elimina cada índice/tabla sin error (UQ_analysis_running_per_field, UQ_analysis_client_request_per_field, analysis_client_request)', async () => {
    const beforeStatus = await bootstrapDataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
    );
    expect(beforeStatus).toHaveLength(1);

    const beforeClientRequestId = await bootstrapDataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_client_request_per_field'`,
    );
    expect(beforeClientRequestId).toHaveLength(1);

    const beforeAssociationTable = await bootstrapDataSource!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'analysis_client_request'`,
    );
    expect(beforeAssociationTable).toHaveLength(1);

    const queryRunner = bootstrapDataSource!.createQueryRunner();
    await queryRunner.connect();
    await new AddRunningAnalysisPerFieldUniqueIndex1788829462102().down(queryRunner);
    // F04 (revisión independiente, ronda 3): down() de la migración de clientRequestId también
    // saca la columna (además del índice) — se prueba SEGUNDA, después de la de arriba, sin
    // ningún orden particular exigido entre ambas (índices independientes, ninguna depende de la
    // otra para poder revertirse).
    await new AddAnalysisClientRequestId1788900000000().down(queryRunner);
    // F04 (revisión independiente, ronda 4): down() de la tabla de asociación se prueba TERCERA —
    // no depende de las dos anteriores tampoco (es una tabla nueva, sin relación estructural con
    // los índices sobre "analysis" más allá de la FK de lectura, que no impide el DROP TABLE de
    // esta tabla en sí).
    await new AddAnalysisClientRequestAssociationTable1788900000001().down(queryRunner);
    await queryRunner.release();

    const afterStatus = await bootstrapDataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_running_per_field'`,
    );
    expect(afterStatus).toHaveLength(0);

    const afterClientRequestId = await bootstrapDataSource!.query(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'UQ_analysis_client_request_per_field'`,
    );
    expect(afterClientRequestId).toHaveLength(0);

    const columnAfter = await bootstrapDataSource!.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'analysis' AND column_name = 'clientRequestId'`,
    );
    expect(columnAfter).toHaveLength(0);

    const afterAssociationTable = await bootstrapDataSource!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'analysis_client_request'`,
    );
    expect(afterAssociationTable).toHaveLength(0);
  });
});
