import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  SimulationStateSnapshot,
  HeatmapPoint,
  PopulationBehaviorType,
  BehaviorCounts,
  SimulationTelemetryStats,
} from '../types/evacuation';
import { getPolygonCentroid, toTurfPolygon } from './routingEngine';

/**
 * Create a zeroed BehaviorCounts object
 */
export function createZeroBehaviorCounts(): BehaviorCounts {
  return { obedient: 0, autonomous: 0, random: 0 };
}

/**
 * Compute exact initial behavior headcounts for a list of Source Areas (matching buildClustersForSources)
 */
export function computeBehaviorCountsFromSources(sourceAreas: SourceArea[]): BehaviorCounts {
  const counts = createZeroBehaviorCounts();
  sourceAreas.forEach((src) => {
    const totalPop = Math.max(0, src.population);
    if (totalPop === 0) return;

    const numClusters = Math.min(75, Math.max(1, totalPop));
    const obCount = Math.round((numClusters * src.behavior.obedient) / 100);
    const auCount = Math.round((numClusters * src.behavior.autonomous) / 100);

    const baseHeadcount = Math.floor(totalPop / numClusters);
    const remainder = totalPop % numClusters;

    for (let i = 0; i < numClusters; i++) {
      const headcount = baseHeadcount + (i < remainder ? 1 : 0);
      if (headcount <= 0) continue;

      if (i < obCount) {
        counts.obedient += headcount;
      } else if (i < obCount + auCount) {
        counts.autonomous += headcount;
      } else {
        counts.random += headcount;
      }
    }
  });
  return counts;
}

/**
 * Allocate `boardedNow` passengers proportionally from `waiting` BehaviorCounts
 * while guaranteeing exact integer sum (`taken.obedient + taken.autonomous + taken.random === boardedNow`)
 * and `0 <= taken[b] <= waiting[b]`.
 */
function allocateBoardedByBehavior(waiting: BehaviorCounts, boardedNow: number): BehaviorCounts {
  const totalAvail = waiting.obedient + waiting.autonomous + waiting.random;
  if (boardedNow <= 0 || totalAvail <= 0) {
    return createZeroBehaviorCounts();
  }
  if (boardedNow >= totalAvail) {
    return {
      obedient: waiting.obedient,
      autonomous: waiting.autonomous,
      random: waiting.random,
    };
  }

  const keys: PopulationBehaviorType[] = ['obedient', 'autonomous', 'random'];
  const exactShares = keys.map((k) => ({
    key: k,
    avail: waiting[k],
    exact: (waiting[k] / totalAvail) * boardedNow,
  }));

  const taken: BehaviorCounts = createZeroBehaviorCounts();
  let assigned = 0;
  for (const item of exactShares) {
    const fl = Math.min(item.avail, Math.floor(item.exact));
    taken[item.key] = fl;
    assigned += fl;
  }

  let remainder = boardedNow - assigned;
  const byFraction = [...exactShares].sort(
    (a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact))
  );

  for (const item of byFraction) {
    if (remainder <= 0) break;
    if (taken[item.key] < item.avail) {
      taken[item.key] += 1;
      remainder -= 1;
    }
  }

  // Fallback in case any rounding gap remains
  for (const k of keys) {
    while (remainder > 0 && taken[k] < waiting[k]) {
      taken[k] += 1;
      remainder -= 1;
    }
  }

  return taken;
}

/**
 * Create initial SimulationTelemetryStats
 */
export function createInitialTelemetryStats(
  sourceAreas: SourceArea[],
  clusters?: SourceInternalCluster[]
): SimulationTelemetryStats {
  const initialByBehavior = createZeroBehaviorCounts();
  if (clusters && clusters.length > 0) {
    clusters.forEach((c) => {
      initialByBehavior[c.behavior] += c.headcount;
    });
  } else {
    const computed = computeBehaviorCountsFromSources(sourceAreas);
    initialByBehavior.obedient = computed.obedient;
    initialByBehavior.autonomous = computed.autonomous;
    initialByBehavior.random = computed.random;
  }

  return {
    initialByBehavior,
    evacuatedByBehavior: createZeroBehaviorCounts(),
    evacuatedPersonSecondsByBehavior: createZeroBehaviorCounts(),
    pickupArrivedByBehavior: createZeroBehaviorCounts(),
    pickupArrivalPersonSecondsByBehavior: createZeroBehaviorCounts(),
    totalCompletedVehicleTrips: 0,
  };
}

/**
 * Format seconds as MM:SS
 */
export function formatMMSS(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Precompute cumulative distance array (in meters) along a polyline
 */
export function buildCumulativeDistances(coords: [number, number][]): {
  cumulative: number[];
  total: number;
} {
  const cumulative: number[] = [0];
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const segDist =
      turf.distance(
        [coords[i][1], coords[i][0]],
        [coords[i + 1][1], coords[i + 1][0]],
        { units: 'kilometers' }
      ) * 1000;
    total += segDist;
    cumulative.push(total);
  }
  return { cumulative, total };
}

/**
 * Interpolate exact [lat, lng] at `distMeters` along a polyline
 */
export function interpolateAlongPolyline(
  coords: [number, number][],
  cumulative: number[],
  distMeters: number
): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (distMeters <= 0) return coords[0];
  const total = cumulative[cumulative.length - 1];
  if (distMeters >= total) return coords[coords.length - 1];

  let low = 0;
  let high = cumulative.length - 1;
  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2);
    if (cumulative[mid] <= distMeters) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const segStart = cumulative[low];
  const segEnd = cumulative[high];
  const segLen = segEnd - segStart;
  const t = segLen > 0 ? (distMeters - segStart) / segLen : 0;

  const p1 = coords[low];
  const p2 = coords[high];
  return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t];
}

/**
 * Build the initial approach path from a Vehicle Fleet's designated staging depot (`fleet.location`)
 * to the Pickup Location (`route.pickupLocation`) using the precomputed obstacle-avoiding `route.approachCoordinates`.
 */
function getDepotToPickupApproachCoords(
  route: ComputedRoute,
  fleet?: VehicleFleet
): [number, number][] {
  const startDepot =
    fleet?.location ||
    (route.approachCoordinates && route.approachCoordinates.length > 0
      ? route.approachCoordinates[0]
      : route.pickupLocation);

  if (route.approachCoordinates && route.approachCoordinates.length >= 2) {
    const coords = [...route.approachCoordinates];
    coords[0] = startDepot;
    coords[coords.length - 1] = route.pickupLocation;
    return coords;
  }

  return [startDepot, route.pickupLocation];
}

/**
 * Build an empty return path along an existing route polyline
 * from the vehicle's current position along the route to the Pickup Location.
 */
