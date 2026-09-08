// F03: prueba el mecanismo de aislamiento de base en sí mismo (no AuthService) — nombre único,
// nunca borrar una base encontrada por colisión, y limpieza correcta ante un fallo de setup
// posterior a la creación. Necesita el mismo Postgres real que la suite de atomicidad (variables
// TEST_DB_* explícitas) — ver isolated-postgres-database.ts para la razón de exigirlas.
import {
  assertSafeIdentifier,
  createIsolatedTestDatabase,
  databaseExists,
  dropIsolatedTestDatabase,
  generateUniqueTestDatabaseName,
  resolveExplicitTestDatabaseTarget,
  TestDatabaseTarget,
} from './isolated-postgres-database';

jest.setTimeout(30_000);

describe('F03 — soporte de base de test aislada (creación/colisión/limpieza)', () => {
  let target: TestDatabaseTarget;

  beforeAll(() => {
    // Si esto lanza (TEST_DB_* no configuradas), la suite entera falla acá con un mensaje
    // accionable — no hay fallback silencioso a las DB_* generales del backend.
    target = resolveExplicitTestDatabaseTarget();
  });

  it('genera nombres únicos y seguros para SQL (prefijo + pid + timestamp + aleatorio)', () => {
    const a = generateUniqueTestDatabaseName('f03_support_test');
    const b = generateUniqueTestDatabaseName('f03_support_test');

    expect(a).not.toBe(b);
    expect(() => assertSafeIdentifier(a)).not.toThrow();
    expect(() => assertSafeIdentifier(b)).not.toThrow();
    expect(a).toMatch(/^f03_support_test_\d+_\d+_[0-9a-f]{8}$/);
  });

  it('rechaza identificadores que no son nombres SQL seguros', () => {
    expect(() =>
      assertSafeIdentifier('agro_score; DROP TABLE users;--'),
    ).toThrow();
    expect(() => assertSafeIdentifier('Agro_Score')).toThrow(); // mayúsculas: no coincide con el patrón exigido
    expect(() => assertSafeIdentifier('1_empieza_con_numero')).toThrow();
    expect(() => assertSafeIdentifier('nombre-con-guiones')).toThrow();
  });

  it('crea la base, confirma su existencia, y la limpieza la borra (camino feliz)', async () => {
    const created = await createIsolatedTestDatabase(
      target,
      'f03_support_happy',
    );

    expect(await databaseExists(target, created.name)).toBe(true);

    await dropIsolatedTestDatabase(target, created.name);

    expect(await databaseExists(target, created.name)).toBe(false);
  });

  it('dropIsolatedTestDatabase(target, null) no hace ningún DROP — nunca borra "por las dudas"', async () => {
    // Si esto intentara un DROP con un nombre nulo/inventado, tiraría un error de Postgres. Que
    // no lance nada ya demuestra que no ejecuta ningún DROP en este caso.
    await expect(
      dropIsolatedTestDatabase(target, null),
    ).resolves.toBeUndefined();
  });

  it('ante colisión con un nombre ya existente, reintenta con OTRO nombre y nunca toca la base encontrada', async () => {
    // Pre-crea una base con un nombre "de colisión" simulado.
    const collidingName = generateUniqueTestDatabaseName(
      'f03_support_collision',
    );
    const preexisting = await createIsolatedTestDatabase(target, 'unused', {
      nameGenerator: () => collidingName,
    });
    expect(preexisting.name).toBe(collidingName);

    try {
      // nameGenerator inyectado: la PRIMERA llamada devuelve el nombre que ya existe (colisión
      // real, detectada por el SELECT contra pg_database) — la función debe reintentar con la
      // segunda, que es libre.
      let call = 0;
      const freshName = generateUniqueTestDatabaseName(
        'f03_support_collision_fresh',
      );
      const created = await createIsolatedTestDatabase(target, 'unused', {
        nameGenerator: () => {
          call += 1;
          return call === 1 ? collidingName : freshName;
        },
      });

      expect(created.name).toBe(freshName);
      expect(created.name).not.toBe(collidingName);

      // La base "colisionada" preexistente sigue intacta — nunca se tocó.
      expect(await databaseExists(target, collidingName)).toBe(true);

      await dropIsolatedTestDatabase(target, created.name);
    } finally {
      await dropIsolatedTestDatabase(target, preexisting.name);
    }
  });

  it('limpieza ante fallo parcial de setup: si algo posterior a CREATE DATABASE falla, la base creada por esta ejecución igual se elimina', async () => {
    let createdDatabaseName: string | null = null;

    await expect(
      (async () => {
        try {
          const created = await createIsolatedTestDatabase(
            target,
            'f03_support_partial_fail',
          );
          createdDatabaseName = created.name;

          // Simula el resto del setup (p. ej. compilar el TestingModule de Nest) fallando DESPUÉS
          // de que la base ya se creó con éxito — mismo patrón que beforeAll() de la suite de
          // atomicidad: el flag/variable de "creada por esta ejecución" ya quedó seteado antes de
          // este punto, así que la limpieza de abajo sabe que tiene que borrarla.
          throw new Error(
            'Fallo simulado de setup posterior a la creación de la base.',
          );
        } finally {
          // Mismo criterio que el afterAll() real: limpiar solo si esta ejecución creó la base.
          await dropIsolatedTestDatabase(target, createdDatabaseName);
        }
      })(),
    ).rejects.toThrow(
      'Fallo simulado de setup posterior a la creación de la base.',
    );

    if (!createdDatabaseName) {
      throw new Error(
        'El setup nunca llegó a crear una base — el test no puede continuar.',
      );
    }
    expect(await databaseExists(target, createdDatabaseName)).toBe(false);
  });
});
