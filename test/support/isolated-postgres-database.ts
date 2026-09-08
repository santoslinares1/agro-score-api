// F03: soporte reusable para tests e2e que necesitan una base PostgreSQL propia y aislada —
// extraído para no repetir esta lógica en cada suite e2e que la necesite, y para poder testear el
// mecanismo de creación/limpieza en sí mismo (ver isolated-postgres-database.e2e-spec.ts).
//
// Reglas duras de esta ayuda (motivadas por un hallazgo real de una revisión anterior):
// - NUNCA asume que las variables generales DB_* del backend apuntan a un servidor seguro para
//   tests — exige variables TEST_DB_* explícitas, sin fallback silencioso.
// - NUNCA hace un DROP preventivo de una base que ya existía antes de esta ejecución — si el
//   nombre generado colisiona, reintenta con otro nombre; jamás toca la base encontrada.
// - Cada base creada lleva un nombre único por ejecución (pid + timestamp + bytes aleatorios), así
//   que dos ejecuciones concurrentes de la misma suite nunca pueden pisarse.
// - La limpieza borra ÚNICAMENTE la base que esta ejecución efectivamente creó, y solo después de
//   cerrar las conexiones propias — nunca usa `WITH (FORCE)` ni termina backends ajenos.
import { randomBytes } from 'crypto';
import { DataSource } from 'typeorm';

export type TestDatabaseTarget = {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Base a la que conectarse para poder ejecutar CREATE/DROP DATABASE — nunca la base de test en
   * sí (no se puede crear/borrar una base conectado a ella misma). Default 'postgres' — es la
   * base de mantenimiento estándar de todo servidor Postgres, no una base de la aplicación. */
  adminDatabase: string;
};

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * Resuelve el destino de test desde variables de entorno EXPLÍCITAS (TEST_DB_*) — a propósito
 * distintas de las DB_* generales que usa el backend para desarrollo/producción. Si falta
 * cualquiera, lanza con un mensaje accionable en vez de improvisar sobre un servidor de uso
 * desconocido (ver restricción del pedido: "no improvisar sobre una base o servidor de uso
 * desconocido").
 */
export function resolveExplicitTestDatabaseTarget(): TestDatabaseTarget {
  const host = process.env.TEST_DB_HOST;
  const port = process.env.TEST_DB_PORT;
  const username = process.env.TEST_DB_USER;
  const password = process.env.TEST_DB_PASSWORD;
  const adminDatabase = process.env.TEST_DB_ADMIN_DATABASE || 'postgres';

  const missing = [
    !host && 'TEST_DB_HOST',
    !port && 'TEST_DB_PORT',
    !username && 'TEST_DB_USER',
    !password && 'TEST_DB_PASSWORD',
  ].filter((v): v is string => Boolean(v));

  if (missing.length > 0) {
    throw new Error(
      `Falta configuración explícita de destino de test para PostgreSQL (${missing.join(', ')}). ` +
        'Esta suite nunca reutiliza las variables generales DB_* del backend como destino de ' +
        'test — configurá TEST_DB_HOST/TEST_DB_PORT/TEST_DB_USER/TEST_DB_PASSWORD apuntando ' +
        'explícitamente a un servidor Postgres seguro para pruebas (p. ej. el mismo Postgres de ' +
        'docker-compose.yml para desarrollo local) antes de correr esta suite. Sin esto, la ' +
        'verificación queda pendiente en vez de asumir un destino desconocido.',
    );
  }

  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
    throw new Error(`TEST_DB_PORT="${port}" no es un puerto válido.`);
  }

  return {
    host: host as string,
    port: parsedPort,
    username: username as string,
    password: password as string,
    adminDatabase,
  };
}

/** Nunca interpolar un nombre de base en SQL sin pasar por acá primero. */
export function assertSafeIdentifier(name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(
      `Identificador de base inseguro o inválido: "${name}" — se esperaba minúsculas/dígitos/guión bajo, empezando por una letra.`,
    );
  }
}

/** Nombre único por ejecución: prefijo + pid + timestamp + 4 bytes aleatorios. La combinación de
 * pid+timestamp+random hace una colisión real (dos ejecuciones generando el mismo nombre)
 * prácticamente imposible — el chequeo de colisión de createIsolatedTestDatabase es la red de
 * seguridad para ese caso "prácticamente imposible", no la garantía principal. */