function getEmptyApproachAlongExistingRoute(
  route: ComputedRoute,
  currentPos?: [number, number]
): [number, number][] {
  // Reversing route.coordinates goes from Target Area -> ... -> Pickup Location along the exact existing route
  const reversedRoute = [...route.coordinates].reverse();
  if (reversedRoute.length < 2) {
    return [route.pickupLocation, route.pickupLocation];
  }

  if (!currentPos) {
    return reversedRoute;
  }

  // Find the vertex on reversedRoute closest to currentPos so the vehicle stays strictly on the existing route
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < reversedRoute.length; i++) {
    const d = turf.distance(
      [currentPos[1], currentPos[0]],
      [reversedRoute[i][1], reversedRoute[i][0]]
    );
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  const sliced = reversedRoute.slice(bestIdx);
  return sliced.length >= 2 ? sliced : reversedRoute;
}

/**
 * Sample a point inside a polygon deterministically using Halton-like sequence
 */
function samplePointInsidePolygon(
  polygonCoords: [number, number][],
  index: number
): [number, number] {
  const centroid = getPolygonCentroid(polygonCoords);
  if (polygonCoords.length < 3) return centroid;

  try {
    const poly = toTurfPolygon(polygonCoords);
    const bbox = turf.bbox(poly); // [minLng, minLat, maxLng, maxLat]

    for (let attempt = 0; attempt < 25; attempt++) {
      const seed = index * 17 + attempt * 31 + 1;
      const u = ((seed * 16807) % 2147483647) / 2147483647;
      const v = (((seed + 7) * 48271) % 2147483647) / 2147483647;

      const lat = bbox[1] + u * (bbox[3] - bbox[1]);
      const lng = bbox[0] + v * (bbox[2] - bbox[0]);

      if (turf.booleanPointInPolygon(turf.point([lng, lat]), poly)) {
        return [lat, lng];
      }
    }
  } catch {
    // Fallback to centroid interpolation
  }

  const corner = polygonCoords[index % polygonCoords.length];
  const t = 0.25 + ((index * 13) % 55) / 100;
  return [
    centroid[0] + (corner[0] - centroid[0]) * t,
    centroid[1] + (corner[1] - centroid[1]) * t,
  ];
}

/**
 * Compute remaining unboarded population per Source Area ID
 */
export function getRemainingPopulationBySource(
  sourceAreas: SourceArea[],
  clusters: SourceInternalCluster[],
  pickupStates: PickupLocationState[],
  hasSimulationStarted: boolean
): Record<string, number> {
  const result: Record<string, number> = {};
  sourceAreas.forEach((src) => {
    if (!hasSimulationStarted) {
      result[src.id] = src.population;
      return;
    }

    const hasClustersOrPickups =
      clusters.some((c) => c.sourceId === src.id) ||
      pickupStates.some((p) => p.sourceId === src.id);

    if (!hasClustersOrPickups) {
      // Newly added Source Area while paused
      result[src.id] = src.population;
      return;
    }

    const moving = clusters
      .filter((c) => c.sourceId === src.id && c.status === 'moving_in_zone')
      .reduce((acc, c) => acc + c.headcount, 0);
    const waiting = pickupStates
      .filter((p) => p.sourceId === src.id)
      .reduce((acc, p) => acc + p.waitingPopulation, 0);

    result[src.id] = moving + waiting;
  });
  return result;
}

/**
 * Generate dynamic heatmap points from clusters and pickup states
 */
export function generateHeatmapFromState(
  clusters: SourceInternalCluster[],
  pickupStates: PickupLocationState[],
  vehicles: ActiveVehicleUnit[],
  targetAreas: TargetArea[],
  targetOccupancies: Record<string, number>
): HeatmapPoint[] {
  const pts: HeatmapPoint[] = [];

  // 1. Clusters still moving inside Source Area polygons
  clusters
    .filter((c) => c.status === 'moving_in_zone' && c.headcount > 0)
    .forEach((c) => {
      const weight = Math.min(0.85, Math.max(0.18, c.headcount / 45));
      pts.push({
        lat: c.position[0],
        lng: c.position[1],
        intensity: weight,
        behavior: c.behavior,
      });
    });

  // 2. Waiting queues at Blue Square Pickup Locations (HOTTEST SPOTS!)
  pickupStates.forEach((p) => {
    const boardingHere = vehicles
      .filter((v) => v.assignedPickupId === p.id && v.status === 'waiting_for_80_pct')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);

    const totalAtPickup = p.waitingPopulation + boardingHere;

    if (totalAtPickup > 0) {
      const coreIntensity = Math.min(1.0, 0.35 + totalAtPickup / 180);

      pts.push({
        lat: p.location[0],
        lng: p.location[1],
        intensity: coreIntensity,
        behavior: 'pickup_hotspot',
      });

      const numAura = Math.min(10, Math.max(3, Math.ceil(totalAtPickup / 40)));
      const radius = 0.00045;
      for (let i = 0; i < numAura; i++) {
        const angle = (i / numAura) * Math.PI * 2;
        pts.push({
          lat: p.location[0] + Math.sin(angle) * radius,
          lng: p.location[1] + Math.cos(angle) * radius,
          intensity: coreIntensity * 0.85,
          behavior: 'pickup_hotspot',
        });
      }
    }
  });

  // 3. Vehicles en route to Target Shelters carrying evacuees
  vehicles
    .filter((v) => v.status === 'to_target' && v.currentOccupancy > 0)
    .forEach((v) => {
      const intensity = Math.min(0.9, Math.max(0.3, v.currentOccupancy / 120));
      pts.push({
        lat: v.currentPosition[0],
        lng: v.currentPosition[1],
        intensity,
        behavior: 'obedient',
      });
    });

  // 4. Target Area Shelters arrived population
  targetAreas.forEach((tgt) => {
    const arrived = targetOccupancies[tgt.id] || 0;
    if (arrived > 0) {
      const centroid = getPolygonCentroid(tgt.polygon);
      const intensity = Math.min(1.0, arrived / 1500);
      pts.push({
        lat: centroid[0],
        lng: centroid[1],
        intensity,
        behavior: 'obedient',
      });
    }
  });

  return pts;
}

/**
 * Helper to generate internal clusters for a list of Source Areas
 */
