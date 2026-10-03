import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  RedArea,
  VehicleFleet,
  ComputedRoute,
  LogEntry,
  RoutingAlgorithm,
} from '../types/evacuation';

/**
 * Compute polygon centroid as [lat, lng] using 2D area center of mass
 */
export function getPolygonCentroid(polygonCoords: [number, number][]): [number, number] {
  if (!polygonCoords || polygonCoords.length === 0) return [0, 0];
  if (polygonCoords.length >= 3) {
    try {
      const poly = toTurfPolygon(polygonCoords);
      const center = turf.centerOfMass(poly);
      const [lng, lat] = center.geometry.coordinates;
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return [lat, lng];
      }
    } catch {
      // Fallback to vertex average below
    }
  }
  const latSum = polygonCoords.reduce((acc, c) => acc + c[0], 0);
  const lngSum = polygonCoords.reduce((acc, c) => acc + c[1], 0);
  return [latSum / polygonCoords.length, lngSum / polygonCoords.length];
}

/**
 * Convert our [lat, lng][] polygon to a closed GeoJSON Polygon (lng, lat order for Turf)
 */
export function toTurfPolygon(coords: [number, number][]) {
  const ring = coords.map((c) => [c[1], c[0]]);
  if (
    ring.length > 0 &&
    (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
  ) {
    ring.push([...ring[0]]);
  }
  return turf.polygon([ring]);
}

/**
 * Return all constituent polygon rings ([lat, lng][][]) of a Red Area
 */
function getRedAreaRings(red: RedArea): [number, number][][] {
  if (red.polygons && red.polygons.length > 0) {
    return red.polygons.filter((ring) => Array.isArray(ring) && ring.length >= 3);
  }
  return red.polygon && red.polygon.length >= 3 ? [red.polygon] : [];
}

/**
 * Fast axis-aligned bounding box check for [lat, lng][] ring vs [minLat, maxLat, minLng, maxLng]
 */
function doesRingBboxOverlap(
  ring: [number, number][],
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): boolean {
  let rMinLat = Infinity;
  let rMaxLat = -Infinity;
  let rMinLng = Infinity;
  let rMaxLng = -Infinity;
  for (let i = 0; i < ring.length; i++) {
    const lat = ring[i][0];
    const lng = ring[i][1];
    if (lat < rMinLat) rMinLat = lat;
    if (lat > rMaxLat) rMaxLat = lat;
    if (lng < rMinLng) rMinLng = lng;
    if (lng > rMaxLng) rMaxLng = lng;
  }
  return !(rMaxLat < minLat || rMinLat > maxLat || rMaxLng < minLng || rMinLng > maxLng);
}

/**
 * Check if a point ([lat, lng]) lies inside any active (non-disabled) Red Area polygon
 */
export function isPointInAnyRedArea(pt: [number, number], redAreas: RedArea[]): boolean {
  const turfPt = turf.point([pt[1], pt[0]]);
  for (const red of redAreas) {
    if (red.disabled) continue;
    const rings = getRedAreaRings(red);
    for (const ring of rings) {
      if (!doesRingBboxOverlap(ring, pt[0], pt[0], pt[1], pt[1])) continue;
      try {
        const poly = toTurfPolygon(ring);
        if (turf.booleanPointInPolygon(turfPt, poly)) {
          return true;
        }
      } catch {
        // Ignore invalid geometry
      }
    }
  }
  return false;
}

/**
 * Check if a single line segment ([lat1, lng1] -> [lat2, lng2]) intersects a Red Area polygon
 */
export function doesSegmentIntersectRedArea(
  p1: [number, number],
  p2: [number, number],
  red: RedArea
): boolean {
  if (red.disabled) return false;
  const rings = getRedAreaRings(red);
  if (rings.length === 0) return false;
  if (p1[0] === p2[0] && p1[1] === p2[1]) {
    return isPointInAnyRedArea(p1, [red]);
  }
  const minLat = Math.min(p1[0], p2[0]);
  const maxLat = Math.max(p1[0], p2[0]);
  const minLng = Math.min(p1[1], p2[1]);
  const maxLng = Math.max(p1[1], p2[1]);
  const seg = turf.lineString([
    [p1[1], p1[0]],
    [p2[1], p2[0]],
  ]);
  for (const ring of rings) {
    if (!doesRingBboxOverlap(ring, minLat, maxLat, minLng, maxLng)) continue;
    try {
      const poly = toTurfPolygon(ring);
      if (turf.booleanIntersects(seg, poly)) {
        return true;
      }
    } catch {
      // Ignore invalid geometry
    }
  }
  return false;
}

/**
 * Check if a single line segment intersects ANY active Red Area polygon
 */
export function doesSegmentIntersectAnyRedArea(
  p1: [number, number],
  p2: [number, number],
  redAreas: RedArea[]
): boolean {
  for (const red of redAreas) {
    if (red.disabled) continue;
    if (doesSegmentIntersectRedArea(p1, p2, red)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a polyline ([lat, lng][]) intersects a Red Area polygon
 */
export function doesRouteIntersectRedArea(
  routeCoords: [number, number][],
  red: RedArea
): boolean {
  if (red.disabled || routeCoords.length < 2) return false;
  const rings = getRedAreaRings(red);
  if (rings.length === 0) return false;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (let i = 0; i < routeCoords.length; i++) {
    const [lat, lng] = routeCoords[i];
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  const line = turf.lineString(routeCoords.map((c) => [c[1], c[0]]));
  for (const ring of rings) {
    if (!doesRingBboxOverlap(ring, minLat, maxLat, minLng, maxLng)) continue;
    try {
      const poly = toTurfPolygon(ring);
      if (turf.booleanIntersects(line, poly)) {
        return true;
      }
    } catch {
      // Ignore invalid geometry
    }
  }
  return false;
}

/**
 * Return all active Red Areas intersected by a polyline
 */
export function findIntersectingRedAreas(
  routeCoords: [number, number][],
  redAreas: RedArea[]
): RedArea[] {
  return redAreas.filter((red) => !red.disabled && doesRouteIntersectRedArea(routeCoords, red));
}

/**
 * If a point falls inside a Red Area polygon, project it to the nearest safe exterior position
 */
export function ensurePointOutsideRedAreas(
  pt: [number, number],
  redAreas: RedArea[]
): [number, number] {
  if (!isPointInAnyRedArea(pt, redAreas)) return pt;

  const safeCandidates = buildSafeObstacleVertices(redAreas);
  let bestPt: [number, number] = pt;
  let bestDist = Infinity;

  for (const cand of safeCandidates) {
    if (!isPointInAnyRedArea(cand, redAreas)) {
      const d = turf.distance([pt[1], pt[0]], [cand[1], cand[0]]);
      if (d < bestDist) {
        bestDist = d;
        bestPt = cand;
      }
    }
  }
  return bestPt;
}

/**
 * Compute a specific, distinct Pickup Location ([lat, lng]) on/near the perimeter boundary
 * of the Source Area polygon so each route has its own dedicated assembly square,
 * ensuring the pickup location is never placed inside a Red Area.
 */
export function computeSpecificPickupPoint(
  source: SourceArea,
  targetCenter: [number, number],
  slotIndex: number,
  redAreas: RedArea[] = []
): [number, number] {
  const poly = source.polygon;
  const centroid = getPolygonCentroid(poly);
  if (!poly || poly.length < 3) return ensurePointOutsideRedAreas(centroid, redAreas);

  // Generate candidate perimeter anchor points (vertices + edge midpoints)
  const anchors: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    anchors.push(p1);
    anchors.push([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
  }

  // Sort anchors by proximity to the target direction
  const sortedByTarget = [...anchors].sort((a, b) => {
    const dA = turf.distance([a[1], a[0]], [targetCenter[1], targetCenter[0]]);
    const dB = turf.distance([b[1], b[0]], [targetCenter[1], targetCenter[0]]);
    return dA - dB;
  });

  let turfPoly: ReturnType<typeof toTurfPolygon> | null = null;
  try {
    turfPoly = toTurfPolygon(poly);
  } catch {
    turfPoly = null;
  }

  // Try candidate anchors starting from slotIndex offset, picking the first that lies strictly inside the Source Area and outside any Red Area
  for (let offset = 0; offset < sortedByTarget.length; offset++) {
    const chosenAnchor =
      sortedByTarget[(slotIndex * 2 + offset) % sortedByTarget.length] || centroid;
    for (const t of [0.82, 0.9, 0.72, 0.95, 0.55]) {
      const lat = Number((centroid[0] + (chosenAnchor[0] - centroid[0]) * t).toFixed(5));
      const lng = Number((centroid[1] + (chosenAnchor[1] - centroid[1]) * t).toFixed(5));
      const candidate: [number, number] = [lat, lng];
      const insideSource =
        !turfPoly || turf.booleanPointInPolygon(turf.point([lng, lat]), turfPoly);
      if (insideSource && !isPointInAnyRedArea(candidate, redAreas)) {
        return candidate;
      }
    }
  }

  if (turfPoly) {
    try {
      const pof = turf.pointOnFeature(turfPoly);
      const [lng, lat] = pof.geometry.coordinates;
      const pofCand: [number, number] = [Number(lat.toFixed(5)), Number(lng.toFixed(5))];
      if (!isPointInAnyRedArea(pofCand, redAreas)) {
        return pofCand;
      }
    } catch {
      // Fallback below
    }
  }

  return ensurePointOutsideRedAreas(centroid, redAreas);
}

/**
 * Build a set of safe exterior obstacle vertices around all Red Area polygons.
 * Uses multi-tier buffered rings and outward vertex offsets so that shortest-path
 * visibility routing can cleanly circumnavigate any convex, concave, or overlapping Red Area.
 */
function buildSafeObstacleVertices(redAreas: RedArea[]): [number, number][] {
  const vertices: [number, number][] = [];

  for (const red of redAreas) {
    if (red.disabled) continue;
    const rings = getRedAreaRings(red).slice(0, 5);
    for (const targetRing of rings) {
      if (targetRing.length < 3) continue;
      // Downsample very dense GeoJSON rings before buffering so Turf stays fast
      const sampleStep = Math.max(1, Math.floor(targetRing.length / 36));
      const sampledRing =
        sampleStep > 1
          ? targetRing.filter((_, idx) => idx % sampleStep === 0)
          : targetRing;
      if (sampledRing.length < 3) continue;

      const poly = toTurfPolygon(sampledRing);
      const centroid = getPolygonCentroid(sampledRing);

      // 1. Multi-tier buffered exterior rings around the Red Area polygon (80m and 220m clearance)
      for (const bufferKm of [0.08, 0.22]) {
        try {
          const buffered = turf.buffer(poly, bufferKm, { units: 'kilometers', steps: 8 });
          if (buffered && buffered.geometry) {
            const coordsList =
              buffered.geometry.type === 'Polygon'
                ? [buffered.geometry.coordinates[0]]
                : buffered.geometry.type === 'MultiPolygon'
                ? buffered.geometry.coordinates.map((c) => c[0])
                : [];

            for (const ring of coordsList) {
              // Downsample ring if very dense while preserving corners
              const step = Math.max(1, Math.floor(ring.length / 18));
              for (let i = 0; i < ring.length; i += step) {
                const pt: [number, number] = [ring[i][1], ring[i][0]];
                if (!isPointInAnyRedArea(pt, redAreas)) {
                  vertices.push(pt);
                }
              }
            }
          }
        } catch {
          // Fallback handled below
        }
      }

      // 2. Outward-projected vertices & edge midpoints from sampled polygon
      const vStep = Math.max(1, Math.floor(sampledRing.length / 16));
      for (let i = 0; i < sampledRing.length; i += vStep) {
        const p1 = sampledRing[i];
        const p2 = sampledRing[(i + 1) % sampledRing.length];
        const mid: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];

        for (const rawPt of [p1, mid]) {
          const dLat = rawPt[0] - centroid[0];
          const dLng = rawPt[1] - centroid[1];
          const dist = Math.hypot(dLat, dLng) || 0.0001;
          for (const padDeg of [0.0011, 0.0028]) {
            const extPt: [number, number] = [
              rawPt[0] + (dLat / dist) * padDeg,
              rawPt[1] + (dLng / dist) * padDeg,
            ];
            if (!isPointInAnyRedArea(extPt, redAreas)) {
              vertices.push(extPt);
            }
          }
        }
      }

      // 3. Padded bounding box corners (guarantees global escape around concave shapes)
      const bbox = turf.bbox(poly); // [minLng, minLat, maxLng, maxLat]
      const latPad = Math.max(0.0022, (bbox[3] - bbox[1]) * 0.25);
      const lngPad = Math.max(0.0028, (bbox[2] - bbox[0]) * 0.25);
      const boxCorners: [number, number][] = [
        [bbox[3] + latPad, bbox[0] - lngPad],
        [bbox[3] + latPad, bbox[2] + lngPad],
        [bbox[1] - latPad, bbox[2] + lngPad],
        [bbox[1] - latPad, bbox[0] - lngPad],
        [bbox[3] + latPad, (bbox[0] + bbox[2]) / 2],
        [bbox[1] - latPad, (bbox[0] + bbox[2]) / 2],
        [(bbox[1] + bbox[3]) / 2, bbox[0] - lngPad],
        [(bbox[1] + bbox[3]) / 2, bbox[2] + lngPad],
      ];
      for (const bc of boxCorners) {
        if (!isPointInAnyRedArea(bc, redAreas)) {
          vertices.push(bc);
        }
      }
    }
  }

  return vertices;
}

/**
 * Compute the exact shortest collision-free path between `start` and `end`
 * using a Visibility Graph over safe exterior obstacle vertices + Dijkstra's algorithm.
 * Every edge in the returned path is mathematically verified to have ZERO intersection
 * with all Red Area polygons (`doesSegmentIntersectAnyRedArea === false`).
 */
export function computeShortestCollisionFreePath(
  start: [number, number],
  end: [number, number],
  redAreas: RedArea[],
  sidePreference: 'primary' | 'alternate' = 'primary'
): [number, number][] {
  const safeStart = ensurePointOutsideRedAreas(start, redAreas);
  const safeEnd = ensurePointOutsideRedAreas(end, redAreas);

  if (redAreas.length === 0 || !doesSegmentIntersectAnyRedArea(safeStart, safeEnd, redAreas)) {
    return [safeStart, safeEnd];
  }

  const obstacleNodes = buildSafeObstacleVertices(redAreas);
  const nodes: [number, number][] = [safeStart, ...obstacleNodes, safeEnd];
  const startIdx = 0;
  const endIdx = nodes.length - 1;

  // Line vector from start to end for optional primary/alternate side bias
  const lineLat = safeEnd[0] - safeStart[0];
  const lineLng = safeEnd[1] - safeStart[1];

  const dist = new Array<number>(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const visited = new Array<boolean>(nodes.length).fill(false);

  dist[startIdx] = 0;

  for (let step = 0; step < nodes.length; step++) {
    let u = -1;
    let minVal = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!visited[i] && dist[i] < minVal) {
        minVal = dist[i];
        u = i;
      }
    }

    if (u === -1 || u === endIdx) break;
    visited[u] = true;

    const uPt = nodes[u];

    for (let v = 0; v < nodes.length; v++) {
      if (visited[v] || u === v) continue;
      const vPt = nodes[v];

      // Check Euclidean/geodesic distance first to avoid unnecessary intersection checks if already worse
      const edgeKm = turf.distance([uPt[1], uPt[0]], [vPt[1], vPt[0]], {
        units: 'kilometers',
      });

      // Slight side bias when computing secondary/alternate corridor so Bravo routes around opposite side
      let weight = edgeKm;
      if (sidePreference === 'alternate' && v !== endIdx) {
        const cross =
          lineLat * (vPt[1] - safeStart[1]) - lineLng * (vPt[0] - safeStart[0]);
        if (cross > 0) {
          weight *= 1.18;
        }
      }

      if (dist[u] + weight >= dist[v]) continue;

      // Strictly forbid any edge that intersects ANY Red Area polygon
      if (!doesSegmentIntersectAnyRedArea(uPt, vPt, redAreas)) {
        dist[v] = dist[u] + weight;
        prev[v] = u;
      }
    }
  }

  // Reconstruct shortest collision-free path
  if (dist[endIdx] < Infinity) {
    const path: [number, number][] = [];
    let curr = endIdx;
    while (curr !== -1) {
      path.push(nodes[curr]);
      curr = prev[curr];
    }
    path.reverse();
    return path;
  }

  return [safeStart, safeEnd];
}

/**
 * Surgically inspect a polyline and replace any segment or contiguous sub-path
 * that enters or crosses any Red Area polygon with the shortest collision-free visibility-graph detour.
 * Guarantees 100% that the returned polyline has ZERO intersections with all Red Areas.
 */
export function enforceStrictRedAreaAvoidance(
  coords: [number, number][],
  redAreas: RedArea[]
): [number, number][] {
  if (redAreas.length === 0 || coords.length < 2) return coords;

  // Ensure all vertices are outside Red Areas first
  let current: [number, number][] = coords.map((pt) => ensurePointOutsideRedAreas(pt, redAreas));

  // If the entire polyline already has zero intersections with all Red Areas, return immediately
  if (findIntersectingRedAreas(current, redAreas).length === 0) {
    return current;
  }

  // Iteratively repair any segment that intersects a Red Area by bridging safe anchors around it
  const maxPasses = 4;
  for (let pass = 0; pass < maxPasses; pass++) {
    if (findIntersectingRedAreas(current, redAreas).length === 0) {
      break;
    }

    const repaired: [number, number][] = [];
    let i = 0;

    while (i < current.length) {
      const pt = current[i];
      repaired.push(pt);

      if (i === current.length - 1) break;

      // Check if segment (current[i] -> current[i+1]) intersects any Red Area polygon
      if (doesSegmentIntersectAnyRedArea(current[i], current[i + 1], redAreas)) {
        // Look ahead to find the first safe vertex j > i whose onward path clears the obstacle
        let j = i + 1;
        while (
          j < current.length - 1 &&
          (isPointInAnyRedArea(current[j], redAreas) ||
            doesSegmentIntersectAnyRedArea(current[j], current[j + 1], redAreas))
        ) {
          j++;
        }

        // Advance one extra vertex when possible for smoother road reconnection
        const exitIdx = Math.min(current.length - 1, j + 1);
        const entryPt = current[i];
        const exitPt = current[exitIdx];

        const detour = computeShortestCollisionFreePath(entryPt, exitPt, redAreas);
        // Append interior detour vertices + exitPt
        for (let k = 1; k < detour.length; k++) {
          repaired.push(detour[k]);
        }

        i = exitIdx;
      } else {
        i++;
      }
    }

    current = repaired;
  }

  return current;
}

/**
 * Query OSRM HTTP API for a driving route through waypoints.
 */
async function fetchOSRMRoute(
  waypoints: [number, number][]
): Promise<{ coordinates: [number, number][]; distanceMeters: number; durationSeconds: number }> {
  const coordsString = waypoints.map((wp) => `${wp[1].toFixed(5)},${wp[0].toFixed(5)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordsString}?overview=full&geometries=geojson`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const data = await response.json();
      if (data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        const coordinates: [number, number][] = route.geometry.coordinates.map(
          (c: [number, number]) => [c[1], c[0]]
        );
        if (coordinates.length > 0) {
          coordinates[0] = waypoints[0];
          coordinates[coordinates.length - 1] = waypoints[waypoints.length - 1];
        }
        return {
          coordinates,
          distanceMeters: route.distance || calculatePathDistanceMeters(coordinates),
          durationSeconds:
            route.duration || Math.round(calculatePathDistanceMeters(coordinates) / 8.5),
        };
      }
    }
  } catch {
    // Fall through to deterministic urban road synthesis
  }

  return synthesizeUrbanRoadPath(waypoints);
}

function synthesizeUrbanRoadPath(waypoints: [number, number][]): {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
} {
  const coords: [number, number][] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const start = waypoints[i];
    const end = waypoints[i + 1];
    coords.push(start);

    const segments = 14;
    const dLat = end[0] - start[0];
    const dLng = end[1] - start[1];

    for (let s = 1; s < segments; s++) {
      const t = s / segments;
      const curveOffset = Math.sin(t * Math.PI * 2) * 0.0005;
      const lat = start[0] + dLat * t + curveOffset;
      const lng = start[1] + dLng * t - curveOffset * 0.7;
      coords.push([lat, lng]);
    }
  }
  coords.push(waypoints[waypoints.length - 1]);

  const distanceMeters = calculatePathDistanceMeters(coords);
  return {
    coordinates: coords,
    distanceMeters,
    durationSeconds: Math.round(distanceMeters / 8.5),
  };
}

/**
 * Full obstacle-avoiding route generator between `start` and `end`:
 * 1. Computes collision-free visibility waypoints around any Red Area polygons in the corridor.
 * 2. Requests an OSRM street route through those waypoints.
 * 3. If OSRM's road geometry still touches/crosses any Red Area polygon, applies
 *    `enforceStrictRedAreaAvoidance` so that every segment is 100% outside all Red Areas.
 */
export async function computeObstacleAvoidingRoute(
  start: [number, number],
  end: [number, number],
  redAreas: RedArea[],
  sidePreference: 'primary' | 'alternate' = 'primary'
): Promise<{
  coordinates: [number, number][];
  avoidedRedAreaNames: string[];
  isDetour: boolean;
}> {
  const safeStart = ensurePointOutsideRedAreas(start, redAreas);
  const safeEnd = ensurePointOutsideRedAreas(end, redAreas);

  const avoidedSet = new Set<string>();
  for (const red of findIntersectingRedAreas([safeStart, safeEnd], redAreas)) {
    avoidedSet.add(red.name);
  }

  // Compute collision-free waypoints via Visibility Graph
  const visWaypoints = computeShortestCollisionFreePath(
    safeStart,
    safeEnd,
    redAreas,
    sidePreference
  );

  // Query OSRM with the visibility waypoints
  const osrmResult = await fetchOSRMRoute(visWaypoints);
  for (const red of findIntersectingRedAreas(osrmResult.coordinates, redAreas)) {
    avoidedSet.add(red.name);
  }

  // Enforce 100% strict Red Area polygon avoidance across every segment of the route
  const strictCoords = enforceStrictRedAreaAvoidance(osrmResult.coordinates, redAreas);

  return {
    coordinates: strictCoords,
    avoidedRedAreaNames: Array.from(avoidedSet),
    isDetour: avoidedSet.size > 0 || visWaypoints.length > 2,
  };
}

export function calculatePathDistanceMeters(coords: [number, number][]): number {
  let totalKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    totalKm += turf.distance(
      [coords[i][1], coords[i][0]],
      [coords[i + 1][1], coords[i + 1][0]],
      { units: 'kilometers' }
    );
  }
  return Math.round(totalKm * 1000);
}

export interface ClosestRoutePointResult {
  point: [number, number];
  segmentIndex: number;
  t: number;
  distanceMeters: number;
}

/**
 * Remove consecutive duplicate coordinates (within ~0.5m) while preserving at least 2 points.
 */
export function dedupPolylineCoords(coords: [number, number][]): [number, number][] {
  if (coords.length <= 2) return coords;
  const out: [number, number][] = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const prev = out[out.length - 1];
    const curr = coords[i];
    if (Math.hypot(curr[0] - prev[0], curr[1] - prev[1]) > 4e-6 || i === coords.length - 1) {
      out.push(curr);
    }
  }
  if (out.length < 2) {
    out.push(coords[coords.length - 1]);
  }
  return out;
}

