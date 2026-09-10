import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerModuleOptions, ThrottlerStorage } from '@nestjs/throttler';

import { UserComputeThrottlerGuard } from './user-compute-throttler.guard';

describe('UserComputeThrottlerGuard (SEC-008)', () => {
  const options: ThrottlerModuleOptions = [
    { name: 'compute', ttl: 600_000, limit: 10 },
  ];
  const storageService = {} as ThrottlerStorage;
  const reflector = {} as Reflector;

  let guard: UserComputeThrottlerGuard;

  beforeEach(() => {
    guard = new UserComputeThrottlerGuard(options, storageService, reflector);
  });

  describe('getTracker', () => {
    it('usa req.user.sub como identidad cuando está autenticado', async () => {
      const tracker = await (guard as any).getTracker({
        user: { sub: 'user-A' },
        ip: '1.2.3.4',
      });

      expect(tracker).toBe('user-A');
    });

    it('cae a req.ip solo si no hay req.user (defensivo — JwtAuthGuard ya debería haber rechazado antes)', async () => {
      const tracker = await (guard as any).getTracker({ ip: '1.2.3.4' });

      expect(tracker).toBe('1.2.3.4');
    });
  });

  describe('generateKey', () => {
    const fakeContext = {
      getClass: () => ({ name: 'AnalysisController' }),
      getHandler: () => ({ name: 'runFieldAnalysis' }),
    } as unknown as ExecutionContext;

    const otherFakeContext = {
      getClass: () => ({ name: 'WeeklyReportsController' }),
      getHandler: () => ({ name: 'create' }),
    } as unknown as ExecutionContext;

    it('para el throttler "compute", ignora clase/handler — misma key para el mismo usuario desde controllers distintos', () => {
      const keyFromAnalysis = (guard as any).generateKey(
        fakeContext,
        'user-A',
        'compute',
      );
      const keyFromWeekly = (guard as any).generateKey(
        otherFakeContext,
        'user-A',
        'compute',
      );

      expect(keyFromAnalysis).toBe(keyFromWeekly);
    });

    it('para el throttler "compute", usuarios distintos obtienen keys distintas', () => {
      const keyUserA = (guard as any).generateKey(
        fakeContext,
        'user-A',
        'compute',
      );
      const keyUserB = (guard as any).generateKey(
        fakeContext,
        'user-B',
        'compute',
      );

      expect(keyUserA).not.toBe(keyUserB);
    });

    it('para cualquier otro throttler (ej. "default"), delega al comportamiento original de ThrottlerGuard (key distinta por controller/handler)', () => {
      const keyFromAnalysis = (guard as any).generateKey(
        fakeContext,
        'user-A',
        'default',
      );
      const keyFromWeekly = (guard as any).generateKey(
        otherFakeContext,
        'user-A',
        'default',
      );

      expect(keyFromAnalysis).not.toBe(keyFromWeekly);
    });
  });

  describe('getErrorMessage', () => {
    it('devuelve un mensaje en español, sin detalles internos', async () => {
      const message = await (guard as any).getErrorMessage();

      expect(message).toMatch(/[a-záéíóúñ]/i);
      expect(message.toLowerCase()).not.toContain('earth engine');
      expect(message.toLowerCase()).not.toContain('throttler');
    });
  });
});
