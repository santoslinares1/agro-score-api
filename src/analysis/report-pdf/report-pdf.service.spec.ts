import { NotFoundException } from '@nestjs/common';

import { Field } from '../../fields/entities/field.entity';
import { Analysis } from '../entities/analysis.entity';
import { ReportPdfService } from './report-pdf.service';

describe('ReportPdfService', () => {
  let service: ReportPdfService;

  const buildAnalysis = (overrides: Partial<Analysis> = {}): Analysis => ({
    id: 'analysis-1',
    lotId: null,
    fieldId: 'field-1',
    scope: 'field',
    lotName: 'Campo A',
    status: 'Finalizado',
    globalScore: 78,
    category: 'Buena aptitud productiva',
    confidenceScore: 0,
    productivityScore: 0,
    stabilityScore: 0,
    soilScore: 0,
    climateScore: 0,
    ndviAverageMax: 0,
    ndviVariability: 'Media',
    zonesDetected: 2,
    maxCloudiness: 30,
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    resultJson: {
      mode: 'python-worker-v2',
      message: '',
      fieldId: 'field-1',
      indices: ['NDVI', 'NDMI'],
      classificationScope: 'field-global',
      fieldLots: [
        {
          id: 'lot-1',
          name: 'Lote 1',
          areaHa: 10,
          includeInProductivityClassification: true,
        },
      ],
      totalsByZone: [
        { zone: 1, name: 'Alta', hectares: 7, percent: 70 },
        { zone: 0, name: 'Baja', hectares: 3, percent: 30 },
      ],
      zones: [
        {
          lot: 'Lote 1',
          lot_id: 'lot-1',
          area_ha: 10,
          valid_pixels: 100,
          campaigns_used: 1,
          warnings: [],
          zones: [
            { zone: 1, name: 'Alta', hectares: 7, percent: 70, pixels: 70 },
            { zone: 0, name: 'Baja', hectares: 3, percent: 30, pixels: 30 },
          ],
        },
      ],
      timeseries: [
        {
          lot: 'Lote 1',
          lot_id: 'lot-1',
          rows: [
            {
              date: '2024-02-01',
              values: { NDVI_mean: 0.7, NDVI_count: 5, NDMI_mean: 0.4 },
            },
          ],
        },
      ],
    } as any,
    createdAt: new Date('2026-01-15T12:00:00Z'),
    updatedAt: new Date('2026-01-15T12:00:00Z'),
    ...overrides,
  });

  const buildField = (overrides: Partial<Field> = {}): Field => ({
    id: 'field-1',
    userId: 'user-A',
    name: 'Campo San José',
    ownerName: 'Juan Pérez',
    location: 'Pergamino',
    province: 'Buenos Aires',
    totalAreaHa: 10,
    lots: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    startDate: '2024-01-01',
    endDate: '2024-06-01',
    maxCloudiness: 30,
    ...overrides,
  });

  beforeEach(() => {
    service = new ReportPdfService();
  });

  it('lanza NotFoundException si el análisis no está Finalizado', async () => {
    const analysis = buildAnalysis({ status: 'Procesando' });

    await expect(service.build(analysis, buildField())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lanza NotFoundException si no hay totalsByZone (datos insuficientes)', async () => {
    const analysis = buildAnalysis({
      resultJson: { mode: 'python-worker-v2', message: '' } as any,
    });

    await expect(service.build(analysis, buildField())).rejects.toThrow(
      'El análisis no tiene datos suficientes para generar el reporte.',
    );
  });

  it('genera un PDF real (buffer con magic bytes %PDF) y un filename agroscore-reporte-<campo>-<fecha>.pdf', async () => {
    const analysis = buildAnalysis();
    const field = buildField();

    const { stream, filename } = await service.build(analysis, field);

    expect(filename).toBe('agroscore-reporte-campo-san-jose-2026-01-15.pdf');

    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) =>
      stream.on('end', () => resolve()),
    );
    stream.end();
    await ended;

    const buffer = Buffer.concat(chunks);
    expect(buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  describe('header / footer (PDF-2)', () => {
    it('no dibuja header/footer en la portada (página 1)', () => {
      const analysis = buildAnalysis();
      const field = buildField();
      const docDefinition = (service as any).buildDocDefinition(
        analysis,
        field,
      );

      expect(docDefinition.header(1, 3)).toBeFalsy();
      expect(docDefinition.footer(1, 3)).toBeFalsy();
    });

    it('desde la página 2 en adelante muestra marca, "Informe técnico", nombre del campo y numeración', () => {
      const analysis = buildAnalysis();
      const field = buildField({ name: 'Campo San José' });
      const docDefinition = (service as any).buildDocDefinition(
        analysis,
        field,
      );

      const header = JSON.stringify(docDefinition.header(2, 5));
      expect(header).toContain('AGROSCORE');
      expect(header).toContain('Informe técnico');
      expect(header).toContain('Campo San José');

      const footer = JSON.stringify(docDefinition.footer(2, 5));
      expect(footer).toContain('Página 2 de 5');
    });
  });

  describe('portada (PDF-2)', () => {
    it('incluye "Informe técnico" y el badge "DIAGNÓSTICO SATELITAL"', () => {
      const analysis = buildAnalysis();
      const field = buildField();
      const cover = JSON.stringify(
        (service as any).buildCoverPage(analysis, field),
      );

      expect(cover).toContain('Informe técnico');
      expect(cover).toContain('DIAGNÓSTICO SATELITAL');
      expect(cover).toContain('AGROSCORE');
    });
  });

  describe('vocabulario prohibido (PDF-2)', () => {
    it('el documento generado no expone jerga interna (worker/assets/mock/pipeline/JSON)', () => {
      const analysis = buildAnalysis();
      const field = buildField();
      const docDefinition = (service as any).buildDocDefinition(
        analysis,
        field,
      );
      const serialized = JSON.stringify(docDefinition.content);

      for (const forbidden of [
        'worker',
        'assets',
        'mock',
        'pipeline',
        'JSON',
      ]) {
        expect(serialized.toLowerCase()).not.toMatch(
          new RegExp(`\\b${forbidden.toLowerCase()}\\b`),
        );
      }
    });
  });

  describe('gráficos de evolución NDVI por campaña y por lote (REPORT-NDVI-EVOL-1)', () => {
    it('inserta un nodo svg real por lote cuando hay al menos 2 observaciones NDVI en una campaña', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          timeseries: [
            {
              lot: 'Lote 1',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.7, NDVI_count: 5, NDMI_mean: 0.4 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.75, NDVI_count: 5, NDMI_mean: 0.45 },
                },
              ],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('<svg');
      // fecha real de la observación (2024-02-01), no un promedio de campaña.
      expect(serialized).toContain('01/02');
      expect(serialized).toContain('Campaña 2023/24');
      expect(serialized).toContain('06. Gráficos de evolución NDVI');
      expect(serialized).toContain(
        'El eje X indica la fecha de observación satelital y el eje Y el valor de',
      );
    });

    it('con una sola observación en la campaña, muestra un aviso honesto en vez de una curva inventada', () => {
      const analysis = buildAnalysis();
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).not.toContain('<svg');
      expect(serialized).toContain(
        'Solo 1 observación NDVI disponible en esta campaña: insuficiente para graficar evolución.',
      );
    });

    it('agrupa resultJson.timeseries en un bloque por campaña agrícola real, con salto de página entre campañas', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          timeseries: [
            {
              lot: 'Lote 1',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2023-11-01',
                  values: { NDVI_mean: 0.3, NDVI_count: 5 },
                },
                {
                  date: '2023-12-01',
                  values: { NDVI_mean: 0.4, NDVI_count: 5 },
                },
                {
                  date: '2024-11-01',
                  values: { NDVI_mean: 0.5, NDVI_count: 5 },
                },
                {
                  date: '2024-12-01',
                  values: { NDVI_mean: 0.6, NDVI_count: 5 },
                },
              ],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      // Nov/Dic 2023 -> campaña 2023/24; Nov/Dic 2024 -> campaña 2024/25 (corte de octubre).
      expect(serialized).toContain('Campaña 2023/24');
      expect(serialized).toContain('Campaña 2024/25');
      expect((serialized.match(/<svg/g) || []).length).toBe(2);

      const secondCampaignIndex = evolucion.findIndex((node: any) =>
        JSON.stringify(node).includes('Campaña 2024/25'),
      );
      expect(evolucion[secondCampaignIndex].pageBreak).toBe('before');
    });

    it('si un lote no tiene observaciones válidas en una campaña, muestra un aviso honesto para ese lote sin ocultarlo del bloque', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          timeseries: [
            {
              lot: 'Lote Norte',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.7, NDVI_count: 5 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.72, NDVI_count: 5 },
                },
              ],
            },
            {
              lot: 'Lote Sur',
              lot_id: 'lot-2',
              rows: [],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('Lote Sur');
      expect(serialized).toContain(
        'Sin observaciones NDVI válidas para este lote en esta campaña.',
      );
      // un solo gráfico real (Lote Norte); Lote Sur no inventa una curva.
      expect((serialized.match(/<svg/g) || []).length).toBe(1);
    });

    it('ya no depende de resultJson.imageSeries para agrupar u ordenar las campañas', () => {
      const resultJsonSinImageSeries = {
        ...buildAnalysis().resultJson,
        imageSeries: undefined,
        timeseries: [
          {
            lot: 'Lote 1',
            lot_id: 'lot-1',
            rows: [
              { date: '2024-02-01', values: { NDVI_mean: 0.7, NDVI_count: 5 } },
              {
                date: '2024-03-01',
                values: { NDVI_mean: 0.75, NDVI_count: 5 },
              },
            ],
          },
        ],
      };

      const evolucion = (service as any).buildEvolucionTemporal(
        resultJsonSinImageSeries,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('<svg');
      expect(serialized).toContain('Campaña 2023/24');
    });

    it('ya no muestra el promedio agregado NDVI+NDMI por campaña como gráfico principal; la tabla de promedios queda como "Resumen de campaña" al final', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          timeseries: [
            {
              lot: 'Lote 1',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.7, NDVI_count: 5, NDMI_mean: 0.4 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.75, NDVI_count: 5, NDMI_mean: 0.45 },
                },
              ],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).not.toContain('Promedio de NDVI y NDMI por campaña');
      expect(serialized).toContain('Resumen de campaña');

      const resumenIndex = evolucion.findIndex((node: any) =>
        JSON.stringify(node).includes('Resumen de campaña'),
      );
      const firstChartIndex = evolucion.findIndex((node: any) =>
        JSON.stringify(node).includes('<svg'),
      );
      // el resumen agregado aparece después de los gráficos reales, nunca antes.
      expect(resumenIndex).toBeGreaterThan(firstChartIndex);
    });

    it('no rompe si el análisis no tiene timeseries y muestra el estado sobrio pedido', () => {
      const resultJsonSinSeries = {
        mode: 'python-worker-v2',
        message: '',
        totalsByZone: [{ zone: 1, name: 'Alta', hectares: 5, percent: 100 }],
      };

      const evolucion = (service as any).buildEvolucionTemporal(
        resultJsonSinSeries,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).not.toContain('<svg');
      expect(serialized).toContain(
        'No hay datos suficientes para graficar la evolución temporal.',
      );
    });

    it('el PDF completo sigue generándose (%PDF) para un análisis sin timeseries', async () => {
      const analysis = buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 1, name: 'Alta', hectares: 5, percent: 100 }],
        } as any,
      });

      const { stream } = await service.build(analysis, buildField());

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise<void>((resolve) =>
        stream.on('end', () => resolve()),
      );
      stream.end();
      await ended;

      expect(Buffer.concat(chunks).subarray(0, 4).toString('ascii')).toBe(
        '%PDF',
      );
    });
  });

  describe('RGB / NDVI / NDMI reestructurados con texto real y hectáreas por lote (REPORT-IMG-1)', () => {
    it('incluye los títulos y las explicaciones de RGB/NDVI/NDMI, y la tabla de hectáreas por lote', () => {
      const analysis = buildAnalysis();
      const imagenes = (service as any).buildImagenes(analysis.resultJson);
      const serialized = JSON.stringify(imagenes);

      expect(serialized).toContain('RGB');
      expect(serialized).toContain(
        'La imagen RGB corresponde a una composición de bandas roja, verde y azul',
      );
      expect(serialized).toContain(
        'Valores altos de NDVI indican mayor presencia y vigor de vegetación activa',
      );
      expect(serialized).toContain(
        'Valores altos de NDMI indican mayor presencia de agua o humedad foliar',
      );
      expect(serialized).toContain('Lote 1');
      expect(serialized).toContain('10.00 ha');
    });

    it('sin imágenes generadas muestra el aviso honesto por sección, no un placeholder', () => {
      const analysis = buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 1, name: 'Alta', hectares: 5, percent: 100 }],
        } as any,
      });
      const imagenes = (service as any).buildImagenes(analysis.resultJson);
      const serialized = JSON.stringify(imagenes);

      expect(serialized).toContain(
        'Imagen RGB no generada para este análisis.',
      );
      expect(serialized).toContain(
        'Imagen NDVI no generada para este análisis.',
      );
      expect(serialized).toContain(
        'Imagen NDMI no generada para este análisis.',
      );
    });

    it('siempre aclara que no incluye grillas mensuales, sin inventarlas', () => {
      const analysis = buildAnalysis();
      const imagenes = (service as any).buildImagenes(analysis.resultJson);
      const serialized = JSON.stringify(imagenes);

      expect(serialized).toContain(
        'Este análisis no incluye grillas mensuales NDVI',
      );
      expect(serialized).toContain(
        'Este análisis no incluye grillas mensuales NDMI',
      );
    });

    it('con más de un lote en el timeseries, genera un gráfico NDVI real por lote dentro de la campaña (no un gráfico combinado)', () => {
      const analysis = buildAnalysis({
        resultJson: {
          mode: 'python-worker-v2',
          message: '',
          totalsByZone: [{ zone: 1, name: 'Alta', hectares: 5, percent: 100 }],
          timeseries: [
            {
              lot: 'Lote Norte',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.7, NDVI_count: 5, NDMI_mean: 0.4 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.72, NDVI_count: 5, NDMI_mean: 0.42 },
                },
              ],
            },
            {
              lot: 'Lote Sur',
              lot_id: 'lot-2',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.5, NDVI_count: 5, NDMI_mean: 0.2 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.55, NDVI_count: 5, NDMI_mean: 0.25 },
                },
              ],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('Lote Norte');
      expect(serialized).toContain('Lote Sur');
      // un gráfico real por lote, ninguno combinado/promediado.
      expect((serialized.match(/<svg/g) || []).length).toBe(2);
    });

    it('con un solo lote igual muestra su curva NDVI (ya no depende de tener más de un lote)', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          timeseries: [
            {
              lot: 'Lote 1',
              lot_id: 'lot-1',
              rows: [
                {
                  date: '2024-02-01',
                  values: { NDVI_mean: 0.7, NDVI_count: 5, NDMI_mean: 0.4 },
                },
                {
                  date: '2024-03-01',
                  values: { NDVI_mean: 0.75, NDVI_count: 5, NDMI_mean: 0.45 },
                },
              ],
            },
          ],
        } as any,
      });
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('Lote 1');
      expect((serialized.match(/<svg/g) || []).length).toBe(1);
    });
  });

  describe('imageSeries: grillas mensuales NDVI/NDMI por campaña (Fase 2 mínima)', () => {
    it('sin imageSeries mantiene el aviso honesto actual, sin inventar grillas', () => {
      const analysis = buildAnalysis();
      const imagenes = (service as any).buildImagenes(analysis.resultJson);
      const serialized = JSON.stringify(imagenes);

      expect(serialized).toContain(
        'Este análisis no incluye grillas mensuales NDVI',
      );
      expect(serialized).toContain(
        'Este análisis no incluye grillas mensuales NDMI',
      );
      expect(serialized).not.toContain('mensual por campaña');
    });

    it('con imageSeries muestra la grilla, el label de cada mes y el aviso "No disponible" cuando falta un mes', () => {
      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          imageSeries: {
            ndvi: [
              {
                campaign: '2024/25',
                images: [
                  {
                    date: '2024-10-15',
                    label: 'Oct 2024',
                    available: true,
                    image_base64: 'AAAA',
                    vmin: 0,
                    vmax: 0.9,
                    palette: ['#d73027', '#fee08b', '#91cf60', '#1a9850'],
                  },
                  {
                    date: '2024-11-15',
                    label: 'Nov 2024',
                    available: false,
                    vmin: 0,
                    vmax: 0.9,
                    palette: [],
                  },
                ],
              },
            ],
            ndmi: [],
          },
        } as any,
      });

      const imagenes = (service as any).buildImagenes(analysis.resultJson);
      const serialized = JSON.stringify(imagenes);

      expect(serialized).toContain('NDVI mensual por campaña');
      expect(serialized).toContain('Campaña 2024/25');
      expect(serialized).toContain('Oct 2024');
      expect(serialized).toContain('Nov 2024');
      expect(serialized).toContain('No disponible');
      // NDMI no tiene serie en este análisis: sigue con el aviso honesto, no inventa una grilla.
      expect(serialized).toContain(
        'Este análisis no incluye grillas mensuales NDMI',
      );
    });
  });

  describe('paginación del PDF (Fase 3: layout/pageBreak, sin cambios de datos)', () => {
    it('NDMI arranca en página nueva dentro de "04. Imágenes satelitales" (regla 3)', () => {
      const analysis = buildAnalysis();
      const imagenes = (service as any).buildImagenes(analysis.resultJson);

      const pageBreakNodes = imagenes.filter(
        (node: any) => node?.pageBreak === 'before',
      );
      // "04. Imágenes satelitales" (título de sección) + "NDMI" (subsección) — ningún otro nodo
      // de la sección de imágenes fuerza un salto de página.
      expect(pageBreakNodes.length).toBe(2);

      const ndmiBreakNode = pageBreakNodes.find((node: any) =>
        JSON.stringify(node).includes('"NDMI"'),
      );
      expect(ndmiBreakNode).toBeTruthy();
      expect(JSON.stringify(ndmiBreakNode)).toContain(
        'Valores altos de NDMI indican mayor presencia de agua',
      );
      // El título nunca queda sin contenido pegado (regla 7/8): viaja en un stack unbreakable.
      expect(ndmiBreakNode.unbreakable).toBe(true);
    });

    it('Clasificación productiva arranca en página nueva después de NDMI (regla 4), con y sin datos', () => {
      const analysis = buildAnalysis();
      const conDatos = (service as any).buildClasificacionProductiva(
        analysis.resultJson,
      );
      expect(conDatos[0].pageBreak).toBe('before');
      expect(conDatos[0].unbreakable).toBe(true);

      const sinDatos = (service as any).buildClasificacionProductiva({});
      expect(sinDatos[0].pageBreak).toBe('before');
      expect(JSON.stringify(sinDatos[0])).toContain(
        'Todavía no hay datos consolidados de clasificación productiva',
      );
    });

    it('Evolución temporal arranca en página nueva (regla 5), con y sin datos', () => {
      const analysis = buildAnalysis();
      const conDatos = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      expect(conDatos[0].pageBreak).toBe('before');

      const sinDatos = (service as any).buildEvolucionTemporal({});
      expect(sinDatos[0].pageBreak).toBe('before');
      expect(JSON.stringify(sinDatos[0])).toContain(
        'No hay datos suficientes para graficar la evolución temporal',
      );
    });

    it('Lectura por lote arranca en página nueva (regla 6), con y sin datos — antes solo la rama con datos lo forzaba', () => {
      const analysis = buildAnalysis();
      const conDatos = (service as any).buildLecturaPorLote(
        analysis.resultJson,
      );
      expect(conDatos[0].pageBreak).toBe('before');

      const sinDatos = (service as any).buildLecturaPorLote({});
      expect(sinDatos[0].pageBreak).toBe('before');
      expect(JSON.stringify(sinDatos[0])).toContain(
        'Todavía no hay lectura por lote interno',
      );
    });

    it('no cambia ningún dato ni texto de las secciones no relacionadas con paginación', () => {
      const analysis = buildAnalysis();
      const resumen = (service as any).buildResumenEjecutivo(
        analysis,
        analysis.resultJson,
      );
      const serialized = JSON.stringify(resumen);

      expect(serialized).toContain('01. Resumen ejecutivo');
      expect(serialized).toContain('78/100');
      // El título va pegado a la interpretación del score (regla 7), sin agregar texto nuevo.
      expect(resumen[0].unbreakable).toBe(true);
    });

    it('el PDF completo sigue generándose (%PDF) con todas las secciones + imageSeries', async () => {
      // PNG 1x1 real (no un string arbitrario): pdfmake/pdfkit decodifican la imagen de verdad
      // al armar el stream completo, a diferencia de los tests de arriba que solo inspeccionan
      // buildImagenes()/buildDocDefinition() sin pasar por ese paso.
      const onePixelPng =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

      const analysis = buildAnalysis({
        resultJson: {
          ...buildAnalysis().resultJson,
          imageSeries: {
            ndvi: [
              {
                campaign: '2024',
                images: [
                  {
                    date: '2024-02-15',
                    label: 'Feb 2024',
                    available: true,
                    image_base64: onePixelPng,
                    vmin: 0,
                    vmax: 0.9,
                    palette: ['#d73027', '#1a9850'],
                  },
                ],
              },
            ],
            ndmi: [],
          },
        } as any,
      });

      const { stream } = await service.build(analysis, buildField());

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      const ended = new Promise<void>((resolve) =>
        stream.on('end', () => resolve()),
      );
      stream.end();
      await ended;

      expect(Buffer.concat(chunks).subarray(0, 4).toString('ascii')).toBe(
        '%PDF',
      );
    });
  });

  describe('Limitaciones metodológicas: copy sobre imágenes puntuales / grillas mensuales / curvas NDVI', () => {
    it('no contradice la existencia de grillas mensuales NDVI/NDMI y diferencia los 3 tipos de dato', () => {
      const analysis = buildAnalysis();
      const limitaciones = (service as any).buildLimitaciones(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(limitaciones);

      expect(serialized).not.toContain(
        'ventana puntual de la campaña, no a un promedio mensual ni multi-campaña',
      );
      expect(serialized).toContain(
        'La imagen RGB y las imágenes puntuales de índice corresponden a una ventana específica de la campaña.',
      );
      expect(serialized).toContain(
        'Las grillas mensuales NDVI/NDMI se generan a partir de composiciones mensuales disponibles para el período analizado.',
      );
      expect(serialized).toContain(
        'Las curvas de evolución NDVI por lote se calculan con las fechas satelitales disponibles',
      );
    });
  });
});
