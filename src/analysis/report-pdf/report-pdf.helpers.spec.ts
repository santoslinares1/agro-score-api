import {
  buildNdviEvolutionChartSvg,
  buildNdviNdmiChartSvg,
  buildPdfFilename,
  campaignLabelFromDate,
  fieldLocationLabel,
  formatDateDMY,
  formatHa,
  getAnalyzedAreaHa,
  getBestLotByNdvi,
  getCampaignRows,
  getCampaignRowsByLot,
  getFieldZoneTotals,
  getImageSeries,
  getImageSeriesScale,
  getIndexScale,
  getLotAreaRows,
  getLotAreaTotalHa,
  getLotsOverview,
  getNdviEvolutionByCampaign,
  getTopZoneByHectares,
  safeText,
  scoreInterpretation,
  slugify,
  zoneColorHex,
} from './report-pdf.helpers';

describe('report-pdf.helpers', () => {
  describe('zoneColorHex', () => {
    // Fase 8E.1: "Alta" y "Muy Alta" deben tener colores distintos, y rojo queda reservado
    // para error/sin datos, nunca para "Baja".
    it('mapea cada nombre de zona a su color esperado', () => {
      expect(zoneColorHex('Muy Alta')).toBe('#004529');
      expect(zoneColorHex('Alta')).toBe('#1a9850');
      expect(zoneColorHex('Baja')).toBe('#fee08b');
      expect(zoneColorHex('Sin datos')).toBe('#d73027');
    });
  });

  describe('scoreInterpretation', () => {
    it('banda alta (>=70): respuesta satelital favorable', () => {
      expect(scoreInterpretation(85)).toMatch(/favorable/);
    });

    it('banda media (>=40 y <70): variabilidad interna relevante', () => {
      expect(scoreInterpretation(55)).toMatch(/variabilidad interna/);
    });

    it('banda baja (<40): menor desempeño relativo', () => {
      expect(scoreInterpretation(20)).toMatch(/menor desempeño/);
    });
  });

  describe('getFieldZoneTotals / getTopZoneByHectares', () => {
    it('ordena por número de zona y detecta la de mayor superficie', () => {
      const resultJson = {
        totalsByZone: [
          { zone: 0, name: 'Baja', hectares: 5, percent: 20 },
          { zone: 2, name: 'Muy Alta', hectares: 15, percent: 60 },
          { zone: 1, name: 'Alta', hectares: 5, percent: 20 },
        ],
      };

      const totals = getFieldZoneTotals(resultJson);
      expect(totals.map((z) => z.name)).toEqual(['Baja', 'Alta', 'Muy Alta']);

      const top = getTopZoneByHectares(totals);
      expect(top?.name).toBe('Muy Alta');
    });

    it('devuelve null si no hay zonas', () => {
      expect(getTopZoneByHectares([])).toBeNull();
    });
  });

  describe('getAnalyzedAreaHa', () => {
    it('suma la superficie analizada de todos los lotes con zonas', () => {
      const resultJson = {
        zones: [
          {
            lot: 'Lote 1',
            area_ha: 10,
            zones: [{ zone: 0, name: 'Baja', hectares: 10, percent: 100 }],
          },
          {
            lot: 'Lote 2',
            area_ha: 5,
            zones: [{ zone: 1, name: 'Alta', hectares: 5, percent: 100 }],
          },
        ],
      };

      expect(getAnalyzedAreaHa(resultJson)).toBe(15);
    });
  });

  describe('getLotsOverview', () => {
    it('combina fieldLots (superficie de referencia) con las notas del Field actual', () => {
      const resultJson = {
        fieldLots: [
          {
            id: 'lot-1',
            name: 'Lote 1',
            areaHa: 12.5,
            includeInProductivityClassification: true,
          },
        ],
      };

      const rows = getLotsOverview(resultJson, [
        { id: 'lot-1', notes: 'Lindero con arroyo' } as any,
      ]);

      expect(rows).toEqual([
        {
          name: 'Lote 1',
          referenceAreaHa: 12.5,
          includedLabel: 'Sí',
          notes: 'Lindero con arroyo',
        },
      ]);
    });

    it('no inventa notas si el Field actual no tiene ninguna para ese lote', () => {
      const resultJson = {
        fieldLots: [{ id: 'lot-1', name: 'Lote 1', areaHa: 3 }],
      };

      const rows = getLotsOverview(resultJson, []);

      expect(rows[0].notes).toBe('');
    });
  });

  describe('getCampaignRows', () => {
    it('agrupa por año y promedia NDVI/NDMI', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote 1',
            rows: [
              {
                date: '2024-01-15',
                values: { NDVI_mean: 0.6, NDVI_count: 5, NDMI_mean: 0.3 },
              },
              {
                date: '2024-03-15',
                values: { NDVI_mean: 0.8, NDVI_count: 5, NDMI_mean: 0.5 },
              },
            ],
          },
        ],
      };

      const rows = getCampaignRows(resultJson);
      expect(rows).toEqual([
        { campaign: '2024', ndviMean: 0.7, ndmiMean: 0.4 },
      ]);
    });

    it('descarta filas sin NDVI_count válido', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote 1',
            rows: [{ date: '2024-01-15', values: { NDVI_count: 0 } }],
          },
        ],
      };

      expect(getCampaignRows(resultJson)).toEqual([]);
    });
  });

  describe('getBestLotByNdvi', () => {
    it('elige el lote con mayor NDVI promedio', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote 1',
            rows: [{ date: '2024-01-01', values: { NDVI_mean: 0.4 } }],
          },
          {
            lot: 'Lote 2',
            rows: [{ date: '2024-01-01', values: { NDVI_mean: 0.9 } }],
          },
        ],
      };

      expect(getBestLotByNdvi(resultJson)).toEqual({
        lot: 'Lote 2',
        avgNdvi: 0.9,
      });
    });

    it('devuelve null si no hay timeseries', () => {
      expect(getBestLotByNdvi({})).toBeNull();
    });
  });

  describe('fieldLocationLabel', () => {
    it('combina location/province/country cuando están disponibles', () => {
      expect(
        fieldLocationLabel({ location: 'Pergamino', province: 'Buenos Aires' }),
      ).toBe('Pergamino, Buenos Aires');
    });

    it('devuelve "No disponible" si el Field no tiene ninguno', () => {
      expect(fieldLocationLabel({})).toBe('No disponible');
    });
  });

  describe('formatDateDMY', () => {
    it('formatea a dd/mm/yyyy', () => {
      expect(formatDateDMY('2024-03-05')).toBe('05/03/2024');
    });

    it('devuelve "No disponible" para fechas inválidas o ausentes', () => {
      expect(formatDateDMY(undefined)).toBe('No disponible');
      expect(formatDateDMY('no-es-una-fecha')).toBe('No disponible');
    });
  });

  describe('slugify / buildPdfFilename', () => {
    it('slugifica nombres con acentos, espacios y mayúsculas', () => {
      expect(slugify('Campo San José / Norte')).toBe('campo-san-jose-norte');
    });

    it('arma el nombre de archivo agroscore-reporte-<campo>-<fecha>.pdf', () => {
      expect(
        buildPdfFilename('Campo San José', new Date('2026-01-15T12:00:00Z')),
      ).toBe('agroscore-reporte-campo-san-jose-2026-01-15.pdf');
    });
  });

  describe('formatHa (PDF-2)', () => {
    it('formatea con dos decimales y sufijo ha', () => {
      expect(formatHa(12.5)).toBe('12.50 ha');
      expect(formatHa(0)).toBe('0.00 ha');
    });

    it('devuelve "No disponible" para null/undefined/NaN, sin inventar un valor', () => {
      expect(formatHa(null)).toBe('No disponible');
      expect(formatHa(undefined)).toBe('No disponible');
      expect(formatHa(NaN)).toBe('No disponible');
    });
  });

  describe('safeText (PDF-2)', () => {
    it('devuelve el valor coercionado a string cuando existe', () => {
      expect(safeText('Sentinel-2')).toBe('Sentinel-2');
      expect(safeText(30)).toBe('30');
    });

    it('cae al fallback ante null/undefined/string vacío, sin inventar contenido', () => {
      expect(safeText(null)).toBe('No disponible');
      expect(safeText(undefined)).toBe('No disponible');
      expect(safeText('')).toBe('No disponible');
      expect(safeText(null, 'Campo')).toBe('Campo');
    });
  });

  describe('getIndexScale (REPORT-IMG-1)', () => {
    it('devuelve la escala real (vmin/vmax/paleta) cuando el análisis la trae', () => {
      expect(
        getIndexScale({
          index: 'NDVI',
          available: true,
          image_base64: 'AAAA',
          vmin: 0,
          vmax: 0.9,
          palette: ['#d73027', '#fee08b', '#91cf60', '#1a9850'],
        }),
      ).toEqual({
        vmin: 0,
        vmax: 0.9,
        palette: ['#d73027', '#fee08b', '#91cf60', '#1a9850'],
      });
    });

    it('devuelve null sin inventar un rango si falta vmin/vmax/paleta (análisis viejos)', () => {
      expect(
        getIndexScale({ index: 'NDVI', available: true, image_base64: 'AAAA' }),
      ).toBeNull();
      expect(getIndexScale(null)).toBeNull();
    });
  });

  describe('getLotAreaRows / getLotAreaTotalHa (REPORT-IMG-1)', () => {
    it('arma la tabla de hectáreas por lote a partir de fieldLots y suma el total', () => {
      const resultJson = {
        fieldLots: [
          { id: 'lot-1', name: 'Lote 1', areaHa: 10 },
          { id: 'lot-2', name: 'Lote 2', areaHa: 5.5 },
        ],
      };

      const rows = getLotAreaRows(resultJson);
      expect(rows).toEqual([
        { name: 'Lote 1', areaHa: 10 },
        { name: 'Lote 2', areaHa: 5.5 },
      ]);
      expect(getLotAreaTotalHa(rows)).toBe(15.5);
    });

    it('devuelve una lista vacía si no hay fieldLots con superficie', () => {
      expect(getLotAreaRows({})).toEqual([]);
      expect(getLotAreaTotalHa([])).toBe(0);
    });
  });

  describe('getCampaignRowsByLot (REPORT-IMG-1)', () => {
    it('agrupa por lote (lot/lot_id) cuando hay más de una serie en el timeseries', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote Norte',
            lot_id: 'lot-1',
            rows: [
              {
                date: '2024-01-15',
                values: { NDVI_mean: 0.6, NDVI_count: 5, NDMI_mean: 0.3 },
              },
            ],
          },
          {
            lot: 'Lote Sur',
            lot_id: 'lot-2',
            rows: [
              {
                date: '2024-01-15',
                values: { NDVI_mean: 0.4, NDVI_count: 5, NDMI_mean: 0.1 },
              },
            ],
          },
        ],
      };

      const groups = getCampaignRowsByLot(resultJson);
      expect(groups).toEqual([
        {
          lot: 'Lote Norte',
          lotId: 'lot-1',
          rows: [{ campaign: '2024', ndviMean: 0.6, ndmiMean: 0.3 }],
        },
        {
          lot: 'Lote Sur',
          lotId: 'lot-2',
          rows: [{ campaign: '2024', ndviMean: 0.4, ndmiMean: 0.1 }],
        },
      ]);
    });

    it('devuelve una lista vacía con un solo lote (no repite el gráfico combinado)', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote Único',
            lot_id: 'lot-1',
            rows: [
              { date: '2024-01-15', values: { NDVI_mean: 0.6, NDVI_count: 5 } },
            ],
          },
        ],
      };

      expect(getCampaignRowsByLot(resultJson)).toEqual([]);
    });
  });

  describe('getImageSeries / getImageSeriesScale (Fase 2 mínima)', () => {
    it('devuelve las campañas con imágenes y filtra campañas vacías', () => {
      const resultJson = {
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
                  palette: ['#d73027', '#1a9850'],
                },
                {
                  date: '2024-11-15',
                  label: 'Nov 2024',
                  available: false,
                  notes: ['Sin imágenes por nubosidad'],
                },
              ],
            },
            { campaign: '2023/24', images: [] },
          ],
          ndmi: [],
        },
      };

      const ndvi = getImageSeries(resultJson, 'ndvi');
      expect(ndvi.length).toBe(1);
      expect(ndvi[0].campaign).toBe('2024/25');
      expect(ndvi[0].images.length).toBe(2);
      expect(ndvi[0].images[1].available).toBe(false);

      expect(getImageSeries(resultJson, 'ndmi')).toEqual([]);
    });

    it('devuelve una lista vacía sin inventar nada cuando falta imageSeries (análisis viejos)', () => {
      expect(getImageSeries({}, 'ndvi')).toEqual([]);
      expect(getImageSeries({ mode: 'python-worker-v2' }, 'ndmi')).toEqual([]);
    });

    it('deriva la escala real de la primera imagen de la serie', () => {
      const series = [
        {
          campaign: '2024/25',
          images: [
            {
              date: '2024-10-15',
              label: 'Oct 2024',
              available: true,
              vmin: 0,
              vmax: 0.9,
              palette: ['#d73027', '#1a9850'],
            },
          ],
        },
      ];

      expect(getImageSeriesScale(series)).toEqual({
        vmin: 0,
        vmax: 0.9,
        palette: ['#d73027', '#1a9850'],
      });
      expect(getImageSeriesScale([])).toBeNull();
    });
  });

  describe('buildNdviNdmiChartSvg (PDF-2)', () => {
    it('devuelve null si no hay campañas (no rompe el PDF por falta de timeseries)', () => {
      expect(buildNdviNdmiChartSvg([])).toBeNull();
    });

    it('genera un <svg> con las series NDVI/NDMI cuando hay varias campañas', () => {
      const svg = buildNdviNdmiChartSvg([
        { campaign: '2023', ndviMean: 0.4, ndmiMean: -0.09 },
        { campaign: '2024', ndviMean: 0.55, ndmiMean: -0.14 },
      ]);

      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
      expect(svg).toContain('NDVI');
      expect(svg).toContain('NDMI');
    });

    it('NDVI (izq.) usa siempre el eje fijo 0–1, NDMI (der.) usa siempre el eje fijo -0.3–0.6, sin auto-escalar según los datos (NDVI-1)', () => {
      // Con valores de NDVI/NDMI bien distintos entre campañas, las etiquetas de eje deben ser
      // siempre las mismas 3 de NDVI (0.00/0.50/1.00) y las mismas 3 de NDMI (-0.30/0.00/0.60):
      // si estuviera auto-escalando (como antes de NDVI-1), estos valores cambiarían con los datos.
      const svgA = buildNdviNdmiChartSvg([
        { campaign: '2023', ndviMean: 0.1, ndmiMean: -0.25 },
        { campaign: '2024', ndviMean: 0.2, ndmiMean: -0.2 },
      ]);
      const svgB = buildNdviNdmiChartSvg([
        { campaign: '2023', ndviMean: 0.8, ndmiMean: 0.5 },
        { campaign: '2024', ndviMean: 0.95, ndmiMean: 0.55 },
      ]);

      for (const svg of [svgA, svgB]) {
        expect(svg).toContain('>0.00<');
        expect(svg).toContain('>0.50<');
        expect(svg).toContain('>1.00<');
        expect(svg).toContain('>-0.30<');
        expect(svg).toContain('>0.60<');
      }

      // Mismo eje NDVI en ambos casos -> la etiqueta "1.00" (borde superior fijo) queda a la
      // misma altura Y en los dos gráficos, sin importar que los datos de svgB sean mucho más
      // altos que los de svgA.
      const yOfNdviTop = (svg: string) =>
        svg.match(/y="([\d.]+)"[^>]*>1\.00</)?.[1];
      expect(yOfNdviTop(svgA as string)).toBe(yOfNdviTop(svgB as string));
    });

    it('NDMI ya no comparte el eje 0–1 de NDVI: con NDMI en su rango típico (~0.2), su punto no queda pegado al piso del gráfico', () => {
      // Antes de NDVI-1, un NDMI de 0.2 contra el eje 0-1 de NDVI se dibujaba casi en el piso
      // del gráfico (cerca de innerHeight completo). Con el eje propio -0.3-0.6, 0.2 cae bastante
      // más arriba, cerca del medio del gráfico.
      const svg = buildNdviNdmiChartSvg([
        { campaign: '2023', ndviMean: 0.7, ndmiMean: 0.2 },
        { campaign: '2024', ndviMean: 0.75, ndmiMean: 0.22 },
      ]);

      const ndmiCircleY = Number(
        svg?.match(
          /<circle cx="[\d.]+" cy="([\d.]+)" r="3" fill="#2563eb"/,
        )?.[1],
      );
      const plotTop = 34; // CHART_PADDING.top
      const plotBottom = 220 - 30; // CHART_HEIGHT - CHART_PADDING.bottom
      const plotHeight = plotBottom - plotTop;

      // A menos del 75% de la altura del gráfico (lejos del piso), no pegado al fondo.
      expect(ndmiCircleY).toBeLessThan(plotTop + plotHeight * 0.75);
    });

    it('con un solo punto dibuja los círculos pero no una línea inventada entre dos fechas', () => {
      const svg = buildNdviNdmiChartSvg([
        { campaign: '2024', ndviMean: 0.6, ndmiMean: 0.2 },
      ]);

      expect(svg).toContain('<circle');
      expect(svg).not.toContain('<path');
    });

    it('no interpola: solo grafica los años que existen realmente en los datos', () => {
      const svg = buildNdviNdmiChartSvg([
        { campaign: '2020', ndviMean: 0.3, ndmiMean: 0.1 },
        { campaign: '2024', ndviMean: 0.5, ndmiMean: 0.2 },
      ]);

      expect(svg).toContain('>2020<');
      expect(svg).toContain('>2024<');
      expect(svg).not.toContain('>2021<');
      expect(svg).not.toContain('>2022<');
      expect(svg).not.toContain('>2023<');
    });
  });

  describe('campaignLabelFromDate (REPORT-NDVI-EVOL-1)', () => {
    it('usa el corte de octubre (mismo criterio que zones.py/sentinel.py en el worker)', () => {
      expect(campaignLabelFromDate('2023-10-01')).toBe('2023/24');
      expect(campaignLabelFromDate('2023-12-31')).toBe('2023/24');
      expect(campaignLabelFromDate('2024-01-01')).toBe('2023/24');
      expect(campaignLabelFromDate('2024-09-30')).toBe('2023/24');
      expect(campaignLabelFromDate('2024-10-01')).toBe('2024/25');
    });

    it('devuelve null sin inventar una campaña si falta o es inválida la fecha', () => {
      expect(campaignLabelFromDate(undefined)).toBeNull();
      expect(campaignLabelFromDate('fecha-invalida')).toBeNull();
    });
  });

  describe('getNdviEvolutionByCampaign (REPORT-NDVI-EVOL-1)', () => {
    it('agrupa las observaciones reales por campaña y, dentro de cada campaña, por lote', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote Norte',
            lot_id: 'lot-1',
            rows: [
              { date: '2023-11-01', values: { NDVI_mean: 0.3, NDVI_count: 5 } },
              { date: '2023-12-01', values: { NDVI_mean: 0.4, NDVI_count: 5 } },
              { date: '2024-11-01', values: { NDVI_mean: 0.5, NDVI_count: 5 } },
            ],
          },
          {
            lot: 'Lote Sur',
            lot_id: 'lot-2',
            rows: [
              {
                date: '2023-11-15',
                values: { NDVI_mean: 0.35, NDVI_count: 5 },
              },
            ],
          },
        ],
      };

      const evolution = getNdviEvolutionByCampaign(resultJson);

      expect(evolution.map((g) => g.campaign)).toEqual(['2023/24', '2024/25']);

      const campaign2324 = evolution[0];
      expect(campaign2324.lots).toEqual([
        {
          lot: 'Lote Norte',
          lotId: 'lot-1',
          points: [
            { date: '2023-11-01', ndviMean: 0.3, ndviStdDev: null },
            { date: '2023-12-01', ndviMean: 0.4, ndviStdDev: null },
          ],
        },
        {
          lot: 'Lote Sur',
          lotId: 'lot-2',
          points: [{ date: '2023-11-15', ndviMean: 0.35, ndviStdDev: null }],
        },
      ]);

      // La campaña 2024/25 sigue listando Lote Sur (sin puntos), en vez de hacerlo desaparecer.
      const campaign2425 = evolution[1];
      expect(campaign2425.lots).toEqual([
        {
          lot: 'Lote Norte',
          lotId: 'lot-1',
          points: [{ date: '2024-11-01', ndviMean: 0.5, ndviStdDev: null }],
        },
        { lot: 'Lote Sur', lotId: 'lot-2', points: [] },
      ]);
    });

    it('conserva NDVI_stdDev real cuando está presente, sin inventarlo cuando falta', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote 1',
            lot_id: 'lot-1',
            rows: [
              {
                date: '2023-11-01',
                values: { NDVI_mean: 0.3, NDVI_count: 5, NDVI_stdDev: 0.05 },
              },
              { date: '2023-12-01', values: { NDVI_mean: 0.4, NDVI_count: 5 } },
            ],
          },
        ],
      };

      const [campaign] = getNdviEvolutionByCampaign(resultJson);
      expect(campaign.lots[0].points).toEqual([
        { date: '2023-11-01', ndviMean: 0.3, ndviStdDev: 0.05 },
        { date: '2023-12-01', ndviMean: 0.4, ndviStdDev: null },
      ]);
    });

    it('ignora filas sin observaciones válidas (NDVI_count en 0 o NDVI_mean no numérico), sin inventar puntos', () => {
      const resultJson = {
        timeseries: [
          {
            lot: 'Lote 1',
            lot_id: 'lot-1',
            rows: [
              { date: '2023-11-01', values: { NDVI_mean: 0.3, NDVI_count: 0 } },
              {
                date: '2023-12-01',
                values: { NDVI_mean: null, NDVI_count: 5 },
              },
              { date: '2024-01-01', values: { NDVI_mean: 0.6, NDVI_count: 5 } },
            ],
          },
        ],
      };

      const [campaign] = getNdviEvolutionByCampaign(resultJson);
      expect(campaign.lots[0].points).toEqual([
        { date: '2024-01-01', ndviMean: 0.6, ndviStdDev: null },
      ]);
    });

    it('devuelve una lista vacía sin inventar campañas cuando no hay timeseries (análisis viejos)', () => {
      expect(getNdviEvolutionByCampaign({})).toEqual([]);
      expect(getNdviEvolutionByCampaign({ mode: 'python-worker-v2' })).toEqual(
        [],
      );
    });
  });

  describe('buildNdviEvolutionChartSvg (REPORT-NDVI-EVOL-1)', () => {
    it('devuelve null con menos de 2 puntos (no hay curva real que trazar)', () => {
      expect(buildNdviEvolutionChartSvg([])).toBeNull();
      expect(
        buildNdviEvolutionChartSvg([
          { date: '2024-01-01', ndviMean: 0.5, ndviStdDev: null },
        ]),
      ).toBeNull();
    });

    it('genera un <svg> con las fechas reales en el eje X', () => {
      const svg = buildNdviEvolutionChartSvg([
        { date: '2024-01-15', ndviMean: 0.4, ndviStdDev: null },
        { date: '2024-02-20', ndviMean: 0.6, ndviStdDev: null },
      ]);

      expect(svg).toContain('<svg');
      expect(svg).toContain('<path');
      expect(svg).toContain('15/01');
      expect(svg).toContain('20/02');
    });

    it('dibuja la banda ±1σ solo cuando todos los puntos tienen NDVI_stdDev válido', () => {
      const conBanda = buildNdviEvolutionChartSvg([
        { date: '2024-01-01', ndviMean: 0.4, ndviStdDev: 0.05 },
        { date: '2024-02-01', ndviMean: 0.5, ndviStdDev: 0.06 },
      ]);
      expect(conBanda).toContain('#dcfce7');

      const sinBandaCompleta = buildNdviEvolutionChartSvg([
        { date: '2024-01-01', ndviMean: 0.4, ndviStdDev: 0.05 },
        { date: '2024-02-01', ndviMean: 0.5, ndviStdDev: null },
      ]);
      expect(sinBandaCompleta).not.toContain('#dcfce7');
    });
  });
});
