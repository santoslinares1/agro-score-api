import { escapeHtml } from '../email.util';
import type { WeeklySnapshotDataQuality } from '../../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import type { EmailContent } from './invitation.template';

export interface ScheduledAnalysisEmailParams {
  userName?: string | null;
  fieldName: string;
  weekStart: string;
  weekEnd: string;
  analysisUrl: string;
  reportUrl: string;
  dataQualityStatus: WeeklySnapshotDataQuality;
  hasRgbImage: boolean;
  hasNdviImage: boolean;
  hasNdmiImage: boolean;
  hasImageSeries: boolean;
  summary: string[];
}

const DATA_QUALITY_LABEL: Record<WeeklySnapshotDataQuality, string> = {
  sufficient: 'Suficiente',
  partial: 'Parcial',
  insufficient: 'Insuficiente',
};

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY', sin pasar por Date (evita corrimientos de huso horario) — mismo
 * criterio que formatDateDMY en report-pdf.helpers.ts, reimplementado acá para no acoplar el
 * email a código de PDF. */
function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : isoDate;
}

function availabilityLabel(available: boolean): string {
  return available ? 'disponible' : 'no disponible';
}

/**
 * Fase 5: reporte semanal COMPARATIVO — reemplaza el aviso "informe visual completo" de Fase 4A.
 * Ya no promete RGB/NDVI/NDMI/PDF completo cada semana (una ventana de 7 días puede no tener
 * imagen Sentinel-2 útil por nubosidad): en cambio comunica qué cambió respecto de la semana
 * anterior, qué datos hay disponibles esta semana y qué tan completo es el reporte
 * (dataQualityStatus). El texto de `summary` ya viene armado y honesto desde
 * compareWeeklySnapshots — este template solo lo renderiza, nunca inventa contenido nuevo.
 */
export function buildScheduledAnalysisEmail(params: ScheduledAnalysisEmailParams): EmailContent {
  const {
    userName,
    fieldName,
    weekStart,
    weekEnd,
    analysisUrl,
    reportUrl,
    dataQualityStatus,
    hasRgbImage,
    hasNdviImage,
    hasNdmiImage,
    hasImageSeries,
    summary,
  } = params;
  const greetingName = userName?.trim() ? userName.trim() : null;

  const subject = `Reporte semanal AgroScore · ${fieldName}`;

  const safeFieldName = escapeHtml(fieldName);
  const safeAnalysisUrl = escapeHtml(analysisUrl);
  const safeReportUrl = escapeHtml(reportUrl);
  const htmlGreeting = greetingName ? `Hola ${escapeHtml(greetingName)},` : 'Hola,';
  const textGreeting = greetingName ? `Hola ${greetingName},` : 'Hola,';
  const weekLabel = `${formatDate(weekStart)} — ${formatDate(weekEnd)}`;
  const qualityLabel = DATA_QUALITY_LABEL[dataQualityStatus];

  const summaryHtml = summary.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 480px;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Reporte semanal AgroScore · ${safeFieldName}</h1>
      <p>${htmlGreeting}</p>
      <p style="font-size: 13px; color: #6b7280; margin-bottom: 20px;">Semana analizada: ${weekLabel}</p>

      <p style="font-weight: bold; margin-bottom: 4px;">Resumen</p>
      <ul style="padding-left: 20px; margin: 0 0 20px;">${summaryHtml}</ul>

      <p style="font-weight: bold; margin-bottom: 4px;">Disponibilidad de datos</p>
      <ul style="padding-left: 20px; margin: 0 0 20px; color: #374151;">
        <li>RGB: ${availabilityLabel(hasRgbImage)}</li>
        <li>NDVI: ${availabilityLabel(hasNdviImage)}</li>
        <li>NDMI: ${availabilityLabel(hasNdmiImage)}</li>
        <li>Evolución semanal: ${availabilityLabel(hasImageSeries)}</li>
      </ul>

      <p style="font-size: 13px; color: #6b7280; margin-bottom: 20px;">
        Calidad del reporte: <strong>${qualityLabel}</strong><br />
        Si no hubo imágenes válidas esta semana, el reporte lo informa y queda registrado para comparación futura.
      </p>

      <p style="margin: 24px 0;">
        <a href="${safeAnalysisUrl}"
           style="display: inline-block; background-color: #14532d; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 999px; font-weight: bold;">
          Ver análisis
        </a>
      </p>
      <p style="font-size: 13px; color: #6b7280;">
        Informe técnico completo:<br />
        <a href="${safeReportUrl}" style="color: #14532d; word-break: break-all;">${safeReportUrl}</a>
      </p>
      <p style="margin-top: 24px; font-size: 12px; color: #6b7280;">
        AgroScore — Diagnóstico productivo con evidencia satelital.
      </p>
    </div>
  `.trim();

  const text = [
    textGreeting,
    '',
    `Reporte semanal AgroScore · ${fieldName}`,
    `Semana analizada: ${weekLabel}`,
    '',
    'Resumen:',
    ...summary.map((line) => `- ${line}`),
    '',
    'Disponibilidad de datos:',
    `- RGB: ${availabilityLabel(hasRgbImage)}`,
    `- NDVI: ${availabilityLabel(hasNdviImage)}`,
    `- NDMI: ${availabilityLabel(hasNdmiImage)}`,
    `- Evolución semanal: ${availabilityLabel(hasImageSeries)}`,
    '',
    `Calidad del reporte: ${qualityLabel}`,
    'Si no hubo imágenes válidas esta semana, el reporte lo informa y queda registrado para comparación futura.',
    '',
    'Ver análisis:',
    analysisUrl,
    '',
    'Informe técnico completo:',
    reportUrl,
    '',
    'AgroScore',
  ].join('\n');

  return { subject, html, text };
}
