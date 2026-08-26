import { Injectable, NotFoundException } from '@nestjs/common';
import pdfMake from 'pdfmake';

import { Analysis } from '../entities/analysis.entity';
import { Field } from '../../fields/entities/field.entity';
import { AnalysisTechnicalVerdictResponse } from '../../analysis-verdict/dto/analysis-technical-verdict.dto';
import {
  buildNdviEvolutionChartSvg,
  buildPdfFilename,
  confidenceLabel,
  fieldLocationLabel,
  formatDateDMY,
  formatHa,
  getAdditionalIndexImages,
  getAnalyzedAreaHa,
  getBestLotByNdvi,
  getCampaignRows,
  getClassificationScopeNote,
  getFieldZoneTotals,
  getImageSeries,
  getImageSeriesScale,
  getIndexImages,
  getIndexScale,
  getLotAreaRows,
  getLotAreaTotalHa,
  getLotZoneDetails,
  getLotsCount,
  getLotsOverview,
  getNdviEvolutionByCampaign,
  getRgbImage,
  getTopZoneByHectares,
  IndexScale,
  indexImageDateRangeLabel,
  LotNdviCampaignSeries,
  MonthlyImage,
  isSoilClimateAvailable,
  safeText,
  scoreInterpretation,
  verdictBadgeStyle,
  verdictLabel,
  zoneColorHex,
  zoneTextColorHex,
} from './report-pdf.helpers';

// pdfmake@0.3.x no publica declaraciones de tipos (ni una carpeta `interfaces` ni un .d.ts) —
// se tipa localmente como `any` en vez de instalar el paquete `@types/pdfmake` (desactualizado
// a la versión 0.3.3 y con una forma de API distinta a la que expone esta versión).
type Content = any;
type TDocumentDefinitions = any;

const METHODOLOGICAL_LIMITATIONS: string[] = [
  'La lectura se basa en las imágenes satelitales Sentinel-2 disponibles para el período analizado.',
  'La disponibilidad y calidad de esas imágenes depende de la nubosidad y la cobertura satelital de cada fecha.',
  'La clasificación productiva es relativa dentro del campo analizado: no es una escala absoluta ni comparable con otros campos.',
  'La imagen RGB y las imágenes puntuales de índice corresponden a una ventana específica de la campaña. Las grillas mensuales NDVI/NDMI se generan a partir de composiciones mensuales disponibles para el período analizado.',
  'Las curvas de evolución NDVI por lote se calculan con las fechas satelitales disponibles; la cantidad de observaciones puede variar según nubosidad y disponibilidad de imágenes.',
  'No reemplaza mediciones a campo ni decisiones agronómicas profesionales — se recomienda usarla como complemento.',
];

// PDF-2: paleta unificada del PDF — toda referencia de color en el documento pasa por acá en
// vez de hardcodear hex sueltos por sección.
const COLORS = {
  ink: '#0f172a',
  muted: '#64748b',
  border: '#e2e8f0',
  panel: '#f8fafc',
  brand: '#15803d',
  brandLight: '#4ade80',
  coverBg: '#0f172a',
  coverMuted: '#94a3b8',
  coverText: '#cbd5e1',
  coverDivider: '#334155',
  badgeBg: '#14532d',
  badgeText: '#86efac',
  warnBg: '#fef9c3',
  warnText: '#92400e',
};

// Ancho de contenido útil en A4 con márgenes [40, *, 40, *] (595.28pt - 40 - 40).
const CONTENT_WIDTH = 515;

// Fuente estándar PDF (una de las 14 built-in de PDFKit): no requiere embeber archivos .ttf
// propios, así que no hay assets de fuentes que mantener ni que puedan faltar en un deploy.
const HELVETICA_FONT_NAMES = new Set([
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Helvetica-BoldOblique',
]);

/**
 * Genera el PDF real del reporte técnico AgroScore a partir del análisis y campo ya validados
 * por ownership (ver AnalysisService.buildReportPdf). No toca metodología ni score: solo
 * presenta datos que ya existen en Analysis/resultJson y en el Field actual.
 */
@Injectable()
export class ReportPdfService {
  constructor() {
    pdfMake.setFonts({
      Helvetica: {
        normal: 'Helvetica',
        bold: 'Helvetica-Bold',
        italics: 'Helvetica-Oblique',
        bolditalics: 'Helvetica-BoldOblique',
      },
    });
    // El docDefinition solo contiene imágenes/gráficos como data URI o SVG inline — nunca URLs
    // remotas — así que se deniega todo acceso a URLs. El acceso "local" solo se permite para
    // los 4 nombres de la fuente estándar Helvetica (que pdfmake resuelve por el mismo
    // mecanismo de validateLocalFile); cualquier otro path de archivo queda denegado.
    pdfMake.setUrlAccessPolicy(() => false);
    pdfMake.setLocalAccessPolicy((path: string) =>
      HELVETICA_FONT_NAMES.has(path),
    );
  }

  async build(
    analysis: Analysis,
    field: Field,
    technicalVerdict: AnalysisTechnicalVerdictResponse | null = null,
  ): Promise<{
    stream: NodeJS.ReadableStream & { end(): void };
    filename: string;
  }> {
    if (analysis.status !== 'Finalizado') {
      throw new NotFoundException(
        'El análisis todavía no tiene un reporte disponible.',
      );
    }

    const resultJson = analysis.resultJson;
    const hasZoneData =
      Array.isArray(resultJson?.totalsByZone) &&
      (resultJson?.totalsByZone as unknown[]).length > 0;

    if (!resultJson || !hasZoneData) {
      throw new NotFoundException(
        'El análisis no tiene datos suficientes para generar el reporte.',
      );
    }

    const docDefinition = this.buildDocDefinition(
      analysis,
      field,
      technicalVerdict,
    );
    const pdf = pdfMake.createPdf(docDefinition);
    const stream = (await pdf.getStream()) as NodeJS.ReadableStream & {
      end(): void;
    };
    const filename = buildPdfFilename(field.name, analysis.createdAt);

    return { stream, filename };
  }

