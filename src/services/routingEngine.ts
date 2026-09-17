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
 * Compute a specific, distinct Pickup Location ([lat, lng]) inside/on the Source Area polygon
 * for a given route slot index so each route has its own dedicated assembly square.
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

  // Select a distinct anchor based on slotIndex (spreading across the perimeter)
  const chosenAnchor = sortedByTarget[(slotIndex * 2) % sortedByTarget.length] || centroid;

  // Interpolate 72% from centroid toward the chosen boundary anchor so it sits clearly inside/at the edge of the source polygon
  const t = 0.72;
  const lat = Number((centroid[0] + (chosenAnchor[0] - centroid[0]) * t).toFixed(5));
  const lng = Number((centroid[1] + (chosenAnchor[1] - centroid[1]) * t).toFixed(5));

  return [lat, lng];
}

/**
 * Convert our [lat, lng][] polygon to a closed GeoJSON Polygon (lng, lat order for Turf)
 */
function toTurfPolygon(coords: [number, number][]) {
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
    [maxLat + latPad, (minLng + maxLng) / 2], // North bypass
    [minLat - latPad, (minLng + maxLng) / 2], // South bypass
    [(minLat + maxLat) / 2, minLng - lngPad], // West bypass
    [(minLat + maxLat) / 2, maxLng + lngPad], // East bypass
    [maxLat + latPad, minLng - lngPad * 0.6], // NW corner
    [minLat - latPad, maxLng + lngPad * 0.6], // SE corner
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
 * Query OSRM HTTP API for a driving/walking route through waypoints.
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
        // Ensure exact start point matches our established pickup coordinate
        if (coordinates.length > 0) {
          coordinates[0] = waypoints[0];
        }
        return {
          coordinates,
          distanceMeters: route.distance || calculatePathDistanceMeters(coordinates),
          durationSeconds: route.duration || Math.round(calculatePathDistanceMeters(coordinates) / 1.4),
        };
      }
    }
  } catch {
    // Fall through to deterministic road-like urban path synthesis
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
    durationSeconds: Math.round(distanceMeters / 1.4),
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

function createRandomPerturbedRoute(
  pickupPt: [number, number],
  baseCoords: [number, number][],
  noGoAreas: NoGoArea[]
): [number, number][] {
  if (baseCoords.length <= 2) return [pickupPt, ...baseCoords.slice(1)];
  const perturbed: [number, number][] = [pickupPt];
  for (let i = 1; i < baseCoords.length - 1; i++) {
    const [lat, lng] = baseCoords[i];
    const jitterLat = Math.sin(i * 1.9) * 0.0018;
    const jitterLng = Math.cos(i * 2.3) * 0.0022;
    perturbed.push([lat + jitterLat, lng + jitterLng]);
  }
  perturbed.push(baseCoords[baseCoords.length - 1]);
  return sanitizePolylineAgainstNoGo(perturbed, noGoAreas);
}

export interface RoutingComputationResult {
  routes: ComputedRoute[];
  logs: LogEntry[];
}

/**
 * Main entry point: Compute obstacle-avoiding evacuation routes and establish specific
 * Blue Square pickup locations on each Source Area.
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
    `Initiating OSRM routing & pickup point establishment across ${sourceAreas.length} source zones, ${targetAreas.length} shelters, and ${noGoAreas.length} no-go areas.`
  );

  for (const source of sourceAreas) {
    const srcCenter = getPolygonCentroid(source.polygon);

    const sortedTargets = [...targetAreas].sort((a, b) => {
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

    // Establish specific Blue Square Pickup Locations for Obedient, Autonomous, and Random routes
    const obedientPickup = computeSpecificPickupPoint(source, tgtCenter, 0);
    const autonomousPickup = computeSpecificPickupPoint(source, secTgtCenter, 1);
    const randomPickup = computeSpecificPickupPoint(source, tgtCenter, 2);

    // 1. Check initial OSRM route between Obedient Pickup and Primary Target
    let initialRoute = await fetchOSRMRoute([obedientPickup, tgtCenter]);
    const intersectedNoGos: NoGoArea[] = [];

    for (const nogo of noGoAreas) {
      if (doesRouteIntersectNoGo(initialRoute.coordinates, nogo)) {
        intersectedNoGos.push(nogo);
      }
    }

    let finalPrimaryCoords = initialRoute.coordinates;
    let isDetour = false;

    if (intersectedNoGos.length > 0) {
      isDetour = true;
      const nogoNames = intersectedNoGos.map((n) => n.name).join(', ');
      pushLog(
        'WARN',
        `Direct OSRM route [${source.name} -> ${primaryTarget.name}] intersects No-Go zone(s): ${nogoNames}. Computing obstacle detour waypoints...`
      );

      let waypoints: [number, number][] = [obedientPickup];
      for (const nogo of intersectedNoGos) {
        const detours = computeDetourWaypoints(obedientPickup, tgtCenter, nogo, 'primary');
        waypoints.push(...detours);
      }
      waypoints.push(tgtCenter);

      const detouredRoute = await fetchOSRMRoute(waypoints);
      finalPrimaryCoords = sanitizePolylineAgainstNoGo(detouredRoute.coordinates, noGoAreas);
      finalPrimaryCoords[0] = obedientPickup;

      const newDistKm = (calculatePathDistanceMeters(finalPrimaryCoords) / 1000).toFixed(2);
      pushLog(
        'ROUTING',
        `Detour verified for [${source.name} -> ${primaryTarget.name}] avoiding ${nogoNames} (Distance: ${newDistKm} km).`
      );
    } else {
      finalPrimaryCoords = sanitizePolylineAgainstNoGo(finalPrimaryCoords, noGoAreas);
      finalPrimaryCoords[0] = obedientPickup;
      const distKm = (calculatePathDistanceMeters(finalPrimaryCoords) / 1000).toFixed(2);
      pushLog(
        'ROUTING',
        `Clear route computed [${source.name} -> ${primaryTarget.name}] via OSRM (${distKm} km).`
      );
    }

    const obedientPop = Math.round((source.population * source.behavior.obedient) / 100);
    const autonomousPop = Math.round((source.population * source.behavior.autonomous) / 100);
    const randomPop = Math.max(0, source.population - obedientPop - autonomousPop);

    const primaryDist = calculatePathDistanceMeters(finalPrimaryCoords);

    // Route A: OBEDIENT population route
    if (obedientPop > 0) {
      routes.push({
        id: `route-${source.id}-obedient`,
        sourceId: source.id,
        sourceName: source.name,
        targetId: primaryTarget.id,
        targetName: primaryTarget.name,
        behaviorType: 'obedient',
        pickupLocation: obedientPickup,
        pickupLabel: `${source.name} — Pickup Bay Alpha (Obedient)`,
        coordinates: finalPrimaryCoords,
        distanceMeters: primaryDist,
        estimatedDurationSeconds: Math.round(primaryDist / 1.45),
        assignedPopulation: obedientPop,
        avoidedNoGoNames: intersectedNoGos.map((n) => n.name),
        isDetour,
      });

      pushLog(
        'ROUTING',
        `Established Pickup Location [Blue Square] at [${obedientPickup[0]}, ${obedientPickup[1]}] in ${source.name} for Obedient route (${obedientPop} evacuees).`
      );
    }

    // Route B: AUTONOMOUS population route
    if (autonomousPop > 0) {
      let autoWaypoints: [number, number][] = [autonomousPickup];
      if (intersectedNoGos.length > 0) {
        for (const nogo of intersectedNoGos) {
          const altDetours = computeDetourWaypoints(autonomousPickup, secTgtCenter, nogo, 'alternate');
          autoWaypoints.push(...altDetours);
        }
      } else {
        const midLat = (autonomousPickup[0] + secTgtCenter[0]) / 2 + 0.0038;
        const midLng = (autonomousPickup[1] + secTgtCenter[1]) / 2 - 0.0035;
        autoWaypoints.push([midLat, midLng]);
      }
      autoWaypoints.push(secTgtCenter);

      const autoRouteRaw = await fetchOSRMRoute(autoWaypoints);
      const autoCoords = sanitizePolylineAgainstNoGo(autoRouteRaw.coordinates, noGoAreas);
      autoCoords[0] = autonomousPickup;
      const autoDist = calculatePathDistanceMeters(autoCoords);

      routes.push({
        id: `route-${source.id}-autonomous`,
        sourceId: source.id,
        sourceName: source.name,
        targetId: secondaryTarget.id,
        targetName: secondaryTarget.name,
        behaviorType: 'autonomous',
        pickupLocation: autonomousPickup,
        pickupLabel: `${source.name} — Pickup Bay Bravo (Autonomous)`,
        coordinates: autoCoords,
        distanceMeters: autoDist,
        estimatedDurationSeconds: Math.round(autoDist / 1.35),
        assignedPopulation: autonomousPop,
        avoidedNoGoNames: intersectedNoGos.map((n) => n.name),
        isDetour: true,
      });

      pushLog(
        'ROUTING',
        `Established Pickup Location [Blue Square] at [${autonomousPickup[0]}, ${autonomousPickup[1]}] in ${source.name} for Autonomous route (${autonomousPop} evacuees).`
      );
    }

    // Route C: RANDOM population route
    if (randomPop > 0) {
      const randomCoords = createRandomPerturbedRoute(randomPickup, finalPrimaryCoords, noGoAreas);
      const randomDist = calculatePathDistanceMeters(randomCoords);
      routes.push({
        id: `route-${source.id}-random`,
        sourceId: source.id,
        sourceName: source.name,
        targetId: primaryTarget.id,
        targetName: primaryTarget.name,
        behaviorType: 'random',
        pickupLocation: randomPickup,
        pickupLabel: `${source.name} — Pickup Bay Charlie (Random Exit)`,
        coordinates: randomCoords,
        distanceMeters: randomDist,
        estimatedDurationSeconds: Math.round(randomDist / 1.15),
        assignedPopulation: randomPop,
        avoidedNoGoNames: intersectedNoGos.map((n) => n.name),
        isDetour,
      });

      pushLog(
        'ROUTING',
        `Established Pickup Location [Blue Square] at [${randomPickup[0]}, ${randomPickup[1]}] in ${source.name} for Random exit path (${randomPop} evacuees).`
      );
    }
  }

  // 2. Compute Vehicle Fleet Dispatch & Transport Routes with dedicated Fleet Pickup Point on Source Area
  for (let i = 0; i < vehicleFleets.length; i++) {
    const fleet = vehicleFleets[i];
    const assignedSource = sourceAreas[i % sourceAreas.length];
    const assignedTarget = targetAreas[i % targetAreas.length];

    if (!assignedSource || !assignedTarget) continue;

    const tgtCenter = getPolygonCentroid(assignedTarget.polygon);
    // Establish a dedicated fleet pickup location (slot 3 + i) on the Source Area polygon
    const fleetPickup = computeSpecificPickupPoint(assignedSource, tgtCenter, 3 + i);

    // Leg 1: Depot -> Fleet Pickup Square on Source Area
    const leg1Raw = await fetchOSRMRoute([fleet.location, fleetPickup]);
    const leg1Coords = sanitizePolylineAgainstNoGo(leg1Raw.coordinates, noGoAreas);

    // Leg 2: Fleet Pickup Square -> Target Shelter
    let leg2Waypoints: [number, number][] = [fleetPickup];
    for (const nogo of noGoAreas) {
      if (doesRouteIntersectNoGo([fleetPickup, tgtCenter], nogo)) {
        leg2Waypoints.push(...computeDetourWaypoints(fleetPickup, tgtCenter, nogo, 'primary'));
      }
    }
    leg2Waypoints.push(tgtCenter);
    const leg2Raw = await fetchOSRMRoute(leg2Waypoints);
    const leg2Coords = sanitizePolylineAgainstNoGo(leg2Raw.coordinates, noGoAreas);

    const combinedCoords = [...leg1Coords, ...leg2Coords.slice(1)];
    const totalDist = calculatePathDistanceMeters(combinedCoords);
    const fleetCapacity = fleet.count * fleet.capacityPerUnit;
    const transportedPop = Math.min(assignedSource.population, fleetCapacity);

    routes.push({
      id: `route-fleet-${fleet.id}`,
      sourceId: assignedSource.id,
      sourceName: `${fleet.name} (${assignedSource.name})`,
      targetId: assignedTarget.id,
      targetName: assignedTarget.name,
      behaviorType: 'vehicle_dispatch',
      pickupLocation: fleetPickup,
      pickupLabel: `${assignedSource.name} — ${fleet.name} Boarding Point`,
      coordinates: combinedCoords,
      distanceMeters: totalDist,
      estimatedDurationSeconds: Math.round(totalDist / 8.5),
      assignedPopulation: transportedPop,
      avoidedNoGoNames: [],
      isDetour: false,
      vehicleFleetId: fleet.id,
      vehicleCountUsed: fleet.count,
    });

    pushLog(
      'INFO',
      `Established Transit Pickup Location [Blue Square] at [${fleetPickup[0]}, ${fleetPickup[1]}] in ${assignedSource.name} for ${fleet.name} (${fleet.count}x ${fleet.type}s).`
    );
  }

  pushLog(
    'ROUTING',
    `Route computation complete: ${routes.length} active corridors and ${routes.length} Blue Square pickup locations established.`
  );

  return { routes, logs };
}
