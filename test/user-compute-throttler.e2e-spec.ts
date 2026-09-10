/**
 * SEC-008: prueba conductual del rate limit por usuario en los 3 endpoints que disparan cómputo
 * caro — POST analysis/field/:fieldId, POST fields/:fieldId/analysis-schedule/run-now, POST
 * fields/:fieldId/weekly-reports. A diferencia de auth.controller.spec.ts (que solo inspecciona
 * metadata de decorators), esto monta una app Nest real con supertest y observa el 429 real.
 *
 * Deliberadamente SIN base de datos (ninguna de las tres) y SIN PythonWorkerService real:
 * AnalysisService/WeeklyReportsService/ScheduledAnalysisRunnerService/FieldAnalysisScheduleService
 * están completamente mockeados — lo único real es el guard chain (JwtAuthGuard real +
 * JwtStrategy real con UsersService mockeado + UserComputeThrottlerGuard real +
 * ThrottlerModule real). Esto prueba que la request ATRAVIESA el guard sin que eso implique
 * ejecutar Worker/Earth Engine real en ningún momento.
 *
 * Prueba específicamente que el bucket 'compute' es COMPARTIDO entre los 3 endpoints (no uno por
 * endpoint) y que está keyeado por usuario (req.user.sub), no por IP — dos requirements
 * explícitos de esta ficha.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { AnalysisController } from '../src/analysis/analysis.controller';
import { AnalysisService } from '../src/analysis/analysis.service';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { UserComputeThrottlerGuard } from '../src/common/guards/user-compute-throttler.guard';
import { FieldAnalysisScheduleService } from '../src/scheduled-analysis/field-analysis-schedule.service';
import { ScheduledAnalysisController } from '../src/scheduled-analysis/scheduled-analysis.controller';
import { ScheduledAnalysisRunnerService } from '../src/scheduled-analysis/scheduled-analysis-runner.service';
import { UserRole } from '../src/users/user-role.enum';
import { UsersService } from '../src/users/users.service';
import { WeeklyReportsController } from '../src/weekly-reports/weekly-reports.controller';
import { WeeklyReportsService } from '../src/weekly-reports/weekly-reports.service';

const TEST_JWT_SECRET =
  'sec-008-user-compute-throttler-e2e-test-secret-not-a-real-secret';

const FIELD_1 = '11111111-1111-4111-8111-111111111111';
const FIELD_2 = '22222222-2222-4222-8222-222222222222';

type FakeAuthUser = {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  tokenVersion: number;
};

function buildFakeUser(overrides: Partial<FakeAuthUser> = {}): FakeAuthUser {
  return {
    id: 'user-A',
    email: 'usera@example.com',
    role: UserRole.USER,
    isActive: true,
    tokenVersion: 0,
    ...overrides,
  };
}

describe('UserComputeThrottlerGuard — SEC-008 (e2e: bucket compartido, sin DB, sin Worker real)', () => {
  let app: INestApplication;
  let jwtService: JwtService;
  let usersServiceMock: { findById: jest.Mock };
  let analysisServiceMock: {
    runFieldAnalysis: jest.Mock;
    assertUserBelowConcurrencyCeiling: jest.Mock;
  };
  let weeklyReportsServiceMock: { create: jest.Mock };
  let runnerServiceMock: { runNow: jest.Mock };
  let scheduleServiceMock: { upsert: jest.Mock; get: jest.Mock };

  const userA = buildFakeUser({ id: 'user-A', email: 'usera@example.com' });
  const userB = buildFakeUser({ id: 'user-B', email: 'userb@example.com' });

  beforeEach(async () => {
    usersServiceMock = {
      findById: jest.fn((id: string) => {
        if (id === userA.id) return Promise.resolve(userA);
        if (id === userB.id) return Promise.resolve(userB);
        return Promise.resolve(null);
      }),
    };
    analysisServiceMock = {
      runFieldAnalysis: jest.fn().mockResolvedValue({ id: 'analysis-1' }),
      assertUserBelowConcurrencyCeiling: jest.fn().mockResolvedValue(undefined),
    };
    weeklyReportsServiceMock = {
      create: jest.fn().mockResolvedValue({ id: 'report-1' }),
    };
    runnerServiceMock = {
      runNow: jest.fn().mockResolvedValue({ id: 'run-1' }),
    };
    scheduleServiceMock = { upsert: jest.fn(), get: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        PassportModule,
        JwtModule.register({
          secret: TEST_JWT_SECRET,
          signOptions: { expiresIn: '1h' },
        }),
        // Mismos dos throttlers que app.module.ts real ('default' + 'compute') — un bucket
        // 'compute' fresco (storage en memoria) por cada test gracias a beforeEach.
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 20 },
          { name: 'compute', ttl: 600_000, limit: 10 },
        ]),
      ],
      controllers: [
        AnalysisController,
        ScheduledAnalysisController,
        WeeklyReportsController,
      ],
      providers: [
        JwtStrategy,
        UserComputeThrottlerGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'JWT_SECRET' ? TEST_JWT_SECRET : undefined,
          },
        },
        { provide: UsersService, useValue: usersServiceMock },
        { provide: AnalysisService, useValue: analysisServiceMock },
        { provide: WeeklyReportsService, useValue: weeklyReportsServiceMock },
        {
          provide: ScheduledAnalysisRunnerService,
          useValue: runnerServiceMock,
        },
        {
          provide: FieldAnalysisScheduleService,
          useValue: scheduleServiceMock,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    jwtService = moduleRef.get(JwtService);
  });

  afterEach(async () => {
    await app.close();
  });

  function tokenFor(user: FakeAuthUser): string {
    return jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
  }

  const analyzePayload = {
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    maxCloudiness: 30,
  };
  const weeklyReportPayload = {
    campaignStart: '2025-10-01',
    targetDate: '2026-08-21',
  };

  it(
    'bucket "compute" compartido: 9 análisis manuales + 1 weekly-report agotan el límite de ' +
      'user A; el 11vo request (cualquiera de los 3 endpoints) da 429; user B (misma conexión ' +
      'de test, "misma IP") sigue permitido — sin llamar nunca a runFieldAnalysis/create más de ' +
      'lo esperado y sin ejecutar Worker/Earth Engine real (todo mockeado)',
    async () => {
      const tokenA = tokenFor(userA);
      const tokenB = tokenFor(userB);

      // 1. User A consume 9 de las 10 unidades del bucket vía análisis manual (mismo endpoint,
      // dos campos distintos para no depender de ningún dedupe per-campo — acá solo interesa el
      // rate limit, PythonWorkerService está mockeado en su totalidad).
      for (let i = 0; i < 9; i++) {
        await request(app.getHttpServer())
          .post(`/analysis/field/${i % 2 === 0 ? FIELD_1 : FIELD_2}`)
          .set('Authorization', `Bearer ${tokenA}`)
          .send(analyzePayload)
          .expect(201);
      }

      // 2. User A usa la 10ma unidad vía weekly-reports — ENDPOINT DISTINTO. Si cada endpoint
      // tuviera su propio bucket (el bug que esta ficha corrige), esto pasaría con margen de
      // sobra (0 de 10 en un bucket "propio" de weekly-reports). Con el bucket compartido, esta
      // es la unidad #10 de 10 — todavía permitida.
      await request(app.getHttpServer())
        .post(`/fields/${FIELD_1}/weekly-reports`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(weeklyReportPayload)
        .expect(201);

      // 3. La request #11 de User A — otra vez análisis manual — debe rechazarse: ya consumió
      // las 10 unidades combinando los dos endpoints anteriores.
      await request(app.getHttpServer())
        .post(`/analysis/field/${FIELD_1}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(analyzePayload)
        .expect(429);

      // Y también run-now — TERCER endpoint, mismo bucket — debe estar bloqueado para User A en
      // este punto, demostrando que los 3 comparten el mismo contador.
      await request(app.getHttpServer())
        .post(`/fields/${FIELD_1}/analysis-schedule/run-now`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(429);

      // 4. User B — la misma conexión de test/"misma IP" que User A — sigue permitido: el bucket
      // 'compute' está keyeado por req.user.sub (UserComputeThrottlerGuard.getTracker), no por
      // IP. Si estuviera keyeado por IP, esta request también daría 429.
      await request(app.getHttpServer())
        .post(`/analysis/field/${FIELD_1}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send(analyzePayload)
        .expect(201);

      // Efectos reales: exactamente 9 (manual) + 1 (userB) = 10 llamadas a runFieldAnalysis,
      // exactamente 1 a weekly-reports.create, CERO a runNow (las dos únicas veces que se pidió
      // ya estaban bloqueadas por el guard, antes de llegar al controller/service) — nada de
      // esto tocó Earth Engine ni el Worker real, todo mockeado.
      expect(analysisServiceMock.runFieldAnalysis).toHaveBeenCalledTimes(10);
      expect(weeklyReportsServiceMock.create).toHaveBeenCalledTimes(1);
      expect(runnerServiceMock.runNow).not.toHaveBeenCalled();
    },
  );

  it('sin token, las 3 rutas de cómputo rechazan con 401 antes de tocar el guard de compute (JwtAuthGuard corre primero)', async () => {
    await request(app.getHttpServer())
      .post(`/analysis/field/${FIELD_1}`)
      .send(analyzePayload)
      .expect(401);

    await request(app.getHttpServer())
      .post(`/fields/${FIELD_1}/weekly-reports`)
      .send(weeklyReportPayload)
      .expect(401);

    await request(app.getHttpServer())
      .post(`/fields/${FIELD_1}/analysis-schedule/run-now`)
      .expect(401);

    expect(analysisServiceMock.runFieldAnalysis).not.toHaveBeenCalled();
    expect(weeklyReportsServiceMock.create).not.toHaveBeenCalled();
    expect(runnerServiceMock.runNow).not.toHaveBeenCalled();
  });
});
