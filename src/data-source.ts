import 'dotenv/config';
import { DataSource } from 'typeorm';

import { Analysis } from './analysis/entities/analysis.entity';
import { Field } from './fields/entities/field.entity';
import { FieldLot } from './fields/entities/field-lot.entity';
import { Lot } from './lots/entities/lot.entity';
import { User } from './users/user.entity';

/**
 * DataSource para el CLI de TypeORM (migration:generate/run/revert) y para
 * los scripts de mantenimiento (scripts/*.ts). No se usa en el bootstrap de
 * Nest: app.module.ts arma su propia conexión vía TypeOrmModule.forRootAsync
 * con las mismas variables de entorno, pero necesita su config aparte porque
 * el CLI corre fuera del ciclo de vida de Nest (sin ConfigModule).
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Field, FieldLot, Lot, Analysis],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
  synchronize: false,
});
