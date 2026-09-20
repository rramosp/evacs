import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  LogEntry,
} from '../types/evacuation';

/**
 * Compute polygon centroid as [lat, lng]
 */
export function getPolygonCentroid(polygonCoords: [number, number][]): [number, number] {
  if (!polygonCoords || polygonCoords.length === 0) return [0, 0];
  const latSum = polygonCoords.reduce((acc, c) => acc + c[0], 0);
  const lngSum = polygonCoords.reduce((acc, c) => acc + c[1], 0);
  return [latSum / polygonCoords.length, lngSum / polygonCoords.length];
}

/**
 * Compute a specific, distinct Pickup Location ([lat, lng]) on/near the perimeter boundary
 * of the Source Area polygon so each route has its own dedicated assembly square.
 */
export function computeSpecificPickupPoint(
  source: SourceArea,
  targetCenter: [number, number],
  slotIndex: number
): [number, number] {
  const poly = source.polygon;
  const centroid = getPolygonCentroid(poly);
  if (!poly || poly.length < 3) return centroid;

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

  // Spread across perimeter anchors based on slotIndex
  const chosenAnchor = sortedByTarget[(slotIndex * 2) % sortedByTarget.length] || centroid;

  // Place pickup point 82% toward the perimeter boundary so both interior walkers and perimeter autonomous walkers reach it naturally
  const t = 0.82;
  const lat = Number((centroid[0] + (chosenAnchor[0] - centroid[0]) * t).toFixed(5));
  const lng = Number((centroid[1] + (chosenAnchor[1] - centroid[1]) * t).toFixed(5));

  return [lat, lng];
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
 * Check if a polyline ([lat, lng][]) intersects a No-Go polygon
 */
export function doesRouteIntersectNoGo(
  routeCoords: [number, number][],
  noGo: NoGoArea
): boolean {
  if (routeCoords.length < 2 || noGo.polygon.length < 3) return false;
  try {
    const line = turf.lineString(routeCoords.map((c) => [c[1], c[0]]));
    const poly = toTurfPolygon(noGo.polygon);
    return turf.booleanIntersects(line, poly);
  } catch {
    return false;
  }
}

/**
 * Compute detour waypoints around a No-Go polygon
 */
function computeDetourWaypoints(
  start: [number, number],
  end: [number, number],
  noGo: NoGoArea,
  sidePreference: 'primary' | 'alternate' = 'primary'
): [number, number][] {
  const poly = toTurfPolygon(noGo.polygon);
  const bbox = turf.bbox(poly); // [minLng, minLat, maxLng, maxLat]
  const minLng = bbox[0];
  const minLat = bbox[1];
  const maxLng = bbox[2];
  const maxLat = bbox[3];

  const latPad = (maxLat - minLat) * 0.45 + 0.0035;
  const lngPad = (maxLng - minLng) * 0.45 + 0.0045;

  const candidates: [number, number][] = [
    [maxLat + latPad, (minLng + maxLng) / 2],
    [minLat - latPad, (minLng + maxLng) / 2],
    [(minLat + maxLat) / 2, minLng - lngPad],
    [(minLat + maxLat) / 2, maxLng + lngPad],
    [maxLat + latPad, minLng - lngPad * 0.6],
    [minLat - latPad, maxLng + lngPad * 0.6],
  ];

  const scored = candidates
    .map((pt) => {
      const d1 = turf.distance([start[1], start[0]], [pt[1], pt[0]]);
      const d2 = turf.distance([pt[1], pt[0]], [end[1], end[0]]);
      const seg1Intersects = doesRouteIntersectNoGo([start, pt], noGo);
      const seg2Intersects = doesRouteIntersectNoGo([pt, end], noGo);
      const penalty = (seg1Intersects ? 25 : 0) + (seg2Intersects ? 25 : 0);
      return { pt, score: d1 + d2 + penalty };
    })
    .sort((a, b) => a.score - b.score);

  if (sidePreference === 'alternate' && scored.length > 1) {
    return [scored[1].pt];
  }
  return [scored[0].pt];
}

/**
 * Geometrically push any remaining route vertices outside all No-Go polygons
 */
function sanitizePolylineAgainstNoGo(
  coords: [number, number][],
  noGoAreas: NoGoArea[]
): [number, number][] {
  if (noGoAreas.length === 0 || coords.length < 2) return coords;

  const densified: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    densified.push(p1);
    const distKm = turf.distance([p1[1], p1[0]], [p2[1], p2[0]]);
    const steps = Math.min(12, Math.max(1, Math.floor(distKm / 0.15)));
    if (steps > 1) {
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        densified.push([p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t]);
      }
    }
  }
  densified.push(coords[coords.length - 1]);

  return densified.map((pt) => {
    let [lat, lng] = pt;
    for (const nogo of noGoAreas) {
      const poly = toTurfPolygon(nogo.polygon);
      const turfPt = turf.point([lng, lat]);
      if (turf.booleanPointInPolygon(turfPt, poly)) {
        const centroid = getPolygonCentroid(nogo.polygon);
        const bbox = turf.bbox(poly);
        const radiusLat = (bbox[3] - bbox[1]) * 0.65 + 0.0022;
        const radiusLng = (bbox[2] - bbox[0]) * 0.65 + 0.0028;
        const dLat = lat - centroid[0];
        const dLng = lng - centroid[1];
        const norm = Math.hypot(dLat, dLng) || 0.0001;
        lat = centroid[0] + (dLat / norm) * radiusLat;
        lng = centroid[1] + (dLng / norm) * radiusLng;
      }
    }
    return [lat, lng];
  });
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
          durationSeconds: route.duration || Math.round(calculatePathDistanceMeters(coordinates) / 8.5),
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
      const curveOffset = Math.sin(t * Math.PI * 2) * 0.0008;
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

