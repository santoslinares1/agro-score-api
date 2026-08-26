import { escapeHtml } from '../email.util';
import type { WeeklySnapshotDataQuality } from '../../scheduled-analysis/entities/weekly-analysis-snapshot.entity';
import {
  confidenceLabel,
  verdictLabel,
} from '../../analysis-verdict/analysis-verdict-labels';
import type { AnalysisTechnicalVerdictResponse } from '../../analysis-verdict/dto/analysis-technical-verdict.dto';
import {
  confidenceLabel as weeklyConfidenceLabel,
  trendLabel as weeklyTrendLabel,
  verdictLabel as weeklyVerdictLabel,
} from '../../weekly-technical-verdict/weekly-technical-verdict-labels';
import type { WeeklyTechnicalVerdictResponse } from '../../weekly-technical-verdict/dto/weekly-technical-verdict.dto';
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
  /**
   * PR 12A: veredicto ya persistido para el Analysis de esta semana (nunca se regenera acá —
   * ver ScheduledAnalysisRunnerService.sendCompletionEmail). undefined/null omite la sección por
   * completo; generator/promptVersion/generatedAt/errorMessage nunca se renderizan, aunque vengan
   * en el objeto — ver buildTechnicalVerdictHtml/buildTechnicalVerdictText.
   */
  technicalVerdict?: AnalysisTechnicalVerdictResponse | null;
  /**
   * PR 16C: diagnóstico semanal ya persistido por PR 16B (nunca se regenera ni se llama a Claude
   * acá — ver ScheduledAnalysisRunnerService.sendCompletionEmail). undefined/null Y
   * status='failed' omiten la sección por completo (decisión de producto: el mail ya tiene
   * Veredicto técnico individual, no hace falta un segundo aviso de error al usuario final).
   * trend='insufficient_data' (primer reporte o datos insuficientes) NO es un error — se renderiza
   * como cualquier otro estado 'generated', el summary ya persistido explica la situación.
   * generator/promptVersion/generatedAt/errorMessage nunca se renderizan — ver
   * buildWeeklyTechnicalVerdictHtml/buildWeeklyTechnicalVerdictText.
   */
  weeklyTechnicalVerdict?: WeeklyTechnicalVerdictResponse | null;
}

const VERDICT_DISCLAIMER =
  'Veredicto técnico generado automáticamente a partir del análisis satelital. Debe validarse con observación en campo.';

const VERDICT_FAILED_NOTICE =
  'El análisis satelital finalizó correctamente, pero no se pudo generar el veredicto técnico automático.';

const WEEKLY_VERDICT_DISCLAIMER =
  'Diagnóstico semanal generado automáticamente a partir de la comparación entre reportes. Debe validarse con observación en campo.';

function htmlList(title: string, items: string[]): string {
  if (!items.length) {
    return '';
  }

  const itemsHtml = items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('');

  return (
    `<p style="font-weight: bold; margin: 12px 0 4px; font-size: 13px;">${title}</p>` +
    `<ul style="padding-left: 20px; margin: 0; color: #374151; font-size: 13px;">${itemsHtml}</ul>`
  );
}

function textList(title: string, items: string[]): string[] {
  if (!items.length) {
    return [];
  }

  return ['', `${title}:`, ...items.map((item) => `- ${item}`)];
}

/**
 * PR 12A: mismos estados/copy que analysis-result.component.ts (PR 11C) y
 * report-pdf.service.ts (PR 11D) — 'generated' arma la sección completa, 'failed' un aviso sobrio
 * no bloqueante, y null/undefined/'pending' omiten la sección entera (nunca se manda un mail con
 * un estado "esperando" — para entonces el runner ya decidió mandar sin veredicto, ver
 * ScheduledAnalysisRunnerService.isWithinVerdictWaitWindow). Nunca renderiza generator,
 * promptVersion, generatedAt ni errorMessage, aunque estén en el objeto recibido.
 */