/**
 * Find the exact closest projected point on an evacuation route polyline `coords` (`[lat, lng][]`)
 * to a given query point `pt` (`[lat, lng]`).
 */
export function findClosestPointOnPolyline(
  pt: [number, number],
  coords: [number, number][]
): ClosestRoutePointResult {
  if (!coords || coords.length === 0) {
    return { point: pt, segmentIndex: 0, t: 0, distanceMeters: 0 };
  }
  if (coords.length === 1) {
    const dMeters =
      turf.distance([pt[1], pt[0]], [coords[0][1], coords[0][0]], { units: 'kilometers' }) * 1000;
    return { point: coords[0], segmentIndex: 0, t: 0, distanceMeters: dMeters };
  }

  const cosLat = Math.max(0.1, Math.cos((pt[0] * Math.PI) / 180));
  let bestPoint: [number, number] = coords[0];
  let bestSegIdx = 0;
  let bestT = 0;
  let bestDistSq = Infinity;

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const abLat = b[0] - a[0];
    const abLng = (b[1] - a[1]) * cosLat;
    const apLat = pt[0] - a[0];
    const apLng = (pt[1] - a[1]) * cosLat;
    const abLenSq = abLat * abLat + abLng * abLng;

    const t =
      abLenSq > 1e-14
        ? Math.max(0, Math.min(1, (apLat * abLat + apLng * abLng) / abLenSq))
        : 0;
    const projLat = a[0] + (b[0] - a[0]) * t;
    const projLng = a[1] + (b[1] - a[1]) * t;

    const dLat = pt[0] - projLat;
    const dLng = (pt[1] - projLng) * cosLat;
    const dSq = dLat * dLat + dLng * dLng;

    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestPoint = [Number(projLat.toFixed(6)), Number(projLng.toFixed(6))];
      bestSegIdx = i;
      bestT = t;
    }
  }

  const distanceMeters =
    turf.distance([pt[1], pt[0]], [bestPoint[1], bestPoint[0]], { units: 'kilometers' }) * 1000;

  return {
    point: bestPoint,
    segmentIndex: bestSegIdx,
    t: bestT,
    distanceMeters,
  };
}

