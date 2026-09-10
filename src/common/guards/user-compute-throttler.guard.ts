import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * SEC-008: rate limiting keyeado por usuario autenticado (no por IP), con un único bucket
 * COMPARTIDO entre los 3 endpoints que disparan cómputo caro vía PythonWorkerService (Earth
 * Engine): POST analysis/field/:fieldId, POST fields/:fieldId/analysis-schedule/run-now, POST
 * fields/:fieldId/weekly-reports. La raíz de SEC-004 es "cuánto cómputo puede disparar un usuario
 * en total", no "cuánto por endpoint" — si cada endpoint tuviera su propio bucket, un usuario
 * podría sumarlos y triplicar el límite real usando los tres caminos. El bucket 'default' (SEC-003)
 * sigue existiendo para rutas públicas pre-auth (login/register/contact) — este es un bucket NUEVO
 * ('compute'), no lo reemplaza ni lo toca.
 *
 * SIEMPRE debe ir DESPUÉS de JwtAuthGuard en @UseGuards (mismo precedente ya existente en
 * auth.controller.ts: change-password/deactivate-account): req.user recién existe una vez que
 * JwtAuthGuard corrió su propio canActivate. El fallback a req.ip es defensivo únicamente — en la
 * práctica JwtAuthGuard ya rechazó cualquier request sin sesión válida antes de que este guard
 * llegue a ejecutarse.
 */
@Injectable()
export class UserComputeThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storageService, reflector);
  }

  protected getTracker(req: Record<string, any>): Promise<string> {
    const authenticatedUser = req.user as { sub?: string } | undefined;

    return Promise.resolve(authenticatedUser?.sub ?? (req.ip as string));
  }

  /**
   * El default de ThrottlerGuard arma la key como
   * `sha256(ControllerClass-handlerName-throttlerName-tracker)` — eso le da a CADA endpoint su
   * propio bucket, incluso con el mismo tracker. Acá, para el throttler 'compute' específicamente,
   * la key ignora a propósito controller/handler (`context`): solo importan el nombre del
   * throttler y el tracker (ya resuelto por getTracker de arriba), así
   * analysis/field/:fieldId, run-now y weekly-reports comparten literalmente el mismo contador en
   * ThrottlerStorageService para un mismo usuario. Cualquier otro throttler (ej. 'default') sigue
   * el comportamiento original de la librería sin cambios.
   */
  protected generateKey(
    context: ExecutionContext,
    suffix: string,
    name: string,
  ): string {
    if (name !== 'compute') {
      return super.generateKey(context, suffix, name);
    }

    return `compute-${suffix}`;
  }

  protected getErrorMessage(): Promise<string> {
    return Promise.resolve(
      'Demasiadas solicitudes de análisis. Esperá unos minutos antes de volver a intentarlo.',
    );
  }
}
