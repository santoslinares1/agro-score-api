/**
 * SEC-004: validación topológica de un ring exterior de polígono — función pura, sin dependencia
 * geométrica externa (nada de librerías pesadas tipo `turf`/`jsts`), reutilizada como única
 * política topológica desde `FieldsService.isValidRing` (create()/createLot()/updateLot(), los
 * tres writers de `FieldLot.geojson`). Espeja la misma política que `agro-score-worker`
 * (`app/ring_topology.py`, Python).
 *
 * Un ring exterior se acepta solo si:
 *   1. Tiene al menos 4 posiciones incluyendo el cierre.
 *   2. La primera y última posición son exactamente iguales (comparación por valor lon/lat).
 *   3. Tiene al menos 3 vértices distintos, excluyendo la posición duplicada de cierre.
 *   4. No tiene lados de longitud cero ni vértices consecutivos duplicados.
 *   5. Su área planar firmada (shoelace, en lon/lat) tiene valor absoluto mayor que cero — SIN
 *      tolerancia/epsilon: un ring exactamente colineal (área matemáticamente cero) se rechaza.
 *   6. No tiene auto-intersecciones entre segmentos no adyacentes (los segmentos adyacentes
 *      pueden compartir su extremo común; el primer y último segmento también son adyacentes).
 *
 * Esta función NO corrige nada — un ring abierto, degenerado o con auto-intersección se rechaza
 * (retorna `false`), nunca se normaliza en silencio. No valida rango lon/lat ni tipos: eso sigue
 * siendo responsabilidad del caller (FieldsService.isValidRing corre esos chequeos primero), así
 * que esta función asume que ya recibió pares `[lon, lat]` numéricos.
 */

export type Point = readonly [number, number];

function pointsEqual(a: Point, b: Point): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Signo del producto cruz (q-p) x (r-p): >0 antihorario, <0 horario, 0 colineal. */
function orientation(p: Point, q: Point, r: Point): number {
  const val = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (val > 0) return 1;
  if (val < 0) return -1;
  return 0;
}

/**
 * Asume p, q, r colineales (orientation(p, q, r) === 0). True si q cae dentro del rectángulo
 * delimitado por p y r — o sea, si q está efectivamente ENTRE p y r sobre la misma recta.
 */
function onSegment(p: Point, q: Point, r: Point): boolean {
  return (
    Math.min(p[0], r[0]) <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] &&
    q[1] <= Math.max(p[1], r[1])
  );
}

/**
 * True si el segmento p1-p2 y el segmento p3-p4 se cruzan, se tocan o se solapan — algoritmo
 * estándar por orientación (incluye el caso colineal-superpuesto vía onSegment).
 */
function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment(p3, p2, p4)) return true;

  return false;
}

/**
 * True si `ring` representa un polígono exterior simple, cerrado, con al menos 3 vértices
 * distintos y área no nula. Determinista, sin efectos secundarios, sin llamadas externas.
 */
export function isSimpleClosedRing(ring: readonly Point[]): boolean {
  if (ring.length < 4) {
    return false;
  }

  if (!pointsEqual(ring[0], ring[ring.length - 1])) {
    return false;
  }

  const exterior = ring.slice(0, -1); // sin el punto de cierre duplicado
  const distinct = new Set(exterior.map(([x, y]) => `${x}:${y}`));

  if (distinct.size < 3) {
    return false;
  }

  const n = ring.length;
  const edges: Array<[Point, Point]> = [];

  for (let i = 0; i < n - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];

    if (pointsEqual(a, b)) {
      return false; // lado de longitud cero / vértices consecutivos duplicados
    }

    edges.push([a, b]);
  }

  let area2 = 0;
  for (const [[x1, y1], [x2, y2]] of edges) {
    area2 += x1 * y2 - x2 * y1;
  }

  if (area2 === 0) {
    return false;
  }

  const edgeCount = edges.length;

  for (let i = 0; i < edgeCount; i++) {
    for (let j = i + 1; j < edgeCount; j++) {
      // Adyacentes: comparten un vértice — incluye el caso cíclico (primer y último lado).
      const adjacent = j === i + 1 || (i === 0 && j === edgeCount - 1);

      if (adjacent) {
        continue;
      }

      const [a1, a2] = edges[i];
      const [b1, b2] = edges[j];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return false;
      }
    }
  }

  return true;
}