function buildClustersForSources(sourceAreas: SourceArea[]): SourceInternalCluster[] {
  const clusters: SourceInternalCluster[] = [];

  sourceAreas.forEach((src) => {
    const totalPop = Math.max(0, src.population);
    if (totalPop === 0) return;

    const numClusters = Math.min(75, Math.max(1, totalPop));
    const obCount = Math.round((numClusters * src.behavior.obedient) / 100);
    const auCount = Math.round((numClusters * src.behavior.autonomous) / 100);

    const baseHeadcount = Math.floor(totalPop / numClusters);
    const remainder = totalPop % numClusters;

    for (let i = 0; i < numClusters; i++) {
      const headcount = baseHeadcount + (i < remainder ? 1 : 0);

      if (headcount <= 0) continue;

      let behavior: PopulationBehaviorType = 'random';
      if (i < obCount) {
        behavior = 'obedient';
      } else if (i < obCount + auCount) {
        behavior = 'autonomous';
      }

      const startPos = samplePointInsidePolygon(src.polygon, i);
      const nearestEdgeIdx = i % Math.max(1, src.polygon.length);

      clusters.push({
        id: `cluster-${src.id}-${i}-${Date.now()}`,
        sourceId: src.id,
        behavior,
        headcount,
        position: startPos,
        targetPickupId: null,
        perimeterEdgeIndex: nearestEdgeIdx,
        perimeterProgress: 0,
        randomHeadingRad: ((i * 73) % 360) * (Math.PI / 180),
        status: 'moving_in_zone',
      });
    }
  });

  return clusters;
}

/**
 * Initialize full simulation state from scratch.
 * Every empty vehicle departing to pick up population strictly follows the existing route polyline!
 */
export function initializeSimulationState(
  routes: ComputedRoute[],
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  vehicleFleets: VehicleFleet[]
): SimulationStateSnapshot {
  const pickupStates: PickupLocationState[] = routes.map((r, idx) => ({
    id: `pickup-${r.id}`,
    routeId: r.id,
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    targetId: r.targetId,
    targetName: r.targetName,
    label: r.pickupLabel || `Pickup Point #${idx + 1}`,
    location: r.pickupLocation,
    waitingPopulation: 0,
    waitingByBehavior: createZeroBehaviorCounts(),
    totalBoardedCount: 0,
    boardedByBehavior: createZeroBehaviorCounts(),
    evacuatedCount: 0,
    evacuatedByBehavior: createZeroBehaviorCounts(),
    completedDeparturesCount: 0,
    totalCompletedVehicleWaitSeconds: 0,
    maxVehicleWaitSeconds: 0,
    totalDepartureOccupancyRatioSum: 0,
  }));

  const clusters = buildClustersForSources(sourceAreas);
  const telemetryStats = createInitialTelemetryStats(sourceAreas, clusters);

  // Initialize Vehicle Units cycling along the existing computed routes to Pickups and Targets
  const vehicles: ActiveVehicleUnit[] = [];

  routes.forEach((route, rIdx) => {
    const pickup = pickupStates.find((p) => p.routeId === route.id);
    if (!pickup) return;

    const fleet =
      vehicleFleets.find((f) => f.id === route.vehicleFleetId) ||
      vehicleFleets[rIdx % Math.max(1, vehicleFleets.length)];

    // Initial dispatch at t = 0 starts from the designated Vehicle Fleet staging depot location
    const approachCoords = getDepotToPickupApproachCoords(route, fleet);
    const evacCoords =
      route.coordinates && route.coordinates.length >= 2
        ? route.coordinates
        : [route.pickupLocation, route.pickupLocation];

    const approachDist = buildCumulativeDistances(approachCoords);
    const evacDist = buildCumulativeDistances(evacCoords);

    const numWaves = 4;
    const totalFleetUnits = fleet ? Math.max(4, Math.ceil(fleet.count / 2)) : 12;
    const unitsPerWave = Math.max(2, Math.round(totalFleetUnits / numWaves));
    const capPerUnit = fleet ? fleet.capacityPerUnit : 50;
    const maxCapPerWave = unitsPerWave * capPerUnit;

    for (let w = 0; w < numWaves; w++) {
      vehicles.push({
        id: `veh-${route.id}-wave-${w}`,
        fleetId: fleet?.id || 'default-fleet',
        fleetName: `${fleet?.name || 'Evac Transit'} Convoy #${w + 1}`,
        vehicleType: fleet?.type || 'Bus',
        unitCount: unitsPerWave,
        capacityPerUnit: capPerUnit,
        maxCapacity: maxCapPerWave,
        currentOccupancy: 0,
        occupancyByBehavior: createZeroBehaviorCounts(),
        assignedRouteId: route.id,
        assignedPickupId: pickup.id,
        sourceId: route.sourceId,
        targetId: route.targetId,
        targetName: route.targetName,
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        currentPosition: approachCoords[0],
        progressMeters: 0,
        speedMps: 18.0,
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords,
        evacCumulative: evacDist.cumulative,
        departureDelaySeconds: w * 22,
      });
    }
  });

  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = 0;
  });

  const totalRemainingAtSource = sourceAreas.reduce((acc, s) => acc + s.population, 0);

  const heatmapPoints = generateHeatmapFromState(
    clusters,
    pickupStates,
    vehicles,
    targetAreas,
    targetOccupancies
  );

  return {
    clusters,
    pickupStates,
    vehicles,
    heatmapPoints,
    targetOccupancies,
    telemetryStats,
    newLogs: [],
    totalEvacuated: 0,
    totalInTransit: 0,
    totalRemainingAtSource,
    totalWaitingAtPickups: 0,
  };
}

/**
 * Reconcile simulation state upon restarting after mid-simulation pause & topology/fleet edits:
 * - Rebuilds pickup states & internal clusters for remaining/modified/new Source Area populations
 * - Routes running vehicles with passengers (`currentOccupancy > 0`) immediately to the CLOSEST active Target Area,
 *   and configures them to follow an existing route connected to that Target Area right after offloading
 * - Ensures all empty vehicles (`currentOccupancy === 0`) & newly added fleets strictly follow existing routes to pick up population
 */
