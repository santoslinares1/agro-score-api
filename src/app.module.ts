import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { resolveDatabaseSsl } from './config/database-ssl.util';
import { LotsModule } from './lots/lots.module';
import { AnalysisModule } from './analysis/analysis.module';
import { PythonWorkerModule } from './python-worker/python-worker.module';
import { FieldsModule } from './fields/fields.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { ContactModule } from './contact/contact.module';
import { AccessRequestModule } from './access-request/access-request.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

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
    ]),

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
        // AUTH-2: el esquema ahora se versiona con migrations (ver
        // src/data-source.ts y src/migrations/). synchronize solo se
        // habilita si TYPEORM_SYNCHRONIZE=true está seteado explícito;
        // por default (incluido local) queda en false.
        synchronize: config.get<string>('TYPEORM_SYNCHRONIZE') === 'true',
        // SEC-004: SSL off por default (Postgres de Docker local no habla
        // TLS); se activa con DATABASE_SSL=true contra RDS/Postgres remoto.
        ssl: resolveDatabaseSsl(
          config.get<string>('DATABASE_SSL'),
          config.get<string>('DATABASE_SSL_REJECT_UNAUTHORIZED'),
        ),
      }),
    }),

    LotsModule,
    AnalysisModule,
    PythonWorkerModule,
    FieldsModule,
    UsersModule,
    AuthModule,
    ContactModule,
    AccessRequestModule,
  ],
})
export class AppModule {}
