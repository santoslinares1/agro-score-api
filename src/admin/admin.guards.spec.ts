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
});