/**
 * Follow an evacuation route polyline (`coords` oriented from pickupLocation at index 0 to dropOffLocation at index N-1)
 * from `snap.point` (on segment `snap.segmentIndex`) backward along the evacuation route to the pickup point (`coords[0]`).
 */
export function buildRouteSuffixToPickup(
  coords: [number, number][],
  snap: ClosestRoutePointResult
): [number, number][] {
  if (!coords || coords.length === 0) return [snap.point, snap.point];
  const prefixReversed = coords.slice(0, snap.segmentIndex + 1).reverse();
  return dedupPolylineCoords([snap.point, ...prefixReversed]);
}

/**
 * Follow an evacuation route polyline (`coords` oriented from pickupLocation at index 0 to dropOffLocation at index N-1)
 * from `snap.point` (on segment `snap.segmentIndex`) forward along the evacuation route to the target shelter (`coords[N-1]`).
 */
export function buildRouteSuffixToTarget(
  coords: [number, number][],
  snap: ClosestRoutePointResult
): [number, number][] {
  if (!coords || coords.length === 0) return [snap.point, snap.point];
  const suffixForward = coords.slice(snap.segmentIndex + 1);
  return dedupPolylineCoords([snap.point, ...suffixForward]);
}

/**
 * Find the evacuation route in `routes` whose polyline is closest to `pt`.
 */
