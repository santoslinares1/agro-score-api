import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { resolveDatabaseSsl } from './database-ssl.util';

/**
 * Opciones de conexión TypeORM compartidas por la API HTTP (AppModule) y por el proceso job
 * runner de ADR-001 (AnalysisJobRunnerModule) — misma base, mismas variables de entorno, mismas
 * reglas (synchronize solo con TYPEORM_SYNCHRONIZE=true explícito, SSL vía DATABASE_SSL).
 */
export function buildTypeOrmModuleOptions(
  config: ConfigService,
): TypeOrmModuleOptions {
  return {
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
  };
}