  private buildDocDefinition(
    analysis: Analysis,
    field: Field,
    technicalVerdict: AnalysisTechnicalVerdictResponse | null = null,
  ): TDocumentDefinitions {
    const resultJson: any = analysis.resultJson;

    return {
      pageSize: 'A4',
      // Top/bottom más generosos que el resto (40) para dejar lugar al header/footer sin que
      // se superpongan con el contenido de la página.
      pageMargins: [40, 60, 40, 60],
      header: this.buildHeader(field),
      footer: this.buildFooter(analysis),
      defaultStyle: { font: 'Helvetica', fontSize: 10, color: COLORS.ink },
      styles: {
        h1: { fontSize: 20, bold: true, color: '#ffffff' },
        h2: { fontSize: 14, bold: true, color: COLORS.ink },
        muted: { color: COLORS.muted, fontSize: 9 },
        tableHeader: { bold: true, fontSize: 9, color: COLORS.muted },
      },
      content: [
        ...this.buildCoverPage(analysis, field),
        ...this.buildResumenEjecutivo(analysis, resultJson),
        ...this.buildMetodologia(analysis, resultJson),
        ...this.buildCampoYLotes(resultJson, field),
        ...this.buildImagenes(resultJson),
        ...this.buildVeredictoTecnico(technicalVerdict),
        ...this.buildClasificacionProductiva(resultJson),
        ...this.buildEvolucionTemporal(resultJson),
        ...this.buildLecturaPorLote(resultJson),
        ...this.buildConclusion(analysis, resultJson),
        ...this.buildLimitaciones(resultJson),
      ],
    };
  }

  // --- Header / footer (PDF-2) ---

  /**
   * Header discreto para todas las páginas salvo la portada (que ya trae su propia identidad
   * visual). pdfmake llama a esta función por página con currentPage 1-indexado; devolver un
   * valor falsy salta el render para esa página sin dejar hueco.
   */
  private buildHeader(field: Field): (currentPage: number) => Content | null {
    const fieldName = safeText(field.name, 'Campo');

    return (currentPage: number): Content | null => {
      if (currentPage === 1) {
        return null;
      }

      return {
        margin: [40, 20, 40, 0],
        stack: [
          {
            columns: [
              {
                text: 'AGROSCORE',
                bold: true,
                color: COLORS.brand,
                fontSize: 9,
                characterSpacing: 0.5,
              },
              {
                text: 'Informe técnico',
                color: COLORS.muted,
                fontSize: 9,
                alignment: 'center',
              },
              {
                text: fieldName,
                color: COLORS.muted,
                fontSize: 9,
                alignment: 'right',
              },
            ],
          },
          {
            canvas: [
              {
                type: 'line',
                x1: 0,
                y1: 8,
                x2: CONTENT_WIDTH,
                y2: 8,
                lineWidth: 0.5,
                lineColor: COLORS.border,
              },
            ],
          },
        ],
      };
    };
  }

  /** Footer con fecha del diagnóstico (estable entre descargas) y numeración "Página X de Y". */
  private buildFooter(
    analysis: Analysis,
  ): (currentPage: number, pageCount: number) => Content | null {
    const diagnosisDate = formatDateDMY(analysis.createdAt);

    return (currentPage: number, pageCount: number): Content | null => {
      if (currentPage === 1) {
        return null;
      }

      return {
        margin: [40, 14, 40, 0],
        columns: [
          {
            text: `Diagnóstico del ${diagnosisDate}`,
            color: COLORS.muted,
            fontSize: 8,
          },
          {
            text: `Página ${currentPage} de ${pageCount}`,
            color: COLORS.muted,
            fontSize: 8,
            alignment: 'right',
          },
        ],
      };
    };
  }

  // --- Helpers de branding (PDF-2) ---