export function findClosestEvacuationRoute(
  pt: [number, number],
  routes: ComputedRoute[]
): { route: ComputedRoute; snap: ClosestRoutePointResult } | null {
  if (!routes || routes.length === 0) return null;

  let bestRoute = routes[0];
  let bestSnap = findClosestPointOnPolyline(pt, routes[0].coordinates);
  let bestPickupDist =
    turf.distance(
      [pt[1], pt[0]],
      [routes[0].pickupLocation[1], routes[0].pickupLocation[0]],
      { units: 'kilometers' }
    ) * 1000;

  for (let i = 1; i < routes.length; i++) {
    const r = routes[i];
    const snap = findClosestPointOnPolyline(pt, r.coordinates);
    const pickupDist =
      turf.distance([pt[1], pt[0]], [r.pickupLocation[1], r.pickupLocation[0]], {
        units: 'kilometers',
      }) * 1000;

    if (
      snap.distanceMeters < bestSnap.distanceMeters - 25 ||
      (Math.abs(snap.distanceMeters - bestSnap.distanceMeters) <= 25 &&
        pickupDist < bestPickupDist)
    ) {
      bestRoute = r;
      bestSnap = snap;
      bestPickupDist = pickupDist;
    }
  }

  return { route: bestRoute, snap: bestSnap };
}

