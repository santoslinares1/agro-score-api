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

  describe('gráfico NDVI/NDMI (PDF-2)', () => {
    it('inserta un nodo svg en la sección de evolución temporal cuando hay timeseries', () => {
      const analysis = buildAnalysis();
      const evolucion = (service as any).buildEvolucionTemporal(
        analysis.resultJson,
      );
      const serialized = JSON.stringify(evolucion);

      expect(serialized).toContain('<svg');
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
});
