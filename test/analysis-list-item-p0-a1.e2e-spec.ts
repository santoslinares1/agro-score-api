// P0-A1 (auditoría de performance autenticada, 2026-09-15): AnalysisService.findAll() contra
// PostgreSQL real, en una base aislada y desechable creada por esta misma ejecución (nunca
// `agro_score` ni las variables DB_* generales del backend, ver
// test/support/isolated-postgres-database.ts).
//
// Por qué un test aparte de analysis.service.spec.ts (unitario, con analysisRepository.query
// mockeado): un mock puede demostrar que el service arma el SQL y mapea filas crudas al DTO
// liviano, pero no puede demostrar que el join de ownership (`f."id"::text = a."fieldId"`, con el
// fallback scope=null → lotId) resuelve igual contra Postgres real, ni que el path JSONB
// (`resultJson -> 'dataAvailability' ->> 'globalScore'`) extrae la señal correcta desde un jsonb
// persistido de verdad — incluido uno con un resultJson realista (imageSeries en base64) que
// nunca debe viajar de vuelta en la respuesta.
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { Repository } from 'typeorm';

import { Analysis } from '../src/analysis/entities/analysis.entity';
import { AnalysisService } from '../src/analysis/analysis.service';
import { AnalysisVerdictService } from '../src/analysis-verdict/analysis-verdict.service';
import { Field } from '../src/fields/entities/field.entity';
import { FieldLot } from '../src/fields/entities/field-lot.entity';
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