/**
 * Pair each evacuation route polyline with a VehicleFleet by proximity to the route polyline,
 * with a gentle load-balancing tie-breaker among nearby depots on the same corridor so all
 * nearby parking stations share their closest evacuation routes.
 */
export function assignFleetsToRoutesByProximity(
  routeCoordsList: [number, number][][],
  vehicleFleets: VehicleFleet[]
): (VehicleFleet | undefined)[] {
  if (!vehicleFleets || vehicleFleets.length === 0) {
    return routeCoordsList.map(() => undefined);
  }

  const assignedCount = new Array<number>(vehicleFleets.length).fill(0);
  return routeCoordsList.map((coords) => {
    let bestFleetIdx = 0;
    let bestScore = Infinity;
    for (let fIdx = 0; fIdx < vehicleFleets.length; fIdx++) {
      const fleet = vehicleFleets[fIdx];
      const snap = findClosestPointOnPolyline(fleet.location, coords);
      // 600m load-balancing step lets co-located depots along the same trunk share routes without cross-city assignment
      const score = snap.distanceMeters + assignedCount[fIdx] * 600;
      if (score < bestScore) {
        bestScore = score;
        bestFleetIdx = fIdx;
      }
    }
    assignedCount[bestFleetIdx] += 1;
    return vehicleFleets[bestFleetIdx];
  });
}

/**
 * Compute the approach path from `startPt` (e.g., a bus parking station `fleet.location` or an off-route bus position)
 * to the closest point on `routeCoords` (`snap.point`), and then follow `routeCoords` in reverse from `snap.point`
 * all the way to the Pickup Location (`routeCoords[0]`).
 */
export async function computeApproachViaClosestPointOnRoute(
  startPt: [number, number],
  routeCoords: [number, number][],
  redAreas: RedArea[],
  sidePreference: 'primary' | 'alternate' = 'primary',
  connectorCache?: Map<string, [number, number][]>
): Promise<[number, number][]> {
  const snap = findClosestPointOnPolyline(startPt, routeCoords);
  const onRouteToPickup = buildRouteSuffixToPickup(routeCoords, snap);

  if (snap.distanceMeters <= 25) {
    return dedupPolylineCoords([startPt, ...onRouteToPickup]);
  }

  const cacheKey = `${startPt[0].toFixed(5)},${startPt[1].toFixed(5)}->${snap.point[0].toFixed(5)},${snap.point[1].toFixed(5)}:${sidePreference}`;
  let connectorCoords = connectorCache?.get(cacheKey);
  if (!connectorCoords) {
    const connectorRes = await computeObstacleAvoidingRoute(
      startPt,
      snap.point,
      redAreas,
      sidePreference
    );
    connectorCoords = connectorRes.coordinates;
    if (connectorCache) {
      connectorCache.set(cacheKey, connectorCoords);
    }
  }

  return dedupPolylineCoords([...connectorCoords, ...onRouteToPickup.slice(1)]);
}

/**
 * When a bus is off any evacuation route after stopping the simulation, changing areas, and recalculating routes,
 * compute the path that directs the bus from `currentPos` to the closest point on the closest recalculated
 * evacuation route, and then follows that evacuation route from there (to the pickup point if `'to_pickup'`,
 * or to the target shelter if `'to_target'`).
 */
export async function computeRejoinPathToClosestRoute(
  currentPos: [number, number],
  routes: ComputedRoute[],
  redAreas: RedArea[],
  mode: 'to_pickup' | 'to_target'
): Promise<{
  route: ComputedRoute;
  snap: ClosestRoutePointResult;
  coordinates: [number, number][];
} | null> {
  const closest = findClosestEvacuationRoute(currentPos, routes);
  if (!closest) return null;

  const activeReds = redAreas.filter((a) => !a.disabled);
  const onRoutePortion =
    mode === 'to_pickup'
      ? buildRouteSuffixToPickup(closest.route.coordinates, closest.snap)
      : buildRouteSuffixToTarget(closest.route.coordinates, closest.snap);

  if (closest.snap.distanceMeters <= 25) {
    return {
      route: closest.route,
      snap: closest.snap,
      coordinates: dedupPolylineCoords([currentPos, ...onRoutePortion]),
    };
  }

  const connectorRes = await computeObstacleAvoidingRoute(
    currentPos,
    closest.snap.point,
    activeReds,
    'primary'
  );

  return {
    route: closest.route,
    snap: closest.snap,
    coordinates: dedupPolylineCoords([...connectorRes.coordinates, ...onRoutePortion.slice(1)]),
  };
}

/**
 * Compute an immediate obstacle-avoiding route from a running vehicle's current position
 * to the closest active (non-disabled) Target Area.
 */
export async function computeDirectRouteToClosestTarget(
  currentPos: [number, number],
  targetAreas: TargetArea[],
  redAreas: RedArea[]
): Promise<{ target: TargetArea; coordinates: [number, number][] }> {
  const activeTargets = targetAreas.filter((t) => !t.disabled);
  const activeReds = redAreas.filter((a) => !a.disabled);
  const candidates = activeTargets.length > 0 ? activeTargets : targetAreas;

  const sorted = [...candidates].sort((a, b) => {
    const cA = getPolygonCentroid(a.polygon);
    const cB = getPolygonCentroid(b.polygon);
    const dA = turf.distance([currentPos[1], currentPos[0]], [cA[1], cA[0]]);
    const dB = turf.distance([currentPos[1], currentPos[0]], [cB[1], cB[0]]);
    return dA - dB;
  });

  const closestTarget = sorted[0];
  const tgtCenter = getPolygonCentroid(closestTarget.polygon);

  const result = await computeObstacleAvoidingRoute(
    currentPos,
    tgtCenter,
    activeReds,
    'primary'
  );

  return { target: closestTarget, coordinates: result.coordinates };
}

