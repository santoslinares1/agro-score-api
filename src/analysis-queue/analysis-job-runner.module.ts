import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AnalysisModule } from '../analysis/analysis.module';
import { resolveDatabaseSsl } from '../config/database-ssl.util';
import { buildTypeOrmModuleOptions } from '../config/typeorm-options.util';
import { AppDataSource } from '../data-source';
import { PythonWorkerModule } from '../python-worker/python-worker.module';
import { AnalysisExecutionStore } from './analysis-execution.store';
import { AnalysisJobConsumerService } from './analysis-job-consumer.service';
import {
  ANALYSIS_JOB_QUEUE,
  PgBossAnalysisJobQueue,
} from './analysis-job-queue';
import { AnalysisJobReconcilerService } from './analysis-job-reconciler.service';
import { AnalysisJobRunnerService } from './analysis-job-runner.service';
import { AnalysisOutboxDispatcherService } from './analysis-outbox-dispatcher.service';
import {
  ANALYSIS_QUEUE_CONFIG,
  AnalysisQueueConfig,
} from './analysis-queue.config';
import { AnalysisQueueInvariantsService } from './analysis-queue-invariants.service';

/**
 * ADR-001: módulo raíz del proceso job runner (NestFactory.createApplicationContext — sin
 * servidor HTTP, sin controllers expuestos). No importa ScheduleModule: los @Interval de la API
 * (scheduler semanal, reconciliador legacy) NO corren en este proceso; y AppModule (la API) no
 * importa este módulo: el proceso web nunca consume jobs.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // Lista explícita (la misma del CLI de migraciones): este proceso no importa todos los
      // módulos de la API, así que autoLoadEntities no alcanzaría para resolver relaciones como
      // Analysis → User.
      useFactory: (config: ConfigService) => ({
        ...buildTypeOrmModuleOptions(config),
        autoLoadEntities: false,
        entities: AppDataSource.options.entities,
      }),
    }),
    // Solo para resolver UserComputeThrottlerGuard, que AnalysisModule declara como provider: este
    // proceso no sirve HTTP, así que ningún límite llega a aplicarse.
    ThrottlerModule.forRoot([]),
    AnalysisModule,
    PythonWorkerModule,
  ],
  providers: [
    {
      provide: ANALYSIS_JOB_QUEUE,
      inject: [ANALYSIS_QUEUE_CONFIG, ConfigService],
      useFactory: (queueConfig: AnalysisQueueConfig, config: ConfigService) =>
        new PgBossAnalysisJobQueue(queueConfig, {
          host: config.get<string>('DB_HOST'),
          port: Number(config.get<string>('DB_PORT')),
          user: config.get<string>('DB_USER'),
          password: config.get<string>('DB_PASSWORD'),
          database: config.get<string>('DB_NAME'),
          ssl: resolveDatabaseSsl(
            config.get<string>('DATABASE_SSL'),
            config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED'),
          ),
        }),
    },
    AnalysisExecutionStore,
    AnalysisOutboxDispatcherService,
    AnalysisJobConsumerService,
    AnalysisJobReconcilerService,
    AnalysisQueueInvariantsService,
    AnalysisJobRunnerService,
  ],
})
export class AnalysisJobRunnerModule {}