/**
 * Compute an immediate obstacle-avoiding route from a running vehicle's current position
 * to the closest active (non-disabled) Target Area.
 */
export async function computeDirectRouteToClosestTarget(
  currentPos: [number, number],
  targetAreas: TargetArea[],
  noGoAreas: NoGoArea[]
): Promise<{ target: TargetArea; coordinates: [number, number][] }> {
  const activeTargets = targetAreas.filter((t) => !t.disabled);
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

  const waypoints: [number, number][] = [currentPos];
  for (const nogo of noGoAreas) {
    if (doesRouteIntersectNoGo([currentPos, tgtCenter], nogo)) {
      waypoints.push(...computeDetourWaypoints(currentPos, tgtCenter, nogo, 'primary'));
    }
  }
  waypoints.push(tgtCenter);

  const raw = await fetchOSRMRoute(waypoints);
  const sanitized = sanitizePolylineAgainstNoGo(raw.coordinates, noGoAreas);
  if (sanitized.length > 0) {
    sanitized[0] = currentPos;
    sanitized[sanitized.length - 1] = tgtCenter;
  }

  return { target: closestTarget, coordinates: sanitized };
}

export interface RoutingComputationResult {
  routes: ComputedRoute[];
  logs: LogEntry[];
}

/**
 * Compute obstacle-avoiding vehicle evacuation routes and establish specific
 * Blue Square Pickup Locations on each Source Area for all enabled Target Areas.
 */