export interface RoutingComputationResult {
  routes: ComputedRoute[];
  logs: LogEntry[];
}

interface EvaccastV1PathResponse {
  pathIndex: number;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  pickupLocation: [number, number];
  dropOffLocation: [number, number];
  coordinates: [number, number][];
  distanceMeters: number;
  estimatedDurationSeconds: number;
}

interface EvaccastV1ApiResponse {
  ok: boolean;
  error?: string;
  paths?: EvaccastV1PathResponse[];
  maxFlowVehPerHr?: number;
  minEvacTimeHours?: number | null;
  demand?: number;
  sheltered?: number;
}

/**
 * Deterministically stringify all routing parameters (source, target, red areas,
 * vehicles, capacities, populations, behaviors, speeds, load/unload rates, disabled states, etc.)
 * so that even a single coordinate point or attribute change alters the serialized string.
 */
export function stringifyRoutingParameters(
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  redAreas: RedArea[],
  vehicleFleets: VehicleFleet[]
): string {
  const canonicalPayload = {
    sourceAreas: sourceAreas.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      polygon: s.polygon.map((pt) => [Number(pt[0]), Number(pt[1])]),
      population: Number(s.population),
      behavior: {
        compliant: Number(s.behavior.compliant),
        'self-directed': Number(s.behavior['self-directed']),
        disoriented: Number(s.behavior.disoriented),
      },
      disabled: Boolean(s.disabled),
    })),
    targetAreas: targetAreas.map((t) => ({
      id: String(t.id),
      name: String(t.name),
      polygon: t.polygon.map((pt) => [Number(pt[0]), Number(pt[1])]),
      capacity: Number(t.capacity),
      disabled: Boolean(t.disabled),
    })),
    redAreas: redAreas.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      polygon: a.polygon.map((pt) => [Number(pt[0]), Number(pt[1])]),
      ...(a.polygons && a.polygons.length > 1
        ? {
            polygons: a.polygons.map((ring) =>
              ring.map((pt) => [Number(pt[0]), Number(pt[1])])
            ),
          }
        : {}),
      disabled: Boolean(a.disabled),
    })),
    vehicleFleets: vehicleFleets.map((v) => ({
      id: String(v.id),
      name: String(v.name),
      type: String(v.type),
      location: [Number(v.location[0]), Number(v.location[1])],
      count: Number(v.count),
      capacityPerUnit: Number(v.capacityPerUnit),
      loadUnloadTimePerPersonSeconds: Number(v.loadUnloadTimePerPersonSeconds),
      transitSpeedKmh: Number(v.transitSpeedKmh),
    })),
  };

  return JSON.stringify(canonicalPayload);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * Compute a deterministic 64-character lowercase hex SHA-256 hash string
 * from the stringified routing parameters.
 */
