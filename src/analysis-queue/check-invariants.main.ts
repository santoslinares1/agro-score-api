import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { buildTypeOrmModuleOptions } from '../config/typeorm-options.util';
import { AppDataSource } from '../data-source';
import { AnalysisQueueInvariantsService } from './analysis-queue-invariants.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        ...buildTypeOrmModuleOptions(config),
        autoLoadEntities: false,
        entities: AppDataSource.options.entities,
        synchronize: false,
      }),
    }),
  ],
  providers: [AnalysisQueueInvariantsService],
})
class CheckInvariantsModule {}

/**
 * ADR-001: `npm run queue:check-invariants` (o `node dist/src/analysis-queue/check-invariants.main.js`
 * en la imagen). Solo lectura. Imprime las violaciones en JSON y sale con código 1 si hay alguna.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    CheckInvariantsModule,
    {
      logger: ['error', 'warn'],
    },
  );

  try {
    const violations = await app.get(AnalysisQueueInvariantsService).check();
    console.log(JSON.stringify({ violations }, null, 2));
    process.exitCode = violations.length > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main().catch((error: Error) => {
  console.error(`[queue:check-invariants] ${error.message}`);
  process.exit(2);
});
