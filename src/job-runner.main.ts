import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AnalysisJobRunnerModule } from './analysis-queue/analysis-job-runner.module';
import { AnalysisJobRunnerService } from './analysis-queue/analysis-job-runner.service';

/**
 * ADR-001: entrypoint del proceso job runner. Misma imagen que la API, otro comando:
 *   node dist/src/job-runner.main.js
 * No abre ningún puerto (createApplicationContext, nunca app.listen). SIGTERM/SIGINT → stop
 * ordenado (ver AnalysisJobRunnerService.stop) y salida con código 0.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('JobRunner');
  let runner: AnalysisJobRunnerService | null = null;
  let app: INestApplicationContext | null = null;
  let shuttingDown = false;

  // Registrados ANTES del bootstrap: un SIGTERM mientras todavía conecta a la base (reintentos de
  // TypeORM) también termina de forma ordenada, sin haber tomado ningún job.
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log(`${signal} recibido: deteniendo el job runner…`);

    try {
      await runner?.stop();
      await app?.close();
      process.exit(0);
    } catch (error) {
      logger.error(
        `Fallo durante el shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  app = await NestFactory.createApplicationContext(AnalysisJobRunnerModule);
  const started = app.get(AnalysisJobRunnerService);
  runner = started;

  if (!shuttingDown) {
    await started.start();
  }
}

bootstrap().catch((error: Error) => {
  console.error(`[job-runner] No se pudo iniciar: ${error.message}`);
  process.exit(1);
});