export function reconcileSimulationOnRestart(
  newRoutes: ComputedRoute[],
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  vehicleFleets: VehicleFleet[],
  existingVehicles: ActiveVehicleUnit[],
  existingTargetOccupancies: Record<string, number>,
  directRoutesToClosestTarget: Record<
    string,
    { target: TargetArea; coordinates: [number, number][] }
  >,
  existingTelemetryStats?: SimulationTelemetryStats,
  existingPickupStates?: PickupLocationState[]
): SimulationStateSnapshot {
  const newLogs: string[] = [];

  // 1. Establish new Pickup Location states from recomputed routes, preserving cumulative history if matched
  const pickupStates: PickupLocationState[] = newRoutes.map((r, idx) => {
    const label = r.pickupLabel || `Pickup Point #${idx + 1}`;
    const prevPickup = existingPickupStates?.find(
      (p) => p.routeId === r.id || (p.sourceId === r.sourceId && p.label === label)
    );
    return {
      id: `pickup-${r.id}`,
      routeId: r.id,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      targetId: r.targetId,
      targetName: r.targetName,
      label,
      location: r.pickupLocation,
      waitingPopulation: 0,
      waitingByBehavior: createZeroBehaviorCounts(),
      totalBoardedCount: prevPickup?.totalBoardedCount || 0,
      boardedByBehavior: prevPickup?.boardedByBehavior
        ? { ...prevPickup.boardedByBehavior }
        : createZeroBehaviorCounts(),
      evacuatedCount: prevPickup?.evacuatedCount || 0,
      evacuatedByBehavior: prevPickup?.evacuatedByBehavior
        ? { ...prevPickup.evacuatedByBehavior }
        : createZeroBehaviorCounts(),
      completedDeparturesCount: prevPickup?.completedDeparturesCount || 0,
      totalCompletedVehicleWaitSeconds: prevPickup?.totalCompletedVehicleWaitSeconds || 0,
      maxVehicleWaitSeconds: prevPickup?.maxVehicleWaitSeconds || 0,
      totalDepartureOccupancyRatioSum: prevPickup?.totalDepartureOccupancyRatioSum || 0,
    };
  });

  // 2. Build clusters for each Source Area using its current (remaining/edited/new) population
  const clusters = buildClustersForSources(sourceAreas);

  // 3. Reconcile vehicles:
  const activeFleetIds = new Set(vehicleFleets.map((f) => f.id));
  const survivingVehicles = existingVehicles.filter((v) => activeFleetIds.has(v.fleetId));

  const updatedVehicles: ActiveVehicleUnit[] = [];

  survivingVehicles.forEach((veh, idx) => {
    const defaultNextRoute = newRoutes[idx % Math.max(1, newRoutes.length)];
    if (!defaultNextRoute) return;

    // CASE A: Running or waiting vehicle carrying passengers (`currentOccupancy > 0`)
    // -> Immediately route from its current position to the CLOSEST active Target Area,
    //    then follow an existing route connected to that Target Area right after offloading!
    if (veh.currentOccupancy > 0) {
      const direct = directRoutesToClosestTarget[veh.id];
      const closestTarget = direct?.target || targetAreas.find((t) => !t.disabled) || targetAreas[0];
      const directCoords =
        direct && direct.coordinates.length >= 2
          ? direct.coordinates
          : [veh.currentPosition, getPolygonCentroid(closestTarget.polygon)];
      const directDist = buildCumulativeDistances(directCoords);

      // Select an existing route connected to `closestTarget` so after offloading at `closestTarget`,
      // the empty vehicle follows that existing route polyline straight back to its Pickup Location!
      const connectedRoute =
        newRoutes.find((r) => r.targetId === closestTarget.id) || defaultNextRoute;
      const connectedPickup =
        pickupStates.find((p) => p.routeId === connectedRoute.id) ||
        pickupStates.find((p) => p.routeId === defaultNextRoute.id);

      if (!connectedPickup) return;

      newLogs.push(
        `Mid-sim reroute: ${veh.fleetName} (${veh.currentOccupancy} pax onboard) diverted from [${veh.currentPosition[0].toFixed(4)}, ${veh.currentPosition[1].toFixed(4)}] to closest active shelter "${closestTarget.name}", then following existing route ${connectedRoute.pickupLabel}.`
      );

      updatedVehicles.push({
        ...veh,
        occupancyByBehavior: veh.occupancyByBehavior
          ? { ...veh.occupancyByBehavior }
          : { obedient: veh.currentOccupancy, autonomous: 0, random: 0 },
        status: 'to_target',
        waitingAtPickupSeconds: 0,
        progressMeters: 0,
        targetId: closestTarget.id,
        targetName: closestTarget.name,
        evacCoords: directCoords,
        evacCumulative: directDist.cumulative,
        assignedRouteId: connectedRoute.id,
        assignedPickupId: connectedPickup.id,
        sourceId: connectedRoute.sourceId,
        postOffloadEvacCoords: connectedRoute.coordinates,
        postOffloadTargetId: connectedRoute.targetId,
        postOffloadTargetName: connectedRoute.targetName,
        departureDelaySeconds: 0,
      });
    } else {
      // CASE B: Empty vehicle (`currentOccupancy === 0`)
      const nextPickup = pickupStates.find((p) => p.routeId === defaultNextRoute.id);
      if (!nextPickup) return;

      const fleet = vehicleFleets.find((f) => f.id === veh.fleetId);
      const isStillAtDepot =
        veh.progressMeters === 0 &&
        fleet &&
        turf.distance(
          [veh.currentPosition[1], veh.currentPosition[0]],
          [fleet.location[1], fleet.location[0]]
        ) < 0.15;

      const approachCoords = isStillAtDepot
        ? getDepotToPickupApproachCoords(defaultNextRoute, fleet)
        : getEmptyApproachAlongExistingRoute(defaultNextRoute, veh.currentPosition);
      const approachDist = buildCumulativeDistances(approachCoords);
      const evacDist = buildCumulativeDistances(defaultNextRoute.coordinates);

      updatedVehicles.push({
        ...veh,
        occupancyByBehavior: createZeroBehaviorCounts(),
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        progressMeters: 0,
        currentPosition: approachCoords[0],
        assignedRouteId: defaultNextRoute.id,
        assignedPickupId: nextPickup.id,
        sourceId: defaultNextRoute.sourceId,
        targetId: defaultNextRoute.targetId,
        targetName: defaultNextRoute.targetName,
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords: defaultNextRoute.coordinates,
        evacCumulative: evacDist.cumulative,
        postOffloadEvacCoords: undefined,
        postOffloadTargetId: undefined,
        postOffloadTargetName: undefined,
        departureDelaySeconds: 0,
      });
    }
  });

  // 4. Spawn vehicles for any NEWLY ADDED fleets — departing from their designated fleet staging location
  const representedFleetIds = new Set(survivingVehicles.map((v) => v.fleetId));
  const newFleets = vehicleFleets.filter((f) => !representedFleetIds.has(f.id));

  newFleets.forEach((fleet, fIdx) => {
    const route = newRoutes[fIdx % Math.max(1, newRoutes.length)];
    const pickup = route ? pickupStates.find((p) => p.routeId === route.id) : undefined;
    if (!route || !pickup) return;

    const approachCoords = getDepotToPickupApproachCoords(route, fleet);
    const approachDist = buildCumulativeDistances(approachCoords);
    const evacDist = buildCumulativeDistances(route.coordinates);

    const numWaves = 3;
    const unitsPerWave = Math.max(2, Math.round(fleet.count / numWaves));
    const maxCapPerWave = unitsPerWave * fleet.capacityPerUnit;

    for (let w = 0; w < numWaves; w++) {
      updatedVehicles.push({
        id: `veh-new-${fleet.id}-wave-${w}-${Date.now()}`,
        fleetId: fleet.id,
        fleetName: `${fleet.name} Convoy #${w + 1}`,
        vehicleType: fleet.type,
        unitCount: unitsPerWave,
        capacityPerUnit: fleet.capacityPerUnit,
        maxCapacity: maxCapPerWave,
        currentOccupancy: 0,
        occupancyByBehavior: createZeroBehaviorCounts(),
        assignedRouteId: route.id,
        assignedPickupId: pickup.id,
        sourceId: route.sourceId,
        targetId: route.targetId,
        targetName: route.targetName,
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        currentPosition: approachCoords[0],
        progressMeters: 0,
        speedMps: 18.0,
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords: route.coordinates,
        evacCumulative: evacDist.cumulative,
        departureDelaySeconds: w * 15,
      });
    }

    newLogs.push(
      `Deployed new fleet "${fleet.name}" (${fleet.count} × ${fleet.type}) along existing corridor ${route.pickupLabel} -> ${route.targetName}.`
    );
  });

  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = existingTargetOccupancies[t.id] || 0;
  });

  const totalEvacuated = Object.values(targetOccupancies).reduce((acc, v) => acc + v, 0);
  const totalInTransit = updatedVehicles
    .filter((v) => v.status === 'to_target')
    .reduce((acc, v) => acc + v.currentOccupancy, 0);
  const totalRemainingAtSource = clusters.reduce((acc, c) => acc + c.headcount, 0);

  // Recompute telemetryStats preserving already evacuated + in-transit + new remaining clusters
  const newClustersByBehavior = createZeroBehaviorCounts();
  clusters.forEach((c) => {
    newClustersByBehavior[c.behavior] += c.headcount;
  });

  const inTransitByBehavior = createZeroBehaviorCounts();
  updatedVehicles.forEach((v) => {
    if (v.currentOccupancy > 0 && v.occupancyByBehavior) {
      inTransitByBehavior.obedient += v.occupancyByBehavior.obedient;
      inTransitByBehavior.autonomous += v.occupancyByBehavior.autonomous;
      inTransitByBehavior.random += v.occupancyByBehavior.random;
    }
  });

  const baseTelemetry = existingTelemetryStats || createInitialTelemetryStats(sourceAreas, clusters);
  const reconciledTelemetry: SimulationTelemetryStats = {
    initialByBehavior: {
      obedient:
        baseTelemetry.evacuatedByBehavior.obedient +
        inTransitByBehavior.obedient +
        newClustersByBehavior.obedient,
      autonomous:
        baseTelemetry.evacuatedByBehavior.autonomous +
        inTransitByBehavior.autonomous +
        newClustersByBehavior.autonomous,
      random:
        baseTelemetry.evacuatedByBehavior.random +
        inTransitByBehavior.random +
        newClustersByBehavior.random,
    },
    evacuatedByBehavior: { ...baseTelemetry.evacuatedByBehavior },
    evacuatedPersonSecondsByBehavior: { ...baseTelemetry.evacuatedPersonSecondsByBehavior },
    pickupArrivedByBehavior: { ...baseTelemetry.pickupArrivedByBehavior },
    pickupArrivalPersonSecondsByBehavior: { ...baseTelemetry.pickupArrivalPersonSecondsByBehavior },
    totalCompletedVehicleTrips: baseTelemetry.totalCompletedVehicleTrips,
  };

  const heatmapPoints = generateHeatmapFromState(
    clusters,
    pickupStates,
    updatedVehicles,
    targetAreas,
    targetOccupancies
  );

  return {
    clusters,
    pickupStates,
    vehicles: updatedVehicles,
    heatmapPoints,
    targetOccupancies,
    telemetryStats: reconciledTelemetry,
    newLogs,
    totalEvacuated,
    totalInTransit,
    totalRemainingAtSource,
    totalWaitingAtPickups: 0,
  };
}