function buildTechnicalVerdictHtml(
  technicalVerdict: AnalysisTechnicalVerdictResponse | null | undefined,
): string {
  if (!technicalVerdict || technicalVerdict.status === 'pending') {
    return '';
  }

  if (technicalVerdict.status === 'failed') {
    return `
      <p style="font-weight: bold; margin-bottom: 4px;">Veredicto técnico</p>
      <p style="font-size: 13px; color: #92400e; background-color: #fef9c3; padding: 10px 12px; border-radius: 8px; margin: 0 0 20px;">
        ${escapeHtml(VERDICT_FAILED_NOTICE)}
      </p>
    `;
  }

  if (technicalVerdict.status !== 'generated') {
    return '';
  }

  const confidence = confidenceLabel(technicalVerdict.confidence);
  const summaryHtml = technicalVerdict.summary
    ? `<p style="margin: 0 0 4px; color: #374151;">${escapeHtml(technicalVerdict.summary)}</p>`
    : '';

  return `
    <p style="font-weight: bold; margin-bottom: 4px;">Veredicto técnico</p>
    <p style="font-size: 13px; color: #374151; margin: 0 0 8px;">
      Estado: <strong>${escapeHtml(verdictLabel(technicalVerdict.verdict))}</strong>${
        confidence
          ? ` &middot; Confianza: <strong>${escapeHtml(confidence)}</strong>`
          : ''
      }
    </p>
    ${summaryHtml}
    ${htmlList('Hallazgos principales', technicalVerdict.keyFindings)}
    ${htmlList('Posibles causas', technicalVerdict.possibleCauses)}
    ${htmlList('Recomendaciones', technicalVerdict.recommendations)}
    ${htmlList('Limitaciones', technicalVerdict.limitations)}
    <p style="font-size: 12px; color: #6b7280; margin: 12px 0 20px;">${escapeHtml(VERDICT_DISCLAIMER)}</p>
  `;
}

function buildTechnicalVerdictText(
  technicalVerdict: AnalysisTechnicalVerdictResponse | null | undefined,
): string[] {
  if (!technicalVerdict || technicalVerdict.status === 'pending') {
    return [];
  }

  if (technicalVerdict.status === 'failed') {
    return ['', 'Veredicto técnico:', VERDICT_FAILED_NOTICE];
  }

  if (technicalVerdict.status !== 'generated') {
    return [];
  }

  const confidence = confidenceLabel(technicalVerdict.confidence);
  const lines = [
    '',
    'Veredicto técnico:',
    `Estado: ${verdictLabel(technicalVerdict.verdict)}${confidence ? ` · Confianza: ${confidence}` : ''}`,
  ];

  if (technicalVerdict.summary) {
    lines.push('', technicalVerdict.summary);
  }

  lines.push(
    ...textList('Hallazgos principales', technicalVerdict.keyFindings),
    ...textList('Posibles causas', technicalVerdict.possibleCauses),
    ...textList('Recomendaciones', technicalVerdict.recommendations),
    ...textList('Limitaciones', technicalVerdict.limitations),
    '',
    VERDICT_DISCLAIMER,
  );

  return lines;
}

/**
 * PR 16C: mismo criterio defensivo que buildTechnicalVerdictHtml — 'failed' se trata igual que
 * null/undefined (se omite la sección entera, decisión de producto: no hace falta un segundo
 * aviso de error si ya existe el de Veredicto técnico). trend='insufficient_data' NO es un caso
 * especial acá: se renderiza por el mismo camino que cualquier otro trend — el summary ya
 * persistido (weekly-technical-verdict-generator.util.ts) explica la falta de base histórica sin
 * que el template tenga que duplicar esa decisión de copy.
 */
function buildWeeklyTechnicalVerdictHtml(
  weeklyTechnicalVerdict: WeeklyTechnicalVerdictResponse | null | undefined,
): string {
  if (
    !weeklyTechnicalVerdict ||
    weeklyTechnicalVerdict.status !== 'generated'
  ) {
    return '';
  }

  const confidence = weeklyConfidenceLabel(weeklyTechnicalVerdict.confidence);
  const summaryHtml = weeklyTechnicalVerdict.summary
    ? `<p style="margin: 0 0 4px; color: #374151;">${escapeHtml(weeklyTechnicalVerdict.summary)}</p>`
    : '';

  return `
    <p style="font-weight: bold; margin-bottom: 4px;">Diagnóstico semanal</p>
    <p style="font-size: 13px; color: #374151; margin: 0 0 8px;">
      Tendencia: <strong>${escapeHtml(weeklyTrendLabel(weeklyTechnicalVerdict.trend))}</strong>
      &middot; Estado: <strong>${escapeHtml(weeklyVerdictLabel(weeklyTechnicalVerdict.verdict))}</strong>${
        confidence
          ? ` &middot; Confianza: <strong>${escapeHtml(confidence)}</strong>`
          : ''
      }
    </p>
    ${summaryHtml}
    ${htmlList('Cambios relevantes', weeklyTechnicalVerdict.keyChanges)}
    ${htmlList('Áreas a revisar', weeklyTechnicalVerdict.areasToReview)}
    ${htmlList('Recomendaciones', weeklyTechnicalVerdict.recommendations)}
    ${htmlList('Limitaciones', weeklyTechnicalVerdict.limitations)}
    <p style="font-size: 12px; color: #6b7280; margin: 12px 0 20px;">${escapeHtml(WEEKLY_VERDICT_DISCLAIMER)}</p>
  `;
}