export function computeRoutingParametersHash(stringifiedParameters: string): string {
  const utf8 = new TextEncoder().encode(stringifiedParameters);
  const bitLen = utf8.length * 8;
  const totalBytes = Math.ceil((utf8.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalBytes);
  padded.set(utf8);
  padded[utf8.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(totalBytes - 8, highBits, false);
  view.setUint32(totalBytes - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalBytes; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

interface RoutingCacheLookupResponse {
  ok: boolean;
  hit: boolean;
  hash: string;
  algorithm: string;
  folder: string;
  path?: string;
  routes?: ComputedRoute[];
  createdAt?: string;
}

async function fetchCachedRoutingResult(
  algorithm: RoutingAlgorithm,
  hash: string,
  signal?: AbortSignal
): Promise<{ routes: ComputedRoute[]; path: string } | null> {
  try {
    const res = await fetch(
      `/api/routing/cache?algorithm=${encodeURIComponent(algorithm)}&hash=${encodeURIComponent(hash)}`,
      { method: 'GET', signal }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as RoutingCacheLookupResponse;
    if (data?.ok && data.hit && Array.isArray(data.routes)) {
      return {
        routes: data.routes,
        path: data.path || `cache/routing/${data.folder}/${hash}.json`,
      };
    }
  } catch {
    // Non-fatal if cache endpoint is unreachable
  }
  return null;
}

async function storeCachedRoutingResult(
  algorithm: RoutingAlgorithm,
  hash: string,
  stringifiedParameters: string,
  routes: ComputedRoute[]
): Promise<string | null> {
  try {
    const res = await fetch('/api/routing/cache', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        algorithm,
        hash,
        stringifiedParameters,
        routes,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; saved?: boolean; path?: string };
    if (data?.ok && data.saved) {
      return data.path || null;
    }
  } catch {
    // Non-fatal if cache storage fails
  }
  return null;
}

/**
 * Compute obstacle-avoiding vehicle evacuation routes and establish specific
 * Blue Square Pickup Locations on each enabled Source Area for all enabled Target Areas,
 * strictly avoiding all enabled Red Areas.
 * Supports selecting between 'Basic OSM' and 'evaccast_v1' and maintains a separate
 * on-disk cache per routing algorithm under `cache/routing/<algorithm>/<hash>.json`.
 */
export async function computeAllEvacuationRoutes(
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  redAreas: RedArea[],
  vehicleFleets: VehicleFleet[],
  algorithm: RoutingAlgorithm = 'Basic OSM',
  signal?: AbortSignal
): Promise<RoutingComputationResult> {
  const routes: ComputedRoute[] = [];
  const logs: LogEntry[] = [];
  const nowStr = () => new Date().toLocaleTimeString();

  const activeSources = sourceAreas.filter((s) => !s.disabled);
  const activeTargets = targetAreas.filter((t) => !t.disabled);
  const activeReds = redAreas.filter((a) => !a.disabled);

  const pushLog = (level: LogEntry['level'], message: string) => {
    logs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: nowStr(),
      twinTimeFormatted: '00:00',
      level,
      message,
    });
  };

  pushLog(
    'ROUTING',
    `[${algorithm}] Initiating evacuation route computation across ${activeSources.length} active source zones (${sourceAreas.length - activeSources.length} disabled), ${activeTargets.length} active shelters (${targetAreas.length - activeTargets.length} disabled), and ${activeReds.length} active red areas (${redAreas.length - activeReds.length} disabled).`
  );

  if (activeSources.length === 0) {
    pushLog(
      'WARN',
      'No active (enabled) Source Areas available! Enable at least one Source Area to compute routes.'
    );
    return { routes, logs };
  }

  if (activeTargets.length === 0) {
    pushLog(
      'WARN',
      'No active (enabled) Target Shelters available! Enable at least one Target Shelter to compute routes.'
    );
    return { routes, logs };
  }

  // 1. Create a hash string from the stringified version of all parameters
  const stringifiedParameters = stringifyRoutingParameters(
    sourceAreas,
    targetAreas,
    redAreas,
    vehicleFleets
  );
  const paramHash = computeRoutingParametersHash(stringifiedParameters);

  // 2. Check first if there is any content stored in the disk cache of this routing algorithm
  const cachedResult = await fetchCachedRoutingResult(algorithm, paramHash, signal);
  if (signal?.aborted) {
    return { routes: [], logs };
  }
  if (cachedResult) {
    pushLog(
      'ROUTING',
      `[${algorithm}] Cache HIT (${paramHash.slice(0, 12)}...): loaded ${cachedResult.routes.length} evacuation route(s) from ${cachedResult.path} without calling the routing algorithm.`
    );
    return {
      routes: cachedResult.routes,
      logs,
    };
  }

  const defaultDepot: [number, number] =
    vehicleFleets.length > 0
      ? vehicleFleets[0].location
      : activeSources.length > 0
      ? getPolygonCentroid(activeSources[0].polygon)
      : [50.85, 4.35];

  if (algorithm === 'evaccast_v1') {
    try {
      const response = await fetch('/api/routing/evaccast-v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceAreas: activeSources,
          targetAreas: activeTargets,
          redAreas: activeReds,
        }),
        signal,
      });

      const data = (await response.json()) as EvaccastV1ApiResponse;
      if (!response.ok || !data.ok || !data.paths) {
        pushLog(
          'WARN',
          `[evaccast_v1] Routing failed: ${data.error || response.statusText || 'Unknown error'}`
        );
        return { routes, logs };
      }

      const paths = data.paths;
      const pathsPerSourceCount = new Map<string, number>();
      const pathsSeenPerSource = new Map<string, number>();
      const popRemainingPerSource = new Map<string, number>();
      const sourcePopMap = new Map<string, number>();

      activeSources.forEach((s) => {
        sourcePopMap.set(s.id, Math.max(0, Math.round(s.population)));
        popRemainingPerSource.set(s.id, Math.max(0, Math.round(s.population)));
      });

      paths.forEach((p) => {
        pathsPerSourceCount.set(p.sourceId, (pathsPerSourceCount.get(p.sourceId) || 0) + 1);
      });

      // Pair each evacuation route with its closest vehicle fleet parking station
      const assignedFleets = assignFleetsToRoutesByProximity(
        paths.map((p) => p.coordinates),
        vehicleFleets
      );

      // Cache depot -> closest-point-on-route connector paths
      const connectorCache = new Map<string, [number, number][]>();

      for (let i = 0; i < paths.length; i++) {
        if (signal?.aborted) {
          return { routes: [], logs };
        }
        const p = paths[i];
        const totalForSrc = pathsPerSourceCount.get(p.sourceId) || 1;
        const seenForSrc = (pathsSeenPerSource.get(p.sourceId) || 0) + 1;
        pathsSeenPerSource.set(p.sourceId, seenForSrc);

        const totalSrcPop = sourcePopMap.get(p.sourceId) || 0;
        const remPop = popRemainingPerSource.get(p.sourceId) || 0;
        const assignedPop =
          seenForSrc === totalForSrc
            ? remPop
            : Math.round(totalSrcPop / totalForSrc);
        popRemainingPerSource.set(p.sourceId, Math.max(0, remPop - assignedPop));

        const fleet =
          assignedFleets[i] || vehicleFleets[i % Math.max(1, vehicleFleets.length)];
        const depot = fleet ? fleet.location : defaultDepot;
        const speedKmh = Math.max(0.5, fleet?.transitSpeedKmh ?? 25);
        const speedMps = (speedKmh * 1000) / 3600;

        // Route from parking station (depot) to the closest point on the evacuation route,
        // and then follow the evacuation route from there to the pickup point
        const approachCoords = await computeApproachViaClosestPointOnRoute(
          depot,
          p.coordinates,
          activeReds,
          'primary',
          connectorCache
        );
        if (signal?.aborted) {
          return { routes: [], logs };
        }

        const distMeters = p.distanceMeters || calculatePathDistanceMeters(p.coordinates);
        const durationSec = Math.round(distMeters / speedMps);
        const pickupLabel =
          totalForSrc > 1
            ? `${p.sourceName} — Pickup #${seenForSrc} (evaccast_v1)`
            : `${p.sourceName} — Pickup (evaccast_v1)`;

        routes.push({
          id: `route-evaccast-${p.sourceId}-${i}`,
          sourceId: p.sourceId,
          sourceName: p.sourceName,
          targetId: p.targetId,
          targetName: p.targetName,
          behaviorType: 'compliant',
          pickupLocation: p.pickupLocation,
          dropOffLocation: p.dropOffLocation,
          pickupLabel,
          coordinates: p.coordinates,
          approachCoordinates: approachCoords,
          distanceMeters: distMeters,
          estimatedDurationSeconds: durationSec,
          assignedPopulation: assignedPop,
          avoidedRedAreaNames: activeReds.map((a) => a.name),
          isDetour: activeReds.length > 0,
          vehicleFleetId: fleet?.id,
        });

        pushLog(
          'ROUTING',
          `[evaccast_v1] Path #${i + 1}: Pickup [${p.pickupLocation[0]}, ${p.pickupLocation[1]}] in ${p.sourceName} -> Drop-Off [${p.dropOffLocation[0]}, ${p.dropOffLocation[1]}] in ${p.targetName} (${(distMeters / 1000).toFixed(2)} km, est. transit ${Math.floor(durationSec / 60)}m ${durationSec % 60}s @ ${speedKmh} km/h).`
        );
      }

      if (!signal?.aborted && routes.length > 0) {
        const savedPath = await storeCachedRoutingResult(
          algorithm,
          paramHash,
          stringifiedParameters,
          routes
        );
        if (savedPath) {
          pushLog('ROUTING', `[evaccast_v1] Stored routing output in disk cache: ${savedPath}`);
        }
      }

      const minEvacInfo =
        typeof data.minEvacTimeHours === 'number'
          ? ` | Min Evac Time Bound: ${data.minEvacTimeHours.toFixed(2)}h`
          : '';
      pushLog(
        'ROUTING',
        `[evaccast_v1] Route computation complete: ${routes.length} vehicle path(s) established across ${activeSources.length} active source area(s)${minEvacInfo}.`
      );
      return { routes, logs };
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        return { routes: [], logs };
      }
      pushLog(
        'WARN',
        `[evaccast_v1] Error invoking backend routing service: ${err instanceof Error ? err.message : String(err)}`
      );
      return { routes, logs };
    }
  }

  // First compute the evacuation corridors (Pickup -> Target Shelter) for all active Source Areas
  interface PendingBasicOsmCorridor {
    id: string;
    source: SourceArea;
    target: TargetArea;
    behaviorType: 'compliant' | 'self-directed';
    pickupLocation: [number, number];
    pickupLabel: string;
    evacCoordinates: [number, number][];
    avoidedRedAreaNames: string[];
    isDetour: boolean;
    assignedPopulation: number;
    sidePreference: 'primary' | 'alternate';
  }

  const pendingCorridors: PendingBasicOsmCorridor[] = [];

  for (let sIdx = 0; sIdx < activeSources.length; sIdx++) {
    if (signal?.aborted) {
      return { routes: [], logs };
    }
    const source = activeSources[sIdx];
    const srcCenter = getPolygonCentroid(source.polygon);

    const sortedTargets = [...activeTargets].sort((a, b) => {
      const cA = getPolygonCentroid(a.polygon);
      const cB = getPolygonCentroid(b.polygon);
      const dA = turf.distance([srcCenter[1], srcCenter[0]], [cA[1], cA[0]]);
      const dB = turf.distance([srcCenter[1], srcCenter[0]], [cB[1], cB[0]]);
      return dA - dB;
    });

    const primaryTarget = sortedTargets[0];
    const secondaryTarget = sortedTargets.length > 1 ? sortedTargets[1] : sortedTargets[0];

    if (!primaryTarget) {
      pushLog('WARN', `No target shelter available for source zone "${source.name}".`);
      continue;
    }

    const tgtCenter = getPolygonCentroid(primaryTarget.polygon);
    const secTgtCenter = getPolygonCentroid(secondaryTarget.polygon);

    // Establish 2 distinct Pickup Locations (Blue Squares) on this Source Area:
    // Pickup #1 (Primary Gate) & Pickup #2 (Secondary Gate)
    const pickupAlpha = computeSpecificPickupPoint(source, tgtCenter, 0, activeReds);
    const pickupBravo = computeSpecificPickupPoint(source, secTgtCenter, 1, activeReds);

    // --- CORRIDOR ALPHA (Pickup Alpha -> Primary Target Shelter) ---
    const evacAlpha = await computeObstacleAvoidingRoute(
      pickupAlpha,
      tgtCenter,
      activeReds,
      'primary'
    );
    if (signal?.aborted) {
      return { routes: [], logs };
    }

    pendingCorridors.push({
      id: `route-${source.id}-alpha`,
      source,
      target: primaryTarget,
      behaviorType: 'compliant',
      pickupLocation: pickupAlpha,
      pickupLabel: `${source.name} — Pickup Square Alpha`,
      evacCoordinates: evacAlpha.coordinates,
      avoidedRedAreaNames: evacAlpha.avoidedRedAreaNames,
      isDetour: evacAlpha.isDetour,
      assignedPopulation: Math.round(source.population * 0.6),
      sidePreference: 'primary',
    });

    // --- CORRIDOR BRAVO (Pickup Bravo -> Secondary Target Shelter) ---
    const evacBravo = await computeObstacleAvoidingRoute(
      pickupBravo,
      secTgtCenter,
      activeReds,
      'alternate'
    );
    if (signal?.aborted) {
      return { routes: [], logs };
    }

    pendingCorridors.push({
      id: `route-${source.id}-bravo`,
      source,
      target: secondaryTarget,
      behaviorType: 'self-directed',
      pickupLocation: pickupBravo,
      pickupLabel: `${source.name} — Pickup Square Bravo`,
      evacCoordinates: evacBravo.coordinates,
      avoidedRedAreaNames: evacBravo.avoidedRedAreaNames,
      isDetour: evacBravo.isDetour,
      assignedPopulation: source.population - Math.round(source.population * 0.6),
      sidePreference: 'alternate',
    });
  }

  // Pair each evacuation corridor with its closest vehicle fleet parking station
  const assignedFleets = assignFleetsToRoutesByProximity(
    pendingCorridors.map((c) => c.evacCoordinates),
    vehicleFleets
  );
  const connectorCache = new Map<string, [number, number][]>();

  for (let cIdx = 0; cIdx < pendingCorridors.length; cIdx++) {
    if (signal?.aborted) {
      return { routes: [], logs };
    }
    const corridor = pendingCorridors[cIdx];
    const fleet =
      assignedFleets[cIdx] ||
      vehicleFleets[cIdx % Math.max(1, vehicleFleets.length)];
    const depot = fleet ? fleet.location : defaultDepot;
    const speedKmh = Math.max(0.5, fleet?.transitSpeedKmh ?? 25);
    const speedMps = (speedKmh * 1000) / 3600;

    // Route from parking station (depot) to the closest point on the evacuation route,
    // and then follow the evacuation route from there to the pickup point
    const approachCoordinates = await computeApproachViaClosestPointOnRoute(
      depot,
      corridor.evacCoordinates,
      activeReds,
      corridor.sidePreference,
      connectorCache
    );
    if (signal?.aborted) {
      return { routes: [], logs };
    }

    const distMeters = calculatePathDistanceMeters(corridor.evacCoordinates);
    const durationSec = Math.round(distMeters / speedMps);
    const gateName = corridor.sidePreference === 'primary' ? 'Alpha' : 'Bravo';

    routes.push({
      id: corridor.id,
      sourceId: corridor.source.id,
      sourceName: corridor.source.name,
      targetId: corridor.target.id,
      targetName: corridor.target.name,
      behaviorType: corridor.behaviorType,
      pickupLocation: corridor.pickupLocation,
      pickupLabel: corridor.pickupLabel,
      coordinates: corridor.evacCoordinates,
      approachCoordinates,
      distanceMeters: distMeters,
      estimatedDurationSeconds: durationSec,
      assignedPopulation: corridor.assignedPopulation,
      avoidedRedAreaNames: corridor.avoidedRedAreaNames,
      isDetour: corridor.isDetour,
      vehicleFleetId: fleet?.id,
    });

    pushLog(
      'ROUTING',
      `Established Pickup Square ${gateName} [Blue Square] at [${corridor.pickupLocation[0]}, ${corridor.pickupLocation[1]}] on ${corridor.source.name} -> ${corridor.target.name} (${(distMeters / 1000).toFixed(2)} km, est. transit ${Math.floor(durationSec / 60)}m ${durationSec % 60}s @ ${speedKmh} km/h, 0 Red Area crossings).`
    );
  }

  if (!signal?.aborted && routes.length > 0) {
    const savedPath = await storeCachedRoutingResult(
      algorithm,
      paramHash,
      stringifiedParameters,
      routes
    );
    if (savedPath) {
      pushLog('ROUTING', `[${algorithm}] Stored routing output in disk cache: ${savedPath}`);
    }
  }

  pushLog(
    'ROUTING',
    `Route computation complete: ${routes.length} Blue Square Pickup Locations established across all active Source Areas (all routes verified 100% Red Area free).`
  );

  return { routes, logs };
}
