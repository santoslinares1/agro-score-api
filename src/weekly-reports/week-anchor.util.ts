const MS_PER_DAY = 86_400_000;

function parseIsoDateUtc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Puerto TypeScript de week_anchor_date() en agro-score-worker/app/pipeline/weekly.py (Fase 1):
 * redondea targetDate al punto de control más cercano de la grilla semanal de campaña, para que
 * dos corridas dentro de la misma semana de campaña colapsen al mismo weekAnchorDate — el
 * backend necesita este mismo cálculo para el unique constraint de WeeklyFieldReport
 * (fieldId + weekAnchorDate + methodologyVersion) y para no depender de que el worker sea quien
 * siempre lo calcule igual. No clampea a campaignStart si targetDate es anterior — igual
 * criterio que la versión Python.
 */
export function computeWeekAnchorDate(
  campaignStart: string,
  targetDate: string,
  stepDays = 7,
): string {
  const start = parseIsoDateUtc(campaignStart);
  const target = parseIsoDateUtc(targetDate);

  const diffDays = Math.round((target.getTime() - start.getTime()) / MS_PER_DAY);
  const nWeeks = Math.round(diffDays / stepDays);

  return toIsoDate(new Date(start.getTime() + nWeeks * stepDays * MS_PER_DAY));
}
