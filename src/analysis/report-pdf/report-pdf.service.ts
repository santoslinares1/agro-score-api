import { Injectable, NotFoundException } from '@nestjs/common';
import pdfMake from 'pdfmake';

import { Analysis } from '../entities/analysis.entity';
import { Field } from '../../fields/entities/field.entity';
import {
  buildNdviNdmiChartSvg,
  buildPdfFilename,
  fieldLocationLabel,
  formatDateDMY,
  formatHa,
  getAdditionalIndexImages,
  getAnalyzedAreaHa,
  getBestLotByNdvi,
  getCampaignRows,
  getClassificationScopeNote,
  getFieldZoneTotals,
  getLotZoneDetails,
  getLotsCount,
  getLotsOverview,
  getPrimaryIndexImages,
  getRgbImage,
  getTopZoneByHectares,
  indexImageDateRangeLabel,
  isSoilClimateAvailable,
  safeText,
  scoreInterpretation,
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
  'Las imágenes visuales (RGB e índices) corresponden a una ventana puntual de la campaña, no a un promedio mensual ni multi-campaña.',
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

    const docDefinition = this.buildDocDefinition(analysis, field);
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
      this.sectionTitle('01. Resumen ejecutivo'),
      this.mutedText(scoreInterpretation(analysis.globalScore), [0, 0, 0, 10]),
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
      this.sectionTitle('02. Metodología'),
      {
        text:
          'El diagnóstico se basa en imágenes satelitales Sentinel-2 y se calcula a partir de los indicadores ' +
          'NDVI y NDMI. Con esa información se identifican zonas de clasificación productiva (Baja, Alta, Muy ' +
          'Alta) agrupando sectores del campo con respuestas satelitales similares, comparables entre los lotes ' +
          'incluidos. Además se muestra la evolución de esos indicadores a lo largo de las campañas disponibles. ' +
          'Se trata de una lectura satelital relativa dentro del campo, no de una medición directa de rendimiento.',
        margin: [0, 0, 0, 10],
        lineHeight: 1.3,
      },
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
        this.sectionTitle('03. Campo y lotes analizados'),
        this.emptyNote(
          'No hay información de lotes disponible para este diagnóstico.',
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

  private buildImagenes(resultJson: any): Content[] {
    const content: Content[] = [
      { ...this.sectionTitle('04. Imágenes satelitales'), pageBreak: 'before' },
    ];

    const rgb = getRgbImage(resultJson);

    content.push({
      text: 'Imagen RGB Sentinel-2',
      bold: true,
      margin: [0, 4, 0, 4],
    });

    if (rgb) {
      content.push(
        {
          image: `data:image/png;base64,${rgb.base64}`,
          width: 380,
          alignment: 'center',
          margin: [0, 0, 0, 4],
        },
        {
          text: `Composición de bandas B4/B3/B2. Rango de fechas: ${rgb.dateRangeLabel}.`,
          style: 'muted',
          alignment: 'center',
          margin: [0, 0, 0, 10],
        },
      );
    } else {
      content.push(
        this.emptyNote('Imagen RGB no disponible para este diagnóstico.'),
      );
    }

    const primary = getPrimaryIndexImages(resultJson);

    content.push({
      text: 'Índices NDVI / NDMI',
      bold: true,
      margin: [0, 10, 0, 4],
    });

    if (primary.length) {
      const columns = primary.map((item) => ({
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
    } else {
      content.push(
        this.emptyNote(
          'Imágenes de NDVI/NDMI no disponibles para este diagnóstico.',
        ),
      );
    }

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

  private buildClasificacionProductiva(resultJson: any): Content[] {
    const zones = getFieldZoneTotals(resultJson);

    if (!zones.length) {
      return [
        this.sectionTitle('05. Clasificación productiva'),
        this.emptyNote(
          'Todavía no hay datos consolidados de clasificación productiva para este campo.',
        ),
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
      this.sectionTitle('05. Clasificación productiva'),
      {
        text:
          'Las zonas productivas representan diferencias relativas dentro del campo según la respuesta ' +
          'satelital. No representa un rendimiento medido.',
        style: 'muted',
        margin: [0, 0, 0, 10],
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
   * PDF-2: la evolución temporal ahora se ve primero como gráfico de líneas NDVI/NDMI (SVG
   * inline, ver buildNdviNdmiChartSvg) y se apoya con la misma tabla resumida de PDF-1 debajo —
   * la tabla no desaparece, solo deja de ser la única forma de leer la evolución.
   */
  private buildEvolucionTemporal(resultJson: any): Content[] {
    const campaigns = getCampaignRows(resultJson);

    if (!campaigns.length) {
      return [
        this.sectionTitle('06. Evolución temporal'),
        this.emptyNote(
          'No hay datos suficientes para graficar la evolución temporal.',
        ),
      ];
    }

    const content: Content[] = [
      this.sectionTitle('06. Evolución temporal'),
      this.mutedText(
        'Promedio de NDVI y NDMI por campaña, sobre el período analizado.',
        [0, 0, 0, 10],
      ),
    ];

    const chartSvg = buildNdviNdmiChartSvg(campaigns);

    if (chartSvg) {
      content.push({
        svg: chartSvg,
        width: 460,
        alignment: 'center',
        margin: [0, 0, 0, 14],
      });
    }

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

    return content;
  }

  private buildLecturaPorLote(resultJson: any): Content[] {
    const lots = getLotZoneDetails(resultJson);

    if (!lots.length) {
      return [
        this.sectionTitle('07. Lectura por lote'),
        this.emptyNote(
          'Todavía no hay lectura por lote interno para este campo.',
        ),
      ];
    }

    const content: Content[] = [
      { ...this.sectionTitle('07. Lectura por lote'), pageBreak: 'before' },
      this.mutedText(
        'Superficie, zona predominante y clasificación productiva de cada lote analizado.',
        [0, 0, 0, 10],
      ),
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
      this.sectionTitle('08. Conclusión técnica preliminar'),
      { ul: bullets, margin: [0, 0, 0, 10] },
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
      this.sectionTitle('09. Limitaciones metodológicas'),
      { ul: items, lineHeight: 1.3 },
    ];
  }
}