describe('P0-A1 — AnalysisService.findAll() real (PostgreSQL real, base aislada por ejecución)', () => {
  let target: TestDatabaseTarget;
  let createdDatabaseName: string | null = null;
  let moduleRef: TestingModule | undefined;

  let service: AnalysisService;
  let userRepo: Repository<User>;
  let fieldRepo: Repository<Field>;
  let analysisRepo: Repository<Analysis>;
  let seedCounter = 0;

  beforeAll(async () => {
    target = resolveExplicitTestDatabaseTarget();

    const created = await createIsolatedTestDatabase(target, 'analysis_list_item_p0_a1');
    createdDatabaseName = created.name;

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          database: createdDatabaseName,
          entities: [User, Field, FieldLot, Analysis],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([User, Field, FieldLot, Analysis]),
      ],
      providers: [
        AnalysisService,
        FieldsService, // real: el join de ownership es justo lo que se quiere probar.
        { provide: PythonWorkerService, useValue: {} },
        { provide: ReportPdfService, useValue: {} },
        { provide: AnalysisVerdictService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(AnalysisService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    fieldRepo = moduleRef.get(getRepositoryToken(Field));
    analysisRepo = moduleRef.get(getRepositoryToken(Analysis));
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    if (moduleRef) {
      try {
        await moduleRef.close();
      } catch (error) {
        cleanupErrors.push(error);
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
        'Fallo(s) durante la limpieza de esta suite — ver causas.',
      );
    }
  });

  async function seedUserAndField(fieldName = 'Campo'): Promise<{ user: User; field: Field }> {
    seedCounter += 1;
    const user = await userRepo.save(
      userRepo.create({
        email: `p0-a1-user-${seedCounter}-${Date.now()}@example.com`,
        passwordHash: 'hash-no-usado',
        fullName: `Usuario ${seedCounter}`,
      }),
    );
    const field = await fieldRepo.save(
      fieldRepo.create({
        userId: user.id,
        name: `${fieldName} ${seedCounter}`,
        totalAreaHa: 10,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        lots: [],
      }),
    );
    return { user, field };
  }

  async function seedAnalysis(
    field: Field,
    overrides: Partial<Analysis> = {},
  ): Promise<Analysis> {
    return analysisRepo.save(
      analysisRepo.create({
        fieldId: field.id,
        scope: 'field',
        lotName: field.name,
        status: 'Finalizado',
        globalScore: 70,
        category: 'Buena aptitud productiva con variabilidad moderada',
        startDate: '2026-01-01',
        endDate: '2026-01-08',
        ...overrides,
      }),
    );
  }

  // Payload realista: un imageSeries con base64 "pesado" (simulado con una string larga, no una
  // imagen real, pero del mismo orden de magnitud de bytes que un PNG chico) — la prueba real es
  // que NADA de esto viaje de vuelta en la respuesta de findAll(), sin importar cuánto pese.
  function heavyResultJson(globalScoreAvailable: boolean | undefined): Analysis['resultJson'] {
    return {
      mode: 'python-worker-v2',
      message: '',
      ...(globalScoreAvailable === undefined
        ? {}
        : { dataAvailability: { globalScore: globalScoreAvailable } }),
      imageSeries: {
        ndvi: [{ images: [{ image_base64: 'A'.repeat(50_000) }] }],
      },
    } as unknown as Analysis['resultJson'];
  }

  it('OWNERSHIP REAL — cada usuario ve únicamente los análisis de sus propios campos', async () => {
    const { user: userA, field: fieldA } = await seedUserAndField('Campo de A');
    const { user: userB, field: fieldB } = await seedUserAndField('Campo de B');

    const analysisA = await seedAnalysis(fieldA, { resultJson: heavyResultJson(true) });
    await seedAnalysis(fieldB, { resultJson: heavyResultJson(true) });

    const resultA = await service.findAll(userA.id);

    expect(resultA).toHaveLength(1);
    expect(resultA[0].id).toBe(analysisA.id);
    expect(resultA[0].fieldId).toBe(fieldA.id);

    const resultB = await service.findAll(userB.id);
    expect(resultB).toHaveLength(1);
    expect(resultB[0].fieldId).toBe(fieldB.id);
  });

  it('P0-A1 — nunca devuelve resultJson, sin importar cuánto pese el jsonb real en la fila', async () => {
    const { user, field } = await seedUserAndField();
    await seedAnalysis(field, { resultJson: heavyResultJson(true) });

    const [item] = await service.findAll(user.id);

    expect(item).not.toHaveProperty('resultJson');
    expect(Object.keys(item).sort()).toEqual(
      [
        'category',
        'createdAt',
        'fieldId',
        'globalScore',
        'globalScoreAvailable',
        'id',
        'lotId',
        'lotName',
        'scope',
        'status',
      ].sort(),
    );
  });

  it('ordena por createdAt DESC (real, contra Postgres)', async () => {
    const { user, field } = await seedUserAndField();
    const older = await seedAnalysis(field, {
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = await seedAnalysis(field, {
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });

    const result = await service.findAll(user.id);

    expect(result.map((a) => a.id)).toEqual([newer.id, older.id]);
  });

  it('F01 — globalScoreAvailable=false solo cuando resultJson.dataAvailability.globalScore es explícitamente false (real, path JSONB)', async () => {
    const { user, field } = await seedUserAndField();
    const sinEvidencia = await seedAnalysis(field, {
      resultJson: heavyResultJson(false),
      globalScore: 0,
    });

    const [item] = await service.findAll(user.id);

    expect(item.id).toBe(sinEvidencia.id);
    expect(item.globalScoreAvailable).toBe(false);
  });

  it('F01 — globalScoreAvailable=true cuando resultJson no tiene dataAvailability (compatibilidad histórica, real)', async () => {
    const { user, field } = await seedUserAndField();
    await seedAnalysis(field, { resultJson: heavyResultJson(undefined) });

    const [item] = await service.findAll(user.id);

    expect(item.globalScoreAvailable).toBe(true);
  });

  it('F01 — globalScoreAvailable=true cuando resultJson es null (análisis sin pipeline corrido aún, real)', async () => {
    const { user, field } = await seedUserAndField();
    await seedAnalysis(field, { resultJson: null });

    const [item] = await service.findAll(user.id);

    expect(item.globalScoreAvailable).toBe(true);
  });

  it('AUTH-3 — un análisis scope=\'lot\' legacy (sin Field/User verificable) no aparece para nadie', async () => {
    const { user, field } = await seedUserAndField();
    await seedAnalysis(field, { resultJson: heavyResultJson(true) }); // el único que debe verse.
    await analysisRepo.save(
      analysisRepo.create({
        scope: 'lot',
        lotId: 'lot-huerfano-sin-relacion',
        fieldId: null,
        lotName: 'Lote legacy sin owner verificable',
        status: 'Finalizado',
        globalScore: 90,
        category: 'N/A',
        startDate: '2026-01-01',
        endDate: '2026-01-08',
        resultJson: heavyResultJson(true),
      }),
    );

    const result = await service.findAll(user.id);

    expect(result).toHaveLength(1);
    expect(result.every((a) => a.scope !== 'lot')).toBe(true);
  });

  it('legacy scope=null con fieldId guardado en lotId sigue resolviéndose por ownership (real)', async () => {
    const { user, field } = await seedUserAndField();
    const legacy = await analysisRepo.save(
      analysisRepo.create({
        scope: null,
        lotId: field.id, // convención legacy: el fieldId histórico vive en lotId.
        fieldId: null,
        lotName: field.name,
        status: 'Finalizado',
        globalScore: 60,
        category: 'Aptitud media',
        startDate: '2026-01-01',
        endDate: '2026-01-08',
        resultJson: heavyResultJson(true),
      }),
    );

    const result = await service.findAll(user.id);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(legacy.id);
    expect(result[0].lotId).toBe(field.id);
  });

  it('usuario sin ningún análisis recibe lista vacía (real)', async () => {
    const { user } = await seedUserAndField();

    const result = await service.findAll(user.id);

    expect(result).toEqual([]);
  });
});