/**
 * Step simulation forward by `deltaSimSeconds` implementing:
 * 1. Obedient population moving immediately to closest pickup location
 * 2. Random population diffusing inside Source Area via true 2D Brownian motion (independent Gaussian random walk)
 *    until within 50m of a pickup location, at which point they direct themselves straight to it
 * 3. Autonomous population wandering along Source Area perimeter limits until stumbling on a pickup location
 * 4. Vehicles waiting at pickup locations until EITHER:
 *    - Occupancy reaches >= 80%, OR
 *    - Waiting time reaches 10 minutes (600s)
 *    Whichever happens first, departing to Target Area provided there is at least 1 passenger onboard!
 * 5. When vehicles depart empty to pick up population, they ALWAYS follow the existing computed route polyline!
 * 6. Dynamic heatmap updating (hotter around pickup locations as queues build, cooler over time as source empties)
 */
export function stepSimulationState(
  prevState: SimulationStateSnapshot,
  elapsedSimSeconds: number,
  deltaSimSeconds: number,
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[]
): SimulationStateSnapshot {
  const newLogs: string[] = [];

  const prevTelemetry =
    prevState.telemetryStats || createInitialTelemetryStats(sourceAreas, prevState.clusters);
  const updatedTelemetry: SimulationTelemetryStats = {
    initialByBehavior: { ...prevTelemetry.initialByBehavior },
    evacuatedByBehavior: { ...prevTelemetry.evacuatedByBehavior },
    evacuatedPersonSecondsByBehavior: { ...prevTelemetry.evacuatedPersonSecondsByBehavior },
    pickupArrivedByBehavior: { ...prevTelemetry.pickupArrivedByBehavior },
    pickupArrivalPersonSecondsByBehavior: { ...prevTelemetry.pickupArrivalPersonSecondsByBehavior },
    totalCompletedVehicleTrips: prevTelemetry.totalCompletedVehicleTrips,
  };

  const pickupMap = new Map<string, PickupLocationState>();
  prevState.pickupStates.forEach((p) => {
    pickupMap.set(p.id, {
      ...p,
      waitingByBehavior: p.waitingByBehavior
        ? { ...p.waitingByBehavior }
        : createZeroBehaviorCounts(),
      boardedByBehavior: p.boardedByBehavior
        ? { ...p.boardedByBehavior }
        : createZeroBehaviorCounts(),
      evacuatedByBehavior: p.evacuatedByBehavior
        ? { ...p.evacuatedByBehavior }
        : createZeroBehaviorCounts(),
      boardingVehicleInfo: undefined,
    });
  });

  const sourceMap = new Map<string, SourceArea>();
  sourceAreas.forEach((s) => sourceMap.set(s.id, s));

  // Speed of pedestrians moving inside Source Area (scaled so Obedient arrive quickly and Random/Autonomous trickle in over minutes)
  const walkSpeedMetersPerSec = 3.2;

  // --- STEP 1: Move internal Source Area crowd clusters ---
  const updatedClusters = prevState.clusters.map((cluster) => {
    if (cluster.status !== 'moving_in_zone' || cluster.headcount <= 0) {
      return cluster;
    }

    const src = sourceMap.get(cluster.sourceId);
    const pickupsInZone = Array.from(pickupMap.values()).filter(
      (p) => p.sourceId === cluster.sourceId
    );

    if (pickupsInZone.length === 0) return cluster;

    const pickupsWithDist = pickupsInZone
      .map((p) => {
        const distMeters =
          turf.distance(
            [cluster.position[1], cluster.position[0]],
            [p.location[1], p.location[0]],
            { units: 'kilometers' }
          ) * 1000;
        return { pickup: p, distMeters };
      })
      .sort((a, b) => a.distMeters - b.distMeters);

    const closest = pickupsWithDist[0];

    // Check arrival threshold (within 14 meters of a pickup point)
    if (closest.distMeters <= 14) {
      closest.pickup.waitingPopulation += cluster.headcount;
      closest.pickup.waitingByBehavior[cluster.behavior] += cluster.headcount;
      updatedTelemetry.pickupArrivedByBehavior[cluster.behavior] += cluster.headcount;
      updatedTelemetry.pickupArrivalPersonSecondsByBehavior[cluster.behavior] +=
        cluster.headcount * elapsedSimSeconds;

      return {
        ...cluster,
        position: [...closest.pickup.location] as [number, number],
        status: 'waiting_at_pickup' as const,
        targetPickupId: closest.pickup.id,
      };
    }

    // --- BEHAVIOR 1: OBEDIENT ---
    // Immediately go straight to the closest pickup location
    if (cluster.behavior === 'obedient') {
      const stepDist = walkSpeedMetersPerSec * deltaSimSeconds;
      const ratio = Math.min(1.0, stepDist / Math.max(1, closest.distMeters));
      const nextLat =
        cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * ratio;
      const nextLng =
        cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * ratio;

      return {
        ...cluster,
        position: [nextLat, nextLng] as [number, number],
        targetPickupId: closest.pickup.id,
      };
    }

    // --- BEHAVIOR 2: RANDOM (2D BROWNIAN MOTION) ---
    // Diffuse via true stochastic 2D Brownian motion (independent zero-mean Gaussian displacements at every tick)
    // until within 50m of ANY pickup point, then direct straight to it!
    if (cluster.behavior === 'random') {
      if (closest.distMeters <= 50.0) {
        const stepDist = walkSpeedMetersPerSec * 1.15 * deltaSimSeconds;
        const ratio = Math.min(1.0, stepDist / Math.max(1, closest.distMeters));
        const nextLat =
          cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * ratio;
        const nextLng =
          cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * ratio;

        return {
          ...cluster,
          position: [nextLat, nextLng] as [number, number],
          targetPickupId: closest.pickup.id,
        };
      } else {
        // Box-Muller transform for independent standard normal N(0, 1) Gaussian variates
        const u1 = Math.max(1e-7, Math.random());
        const u2 = Math.random();
        const mag = Math.sqrt(-2.0 * Math.log(u1));
        const zNorth = mag * Math.cos(2.0 * Math.PI * u2);
        const zEast = mag * Math.sin(2.0 * Math.PI * u2);

        // Wiener process scaling: dX = sigma * sqrt(dt) * Z
        const sigmaMeters = 10.5;
        const stepScaleMeters = sigmaMeters * Math.sqrt(Math.max(0.1, deltaSimSeconds));
        const dNorthMeters = zNorth * stepScaleMeters;
        const dEastMeters = zEast * stepScaleMeters;

        const metersPerDegLat = 111320;
        const metersPerDegLng =
          111320 * Math.cos((cluster.position[0] * Math.PI) / 180);

        const dLat = dNorthMeters / metersPerDegLat;
        const dLng = dEastMeters / Math.max(1000, metersPerDegLng);

        let candidateLat = cluster.position[0] + dLat;
        let candidateLng = cluster.position[1] + dLng;

        // Reflect Brownian step back inside polygon if it crosses the boundary (without persistent straight-line drift)
        if (src && src.polygon.length >= 3) {
          try {
            const poly = toTurfPolygon(src.polygon);
            if (!turf.booleanPointInPolygon(turf.point([candidateLng, candidateLat]), poly)) {
              const centroid = getPolygonCentroid(src.polygon);
              candidateLat =
                cluster.position[0] - dLat * 0.65 + (centroid[0] - cluster.position[0]) * 0.08;
              candidateLng =
                cluster.position[1] - dLng * 0.65 + (centroid[1] - cluster.position[1]) * 0.08;
            }
          } catch {
            // Ignore turf error
          }
        }

        return {
          ...cluster,
          position: [candidateLat, candidateLng] as [number, number],
        };
      }
    }

    // --- BEHAVIOR 3: AUTONOMOUS ---
    // Wander around the LIMITS (perimeter boundary) of the source area until stumbling upon a pickup location
    if (cluster.behavior === 'autonomous') {
      if (closest.distMeters <= 55.0) {
        const stepDist = walkSpeedMetersPerSec * 1.1 * deltaSimSeconds;
        const ratio = Math.min(1.0, stepDist / Math.max(1, closest.distMeters));
        const nextLat =
          cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * ratio;
        const nextLng =
          cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * ratio;

        return {
          ...cluster,
          position: [nextLat, nextLng] as [number, number],
          targetPickupId: closest.pickup.id,
        };
      }

      if (src && src.polygon.length >= 3) {
        const poly = src.polygon;
        const pStart = poly[cluster.perimeterEdgeIndex % poly.length];
        const pEnd = poly[(cluster.perimeterEdgeIndex + 1) % poly.length];

        const edgeDistMeters =
          turf.distance([pStart[1], pStart[0]], [pEnd[1], pEnd[0]], { units: 'kilometers' }) *
          1000;
        const stepMeters = walkSpeedMetersPerSec * 0.85 * deltaSimSeconds;
        const progressDelta = edgeDistMeters > 0 ? stepMeters / edgeDistMeters : 0.15;

        let nextProgress = cluster.perimeterProgress + progressDelta;
        let nextEdgeIdx = cluster.perimeterEdgeIndex;

        if (nextProgress >= 1.0) {
          nextProgress = nextProgress - 1.0;
          nextEdgeIdx = (cluster.perimeterEdgeIndex + 1) % poly.length;
        }

        const edgeA = poly[nextEdgeIdx];
        const edgeB = poly[(nextEdgeIdx + 1) % poly.length];
        const perimLat = edgeA[0] + (edgeB[0] - edgeA[0]) * nextProgress;
        const perimLng = edgeA[1] + (edgeB[1] - edgeA[1]) * nextProgress;

        const nextLat = cluster.position[0] * 0.35 + perimLat * 0.65;
        const nextLng = cluster.position[1] * 0.35 + perimLng * 0.65;

        return {
          ...cluster,
          position: [nextLat, nextLng] as [number, number],
          perimeterEdgeIndex: nextEdgeIdx,
          perimeterProgress: nextProgress,
        };
      }
    }

    return cluster;
  });

  // Calculate remaining unboarded evacuees per Source Area
  const getUnboardedInSource = (sourceId: string): number => {
    const movingCount = updatedClusters
      .filter((c) => c.sourceId === sourceId && c.status === 'moving_in_zone')
      .reduce((acc, c) => acc + c.headcount, 0);
    const waitingCount = Array.from(pickupMap.values())
      .filter((p) => p.sourceId === sourceId)
      .reduce((acc, p) => acc + p.waitingPopulation, 0);
    return movingCount + waitingCount;
  };

  const updatedTargetOccupancies = { ...prevState.targetOccupancies };

  // --- STEP 2: Process Vehicle Dispatches, Dual Departure Condition (80% Occupancy OR 10 Minutes Wait), and Shelter Offloads ---
  const updatedVehicles = prevState.vehicles.map((rawVeh) => {
    const veh: ActiveVehicleUnit = {
      ...rawVeh,
      occupancyByBehavior: rawVeh.occupancyByBehavior
        ? { ...rawVeh.occupancyByBehavior }
        : createZeroBehaviorCounts(),
    };

    if (veh.status === 'completed') return veh;
    if (elapsedSimSeconds < veh.departureDelaySeconds) return veh;

    const pickup = pickupMap.get(veh.assignedPickupId);
    if (!pickup) return veh;

    // STATE A: Driving empty along existing route TO Pickup Location (Blue Square)
    if (veh.status === 'to_pickup') {
      const totalApproachDist =
        veh.approachCumulative[veh.approachCumulative.length - 1] || 1;
      const nextProgress = veh.progressMeters + veh.speedMps * deltaSimSeconds;

      if (nextProgress >= totalApproachDist) {
        return {
          ...veh,
          status: 'waiting_for_80_pct' as const,
          waitingAtPickupSeconds: 0,
          progressMeters: 0,
          currentPosition: pickup.location,
        };
      }

      const pos = interpolateAlongPolyline(
        veh.approachCoords,
        veh.approachCumulative,
        nextProgress
      );
      return {
        ...veh,
        progressMeters: nextProgress,
        currentPosition: pos,
      };
    }

    // STATE B: At Blue Square Pickup Location — Board waiting evacuees & WAIT UNTIL:
    // (1) Occupancy >= 80%, OR (2) Waiting time >= 10 minutes (600 seconds)
    // Whichever happens first, depart to Target Area IF there is at least 1 passenger!
    if (veh.status === 'waiting_for_80_pct') {
      const nextWaitSeconds = veh.waitingAtPickupSeconds + deltaSimSeconds;

      // Board any waiting evacuees from the pickup queue
      const spaceNeeded = veh.maxCapacity - veh.currentOccupancy;
      if (spaceNeeded > 0 && pickup.waitingPopulation > 0) {
        const boardedNow = Math.min(spaceNeeded, pickup.waitingPopulation);
        const boardedBreakdown = allocateBoardedByBehavior(pickup.waitingByBehavior, boardedNow);

        veh.currentOccupancy += boardedNow;
        veh.occupancyByBehavior.obedient += boardedBreakdown.obedient;
        veh.occupancyByBehavior.autonomous += boardedBreakdown.autonomous;
        veh.occupancyByBehavior.random += boardedBreakdown.random;

        pickup.waitingPopulation -= boardedNow;
        pickup.waitingByBehavior.obedient = Math.max(
          0,
          pickup.waitingByBehavior.obedient - boardedBreakdown.obedient
        );
        pickup.waitingByBehavior.autonomous = Math.max(
          0,
          pickup.waitingByBehavior.autonomous - boardedBreakdown.autonomous
        );
        pickup.waitingByBehavior.random = Math.max(
          0,
          pickup.waitingByBehavior.random - boardedBreakdown.random
        );

        pickup.totalBoardedCount += boardedNow;
        pickup.boardedByBehavior.obedient += boardedBreakdown.obedient;
        pickup.boardedByBehavior.autonomous += boardedBreakdown.autonomous;
        pickup.boardedByBehavior.random += boardedBreakdown.random;
      }

      const hasAtLeastOnePassenger = veh.currentOccupancy >= 1;
      const occupancyRatio = veh.currentOccupancy / Math.max(1, veh.maxCapacity);
      const remainingUnboardedInSource = getUnboardedInSource(veh.sourceId);

      // Dual Departure Conditions:
      const reached80Percent = occupancyRatio >= 0.80;
      const reached10Minutes = nextWaitSeconds >= 600.0; // 10 minutes = 600 simulation seconds
      const isLastCleanupSweep =
        remainingUnboardedInSource === 0 && hasAtLeastOnePassenger;

      // Depart if (80% occupancy OR 10 min wait OR cleanup sweep) AND at least 1 passenger is onboard
      if (hasAtLeastOnePassenger && (reached80Percent || reached10Minutes || isLastCleanupSweep)) {
        const pctStr = Math.round(occupancyRatio * 100);
        const waitFormatted = formatMMSS(nextWaitSeconds);

        pickup.completedDeparturesCount += 1;
        pickup.totalCompletedVehicleWaitSeconds += nextWaitSeconds;
        pickup.maxVehicleWaitSeconds = Math.max(pickup.maxVehicleWaitSeconds, nextWaitSeconds);
        pickup.totalDepartureOccupancyRatioSum += occupancyRatio;

        let triggerReason = '80% Occupancy Reached';
        if (!reached80Percent && reached10Minutes) {
          triggerReason = '10-Minute Wait Timeout Reached';
        } else if (!reached80Percent && !reached10Minutes && isLastCleanupSweep) {
          triggerReason = 'Final Evacuees Boarded';
        }

        newLogs.push(
          `${veh.fleetName} departing ${pickup.label} -> ${veh.targetName} [${triggerReason}: ${veh.currentOccupancy}/${veh.maxCapacity} passengers (${pctStr}%), Wait Time: ${waitFormatted}].`
        );

        return {
          ...veh,
          status: 'to_target' as const,
          waitingAtPickupSeconds: 0,
          progressMeters: 0,
          currentPosition: veh.evacCoords[0] || pickup.location,
        };
      } else {
        // Still waiting at Blue Square
        const pctStr = Math.round(occupancyRatio * 100);
        const waitFormatted = formatMMSS(nextWaitSeconds);
        pickup.maxVehicleWaitSeconds = Math.max(pickup.maxVehicleWaitSeconds, nextWaitSeconds);

        if (nextWaitSeconds >= 600.0 && !hasAtLeastOnePassenger) {
          pickup.boardingVehicleInfo = `${veh.fleetName}: 0/${veh.maxCapacity} (Wait ${waitFormatted}/10:00 — Awaiting >=1 passenger)`;
        } else {
          pickup.boardingVehicleInfo = `${veh.fleetName}: ${veh.currentOccupancy}/${veh.maxCapacity} (${pctStr}% | Wait ${waitFormatted}/10:00)`;
        }

        // If 0 people left anywhere in source area and vehicle is empty, mark completed
        if (remainingUnboardedInSource === 0 && veh.currentOccupancy === 0) {
          return {
            ...veh,
            waitingAtPickupSeconds: nextWaitSeconds,
            status: 'completed' as const,
          };
        }

        return {
          ...veh,
          waitingAtPickupSeconds: nextWaitSeconds,
          currentPosition: pickup.location,
        };
      }
    }

    // STATE C: Driving from Pickup Location (or mid-transit diversion) TO Target Shelter
    if (veh.status === 'to_target') {
      const totalEvacDist = veh.evacCumulative[veh.evacCumulative.length - 1] || 1;
      const nextProgress = veh.progressMeters + veh.speedMps * deltaSimSeconds;

      if (nextProgress >= totalEvacDist) {
        updatedTargetOccupancies[veh.targetId] =
          (updatedTargetOccupancies[veh.targetId] || 0) + veh.currentOccupancy;

        // Credit evacuated counts & cumulative person-seconds by behavior
        updatedTelemetry.totalCompletedVehicleTrips += 1;
        (['obedient', 'autonomous', 'random'] as PopulationBehaviorType[]).forEach((beh) => {
          const countB = veh.occupancyByBehavior[beh] || 0;
          updatedTelemetry.evacuatedByBehavior[beh] += countB;
          updatedTelemetry.evacuatedPersonSecondsByBehavior[beh] += countB * elapsedSimSeconds;
        });

        // Credit pickup location shelter delivery statistics
        pickup.evacuatedCount += veh.currentOccupancy;
        pickup.evacuatedByBehavior.obedient += veh.occupancyByBehavior.obedient;
        pickup.evacuatedByBehavior.autonomous += veh.occupancyByBehavior.autonomous;
        pickup.evacuatedByBehavior.random += veh.occupancyByBehavior.random;

        newLogs.push(
          `${veh.fleetName} arrived at ${veh.targetName}, offloading ${veh.currentOccupancy.toLocaleString()} evacuees safely.`
        );

        // If this vehicle was diverted mid-simulation to the closest Target Area and has a post-offload recomputed route,
        // transition it now to follow that existing route!
        const nextEvacCoords = veh.postOffloadEvacCoords || veh.evacCoords;
        const nextTargetId = veh.postOffloadTargetId || veh.targetId;
        const nextTargetName = veh.postOffloadTargetName || veh.targetName;
        const nextEvacDist = buildCumulativeDistances(nextEvacCoords);

        // Return trip to pick up population ALWAYS follows the existing route polyline in reverse!
        const returnCoords: [number, number][] = [...nextEvacCoords].reverse();
        const returnDist = buildCumulativeDistances(returnCoords);

        const offloadedVeh: ActiveVehicleUnit = {
          ...veh,
          currentOccupancy: 0,
          occupancyByBehavior: createZeroBehaviorCounts(),
          waitingAtPickupSeconds: 0,
          progressMeters: 0,
          currentPosition: returnCoords[0],
          evacCoords: nextEvacCoords,
          evacCumulative: nextEvacDist.cumulative,
          targetId: nextTargetId,
          targetName: nextTargetName,
          postOffloadEvacCoords: undefined,
          postOffloadTargetId: undefined,
          postOffloadTargetName: undefined,
        };

        const remainingInSource = getUnboardedInSource(veh.sourceId);
        if (remainingInSource > 0) {
          return {
            ...offloadedVeh,
            status: 'to_pickup' as const,
            approachCoords: returnCoords,
            approachCumulative: returnDist.cumulative,
          };
        } else {
          return {
            ...offloadedVeh,
            status: 'completed' as const,
          };
        }
      }

      const pos = interpolateAlongPolyline(
        veh.evacCoords,
        veh.evacCumulative,
        nextProgress
      );
      return {
        ...veh,
        progressMeters: nextProgress,
        currentPosition: pos,
      };
    }

    return veh;
  });

  const finalPickupStates = Array.from(pickupMap.values());

  // Compute global KPI totals
  const totalEvacuated = Object.values(updatedTargetOccupancies).reduce(
    (acc, val) => acc + val,
    0
  );

  const totalInTransit = updatedVehicles
    .filter((v) => v.status === 'to_target')
    .reduce((acc, v) => acc + v.currentOccupancy, 0);

  const totalBoardingInVehicles = updatedVehicles
    .filter((v) => v.status === 'waiting_for_80_pct')
    .reduce((acc, v) => acc + v.currentOccupancy, 0);

  const totalWaitingInQueues = finalPickupStates.reduce(
    (acc, p) => acc + p.waitingPopulation,
    0
  );

  const totalMovingInZone = updatedClusters
    .filter((c) => c.status === 'moving_in_zone')
    .reduce((acc, c) => acc + c.headcount, 0);

  const totalWaitingAtPickups = totalWaitingInQueues + totalBoardingInVehicles;
  const totalRemainingAtSource = totalMovingInZone + totalWaitingAtPickups;

  const heatmapPoints = generateHeatmapFromState(
    updatedClusters,
    finalPickupStates,
    updatedVehicles,
    targetAreas,
    updatedTargetOccupancies
  );

  return {
    clusters: updatedClusters,
    pickupStates: finalPickupStates,
    vehicles: updatedVehicles,
    heatmapPoints,
    targetOccupancies: updatedTargetOccupancies,
    telemetryStats: updatedTelemetry,
    newLogs,
    totalEvacuated,
    totalInTransit,
    totalRemainingAtSource,
    totalWaitingAtPickups,
  };
}
