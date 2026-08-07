import 'dotenv/config';
import { DataSource } from 'typeorm';

import { AccessRequest } from './access-request/entities/access-request.entity';
import { Analysis } from './analysis/entities/analysis.entity';
import { AdminAuditLog } from './audit-log/entities/admin-audit-log.entity';
import { resolveDatabaseSsl } from './config/database-ssl.util';
import { Field } from './fields/entities/field.entity';
import { FieldLot } from './fields/entities/field-lot.entity';
import { PasswordResetToken } from './users/entities/password-reset-token.entity';
import { UserInvitation } from './users/entities/user-invitation.entity';
import { User } from './users/user.entity';

/**
 * DataSource para el CLI de TypeORM (migration:generate/run/revert) y para
 * los scripts de mantenimiento (scripts/*.ts). No se usa en el bootstrap de
 * Nest: app.module.ts arma su propia conexión vía TypeOrmModule.forRootAsync
 * con las mismas variables de entorno, pero necesita su config aparte porque
 * el CLI corre fuera del ciclo de vida de Nest (sin ConfigModule).
 *
 * CLEANUP-2: la entidad `Lot` (tabla `lots`, legacy) se borró y ya no está
 * acá. La tabla sigue existiendo en la DB con sus datos intactos (no se
 * tocó), pero TypeORM ya no la gestiona. Ojo: si en el futuro se corre
 * `migration:generate`, el diff resultante va a proponer un DROP TABLE
 * "lots" (porque ninguna entidad la describe ya) — revisar esa migración a
 * mano y sacar esa sentencia si todavía no se quiere borrar la tabla.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [
    User,
    Field,
    FieldLot,
    Analysis,
    AccessRequest,
    AdminAuditLog,
    UserInvitation,
    PasswordResetToken,
  ],
  migrations: ['src/migrations/*.ts'],
  migrationsTableName: 'migrations',
  synchronize: false,
  // SEC-004: mismo criterio que app.module.ts — ver config/database-ssl.util.ts.
  ssl: resolveDatabaseSsl(
    process.env.DATABASE_SSL,
    process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  ),
});
