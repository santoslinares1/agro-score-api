import { isSimpleClosedRing, Point } from './ring-topology.util';

const TRIANGLE: Point[] = [
  [0, 0],
  [4, 0],
  [2, 3],
  [0, 0],
];

const RECTANGLE: Point[] = [
  [0, 0],
  [0, 2],
  [3, 2],
  [3, 0],
  [0, 0],
];

describe('isSimpleClosedRing — SEC-004', () => {
  describe('negative', () => {
    it('rechaza un ring abierto (4 posiciones, sin repetir el primer punto al final)', () => {
      const openRing: Point[] = [
        [0, 0],
        [4, 0],
        [2, 3],
        [1, 1],
      ];

      expect(isSimpleClosedRing(openRing)).toBe(false);
    });

    it('rechaza menos de 4 posiciones', () => {
      expect(
        isSimpleClosedRing([
          [0, 0],
          [1, 0],
          [0, 0],
        ]),
      ).toBe(false);
    });

    it('rechaza menos de 3 vértices distintos', () => {
      const ring: Point[] = [
        [0, 0],
        [1, 1],
        [0, 0],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza todos los puntos iguales', () => {
      const ring: Point[] = [
        [5, 5],
        [5, 5],
        [5, 5],
        [5, 5],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza vértices consecutivos duplicados (lado de longitud cero)', () => {
      const ring: Point[] = [
        [0, 0],
        [4, 0],
        [4, 0],
        [2, 3],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza un ring cerrado y colineal (área cero)', () => {
      const ring: Point[] = [
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza un bow-tie/autointersección (asimétrico, área neta distinta de cero)', () => {
      const ring: Point[] = [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 1],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza un bow-tie simétrico aunque el área neta cancele a cero', () => {
      const ring: Point[] = [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza el contacto de un vértice sobre un lado no adyacente (T-junction)', () => {
      const ring: Point[] = [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });

    it('rechaza el solapamiento colineal entre lados no adyacentes', () => {
      const ring: Point[] = [
        [0, 0],
        [4, 0],
        [4, 2],
        [1, 2],
        [1, 0],
        [3, 0],
        [3, -2],
        [0, -2],
        [0, 0],
      ];

      expect(isSimpleClosedRing(ring)).toBe(false);
    });
  });

  describe('positive', () => {
    it('acepta un triángulo cerrado simple', () => {
      expect(isSimpleClosedRing(TRIANGLE)).toBe(true);
    });

    it('acepta un rectángulo cerrado simple', () => {
      expect(isSimpleClosedRing(RECTANGLE)).toBe(true);
    });

    it('acepta un polígono válido con más de cuatro posiciones', () => {
      const pentagon: Point[] = [
        [0, 0],
        [4, 0],
        [5, 2],
        [2, 4],
        [-1, 2],
        [0, 0],
      ];

      expect(isSimpleClosedRing(pentagon)).toBe(true);
    });

    it('acepta la misma forma recorrida en sentido horario', () => {
      expect(isSimpleClosedRing([...RECTANGLE].reverse() as Point[])).toBe(true);
    });

    it('acepta un polígono cóncavo (forma de L) sin confundir vértices adyacentes con autointersección', () => {
      const lShape: Point[] = [
        [0, 0],
        [4, 0],
        [4, 2],
        [2, 2],
        [2, 4],
        [0, 4],
        [0, 0],
      ];

      expect(isSimpleClosedRing(lShape)).toBe(true);
    });
  });
});