function buildWeeklyTechnicalVerdictText(
  weeklyTechnicalVerdict: WeeklyTechnicalVerdictResponse | null | undefined,
): string[] {
  if (
    !weeklyTechnicalVerdict ||
    weeklyTechnicalVerdict.status !== 'generated'
  ) {
    return [];
  }

  const confidence = weeklyConfidenceLabel(weeklyTechnicalVerdict.confidence);
  const lines = [
    '',
    'Diagnóstico semanal:',
    `Tendencia: ${weeklyTrendLabel(weeklyTechnicalVerdict.trend)} · Estado: ${weeklyVerdictLabel(weeklyTechnicalVerdict.verdict)}${confidence ? ` · Confianza: ${confidence}` : ''}`,
  ];

  if (weeklyTechnicalVerdict.summary) {
    lines.push('', weeklyTechnicalVerdict.summary);
  }

  lines.push(
    ...textList('Cambios relevantes', weeklyTechnicalVerdict.keyChanges),
    ...textList('Áreas a revisar', weeklyTechnicalVerdict.areasToReview),
    ...textList('Recomendaciones', weeklyTechnicalVerdict.recommendations),
    ...textList('Limitaciones', weeklyTechnicalVerdict.limitations),
    '',
    WEEKLY_VERDICT_DISCLAIMER,
  );

  return lines;
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
export function buildScheduledAnalysisEmail(
  params: ScheduledAnalysisEmailParams,
): EmailContent {
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
    technicalVerdict,
    weeklyTechnicalVerdict,
  } = params;
  const greetingName = userName?.trim() ? userName.trim() : null;

  const subject = `Reporte semanal AgroScore · ${fieldName}`;

  const safeFieldName = escapeHtml(fieldName);
  const safeAnalysisUrl = escapeHtml(analysisUrl);
  const safeReportUrl = escapeHtml(reportUrl);
  const htmlGreeting = greetingName
    ? `Hola ${escapeHtml(greetingName)},`
    : 'Hola,';
  const textGreeting = greetingName ? `Hola ${greetingName},` : 'Hola,';
  const weekLabel = `${formatDate(weekStart)} — ${formatDate(weekEnd)}`;
  const qualityLabel = DATA_QUALITY_LABEL[dataQualityStatus];

  const summaryHtml = summary
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
  const technicalVerdictHtml = buildTechnicalVerdictHtml(technicalVerdict);
  const technicalVerdictTextLines = buildTechnicalVerdictText(technicalVerdict);
  const weeklyTechnicalVerdictHtml = buildWeeklyTechnicalVerdictHtml(
    weeklyTechnicalVerdict,
  );
  const weeklyTechnicalVerdictTextLines = buildWeeklyTechnicalVerdictText(
    weeklyTechnicalVerdict,
  );

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; line-height: 1.6; max-width: 480px;">
      <h1 style="font-size: 20px; color: #14532d; margin-bottom: 16px;">Reporte semanal AgroScore · ${safeFieldName}</h1>
      <p>${htmlGreeting}</p>
      <p style="font-size: 13px; color: #6b7280; margin-bottom: 20px;">Semana analizada: ${weekLabel}</p>

      <p style="font-weight: bold; margin-bottom: 4px;">Resumen</p>
      <ul style="padding-left: 20px; margin: 0 0 20px;">${summaryHtml}</ul>

      ${technicalVerdictHtml}

      ${weeklyTechnicalVerdictHtml}

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
    ...technicalVerdictTextLines,
    ...weeklyTechnicalVerdictTextLines,
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