export function generateUniqueTestDatabaseName(prefix: string): string {
  const name = `${prefix}_${process.pid}_${Date.now()}_${randomBytes(4).toString('hex')}`;
  assertSafeIdentifier(name);
  return name;
}

function isDuplicateDatabaseError(error: unknown): boolean {
  // 42P04 = duplicate_database (código real de Postgres) — se puede dar en la ventana entre el
  // SELECT de colisión y el CREATE si otra ejecución generó el mismo nombre justo en el medio.
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '42P04',
  );
}

export async function withAdminConnection<T>(
  target: TestDatabaseTarget,
  work: (ds: DataSource) => Promise<T>,
): Promise<T> {
  const ds = new DataSource({
    type: 'postgres',
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    database: target.adminDatabase,
  });
  await ds.initialize();
  try {
    return await work(ds);
  } finally {
    await ds.destroy();
  }
}

export type CreatedTestDatabase = {
  name: string;
  target: TestDatabaseTarget;
};

/**
 * Crea una base de test con nombre único. Ante colisión con una base ya existente (chequeada
 * antes de crear, y también atrapada como error real de Postgres si la ventana de tiempo lo
 * permite), reintenta con OTRO nombre — nunca toca ni asume dueño de la base encontrada, tal como
 * pide la restricción de no destruir recursos ajenos.
 *
 * `nameGenerator` es inyectable (default: generateUniqueTestDatabaseName) para poder testear
 * determinísticamente el camino de colisión — ver isolated-postgres-database.e2e-spec.ts.
 */
export async function createIsolatedTestDatabase(
  target: TestDatabaseTarget,
  prefix: string,
  options: {
    maxAttempts?: number;
    nameGenerator?: (prefix: string) => string;
  } = {},
): Promise<CreatedTestDatabase> {
  const maxAttempts = options.maxAttempts ?? 5;
  const nameGenerator = options.nameGenerator ?? generateUniqueTestDatabaseName;

  return withAdminConnection(target, async (adminDs) => {
    let lastCollision: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const candidate = nameGenerator(prefix);
      assertSafeIdentifier(candidate);

      const existing: unknown[] = await adminDs.query(
        'SELECT 1 FROM pg_database WHERE datname = $1',
        [candidate],
      );
      if (existing.length > 0) {
        lastCollision = candidate;
        continue; // Colisión real — jamás se toca; se reintenta con otro nombre.
      }

      try {
        await adminDs.query(`CREATE DATABASE "${candidate}"`);
        return { name: candidate, target };
      } catch (error) {
        if (isDuplicateDatabaseError(error) && attempt < maxAttempts - 1) {
          lastCollision = candidate;
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `No se pudo generar un nombre de base de test único después de ${maxAttempts} intentos ` +
        `(última colisión: ${lastCollision ?? 'n/a'}). Abortando sin tocar ninguna base existente.`,
    );
  });
}

/**
 * Elimina la base SOLO si `databaseName` no es null — el caller es responsable de pasar null
 * cuando esta ejecución nunca llegó a crear una base propia (ver el flag `wasCreated`-equivalente
 * en el caller: nunca se borra "por las dudas"). No usa `WITH (FORCE)` ni termina backends
 * ajenos — el caller debe cerrar sus propias conexiones a `databaseName` antes de llamar acá; si
 * queda alguna conexión abierta, el DROP falla con un error de Postgres explícito en vez de matar
 * conexiones que podrían no ser propias.
 */
export async function dropIsolatedTestDatabase(
  target: TestDatabaseTarget,
  databaseName: string | null,
): Promise<void> {
  if (!databaseName) {
    return;
  }
  assertSafeIdentifier(databaseName);

  await withAdminConnection(target, async (adminDs) => {
    await adminDs.query(`DROP DATABASE "${databaseName}"`);
  });
}

export async function databaseExists(
  target: TestDatabaseTarget,
  databaseName: string,
): Promise<boolean> {
  assertSafeIdentifier(databaseName);

  return withAdminConnection(target, async (adminDs) => {
    const rows: unknown[] = await adminDs.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [databaseName],
    );
    return rows.length > 0;
  });
}
