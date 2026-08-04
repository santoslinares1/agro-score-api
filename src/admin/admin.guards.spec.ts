import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
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
});
