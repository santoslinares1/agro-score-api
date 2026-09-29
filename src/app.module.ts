import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildTypeOrmModuleOptions } from './config/typeorm-options.util';
import { LotsModule } from './lots/lots.module';
import { AnalysisModule } from './analysis/analysis.module';
import { PythonWorkerModule } from './python-worker/python-worker.module';
import { FieldsModule } from './fields/fields.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ContactModule } from './contact/contact.module';
import { AccessRequestModule } from './access-request/access-request.module';
import { AdminModule } from './admin/admin.module';
import { WeeklyReportsModule } from './weekly-reports/weekly-reports.module';
import { ScheduledAnalysisModule } from './scheduled-analysis/scheduled-analysis.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    // Fase 4A (scheduled-analysis): habilita @Interval()/@Cron() en toda la app. Un único
    // registro global acá alcanza — los feature modules no vuelven a importar ScheduleModule.
    ScheduleModule.forRoot(),

    // SEC-FIX-1 (SEC-003): baseline global para @Throttle() puntual en rutas
    // públicas sensibles (/auth/login, /auth/register, /contact). No se
    // aplica como guard global — cada endpoint que lo necesita usa
    // @UseGuards(ThrottlerGuard) + @Throttle() explícito, así no cambia el
    // comportamiento del resto de la API. Deuda conocida: almacenamiento en
    // memoria del proceso, no compartido entre instancias — si en el futuro
    // se corre el backend con más de una réplica, migrar a un storage
    // compartido (ej. Redis) para que el límite sea efectivo entre todas.
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 20,
      },
      // SEC-008: bucket separado, compartido por usuario, para los 3 endpoints que disparan
      // cómputo caro (análisis manual, run-now, weekly-reports) — ver UserComputeThrottlerGuard.
      // Los límites reales van en @Throttle({ compute: {...} }) por ruta (mismo patrón que
      // 'default' en SEC-003); esto solo declara que el throttler existe. Igual que 'default',
      // almacenamiento en memoria del proceso — deuda conocida para multi-instancia, no nueva.
      {
        name: 'compute',
        ttl: 600_000,
        limit: 10,
      },
    ]),

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildTypeOrmModuleOptions,
    }),

    LotsModule,
    AnalysisModule,
    PythonWorkerModule,
    FieldsModule,
    UsersModule,
    AuthModule,
    ContactModule,
    AccessRequestModule,
    AdminModule,
    WeeklyReportsModule,
    ScheduledAnalysisModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