export async function computeAllEvacuationRoutes(
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  noGoAreas: NoGoArea[],
  vehicleFleets: VehicleFleet[]
): Promise<RoutingComputationResult> {
  const routes: ComputedRoute[] = [];
  const logs: LogEntry[] = [];
  const nowStr = () => new Date().toLocaleTimeString();

  const activeTargets = targetAreas.filter((t) => !t.disabled);

  const pushLog = (level: LogEntry['level'], message: string) => {
    logs.push({
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: nowStr(),
      simTimeFormatted: '00:00',
      level,
      message,
    });
  };

  pushLog(
    'ROUTING',
    `Initiating OSRM routing & pickup location establishment across ${sourceAreas.length} source zones, ${activeTargets.length} active shelters (${targetAreas.length - activeTargets.length} disabled), and ${noGoAreas.length} no-go areas.`
  );

  if (activeTargets.length === 0) {
    pushLog('WARN', 'No active (enabled) Target Shelters available! Enable at least one Target Shelter to compute routes.');
    return { routes, logs };
  }

  const defaultDepot: [number, number] =
    vehicleFleets.length > 0
      ? vehicleFleets[0].location
      : sourceAreas.length > 0
      ? getPolygonCentroid(sourceAreas[0].polygon)
      : [50.85, 4.35];

  for (let sIdx = 0; sIdx < sourceAreas.length; sIdx++) {
    const source = sourceAreas[sIdx];
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
    const pickupAlpha = computeSpecificPickupPoint(source, tgtCenter, 0);
    const pickupBravo = computeSpecificPickupPoint(source, secTgtCenter, 1);

    const fleetForAlpha = vehicleFleets[sIdx % Math.max(1, vehicleFleets.length)];
    const fleetForBravo = vehicleFleets[(sIdx + 1) % Math.max(1, vehicleFleets.length)];

    const depotAlpha = fleetForAlpha ? fleetForAlpha.location : defaultDepot;
    const depotBravo = fleetForBravo ? fleetForBravo.location : defaultDepot;

    // --- CORRIDOR ALPHA (Pickup Alpha -> Primary Target Shelter) ---
    const approachAlphaRaw = await fetchOSRMRoute([depotAlpha, pickupAlpha]);
    const approachAlphaCoords = sanitizePolylineAgainstNoGo(approachAlphaRaw.coordinates, noGoAreas);

    let evacAlphaWaypoints: [number, number][] = [pickupAlpha];
    const intersectedNoGosAlpha: NoGoArea[] = [];
    for (const nogo of noGoAreas) {
      if (doesRouteIntersectNoGo([pickupAlpha, tgtCenter], nogo)) {
        intersectedNoGosAlpha.push(nogo);
        evacAlphaWaypoints.push(...computeDetourWaypoints(pickupAlpha, tgtCenter, nogo, 'primary'));
      }
    }
    evacAlphaWaypoints.push(tgtCenter);

    const evacAlphaRaw = await fetchOSRMRoute(evacAlphaWaypoints);
    const evacAlphaCoords = sanitizePolylineAgainstNoGo(evacAlphaRaw.coordinates, noGoAreas);
    evacAlphaCoords[0] = pickupAlpha;
    const alphaDist = calculatePathDistanceMeters(evacAlphaCoords);

    routes.push({
      id: `route-${source.id}-alpha`,
      sourceId: source.id,
      sourceName: source.name,
      targetId: primaryTarget.id,
      targetName: primaryTarget.name,
      behaviorType: 'obedient',
      pickupLocation: pickupAlpha,
      pickupLabel: `${source.name} — Pickup Square Alpha`,
      coordinates: evacAlphaCoords,
      approachCoordinates: approachAlphaCoords,
      distanceMeters: alphaDist,
      estimatedDurationSeconds: Math.round(alphaDist / 8.5),
      assignedPopulation: Math.round(source.population * 0.6),
      avoidedNoGoNames: intersectedNoGosAlpha.map((n) => n.name),
      isDetour: intersectedNoGosAlpha.length > 0,
      vehicleFleetId: fleetForAlpha?.id,
    });

    pushLog(
      'ROUTING',
      `Established Pickup Square Alpha [Blue Square] at [${pickupAlpha[0]}, ${pickupAlpha[1]}] on ${source.name} -> ${primaryTarget.name} (${(alphaDist / 1000).toFixed(2)} km).`
    );

    // --- CORRIDOR BRAVO (Pickup Bravo -> Secondary Target Shelter) ---
    const approachBravoRaw = await fetchOSRMRoute([depotBravo, pickupBravo]);
    const approachBravoCoords = sanitizePolylineAgainstNoGo(approachBravoRaw.coordinates, noGoAreas);

    let evacBravoWaypoints: [number, number][] = [pickupBravo];
    const intersectedNoGosBravo: NoGoArea[] = [];
    for (const nogo of noGoAreas) {
      if (doesRouteIntersectNoGo([pickupBravo, secTgtCenter], nogo)) {
        intersectedNoGosBravo.push(nogo);
        evacBravoWaypoints.push(...computeDetourWaypoints(pickupBravo, secTgtCenter, nogo, 'alternate'));
      }
    }
    evacBravoWaypoints.push(secTgtCenter);

    const evacBravoRaw = await fetchOSRMRoute(evacBravoWaypoints);
    const evacBravoCoords = sanitizePolylineAgainstNoGo(evacBravoRaw.coordinates, noGoAreas);
    evacBravoCoords[0] = pickupBravo;
    const bravoDist = calculatePathDistanceMeters(evacBravoCoords);

    routes.push({
      id: `route-${source.id}-bravo`,
      sourceId: source.id,
      sourceName: source.name,
      targetId: secondaryTarget.id,
      targetName: secondaryTarget.name,
      behaviorType: 'autonomous',
      pickupLocation: pickupBravo,
      pickupLabel: `${source.name} — Pickup Square Bravo`,
      coordinates: evacBravoCoords,
      approachCoordinates: approachBravoCoords,
      distanceMeters: bravoDist,
      estimatedDurationSeconds: Math.round(bravoDist / 8.5),
      assignedPopulation: source.population - Math.round(source.population * 0.6),
      avoidedNoGoNames: intersectedNoGosBravo.map((n) => n.name),
      isDetour: true,
      vehicleFleetId: fleetForBravo?.id,
    });

    pushLog(
      'ROUTING',
      `Established Pickup Square Bravo [Blue Square] at [${pickupBravo[0]}, ${pickupBravo[1]}] on ${source.name} -> ${secondaryTarget.name} (${(bravoDist / 1000).toFixed(2)} km).`
    );
  }

  pushLog(
    'ROUTING',
    `Route computation complete: ${routes.length} Blue Square Pickup Locations established across all Source Areas.`
  );

  return { routes, logs };
}
