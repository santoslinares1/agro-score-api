import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LotsModule } from './lots/lots.module';
import { AnalysisModule } from './analysis/analysis.module';
import { PythonWorkerModule } from './python-worker/python-worker.module';
import { FieldsModule } from './fields/fields.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST'),
        port: Number(config.get<string>('DB_PORT')),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        autoLoadEntities: true,
        synchronize: true,
      }),
    }),

    LotsModule,
    AnalysisModule,
    PythonWorkerModule,
    FieldsModule,
  ],
})
export class AppModule {}
