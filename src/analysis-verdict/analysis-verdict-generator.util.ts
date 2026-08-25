import {
  AnalysisVerdictConfidence,
  AnalysisVerdictLabel,
} from './entities/analysis-technical-verdict.entity';
import { NdviVariability } from '../analysis/entities/analysis.entity';

export interface VerdictGeneratorInput {
  globalScore: number;
  /**
   * Misma señal que ya usa report-pdf.service.ts (resultJson.totalsByZone no vacío) para decidir
   * si un análisis "Finalizado" tiene datos reales para interpretar — no se inventa un umbral
   * nuevo acá.
   */
  hasZoneData: boolean;
  ndviAverageMax: number;
  ndviVariability: NdviVariability;
  /** null si el resultJson no trae NDMI_mean utilizable (ver extractNdmiMean). */
  ndmiMean: number | null;
}

export interface GeneratedVerdict {
  verdict: AnalysisVerdictLabel;
  confidence: AnalysisVerdictConfidence;
  summary: string;
  keyFindings: string[];
  possibleCauses: string[];
  recommendations: string[];
  limitations: string[];
}

const COMMON_LIMITATIONS = [
  'La interpretación se basa en índices satelitales y debe validarse con observación en campo.',
  'El veredicto no reemplaza el criterio de un profesional agronómico.',
  'No se deben tomar decisiones de aplicación o manejo únicamente con este resultado.',
];

const FAVORABLE_SCORE_THRESHOLD = 75;
const ATTENTION_SCORE_THRESHOLD = 50;

function classifyVerdict(input: VerdictGeneratorInput): AnalysisVerdictLabel {
  if (!input.hasZoneData) {
    return 'insufficient_data';
  }

  if (input.globalScore >= FAVORABLE_SCORE_THRESHOLD) {
    return 'favorable';
  }

  if (input.globalScore >= ATTENTION_SCORE_THRESHOLD) {
    return 'attention';
  }

  return 'critical';
}

/**
 * ndviAverageMax/ndviVariability son columnas planas de Analysis, siempre pobladas por el worker
 * cuando hay zonas (hasZoneData=true) — por eso "hay NDVI" no se cuestiona ahí. NDMI no tiene
 * columna propia (ver extractNdmiMean), así que es la única señal que realmente puede faltar y
 * mover la confianza de medium a high.
 */
function classifyConfidence(
  verdict: AnalysisVerdictLabel,
  input: VerdictGeneratorInput,
): AnalysisVerdictConfidence {
  if (verdict === 'insufficient_data') {
    return 'low';
  }

  return input.ndmiMean !== null ? 'high' : 'medium';
}

export function generateTechnicalVerdict(
  input: VerdictGeneratorInput,
): GeneratedVerdict {
  const verdict = classifyVerdict(input);
  const confidence = classifyConfidence(verdict, input);
  const limitations = [...COMMON_LIMITATIONS];

  switch (verdict) {
    case 'favorable':
      return {
        verdict,
        confidence,
        summary:
          'El análisis satelital muestra un estado general favorable del lote, con índices compatibles con buena cobertura vegetal y sin señales críticas generalizadas.',
        keyFindings: [
          'El score general se encuentra en un rango favorable.',
          'No se observan alertas críticas a partir de los índices disponibles.',
        ],
        possibleCauses: [
          'Condiciones de manejo, suelo y humedad relativamente uniformes y favorables durante el período analizado.',
        ],
        recommendations: [
          'Mantener el monitoreo semanal para detectar cambios tempranos.',
          'Validar en campo cualquier diferencia localizada que no sea visible en el promedio general.',
        ],
        limitations,
      };

    case 'attention':
      return {
        verdict,
        confidence,
        summary:
          'El análisis satelital muestra un estado general intermedio, con señales que requieren seguimiento. Los índices disponibles sugieren revisar posibles diferencias internas dentro del lote.',
        keyFindings: [
          'El score general se encuentra en un rango de atención.',
          'Conviene revisar sectores con menor vigor o menor humedad relativa si están presentes en los mapas.',
        ],
        possibleCauses: [
          'Posibles diferencias de riego, suelo, compactación o manejo dentro del lote.',
          'Variabilidad natural del cultivo entre distintas zonas del lote.',
        ],
        recommendations: [
          'Revisar el lote en campo priorizando las zonas de menor desempeño.',
          'Comparar el resultado con riego, relieve, compactación, tipo de suelo o manejo reciente.',
          'Repetir el análisis en los próximos días para confirmar evolución.',
        ],
        limitations,
      };

    case 'critical':
      return {
        verdict,
        confidence,
        summary:
          'El análisis satelital muestra un estado general comprometido o con señales relevantes de estrés. Se recomienda validar el resultado en campo antes de tomar decisiones de manejo.',
        keyFindings: [
          'El score general se encuentra en un rango crítico.',
          'Los índices disponibles sugieren una condición que requiere revisión prioritaria.',
        ],
        possibleCauses: [
          'Posible estrés hídrico, problemas de suelo, plagas, enfermedades o eventos climáticos recientes.',
          'Manejo o fecha de siembra que podría no reflejarse adecuadamente en el período analizado.',
        ],
        recommendations: [
          'Realizar una recorrida de campo en las zonas de menor desempeño.',
          'Contrastar el resultado con información de riego, suelo, manejo y eventos climáticos recientes.',
          'Evitar decisiones agronómicas definitivas basadas solo en el análisis satelital.',
        ],
        limitations,
      };

    case 'insufficient_data':
    default:
      return {
        verdict: 'insufficient_data',
        confidence,
        summary:
          'No hay datos suficientes para generar un veredicto técnico confiable del análisis.',
        keyFindings: [
          'Faltan métricas suficientes para interpretar el estado del lote.',
        ],
        possibleCauses: [],
        recommendations: [
          'Revisar que el análisis haya finalizado correctamente.',
          'Reintentar el análisis o validar la disponibilidad de imágenes satelitales para la fecha seleccionada.',
        ],
        limitations,
      };
  }
}
