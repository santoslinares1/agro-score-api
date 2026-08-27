import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * SMTP-MIGRATION-1: los tres flujos que dependían del SDK de Resend (invitación/reset/reporte
 * semanal en email.service.ts, solicitud de acceso en access-request/, consulta pública en
 * contact/) migraron a SMTP vía nodemailer. Este test barre esos tres directorios y falla si
 * alguno vuelve a importar 'resend' — evita una regresión silenciosa donde alguien reintroduce el
 * SDK viejo en uno de los flujos ya migrados.
 */
const REPLACED_FLOW_DIRS = ['email', 'access-request', 'contact'];

function listTsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      return listTsFiles(fullPath);
    }
    return fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('migración SMTP — sin Resend en los flujos reemplazados', () => {
  it.each(REPLACED_FLOW_DIRS)(
    'src/%s no importa el SDK de resend',
    (dirName) => {
      const dir = join(__dirname, '..', dirName);
      const files = listTsFiles(dir);

      expect(files.length).toBeGreaterThan(0);

      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        expect(content).not.toMatch(/from\s+['"]resend['"]/);
        expect(content).not.toMatch(/require\(\s*['"]resend['"]\s*\)/);
      }
    },
  );
});
