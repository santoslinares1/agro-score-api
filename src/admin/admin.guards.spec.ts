import {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UserRole } from '../users/user-role.enum';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

/**
 * ADMIN-1: reemplaza JwtAuthGuard real (que depende de Passport + un JWT
 * válido) por un doble de prueba que simula exactamente el mismo contrato:
 * puebla request.user si viene un header de test, o deniega si no viene
 * (equivalente a "sin JWT"). RolesGuard, en cambio, es el real — así este
 * test valida la composición real @UseGuards(JwtAuthGuard, RolesGuard) +
 * @Roles(owner, admin) tal como está declarada en AdminController, no una
 * reimplementación en memoria de la política.
 */
class FakeJwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-test-role'];

    if (!role) {
      return false;
    }

    req.user = { sub: 'test-user-id', email: 'test@agroscorelatam.com', role };
    return true;
  }
}

describe('/admin/* — guards de rol (ADMIN-1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: AdminService,
          useValue: {
            getMetrics: jest.fn().mockResolvedValue({ totalUsers: 0 }),
            getSystemHealth: jest
              .fn()
              .mockResolvedValue({ api: { status: 'ok' } }),
            listAuditLogs: jest
              .fn()
              .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20 }),
            getProductAnalytics: jest.fn().mockResolvedValue({
              generatedAt: new Date().toISOString(),
              funnel: [],
              insights: [],
              weeklyMonitoring: {
                totalFields: 0,
                activeSchedules: 0,
                activeSchedulesWithoutRuns: 0,
                schedulesWithRuns: 0,
                sentEmails: 0,
              },
              topAnalysisErrorsLast30Days: [],
            }),
            getFieldDetail: jest.fn().mockResolvedValue({
              field: {
                id: 'field-1',
                analysisStatus: 'without_analysis',
                requiresAttention: false,
              },
              latestAnalysis: null,
              technicalVerdict: null,
              lots: [],
              analyses: [],
              weeklyMonitoring: {
                active: false,
                scheduleId: null,
                frequency: null,
                nextRunAt: null,
                lastRunAt: null,
                hasRuns: false,
              },
              scheduledRuns: [],
            }),
            getUserDetail: jest.fn().mockResolvedValue({
              user: { id: 'user-1', email: 'user@agroscorelatam.com' },
              summary: {
                fieldsCount: 0,
                lotsCount: 0,
                analysesCount: 0,
                completedAnalysesCount: 0,
                failedAnalysesCount: 0,
                fieldsWithoutAnalysisCount: 0,
                fieldsRequiringAttentionCount: 0,
                activeSchedulesCount: 0,
                schedulesWithoutRunsCount: 0,
                sentEmailsCount: 0,
              },
              fields: [],
              recentAnalyses: [],
              scheduledAnalysis: [],
              recentAuditLogs: [],
            }),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(FakeJwtAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('sin JWT (sin header de test) no entra', async () => {
    await request(app.getHttpServer()).get('/admin/metrics').expect(403);
  });

  it('usuario con role "user" no entra', async () => {
    await request(app.getHttpServer())
      .get('/admin/metrics')
      .set('x-test-role', UserRole.USER)
      .expect(403);
  });

  it('usuario con role "admin" entra', async () => {
    await request(app.getHttpServer())
      .get('/admin/metrics')
      .set('x-test-role', UserRole.ADMIN)
      .expect(200);
  });

  it('usuario con role "owner" entra', async () => {
    await request(app.getHttpServer())
      .get('/admin/metrics')
      .set('x-test-role', UserRole.OWNER)
      .expect(200);
  });

  // ADMIN-2: mismos endpoints nuevos, misma composición de guards a nivel
  // controller — confirma que no quedaron desprotegidos "por error de
  // copiar/pegar" al agregarlos.
  it('GET /admin/system/health — role "user" no entra, "owner" sí', async () => {
    await request(app.getHttpServer())
      .get('/admin/system/health')
      .set('x-test-role', UserRole.USER)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/system/health')
      .set('x-test-role', UserRole.OWNER)
      .expect(200);
  });

  it('GET /admin/audit-logs — role "user" no entra, "admin" sí', async () => {
    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('x-test-role', UserRole.USER)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/audit-logs')
      .set('x-test-role', UserRole.ADMIN)
      .expect(200);
  });

  // Admin PR 4: mismo endpoint nuevo, misma composición de guards a nivel controller.
  it('GET /admin/product-analytics — role "user" no entra, "admin" sí', async () => {
    await request(app.getHttpServer())
      .get('/admin/product-analytics')
      .set('x-test-role', UserRole.USER)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/product-analytics')
      .set('x-test-role', UserRole.ADMIN)
      .expect(200);
  });

  // Admin PR 6: mismo endpoint nuevo, misma composición de guards — los guards corren ANTES que
  // ParseUUIDPipe, así que un role sin permiso da 403 aunque el :fieldId ni siquiera sea un UUID
  // válido.
  it('GET /admin/fields/:fieldId — role "user" no entra, "admin" sí', async () => {
    await request(app.getHttpServer())
      .get('/admin/fields/a1111111-1111-4111-8111-111111111111')
      .set('x-test-role', UserRole.USER)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/fields/a1111111-1111-4111-8111-111111111111')
      .set('x-test-role', UserRole.ADMIN)
      .expect(200);
  });

  // Admin PR 7: mismo endpoint nuevo, misma composición de guards — GET 'users/:userId' convive
  // sin ambigüedad con PATCH/DELETE/POST 'users/:id' (métodos HTTP distintos).
  it('GET /admin/users/:userId — role "user" no entra, "admin" sí', async () => {
    await request(app.getHttpServer())
      .get('/admin/users/a1111111-1111-4111-8111-111111111111')
      .set('x-test-role', UserRole.USER)
      .expect(403);

    await request(app.getHttpServer())
      .get('/admin/users/a1111111-1111-4111-8111-111111111111')
      .set('x-test-role', UserRole.ADMIN)
      .expect(200);
  });
});
