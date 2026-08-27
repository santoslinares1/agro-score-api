/**
 * Admin PR 5: contexto MÍNIMO del campo dentro de la fila de un lote — a propósito solo dos
 * booleanos, no el AdminFieldAnalysisStatus completo de Campos (que necesitaría resolver el
 * último análisis + veredicto por campo acá también). El ticket lo marca como "prioridad mínima":
 * "mostrar si el campo tiene diagnóstico o no" y "monitoreo activo/inactivo si es barato" — no
 * convertir Lotes en una copia de Campos.
 */
export type AdminLotItem = {
  id: string;
  name: string;
  fieldId: string;
  fieldName: string | null;
  ownerId: string | null;
  ownerEmail: string | null;
  ownerFullName: string | null;
  fieldHasAnalysis: boolean;
  fieldHasActiveMonitoring: boolean;
  createdAt: string;
  updatedAt: string;
};