  /** Título de sección numerado con divisor debajo, unificado para las 9 secciones del PDF. */
  private sectionTitle(title: string): Content {
    return {
      stack: [
        { text: title, style: 'h2', margin: [0, 0, 0, 6] },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: CONTENT_WIDTH,
              y2: 0,
              lineWidth: 1,
              lineColor: COLORS.border,
            },
          ],
        },
      ],
      margin: [0, 22, 0, 10],
    };
  }

  private mutedText(text: string, margin: number[] = [0, 0, 0, 0]): Content {
    return { text, style: 'muted', margin };
  }

  /**
   * Layout PDF-3: agrupa nodos en un bloque atómico (`unbreakable`) para que un salto de
   * página natural nunca los separe — típicamente un título (de sección o subsección) junto a
   * su primer contenido, así nunca queda un título solo al final de una página con el resto
   * recién arrancando en la siguiente. Solo se usa con contenido acotado (un párrafo, una
   * escala, una lista corta) — nunca con una tabla potencialmente larga, porque un bloque
   * `unbreakable` más alto que una página se desborda en vez de paginarse.
   */
  private glued(...nodes: Content[]): Content {
    return { stack: nodes, unbreakable: true };
  }

  /** Pill de una sola celda (fillColor de pdfmake solo pinta en celdas de tabla). */
  private badge(
    text: string,
    options: { background: string; color: string; fontSize?: number },
  ): Content {
    return {
      table: {
        widths: ['auto'],
        body: [
          [
            {
              text,
              bold: true,
              color: options.color,
              fillColor: options.background,
              fontSize: options.fontSize ?? 9,
              margin: [8, 4, 8, 4],
            },
          ],
        ],
      },
      layout: 'noBorders',
    };
  }

  private metricCard(label: string, value: string): Content {
    return {
      width: '25%',
      stack: [
        { text: label.toUpperCase(), style: 'muted' },
        { text: value, bold: true, fontSize: 13, margin: [0, 3, 0, 0] },
      ],
    };
  }

  /** Par color de texto/fondo para una zona (Baja/Alta/Muy Alta/sin datos) en un mismo lugar. */
  private zoneStyle(name: string): { color: string; fillColor: string } {
    return { color: zoneTextColorHex(name), fillColor: zoneColorHex(name) };
  }

  private emptyNote(text: string): Content {
    return {
      table: {
        widths: ['*'],
        body: [
          [
            {
              text,
              color: COLORS.warnText,
              fillColor: COLORS.warnBg,
              margin: [10, 8, 10, 8],
            },
          ],
        ],
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 10],
    };
  }

  // --- Secciones ---

  private buildCoverPage(analysis: Analysis, field: Field): Content[] {
    // pdfmake solo pinta `fillColor` cuando el nodo es una celda de tabla — en un `stack`
    // suelto lo ignora silenciosamente. Por eso la portada se envuelve en una tabla de una
    // sola celda (mismo truco que emptyNote()/badge()) en vez de aplicar fillColor directo.
    const cover: Content = {
      stack: [
        {
          text: 'AGROSCORE',
          color: COLORS.brandLight,
          bold: true,
          fontSize: 22,
          characterSpacing: 2,
        },
        {
          margin: [0, 12, 0, 0],
          ...this.badge('DIAGNÓSTICO SATELITAL', {
            background: COLORS.badgeBg,
            color: COLORS.badgeText,
            fontSize: 8,
          }),
        },
        {
          text: 'Informe técnico',
          style: 'muted',
          color: COLORS.coverMuted,
          margin: [0, 14, 0, 2],
        },
        {
          text: safeText(field.name, 'Campo sin nombre'),
          style: 'h1',
          margin: [0, 0, 0, 4],
        },
        {
          text: fieldLocationLabel(field),
          color: COLORS.coverText,
          fontSize: 11,
          margin: [0, 0, 0, 2],
        },
        ...(field.ownerName
          ? [
              {
                text: `Cliente / propietario: ${field.ownerName}`,
                color: COLORS.coverMuted,
                fontSize: 9,
              },
            ]
          : []),
        {
          text: 'Clasificación productiva, indicadores NDVI/NDMI y evolución temporal.',
          color: COLORS.coverText,
          fontSize: 10,
          margin: [0, 16, 0, 0],
        },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: CONTENT_WIDTH - 48,
              y2: 0,
              lineWidth: 0.75,
              lineColor: COLORS.coverDivider,
            },
          ],
          margin: [0, 22, 0, 0],
        },
        {
          columns: [
            {
              width: '*',
              stack: [
                {
                  text: 'RANGO DE CAMPAÑA',
                  style: 'muted',
                  color: COLORS.coverMuted,
                },
                {
                  text: `${formatDateDMY(analysis.startDate)} — ${formatDateDMY(analysis.endDate)}`,
                  color: '#ffffff',
                  bold: true,
                  fontSize: 12,
                  margin: [0, 2, 0, 0],
                },
                {
                  text: 'FECHA DEL DIAGNÓSTICO',
                  style: 'muted',
                  color: COLORS.coverMuted,
                  margin: [0, 10, 0, 0],
                },
                {
                  text: formatDateDMY(analysis.createdAt),
                  color: '#ffffff',
                  bold: true,
                  fontSize: 12,
                  margin: [0, 2, 0, 0],
                },
              ],
            },
            {
              width: 'auto',
              stack: [
                {
                  text: 'SCORE PRODUCTIVO',
                  style: 'muted',
                  color: COLORS.coverMuted,
                  alignment: 'right',
                },
                {
                  text: `${analysis.globalScore}/100`,
                  color: '#ffffff',
                  bold: true,
                  fontSize: 30,
                  alignment: 'right',
                  margin: [0, 2, 0, 0],
                },
                {
                  text: analysis.category,
                  color: COLORS.coverText,
                  bold: true,
                  alignment: 'right',
                },
              ],
            },
          ],
          margin: [0, 18, 0, 0],
        },
      ],
    };

    return [
      {
        table: {
          widths: ['*'],
          body: [
            [{ ...cover, fillColor: COLORS.coverBg, margin: [24, 28, 24, 28] }],
          ],
        },
        layout: 'noBorders',
      },
      { text: '', margin: [0, 0, 0, 20] },
    ];
  }

  private buildResumenEjecutivo(
    analysis: Analysis,
    resultJson: any,
  ): Content[] {
    const analyzedAreaHa = getAnalyzedAreaHa(resultJson);
    const lotsCount = getLotsCount(resultJson);
    const topZone = getTopZoneByHectares(getFieldZoneTotals(resultJson));

    return [
      this.glued(
        this.sectionTitle('01. Resumen ejecutivo'),
        this.mutedText(
          scoreInterpretation(analysis.globalScore),
          [0, 0, 0, 10],
        ),
      ),
      {
        columns: [
          this.metricCard('Score productivo', `${analysis.globalScore}/100`),
          this.metricCard('Superficie analizada', formatHa(analyzedAreaHa)),
          this.metricCard('Lotes internos', String(lotsCount)),
          this.metricCard(
            'Zona predominante',
            topZone
              ? `${topZone.name} (${topZone.percent.toFixed(1)}%)`
              : 'No disponible',
          ),
        ],
        columnGap: 10,
      },
    ];
  }

  private buildMetodologia(analysis: Analysis, resultJson: any): Content[] {
    const indices = safeText(
      Array.isArray(resultJson?.indices) && resultJson.indices.length
        ? resultJson.indices.join(', ')
        : null,
    );
    const campaigns = safeText(
      resultJson?.zoneClassification?.campaignsUsed?.length
        ? resultJson.zoneClassification.campaignsUsed.join(', ')
        : null,
    );
    const cloudiness = safeText(
      analysis.maxCloudiness !== null && analysis.maxCloudiness !== undefined
        ? `${analysis.maxCloudiness}%`
        : null,
    );

    const row = (label: string, value: string) => ({
      columns: [
        { text: label, style: 'muted', width: '45%' },
        { text: value, width: '55%' },
      ],
      margin: [0, 3, 0, 3],
    });

    return [
      this.glued(this.sectionTitle('02. Metodología'), {
        text:
          'El diagnóstico se basa en imágenes satelitales Sentinel-2 y se calcula a partir de los indicadores ' +
          'NDVI y NDMI. Con esa información se identifican zonas de clasificación productiva (Baja, Alta, Muy ' +
          'Alta) agrupando sectores del campo con respuestas satelitales similares, comparables entre los lotes ' +
          'incluidos. Además se muestra la evolución de esos indicadores a lo largo de las campañas disponibles. ' +
          'Se trata de una lectura satelital relativa dentro del campo, no de una medición directa de rendimiento.',
        margin: [0, 0, 0, 10],
        lineHeight: 1.3,
      }),
      {
        table: {
          widths: ['*'],
          body: [
            [
              {
                stack: [
                  row('Fuente satelital', 'Sentinel-2'),
                  row('Indicadores utilizados', indices),
                  row('Campañas usadas en la clasificación', campaigns),
                  row('Nubosidad máxima admitida', cloudiness),
                ],
                fillColor: COLORS.panel,
                margin: [10, 8, 10, 8],
              },
            ],
          ],
        },
        layout: 'noBorders',
      },
    ];
  }

  private buildCampoYLotes(resultJson: any, field: Field): Content[] {
    const lots = getLotsOverview(resultJson, field.lots || []);

    if (!lots.length) {
      return [
        this.glued(
          this.sectionTitle('03. Campo y lotes analizados'),
          this.emptyNote(
            'No hay información de lotes disponible para este diagnóstico.',
          ),
        ),
      ];
    }

    const body = [
      [
        { text: 'Lote', style: 'tableHeader' },
        { text: 'Superficie', style: 'tableHeader' },
        { text: 'Incluido', style: 'tableHeader' },
        { text: 'Notas', style: 'tableHeader' },
      ],
      ...lots.map((lot) => [
        { text: lot.name, bold: true },
        { text: formatHa(lot.referenceAreaHa) },
        { text: lot.includedLabel },
        { text: lot.notes || '—', style: lot.notes ? undefined : 'muted' },
      ]),
    ];

    return [
      this.sectionTitle('03. Campo y lotes analizados'),
      {
        table: { headerRows: 1, widths: ['*', 'auto', 'auto', '*'], body },
        layout: 'lightHorizontalLines',
      },
    ];
  }

  /** Barra de color real (vmin/vmax/paleta del worker) — REPORT-IMG-1, no un valor inventado. */
  private buildScaleBar(scale: IndexScale): Content {
    return {
      margin: [0, 2, 0, 8],
      stack: [
        {
          table: {
            widths: scale.palette.map(() => '*'),
            heights: 8,
            body: [
              scale.palette.map((color) => ({ text: '', fillColor: color })),
            ],
          },
          layout: 'noBorders',
        },
        {
          columns: [
            { text: String(scale.vmin), style: 'muted', fontSize: 8 },
            {
              text: String(scale.vmax),
              style: 'muted',
              fontSize: 8,
              alignment: 'right',
            },
          ],
        },
      ],
    };
  }

  /** Fase 2 mínima: una celda de la grilla mensual — imagen real o aviso honesto, nunca un placeholder visual. */
  private buildMonthlyImageCell(img: MonthlyImage): Content {
    if (img.available && img.image_base64) {
      return {
        stack: [
          {
            image: `data:image/png;base64,${img.image_base64}`,
            width: 150,
            alignment: 'center',
          },
          {
            text: img.label || '',
            alignment: 'center',
            fontSize: 8,
            margin: [0, 3, 0, 0],
          },
        ],
        margin: [0, 0, 0, 10],
      };
    }

    return {
      stack: [
        {
          table: {
            widths: ['*'],
            body: [
              [
                {
                  text: 'No disponible',
                  color: COLORS.muted,
                  fontSize: 8,
                  alignment: 'center',
                  fillColor: COLORS.panel,
                  margin: [0, 22, 0, 22],
                },
              ],
            ],
          },
          layout: 'noBorders',
        },
        {
          text: img.label || '',
          alignment: 'center',
          fontSize: 8,
          margin: [0, 3, 0, 0],
        },
      ],
      margin: [0, 0, 0, 10],
    };
  }

  /** Grilla de 2 columnas (pdfmake pagina la tabla sola si no entra en una página). */
  private buildMonthlyImageGrid(images: MonthlyImage[]): Content {
    const rows: Content[][] = [];

    for (let i = 0; i < images.length; i += 2) {
      const pair = images
        .slice(i, i + 2)
        .map((img) => this.buildMonthlyImageCell(img));

      if (pair.length === 1) {
        pair.push({ text: '' });
      }

      rows.push(pair);
    }

    return {
      table: { widths: ['*', '*'], body: rows },
      layout: 'noBorders',
      margin: [0, 4, 0, 6],
    };
  }

  /**
   * Fase 2 mínima: NDVI/NDMI mensual por campaña. `imageSeries` es completamente independiente
   * de mapAssets — un análisis puede tener uno, el otro, los dos, o ninguno. Si no hay serie
   * para el índice, mantiene la nota honesta que ya mostraba buildImagenes.
   */
  private buildImageSeriesBlock(
    resultJson: any,
    index: 'ndvi' | 'ndmi',
  ): Content[] {
    const label = index === 'ndvi' ? 'NDVI' : 'NDMI';
    const series = getImageSeries(resultJson, index);

    if (!series.length) {
      return [
        {
          text:
            `Este análisis no incluye grillas mensuales ${label}. Se muestra la serie temporal ` +
            'calculada con imágenes satelitales disponibles.',
          style: 'muted',
          margin: [0, 4, 0, 14],
        },
      ];
    }

    const seriesTitle = {
      text: `${label} mensual por campaña`,
      bold: true,
      fontSize: 11,
      margin: [0, 8, 0, 4],
    };
    const scale = getImageSeriesScale(series);

    // Título + escala pegados (regla 7/8): la escala es corta y casi siempre está presente
    // (vmin/vmax/paleta viajan incluso en meses no disponibles), así que el título nunca queda
    // solo al final de una página con la escala recién empezando en la siguiente.
    const content: Content[] = [
      scale ? this.glued(seriesTitle, this.buildScaleBar(scale)) : seriesTitle,
    ];

    for (const campaignSeries of series) {
      content.push(
        {
          text: `Campaña ${campaignSeries.campaign}`,
          bold: true,
          fontSize: 9,
          margin: [0, 6, 0, 2],
        },
        this.buildMonthlyImageGrid(campaignSeries.images),
      );
    }

    return content;
  }

  private buildImagenes(resultJson: any): Content[] {
    const content: Content[] = [
      { ...this.sectionTitle('04. Imágenes satelitales'), pageBreak: 'before' },
    ];

    // --- RGB ---
    const rgb = getRgbImage(resultJson);

    content.push(
      this.glued(
        { text: 'RGB', style: 'h2', fontSize: 12, margin: [0, 4, 0, 4] },
        {
          text:
            'La imagen RGB corresponde a una composición de bandas roja, verde y azul, similar a ' +
            'una vista natural de la superficie.',
          style: 'muted',
          lineHeight: 1.3,
          margin: [0, 0, 0, 8],
        },
      ),
    );

    if (rgb) {
      content.push(
        {
          image: `data:image/png;base64,${rgb.base64}`,
          width: 380,
          alignment: 'center',
          margin: [0, 0, 0, 4],
        },
        {
          text: `Rango de fechas: ${rgb.dateRangeLabel}.`,
          style: 'muted',
          alignment: 'center',
          margin: [0, 0, 0, 10],
        },
      );
    } else {
      content.push(
        this.emptyNote('Imagen RGB no generada para este análisis.'),
      );
    }

    const lotAreaRows = getLotAreaRows(resultJson);

    if (lotAreaRows.length) {
      const totalHa = getLotAreaTotalHa(lotAreaRows);
      const body = [
        [
          { text: 'Lote', style: 'tableHeader' },
          { text: 'Hectáreas', style: 'tableHeader' },
        ],
        ...lotAreaRows.map((row) => [
          { text: row.name },
          { text: formatHa(row.areaHa) },
        ]),
        [
          { text: 'Total', bold: true },
          { text: formatHa(totalHa), bold: true },
        ],
      ];

      content.push({
        table: { headerRows: 1, widths: ['*', 'auto'], body },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 14],
      });
    }

    // --- NDVI ---
    const ndvi =
      getIndexImages(resultJson).find((item) => item.index === 'NDVI') || null;

    content.push(
      this.glued(
        { text: 'NDVI', style: 'h2', fontSize: 12, margin: [0, 6, 0, 4] },
        {
          text:
            'Valores altos de NDVI indican mayor presencia y vigor de vegetación activa. Valores ' +
            'bajos pueden indicar suelo desnudo, rastrojo o baja cobertura vegetal.',
          style: 'muted',
          lineHeight: 1.3,
          margin: [0, 0, 0, 8],
        },
      ),
    );

    if (ndvi) {
      content.push(
        {
          image: `data:image/png;base64,${ndvi.image_base64}`,
          width: 300,
          alignment: 'center',
          margin: [0, 0, 0, 4],
        },
        {
          text: `Rango de fechas: ${indexImageDateRangeLabel(ndvi)}.`,
          style: 'muted',
          alignment: 'center',
          margin: [0, 0, 0, 6],
        },
      );

      const ndviScale = getIndexScale(ndvi);

      if (ndviScale) {
        content.push(this.buildScaleBar(ndviScale));
      }
    } else {
      content.push(
        this.emptyNote('Imagen NDVI no generada para este análisis.'),
      );
    }

    content.push(...this.buildImageSeriesBlock(resultJson, 'ndvi'));

    // --- NDMI ---
    const ndmi =
      getIndexImages(resultJson).find((item) => item.index === 'NDMI') || null;

    content.push({
      // Regla 3 de la ficha de paginación: NDMI siempre arranca en página nueva (antes se
      // mezclaba con el final de las grillas mensuales de NDVI).
      ...this.glued(
        { text: 'NDMI', style: 'h2', fontSize: 12, margin: [0, 6, 0, 4] },
        {
          text:
            'Valores altos de NDMI indican mayor presencia de agua o humedad foliar. Valores bajos ' +
            'pueden indicar menor contenido de humedad o suelo desnudo.',
          style: 'muted',
          lineHeight: 1.3,
          margin: [0, 0, 0, 8],
        },
      ),
      pageBreak: 'before',
    });

    if (ndmi) {
      content.push(
        {
          image: `data:image/png;base64,${ndmi.image_base64}`,
          width: 300,
          alignment: 'center',
          margin: [0, 0, 0, 4],
        },
        {
          text: `Rango de fechas: ${indexImageDateRangeLabel(ndmi)}.`,
          style: 'muted',
          alignment: 'center',
          margin: [0, 0, 0, 6],
        },
      );

      const ndmiScale = getIndexScale(ndmi);

      if (ndmiScale) {
        content.push(this.buildScaleBar(ndmiScale));
      }
    } else {
      content.push(
        this.emptyNote('Imagen NDMI no generada para este análisis.'),
      );
    }

    content.push(...this.buildImageSeriesBlock(resultJson, 'ndmi'));

    // --- Índices adicionales ---
    const additional = getAdditionalIndexImages(resultJson);

    if (additional.length) {
      content.push({
        text: 'Índices adicionales',
        bold: true,
        margin: [0, 10, 0, 4],
      });
      const columns = additional.map((item) => ({
        width: '*',
        stack: [
          {
            image: `data:image/png;base64,${item.image_base64}`,
            width: 220,
            alignment: 'center',
          },
          {
            text: item.index,
            bold: true,
            alignment: 'center',
            margin: [0, 4, 0, 0],
          },
          {
            text: `Rango de fechas: ${indexImageDateRangeLabel(item)}.`,
            style: 'muted',
            alignment: 'center',
          },
        ],
      }));
      content.push({ columns, columnGap: 10 });
    }

    return content;
  }

  /**
   * PR 11D: el veredicto técnico ya viene generado por AnalysisVerdictService (PR 11A/11B) —
   * nunca se regenera ni se llama a ningún proveedor acá, solo se lee lo que ya persiste
   * AnalysisTechnicalVerdict. Mismos estados y copy que analysis-result.component.ts (PR 11C):
   * 'generated' arma la sección completa, 'failed' un aviso no bloqueante, y null/'pending'
   * omiten la sección entera. El PDF solo se genera para análisis 'Finalizado' (ver build()), así
   * que 'pending' no debería ocurrir en la práctica — se omite igual en vez de mostrar un estado
   * transitorio en un documento ya cerrado.
   */
  private buildVeredictoTecnico(
    technicalVerdict: AnalysisTechnicalVerdictResponse | null,
  ): Content[] {
    if (!technicalVerdict || technicalVerdict.status === 'pending') {
      return [];
    }

    if (technicalVerdict.status === 'failed') {
      return [
        {
          ...this.glued(
            this.sectionTitle('05. Veredicto técnico'),
            this.emptyNote(
              'El análisis satelital finalizó correctamente, pero no se pudo generar el veredicto técnico automático.',
            ),
          ),
          pageBreak: 'before',
        },
      ];
    }

    if (technicalVerdict.status !== 'generated') {
      return [];
    }

    const confidence = confidenceLabel(technicalVerdict.confidence);
    const badges: Content = {
      columns: [
        {
          width: 'auto',
          ...this.badge(
            verdictLabel(technicalVerdict.verdict),
            verdictBadgeStyle(technicalVerdict.verdict),
          ),
        },
        ...(confidence
          ? [
              {
                width: 'auto',
                ...this.badge(`Confianza: ${confidence}`, {
                  background: COLORS.panel,
                  color: COLORS.muted,
                }),
              },
            ]
          : []),
        { width: '*', text: '' },
      ],
      columnGap: 8,
    };

    const content: Content[] = [
      {
        ...this.glued(this.sectionTitle('05. Veredicto técnico'), badges),
        pageBreak: 'before',
      },
    ];

    if (technicalVerdict.summary) {
      content.push({
        text: technicalVerdict.summary,
        lineHeight: 1.3,
        margin: [0, 10, 0, 0],
      });
    }

    content.push(
      ...this.buildVerdictList(
        'Hallazgos principales',
        technicalVerdict.keyFindings,
      ),
      ...this.buildVerdictList(
        'Posibles causas',
        technicalVerdict.possibleCauses,
      ),
      ...this.buildVerdictList(
        'Recomendaciones',
        technicalVerdict.recommendations,
      ),
      ...this.buildVerdictList('Limitaciones', technicalVerdict.limitations),
      {
        text:
          'Veredicto técnico generado automáticamente a partir del análisis satelital. Debe ' +
          'validarse con observación en campo.',
        style: 'muted',
        margin: [0, 10, 0, 0],
      },
    );

    return content;
  }

  /**
   * Subsección de lista del veredicto (hallazgos/causas/recomendaciones/limitaciones) — nunca
   * renderiza el subtítulo si el array viene vacío, para no dejar un título sin bullets.
   */
  private buildVerdictList(title: string, items: string[]): Content[] {
    if (!items.length) {
      return [];
    }

    return [
      { text: title, bold: true, fontSize: 10, margin: [0, 10, 0, 3] },
      { ul: items, lineHeight: 1.25 },
    ];
  }

  private buildClasificacionProductiva(resultJson: any): Content[] {
    const zones = getFieldZoneTotals(resultJson);

    if (!zones.length) {
      return [
        {
          // Regla 4: Clasificación productiva siempre arranca en página nueva después de NDMI.
          ...this.glued(
            this.sectionTitle('06. Clasificación productiva'),
            this.emptyNote(
              'Todavía no hay datos consolidados de clasificación productiva para este campo.',
            ),
          ),
          pageBreak: 'before',
        },
      ];
    }

    const body = [
      [
        { text: 'Zona', style: 'tableHeader' },
        { text: 'Hectáreas', style: 'tableHeader' },
        { text: 'Porcentaje', style: 'tableHeader' },
      ],
      ...zones.map((zone) => [
        { text: zone.name, bold: true, ...this.zoneStyle(zone.name) },
        { text: formatHa(zone.hectares) },
        { text: `${zone.percent.toFixed(1)}%` },
      ]),
    ];

    return [
      {
        // Regla 4: Clasificación productiva siempre arranca en página nueva después de NDMI.
        ...this.glued(this.sectionTitle('06. Clasificación productiva'), {
          text:
            'Las zonas productivas representan diferencias relativas dentro del campo según la respuesta ' +
            'satelital. No representa un rendimiento medido.',
          style: 'muted',
          margin: [0, 0, 0, 10],
        }),
        pageBreak: 'before',
      },
      {
        table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body },
        layout: 'lightHorizontalLines',
      },
      {
        text: getClassificationScopeNote(resultJson),
        style: 'muted',
        margin: [0, 8, 0, 0],
      },
    ];
  }

  /**
   * REPORT-NDVI-EVOL-1: un bloque por lote dentro de una campaña — nombre de lote + curva NDVI
   * real (fecha por fecha), o un aviso honesto si no hay suficientes observaciones válidas. Se
   * envuelve en `unbreakable` (regla del helper `glued`) para que un salto de página natural
   * nunca corte un gráfico a la mitad ni deje el nombre del lote solo al pie de la página.
   */
  private buildLotNdviChartBlock(lotSeries: LotNdviCampaignSeries): Content {
    const label = {
      text: lotSeries.lot,
      bold: true,
      fontSize: 10,
      margin: [0, 8, 0, 3],
    };
    const pointCount = lotSeries.points.length;

    if (pointCount === 0) {
      return this.glued(
        label,
        this.emptyNote(
          'Sin observaciones NDVI válidas para este lote en esta campaña.',
        ),
      );
    }

    if (pointCount === 1) {
      return this.glued(
        label,
        this.emptyNote(
          'Solo 1 observación NDVI disponible en esta campaña: insuficiente para graficar evolución.',
        ),
      );
    }

    const chartSvg = buildNdviEvolutionChartSvg(lotSeries.points);

    return this.glued(label, {
      svg: chartSvg,
      width: 420,
      alignment: 'center',
      margin: [0, 0, 0, 4],
    });
  }

  /**
   * REPORT-NDVI-EVOL-1: reemplaza el gráfico agregado NDVI+NDMI por campaña (un punto por
   * campaña, promediado) por el patrón del reporte histórico de referencia (Horacio Heinz): una
   * página por campaña agrícola real, con una curva NDVI real por lote dentro de cada campaña —
   * fechas y valores tal cual salen de resultJson.timeseries, sin promediar ni inventar puntos.
   * La tabla de promedios por campaña se mantiene pero baja a "Resumen de campaña", después de
   * los gráficos, ya no como la única lectura posible de la evolución temporal.
   */
  private buildEvolucionTemporal(resultJson: any): Content[] {
    const evolution = getNdviEvolutionByCampaign(resultJson);

    if (!evolution.length) {
      return [
        {
          // Regla 5: arranca en página nueva para separarla con claridad de Clasificación productiva.
          ...this.glued(
            this.sectionTitle('07. Gráficos de evolución NDVI'),
            this.emptyNote(
              'No hay datos suficientes para graficar la evolución temporal.',
            ),
          ),
          pageBreak: 'before',
        },
      ];
    }

    const content: Content[] = [
      {
        ...this.glued(
          this.sectionTitle('07. Gráficos de evolución NDVI'),
          this.mutedText(
            'Los siguientes gráficos representan la evolución del índice NDVI para las campañas ' +
              'estudiadas. El eje X indica la fecha de observación satelital y el eje Y el valor de ' +
              'NDVI promedio del lote en cada fecha.',
            [0, 0, 0, 10],
          ),
        ),
        pageBreak: 'before',
      },
    ];

    evolution.forEach((campaignGroup, index) => {
      const campaignHeading = {
        text: `Campaña ${campaignGroup.campaign}`,
        bold: true,
        fontSize: 11,
        margin: [0, index === 0 ? 0 : 10, 0, 2],
      };

      const firstLotBlock = this.buildLotNdviChartBlock(campaignGroup.lots[0]);

      content.push(
        index === 0
          ? this.glued(campaignHeading, firstLotBlock)
          : {
              ...this.glued(campaignHeading, firstLotBlock),
              pageBreak: 'before',
            },
      );

      for (const lotSeries of campaignGroup.lots.slice(1)) {
        content.push(this.buildLotNdviChartBlock(lotSeries));
      }
    });

    const campaigns = getCampaignRows(resultJson);

    if (campaigns.length) {
      content.push({
        text: 'Resumen de campaña',
        bold: true,
        fontSize: 11,
        margin: [0, 18, 0, 4],
      });

      const body = [
        [
          { text: 'Campaña', style: 'tableHeader' },
          { text: 'NDVI promedio', style: 'tableHeader' },
          { text: 'NDMI promedio', style: 'tableHeader' },
        ],
        ...campaigns.map((row) => [
          { text: row.campaign },
          { text: row.ndviMean.toFixed(2) },
          { text: row.ndmiMean.toFixed(2) },
        ]),
      ];

      content.push({
        table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body },
        layout: 'lightHorizontalLines',
      });
    }

    return content;
  }

  private buildLecturaPorLote(resultJson: any): Content[] {
    const lots = getLotZoneDetails(resultJson);

    if (!lots.length) {
      return [
        {
          // Regla 6: Lectura por lote siempre arranca en página nueva (antes esta rama sin
          // datos no forzaba el salto, a diferencia de la rama con datos).
          ...this.glued(
            this.sectionTitle('08. Lectura por lote'),
            this.emptyNote(
              'Todavía no hay lectura por lote interno para este campo.',
            ),
          ),
          pageBreak: 'before',
        },
      ];
    }

    const content: Content[] = [
      {
        ...this.glued(
          this.sectionTitle('08. Lectura por lote'),
          this.mutedText(
            'Superficie, zona predominante y clasificación productiva de cada lote analizado.',
            [0, 0, 0, 10],
          ),
        ),
        pageBreak: 'before',
      },
    ];

    for (const lot of lots) {
      const topZone = getTopZoneByHectares(lot.zones);

      const zoneBody = [
        [
          { text: 'Zona', style: 'tableHeader' },
          { text: 'Hectáreas', style: 'tableHeader' },
          { text: 'Porcentaje', style: 'tableHeader' },
        ],
        ...lot.zones.map((zone) => [
          { text: zone.name, bold: true, ...this.zoneStyle(zone.name) },
          { text: formatHa(zone.hectares) },
          { text: `${zone.percent.toFixed(1)}%` },
        ]),
      ];

      const lotStack: Content[] = [
        { text: lot.lot, bold: true, fontSize: 12, margin: [0, 10, 0, 2] },
        this.mutedText(`${formatHa(lot.areaHa)} analizadas`, [0, 0, 0, 4]),
      ];

      if (topZone) {
        lotStack.push({
          ...this.badge(
            `Zona predominante: ${topZone.name} (${topZone.percent.toFixed(0)}%)`,
            {
              background: zoneColorHex(topZone.name),
              color: zoneTextColorHex(topZone.name),
            },
          ),
          margin: [0, 0, 0, 6],
        });
      }

      lotStack.push({
        table: { headerRows: 1, widths: ['*', 'auto', 'auto'], body: zoneBody },
        layout: 'lightHorizontalLines',
      });

      if (lot.pngBase64) {
        lotStack.push(
          {
            text: 'Mapa de clasificación productiva',
            style: 'muted',
            margin: [0, 8, 0, 4],
          },
          {
            image: `data:image/png;base64,${lot.pngBase64}`,
            width: 260,
            alignment: 'center',
          },
        );
      }

      content.push({
        stack: lotStack,
        unbreakable: true,
        margin: [0, 0, 0, 10],
      });
    }

    return content;
  }

  private buildConclusion(analysis: Analysis, resultJson: any): Content[] {
    const topZone = getTopZoneByHectares(getFieldZoneTotals(resultJson));
    const bestLot = getBestLotByNdvi(resultJson);
    const analyzedAreaHa = getAnalyzedAreaHa(resultJson);
    const lotsCount = getLotsCount(resultJson);

    const bullets: string[] = [scoreInterpretation(analysis.globalScore)];

    if (topZone) {
      bullets.push(
        `La zona con mayor superficie es ${topZone.name}, con ${formatHa(topZone.hectares)} (${topZone.percent.toFixed(1)}% del total considerado).`,
      );
    }

    if (bestLot) {
      bullets.push(
        `El lote con mayor NDVI promedio en el período analizado es ${bestLot.lot} (${bestLot.avgNdvi.toFixed(2)}).`,
      );
    }

    bullets.push(
      `Se clasificaron ${formatHa(analyzedAreaHa)} en total entre los ${lotsCount} lote(s) incluido(s) en la clasificación productiva.`,
    );

    return [
      this.glued(this.sectionTitle('09. Conclusión técnica preliminar'), {
        ul: bullets,
        margin: [0, 0, 0, 10],
      }),
      {
        table: {
          widths: ['*'],
          body: [
            [
              {
                text:
                  'Se recomienda complementar esta lectura satelital con información de manejo y contexto de ' +
                  'campo antes de tomar decisiones agronómicas.',
                fillColor: COLORS.panel,
                margin: [10, 8, 10, 8],
              },
            ],
          ],
        },
        layout: 'noBorders',
      },
      {
        text:
          'Esta conclusión no afirma tipo de cultivo, causas agronómicas ni condiciones de suelo o agua — solo ' +
          'describe los datos satelitales y las hectáreas efectivamente calculados en este diagnóstico.',
        style: 'muted',
        margin: [0, 8, 0, 0],
      },
    ];
  }

  private buildLimitaciones(resultJson: any): Content[] {
    const items = [...METHODOLOGICAL_LIMITATIONS];

    if (!isSoilClimateAvailable(resultJson)) {
      items.push(
        'Suelo y clima no están incluidos en el cálculo del score en este diagnóstico.',
      );
    }

    return [
      this.glued(this.sectionTitle('10. Limitaciones metodológicas'), {
        ul: items,
        lineHeight: 1.3,
      }),
    ];
  }
}
