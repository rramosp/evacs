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
  BrusselsMetroCorridor,
} from '../types/evacuation';
import { getPolygonCentroid, toTurfPolygon } from './routingEngine';

export interface MetroEvacuationOptions {
  enabled: boolean;
  corridors: BrusselsMetroCorridor[];
  trainCount: number;
  trainCapacity: number;
}

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
 * Convert vehicle transit speed in km/h to meters per second (m/s)
 */
export function kmhToMps(speedKmh: number): number {
  const safeKmh = Number.isFinite(speedKmh) && speedKmh > 0 ? speedKmh : 25;
  return (safeKmh * 1000) / 3600;
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
      [reversedRoute[i][1], reversedRoute[i][0]],
      { units: 'kilometers' }
    );
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }

  const sliced = reversedRoute.slice(bestIdx);
  if (sliced.length >= 2) {
    return bestDist > 0.003 ? [currentPos, ...sliced] : sliced;
  }
  return bestDist > 0.003 ? [currentPos, ...reversedRoute] : reversedRoute;
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

  // 3. Vehicles en route to Target Shelters or unloading at Target Shelters carrying evacuees
  vehicles
    .filter((v) => (v.status === 'to_target' || v.status === 'unloading') && v.currentOccupancy > 0)
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
 * Helper to append Brussels Metro Station Pickups and Metro Train units
 * along static Metro Line trajectories (unaffected by Avoid Areas).
 */
function appendMetroPickupsAndTrains(
  pickupStates: PickupLocationState[],
  vehicles: ActiveVehicleUnit[],
  metroEvacuation?: MetroEvacuationOptions,
  existingPickupStates?: PickupLocationState[],
  newLogs?: string[]
): void {
  if (
    !metroEvacuation ||
    !metroEvacuation.enabled ||
    metroEvacuation.corridors.length === 0
  ) {
    return;
  }

  const totalTrains = Math.max(1, Math.round(metroEvacuation.trainCount || 1));
  const trainCapacity = Math.max(1, Math.round(metroEvacuation.trainCapacity || 300));
  const numCorridors = metroEvacuation.corridors.length;

  let globalTrainNumber = 1;

  metroEvacuation.corridors.forEach((corridor, cIdx) => {
    const pickupId = `pickup-${corridor.id}`;
    const label = `🚇 Metro Pickup: ${corridor.sourceStation.name_fr} → Drop-Off: ${corridor.targetStation.name_fr} (${corridor.lineLabel})`;
    const prevPickup = existingPickupStates?.find(
      (p) => p.id === pickupId || p.routeId === corridor.id
    );

    pickupStates.push({
      id: pickupId,
      routeId: corridor.id,
      sourceId: corridor.sourceId,
      sourceName: corridor.sourceName,
      targetId: corridor.targetId,
      targetName: corridor.targetName,
      label,
      location: corridor.sourceStation.position,
      dropOffLocation: corridor.targetStation.position,
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
      isMetro: true,
      metroLine: corridor.lineLabel,
      metroColor: corridor.color,
      metroStationName: corridor.sourceStation.name_fr,
      metroTargetStationName: corridor.targetStation.name_fr,
    });

    // Distribute the user-configured trainCount across active corridors, ensuring every active corridor gets at least 1 train
    const trainsForCorridor =
      totalTrains >= numCorridors
        ? Math.floor(totalTrains / numCorridors) +
          (cIdx < totalTrains % numCorridors ? 1 : 0)
        : 1;

    const evacCoords =
      corridor.coordinates.length >= 2
        ? corridor.coordinates
        : [corridor.sourceStation.position, corridor.targetStation.position];
    const evacDist = buildCumulativeDistances(evacCoords);

    // Metro trains travel at 45 km/h on underground grade-separated tracks with fast multi-door boarding (0.2s/person)
    const metroTransitSpeedKmh = 45;
    const metroSpeedMps = kmhToMps(metroTransitSpeedKmh);
    const metroLoadUnloadSec = 0.2;

    for (let tIdx = 0; tIdx < trainsForCorridor; tIdx++) {
      const trainNum = globalTrainNumber++;
      const startsImmediatelyOnPlatform = tIdx === 0;
      const stationApproachCoords: [number, number][] = [
        corridor.sourceStation.position,
        corridor.sourceStation.position,
      ];

      vehicles.push({
        id: `metro-train-${corridor.id}-unit-${tIdx}`,
        fleetId: `brussels-metro-fleet`,
        fleetName: `STIB ${corridor.lineLabel} Train #${trainNum} (${corridor.sourceStation.name_fr} → ${corridor.targetStation.name_fr})`,
        vehicleType: 'Metro',
        unitCount: 1,
        capacityPerUnit: trainCapacity,
        maxCapacity: trainCapacity,
        loadUnloadTimePerPersonSeconds: metroLoadUnloadSec,
        transitSpeedKmh: metroTransitSpeedKmh,
        currentOccupancy: 0,
        occupancyByBehavior: createZeroBehaviorCounts(),
        assignedRouteId: corridor.id,
        assignedPickupId: pickupId,
        sourceId: corridor.sourceId,
        targetId: corridor.targetId,
        targetName: corridor.targetName,
        status: startsImmediatelyOnPlatform ? 'waiting_for_80_pct' : 'to_pickup',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        loadingElapsedSeconds: 0,
        unloadingProgressRemainder: 0,
        unloadingElapsedSeconds: 0,
        unloadingInitialOccupancy: 0,
        currentPosition: corridor.sourceStation.position,
        progressMeters: 0,
        speedMps: metroSpeedMps,
        approachCoords: stationApproachCoords,
        approachCumulative: [0, 0],
        evacCoords,
        evacCumulative: evacDist.cumulative,
        departureDelaySeconds: tIdx * 18,
        isMetro: true,
        metroLine: corridor.lineLabel,
        metroColor: corridor.color,
        sourceStationName: corridor.sourceStation.name_fr,
        targetStationName: corridor.targetStation.name_fr,
      });
    }

    if (newLogs) {
      newLogs.push(
        `🚇 Brussels Metro Evacuation Active: Established Pickup Station "${corridor.sourceStation.name_fr}" (${corridor.sourceName}) → Drop-Off Station "${corridor.targetStation.name_fr}" (${corridor.targetName}) via ${corridor.lineLabel} (${(corridor.distanceMeters / 1000).toFixed(2)} km track) with ${trainsForCorridor} train(s) × ${trainCapacity} pax.`
      );
    }
  });
}

/**
 * Initialize full simulation state from scratch.
 * Every empty vehicle departing to pick up population strictly follows the existing route polyline!
 */
export function initializeSimulationState(
  routes: ComputedRoute[],
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  vehicleFleets: VehicleFleet[],
  metroEvacuation?: MetroEvacuationOptions
): SimulationStateSnapshot {
  const newLogs: string[] = [];

  // Source Areas that have active Brussels Metro evacuation corridors use their Metro Stations
  // as Pickup Points and Target Area Metro Stations as Drop-Off Points
  const metroSourceIds = new Set<string>(
    metroEvacuation && metroEvacuation.enabled
      ? metroEvacuation.corridors.map((c) => c.sourceId)
      : []
  );

  const activeStreetRoutes =
    vehicleFleets.length > 0
      ? routes.filter((r) => !metroSourceIds.has(r.sourceId))
      : [];

  const pickupStates: PickupLocationState[] = [];
  const vehicles: ActiveVehicleUnit[] = [];

  // 1. Establish Brussels Metro Station Pickups/Drop-Offs and Metro Trains first
  appendMetroPickupsAndTrains(
    pickupStates,
    vehicles,
    metroEvacuation,
    undefined,
    newLogs
  );

  // 2. Establish Street Pickup Squares and Street Vehicle Units for Source Areas served by street fleets
  activeStreetRoutes.forEach((r, idx) => {
    pickupStates.push({
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
    });
  });

  const clusters = buildClustersForSources(sourceAreas);
  const telemetryStats = createInitialTelemetryStats(sourceAreas, clusters);

  activeStreetRoutes.forEach((route, rIdx) => {
    const pickup = pickupStates.find((p) => p.routeId === route.id);
    if (!pickup) return;

    const fleet =
      vehicleFleets.find((f) => f.id === route.vehicleFleetId) ||
      vehicleFleets[rIdx % Math.max(1, vehicleFleets.length)];

    if (!fleet || fleet.count <= 0) return;

    // Initial dispatch at t = 0 starts from the designated Vehicle Fleet staging depot location
    const approachCoords = getDepotToPickupApproachCoords(route, fleet);
    const evacCoords =
      route.coordinates && route.coordinates.length >= 2
        ? route.coordinates
        : [route.pickupLocation, route.pickupLocation];

    const approachDist = buildCumulativeDistances(approachCoords);
    const evacDist = buildCumulativeDistances(evacCoords);

    const numWaves = 4;
    const totalFleetUnits = Math.max(4, Math.ceil(fleet.count / 2));
    const unitsPerWave = Math.max(1, Math.round(totalFleetUnits / numWaves));
    const capPerUnit = fleet.capacityPerUnit;
    const maxCapPerWave = unitsPerWave * capPerUnit;
    const loadUnloadTimeSec = Math.max(0, fleet.loadUnloadTimePerPersonSeconds ?? 2);
    const transitSpeedKmh = Math.max(0.5, fleet.transitSpeedKmh ?? 25);
    const speedMps = kmhToMps(transitSpeedKmh);

    for (let w = 0; w < numWaves; w++) {
      vehicles.push({
        id: `veh-${route.id}-wave-${w}`,
        fleetId: fleet.id,
        fleetName: `${fleet.name} Convoy #${w + 1}`,
        vehicleType: fleet.type || 'Bus',
        unitCount: unitsPerWave,
        capacityPerUnit: capPerUnit,
        maxCapacity: maxCapPerWave,
        loadUnloadTimePerPersonSeconds: loadUnloadTimeSec,
        transitSpeedKmh,
        currentOccupancy: 0,
        occupancyByBehavior: createZeroBehaviorCounts(),
        assignedRouteId: route.id,
        assignedPickupId: pickup.id,
        sourceId: route.sourceId,
        targetId: route.targetId,
        targetName: route.targetName,
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        loadingElapsedSeconds: 0,
        unloadingProgressRemainder: 0,
        unloadingElapsedSeconds: 0,
        unloadingInitialOccupancy: 0,
        currentPosition: approachCoords[0],
        progressMeters: 0,
        speedMps,
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
    newLogs,
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
  existingPickupStates?: PickupLocationState[],
  metroEvacuation?: MetroEvacuationOptions
): SimulationStateSnapshot {
  const newLogs: string[] = [];

  const metroSourceIds = new Set<string>(
    metroEvacuation && metroEvacuation.enabled
      ? metroEvacuation.corridors.map((c) => c.sourceId)
      : []
  );

  const activeStreetRoutes =
    vehicleFleets.length > 0
      ? newRoutes.filter((r) => !metroSourceIds.has(r.sourceId))
      : [];

  // 1. Establish new Pickup Location states from recomputed street routes, preserving cumulative history if matched
  const pickupStates: PickupLocationState[] = activeStreetRoutes.map((r, idx) => {
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

  // 3. Reconcile street vehicles (exclude old empty metro trains, keep loaded metro trains until offload):
  const activeFleetIds = new Set(vehicleFleets.map((f) => f.id));
  const survivingVehicles = existingVehicles.filter(
    (v) => (!v.isMetro && activeFleetIds.has(v.fleetId)) || (v.isMetro && v.currentOccupancy > 0)
  );

  const updatedVehicles: ActiveVehicleUnit[] = [];

  survivingVehicles.forEach((veh, idx) => {
    // Loaded metro trains continue unaffected along their underground metro track!
    if (veh.isMetro && veh.currentOccupancy > 0) {
      updatedVehicles.push(veh);
      return;
    }

    const defaultNextRoute = activeStreetRoutes[idx % Math.max(1, activeStreetRoutes.length)];
    if (!defaultNextRoute && veh.currentOccupancy === 0) return;

    const fleet = vehicleFleets.find((f) => f.id === veh.fleetId);
    const updatedLoadUnloadSec = fleet
      ? Math.max(0, fleet.loadUnloadTimePerPersonSeconds ?? 2)
      : Math.max(0, veh.loadUnloadTimePerPersonSeconds ?? 2);
    const updatedTransitSpeedKmh = fleet
      ? Math.max(0.5, fleet.transitSpeedKmh ?? 25)
      : Math.max(0.5, veh.transitSpeedKmh ?? (veh.speedMps > 0 ? veh.speedMps * 3.6 : 25));
    const updatedSpeedMps = kmhToMps(updatedTransitSpeedKmh);
    const updatedCapPerUnit = fleet ? fleet.capacityPerUnit : veh.capacityPerUnit;
    const updatedMaxCap = Math.max(veh.currentOccupancy, veh.unitCount * updatedCapPerUnit);

    // CASE A: Running, waiting, or unloading vehicle carrying passengers (`currentOccupancy > 0`)
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
        activeStreetRoutes.find((r) => r.targetId === closestTarget.id) ||
        defaultNextRoute ||
        newRoutes.find((r) => r.targetId === closestTarget.id) ||
        newRoutes[0];
      if (!connectedRoute) return;

      const connectedPickup =
        pickupStates.find((p) => p.routeId === connectedRoute.id) ||
        (defaultNextRoute
          ? pickupStates.find((p) => p.routeId === defaultNextRoute.id)
          : undefined) ||
        pickupStates[0];

      if (!connectedPickup) return;

      const preserveUnloadingAtSameTarget =
        veh.status === 'unloading' && veh.targetId === closestTarget.id;

      if (!preserveUnloadingAtSameTarget) {
        newLogs.push(
          `Mid-sim reroute: ${veh.fleetName} (${veh.currentOccupancy} pax onboard, ${updatedTransitSpeedKmh} km/h) diverted from [${veh.currentPosition[0].toFixed(4)}, ${veh.currentPosition[1].toFixed(4)}] to closest active shelter "${closestTarget.name}", then following existing route ${connectedRoute.pickupLabel}.`
        );
      }

      updatedVehicles.push({
        ...veh,
        capacityPerUnit: updatedCapPerUnit,
        maxCapacity: updatedMaxCap,
        loadUnloadTimePerPersonSeconds: updatedLoadUnloadSec,
        transitSpeedKmh: updatedTransitSpeedKmh,
        speedMps: updatedSpeedMps,
        occupancyByBehavior: veh.occupancyByBehavior
          ? { ...veh.occupancyByBehavior }
          : { obedient: veh.currentOccupancy, autonomous: 0, random: 0 },
        status: preserveUnloadingAtSameTarget ? 'unloading' : 'to_target',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        progressMeters: preserveUnloadingAtSameTarget ? veh.progressMeters : 0,
        targetId: closestTarget.id,
        targetName: closestTarget.name,
        evacCoords: preserveUnloadingAtSameTarget ? veh.evacCoords : directCoords,
        evacCumulative: preserveUnloadingAtSameTarget ? veh.evacCumulative : directDist.cumulative,
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
      if (!defaultNextRoute) return;
      const nextPickup = pickupStates.find((p) => p.routeId === defaultNextRoute.id);
      if (!nextPickup) return;

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
        capacityPerUnit: updatedCapPerUnit,
        maxCapacity: updatedMaxCap,
        loadUnloadTimePerPersonSeconds: updatedLoadUnloadSec,
        transitSpeedKmh: updatedTransitSpeedKmh,
        speedMps: updatedSpeedMps,
        occupancyByBehavior: createZeroBehaviorCounts(),
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        loadingElapsedSeconds: 0,
        unloadingProgressRemainder: 0,
        unloadingElapsedSeconds: 0,
        unloadingInitialOccupancy: 0,
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
    const route = activeStreetRoutes[fIdx % Math.max(1, activeStreetRoutes.length)];
    const pickup = route ? pickupStates.find((p) => p.routeId === route.id) : undefined;
    if (!route || !pickup) return;

    const approachCoords = getDepotToPickupApproachCoords(route, fleet);
    const approachDist = buildCumulativeDistances(approachCoords);
    const evacDist = buildCumulativeDistances(route.coordinates);

    const numWaves = 3;
    const unitsPerWave = Math.max(1, Math.round(fleet.count / numWaves));
    const maxCapPerWave = unitsPerWave * fleet.capacityPerUnit;
    const loadUnloadTimeSec = Math.max(0, fleet.loadUnloadTimePerPersonSeconds ?? 2);
    const transitSpeedKmh = Math.max(0.5, fleet.transitSpeedKmh ?? 25);
    const speedMps = kmhToMps(transitSpeedKmh);

    for (let w = 0; w < numWaves; w++) {
      updatedVehicles.push({
        id: `veh-new-${fleet.id}-wave-${w}-${Date.now()}`,
        fleetId: fleet.id,
        fleetName: `${fleet.name} Convoy #${w + 1}`,
        vehicleType: fleet.type,
        unitCount: unitsPerWave,
        capacityPerUnit: fleet.capacityPerUnit,
        maxCapacity: maxCapPerWave,
        loadUnloadTimePerPersonSeconds: loadUnloadTimeSec,
        transitSpeedKmh,
        currentOccupancy: 0,
        occupancyByBehavior: createZeroBehaviorCounts(),
        assignedRouteId: route.id,
        assignedPickupId: pickup.id,
        sourceId: route.sourceId,
        targetId: route.targetId,
        targetName: route.targetName,
        status: 'to_pickup',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        loadingElapsedSeconds: 0,
        unloadingProgressRemainder: 0,
        unloadingElapsedSeconds: 0,
        unloadingInitialOccupancy: 0,
        currentPosition: approachCoords[0],
        progressMeters: 0,
        speedMps,
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords: route.coordinates,
        evacCumulative: evacDist.cumulative,
        departureDelaySeconds: w * 15,
      });
    }

    newLogs.push(
      `Deployed new fleet "${fleet.name}" (${fleet.count} × ${fleet.type}, ${transitSpeedKmh} km/h, ${loadUnloadTimeSec}s/pax load/unload) along existing corridor ${route.pickupLabel} -> ${route.targetName}.`
    );
  });

  // 5. Append Brussels Metro Station Pickups and Metro Trains if enabled
  appendMetroPickupsAndTrains(
    pickupStates,
    updatedVehicles,
    metroEvacuation,
    existingPickupStates,
    newLogs
  );

  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = existingTargetOccupancies[t.id] || 0;
  });

  const totalEvacuated = Object.values(targetOccupancies).reduce((acc, v) => acc + v, 0);
  const totalInTransit = updatedVehicles
    .filter((v) => v.status === 'to_target' || v.status === 'unloading')
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
 *    until within capture range of a pickup location, at which point they direct themselves straight to it
 * 3. Autonomous population wandering along Source Area perimeter limits until reaching a pickup location
 * 4. Vehicles waiting at pickup locations until EITHER:
 *    - Occupancy reaches >= 80%, OR
 *    - Waiting time reaches 10 minutes (600s) (or Metro platform dispatch cadence for Metro Trains)
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
    const allPickupsInZone = Array.from(pickupMap.values()).filter(
      (p) => p.sourceId === cluster.sourceId
    );

    if (allPickupsInZone.length === 0) return cluster;

    // When a Source Area has active Metro Station Pickup Points, prioritize the Metro Station Pickup Points
    const metroPickupsInZone = allPickupsInZone.filter((p) => p.isMetro);
    const pickupsInZone =
      metroPickupsInZone.length > 0 ? metroPickupsInZone : allPickupsInZone;

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
      .sort((a, b) => {
        if (Math.abs(a.distMeters - b.distMeters) <= 15) {
          return a.pickup.waitingPopulation - b.pickup.waitingPopulation;
        }
        return a.distMeters - b.distMeters;
      });

    const closest = pickupsWithDist[0];
    const arrivalRadiusMeters = closest.pickup.isMetro ? 18.0 : 14.0;

    // Check arrival threshold
    if (closest.distMeters <= arrivalRadiusMeters) {
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
    // until within capture distance of a pickup point, then direct straight to it!
    if (cluster.behavior === 'random') {
      const captureDistMeters = closest.pickup.isMetro ? 75.0 : 50.0;
      if (closest.distMeters <= captureDistMeters) {
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

        // If heading toward an interior Metro Station, add a gentle radial drift so Brownian walkers don't stay trapped at far corners
        if (closest.pickup.isMetro) {
          const driftRatio = Math.min(
            0.35,
            (walkSpeedMetersPerSec * 0.55 * deltaSimSeconds) /
              Math.max(1, closest.distMeters)
          );
          candidateLat += (closest.pickup.location[0] - cluster.position[0]) * driftRatio;
          candidateLng += (closest.pickup.location[1] - cluster.position[1]) * driftRatio;
        }

        // Reflect Brownian step back inside polygon if it crosses the boundary (without persistent straight-line drift)
        if (src && src.polygon.length >= 3) {
          try {
            const poly = toTurfPolygon(src.polygon);
            if (!turf.booleanPointInPolygon(turf.point([candidateLng, candidateLat]), poly)) {
              const targetRef = closest.pickup.isMetro
                ? closest.pickup.location
                : getPolygonCentroid(src.polygon);
              candidateLat =
                cluster.position[0] - dLat * 0.65 + (targetRef[0] - cluster.position[0]) * 0.12;
              candidateLng =
                cluster.position[1] - dLng * 0.65 + (targetRef[1] - cluster.position[1]) * 0.12;
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
    // (or curve inward from the perimeter when the pickup is an interior Metro Station)
    if (cluster.behavior === 'autonomous') {
      const captureDistMeters = closest.pickup.isMetro ? 75.0 : 55.0;
      if (closest.distMeters <= captureDistMeters) {
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

        if (closest.pickup.isMetro) {
          // Interior Metro Station: follow a curved path guided by the perimeter while steadily converging on the Metro Station
          const stepToMetro = walkSpeedMetersPerSec * 0.9 * deltaSimSeconds;
          const directRatio = Math.min(1.0, stepToMetro / Math.max(1, closest.distMeters));
          const directLat =
            cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * directRatio;
          const directLng =
            cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * directRatio;

          return {
            ...cluster,
            position: [directLat, directLng] as [number, number],
            perimeterEdgeIndex: nextEdgeIdx,
            perimeterProgress: nextProgress,
            targetPickupId: closest.pickup.id,
          };
        }

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

  // Calculate remaining moving evacuees in a Source Area
  const getMovingInSource = (sourceId: string): number => {
    return updatedClusters
      .filter((c) => c.sourceId === sourceId && c.status === 'moving_in_zone')
      .reduce((acc, c) => acc + c.headcount, 0);
  };

  // Calculate remaining unboarded evacuees per Source Area
  const getUnboardedInSource = (sourceId: string): number => {
    const movingCount = getMovingInSource(sourceId);
    const waitingCount = Array.from(pickupMap.values())
      .filter((p) => p.sourceId === sourceId)
      .reduce((acc, p) => acc + p.waitingPopulation, 0);
    return movingCount + waitingCount;
  };

  const updatedTargetOccupancies = { ...prevState.targetOccupancies };

  // Helper to transition an empty vehicle after completing unloading at a Target Shelter
  const finalizeEmptyVehicleAfterUnload = (veh: ActiveVehicleUnit): ActiveVehicleUnit => {
    updatedTelemetry.totalCompletedVehicleTrips += 1;

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
      loadingProgressRemainder: 0,
      loadingElapsedSeconds: 0,
      unloadingProgressRemainder: 0,
      unloadingElapsedSeconds: 0,
      unloadingInitialOccupancy: 0,
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

    const assignedPickup = pickupMap.get(veh.assignedPickupId);
    const remainingForPickup =
      getMovingInSource(veh.sourceId) + (assignedPickup ? assignedPickup.waitingPopulation : 0);

    if (remainingForPickup > 0 || getUnboardedInSource(veh.sourceId) > 0) {
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
  };

  // Track queue passengers reserved by earlier waiting vehicles at the same Pickup Location
  // so the lead boarding vehicle fills to 80% before subsequent vehicles board non-overflow passengers
  const reservedQueueByPickup = new Map<string, number>();

  // --- STEP 2: Process Vehicle Dispatches, Loading Time at Pickups (80% Occupancy OR 10 Minutes Wait), and Unloading Time at Target Shelters ---
  const updatedVehicles = prevState.vehicles.map((rawVeh) => {
    const transitSpeedKmh = Math.max(
      0.5,
      rawVeh.transitSpeedKmh ?? (rawVeh.speedMps > 0 ? rawVeh.speedMps * 3.6 : 25)
    );
    const speedMps = kmhToMps(transitSpeedKmh);

    const veh: ActiveVehicleUnit = {
      ...rawVeh,
      transitSpeedKmh,
      speedMps,
      occupancyByBehavior: rawVeh.occupancyByBehavior
        ? { ...rawVeh.occupancyByBehavior }
        : createZeroBehaviorCounts(),
    };

    if (veh.status === 'completed') return veh;
    if (elapsedSimSeconds < veh.departureDelaySeconds) return veh;

    const pickup = pickupMap.get(veh.assignedPickupId);
    if (!pickup) return veh;

    const loadUnloadSecPerPerson = Math.max(0, veh.loadUnloadTimePerPersonSeconds ?? 2);

    // Account for exact active time within tick if vehicle just passed its departureDelaySeconds
    const effectiveDeltaSec =
      veh.progressMeters === 0 && veh.status === 'to_pickup' && veh.departureDelaySeconds > 0
        ? Math.min(deltaSimSeconds, Math.max(0, elapsedSimSeconds - veh.departureDelaySeconds))
        : deltaSimSeconds;

    // STATE A: Driving empty along existing route TO Pickup Location (Blue Square or Metro Station) at configured transitSpeedKmh
    if (veh.status === 'to_pickup') {
      const totalApproachDist = Math.max(
        0,
        veh.approachCumulative[veh.approachCumulative.length - 1] ?? 0
      );
      const stepMeters = speedMps * effectiveDeltaSec;
      const nextProgress = veh.progressMeters + stepMeters;

      if (nextProgress >= totalApproachDist) {
        const remainingDistToPickup = Math.max(0, totalApproachDist - veh.progressMeters);
        const driveTimeUsedSec = speedMps > 0 ? remainingDistToPickup / speedMps : 0;
        const leftoverWaitSec = Math.max(0, effectiveDeltaSec - driveTimeUsedSec);

        return {
          ...veh,
          status: 'waiting_for_80_pct' as const,
          waitingAtPickupSeconds: leftoverWaitSec,
          loadingProgressRemainder: 0,
          loadingElapsedSeconds: 0,
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

    // STATE B: At Blue Square Pickup Location (or Metro Station) — Board waiting evacuees accounting for per-person loading time
    // & WAIT UNTIL: (1) Occupancy >= 80%, OR (2) Waiting time >= 10 minutes (600 seconds) (or Metro platform cadence)
    // Whichever happens first, depart to Target Area IF there is at least 1 passenger!
    if (veh.status === 'waiting_for_80_pct') {
      const nextWaitSeconds = veh.waitingAtPickupSeconds + deltaSimSeconds;

      const reservedAhead = reservedQueueByPickup.get(pickup.id) || 0;
      const spaceNeeded = veh.maxCapacity - veh.currentOccupancy;

      // If this is a Metro train (or local queue is empty with no more moving clusters in zone) and more passengers are needed,
      // draw waiting evacuees from other pickup queues in the same Source Area so Metro capacity is fully utilized!
      if (
        spaceNeeded > Math.max(0, pickup.waitingPopulation - reservedAhead) &&
        (veh.isMetro || (pickup.waitingPopulation === 0 && getMovingInSource(veh.sourceId) === 0))
      ) {
        for (const otherPickup of pickupMap.values()) {
          const currentAvail = Math.max(0, pickup.waitingPopulation - reservedAhead);
          const deficit = spaceNeeded - currentAvail;
          if (deficit <= 0) break;
          if (
            otherPickup.sourceId === veh.sourceId &&
            otherPickup.id !== pickup.id &&
            otherPickup.waitingPopulation > 0
          ) {
            const transferCount = Math.min(deficit, otherPickup.waitingPopulation);
            if (transferCount > 0) {
              const transferredByBehavior = allocateBoardedByBehavior(
                otherPickup.waitingByBehavior,
                transferCount
              );
              otherPickup.waitingPopulation -= transferCount;
              otherPickup.waitingByBehavior.obedient = Math.max(
                0,
                otherPickup.waitingByBehavior.obedient - transferredByBehavior.obedient
              );
              otherPickup.waitingByBehavior.autonomous = Math.max(
                0,
                otherPickup.waitingByBehavior.autonomous - transferredByBehavior.autonomous
              );
              otherPickup.waitingByBehavior.random = Math.max(
                0,
                otherPickup.waitingByBehavior.random - transferredByBehavior.random
              );

              pickup.waitingPopulation += transferCount;
              pickup.waitingByBehavior.obedient += transferredByBehavior.obedient;
              pickup.waitingByBehavior.autonomous += transferredByBehavior.autonomous;
              pickup.waitingByBehavior.random += transferredByBehavior.random;
            }
          }
        }
      }

      const availableQueueForVeh = Math.max(0, pickup.waitingPopulation - reservedAhead);

      let boardedNow = 0;
      if (spaceNeeded > 0 && availableQueueForVeh > 0) {
        if (loadUnloadSecPerPerson <= 0) {
          boardedNow = Math.min(spaceNeeded, availableQueueForVeh);
          veh.loadingProgressRemainder = 0;
        } else {
          // Each individual vehicle in `veh.unitCount` boards 1 person every `loadUnloadSecPerPerson` seconds in parallel
          const activeLoadingUnits = Math.max(
            1,
            Math.min(veh.unitCount, availableQueueForVeh, spaceNeeded)
          );
          const exactBoarded =
            (deltaSimSeconds * activeLoadingUnits) / loadUnloadSecPerPerson +
            (veh.loadingProgressRemainder || 0);
          boardedNow = Math.min(
            spaceNeeded,
            availableQueueForVeh,
            Math.floor(exactBoarded)
          );
          veh.loadingProgressRemainder = exactBoarded - boardedNow;
          veh.loadingElapsedSeconds = (veh.loadingElapsedSeconds || 0) + deltaSimSeconds;
        }

        if (boardedNow > 0) {
          const boardedBreakdown = allocateBoardedByBehavior(
            pickup.waitingByBehavior,
            boardedNow
          );

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
      } else {
        veh.loadingProgressRemainder = 0;
      }

      const hasAtLeastOnePassenger = veh.currentOccupancy >= 1;
      const occupancyRatio = veh.currentOccupancy / Math.max(1, veh.maxCapacity);
      const remainingUnboardedForPickup =
        getMovingInSource(veh.sourceId) + pickup.waitingPopulation;
      const remainingUnboardedInSource = getUnboardedInSource(veh.sourceId);

      // Departure Conditions:
      const remainingQueueForVeh = Math.max(0, pickup.waitingPopulation - reservedAhead);
      const reached80Percent = occupancyRatio >= 0.80;
      const reached10Minutes = nextWaitSeconds >= 600.0; // 10 minutes = 600 simulation seconds
      const reachedMetroCadence =
        Boolean(veh.isMetro) &&
        remainingQueueForVeh === 0 &&
        nextWaitSeconds >= 25.0;
      const isLastCleanupSweep =
        (remainingUnboardedForPickup === 0 || remainingUnboardedInSource === 0) &&
        hasAtLeastOnePassenger;

      // Depart if (80% occupancy OR metro cadence OR 10 min wait OR cleanup sweep) AND at least 1 passenger is onboard
      if (
        hasAtLeastOnePassenger &&
        (reached80Percent || reachedMetroCadence || reached10Minutes || isLastCleanupSweep)
      ) {
        const pctStr = Math.round(occupancyRatio * 100);
        const waitFormatted = formatMMSS(nextWaitSeconds);
        const loadFormatted = formatMMSS(veh.loadingElapsedSeconds || 0);
        const totalEvacDistMeters = Math.max(
          0,
          veh.evacCumulative[veh.evacCumulative.length - 1] ?? 0
        );
        const estTransitFormatted = formatMMSS(
          speedMps > 0 ? totalEvacDistMeters / speedMps : 0
        );

        pickup.completedDeparturesCount += 1;
        pickup.totalCompletedVehicleWaitSeconds += nextWaitSeconds;
        pickup.maxVehicleWaitSeconds = Math.max(pickup.maxVehicleWaitSeconds, nextWaitSeconds);
        pickup.totalDepartureOccupancyRatioSum += occupancyRatio;

        let triggerReason = '80% Occupancy Reached';
        if (!reached80Percent && isLastCleanupSweep) {
          triggerReason = 'Final Evacuees Boarded';
        } else if (!reached80Percent && reachedMetroCadence) {
          triggerReason = 'Metro Platform Dispatch Cadence';
        } else if (!reached80Percent && reached10Minutes) {
          triggerReason = '10-Minute Wait Timeout Reached';
        }

        const destDesc = veh.isMetro && veh.targetStationName
          ? `${veh.targetStationName} (${veh.targetName})`
          : veh.targetName;

        newLogs.push(
          `${veh.fleetName} departing ${pickup.label} -> ${destDesc} (${(totalEvacDistMeters / 1000).toFixed(2)} km @ ${transitSpeedKmh} km/h, est. transit ${estTransitFormatted}) [${triggerReason}: ${veh.currentOccupancy}/${veh.maxCapacity} passengers (${pctStr}%), Wait/Load Time: ${waitFormatted} (active loading: ${loadFormatted} @ ${loadUnloadSecPerPerson}s/pax)].`
        );

        return {
          ...veh,
          status: 'to_target' as const,
          waitingAtPickupSeconds: 0,
          loadingProgressRemainder: 0,
          loadingElapsedSeconds: 0,
          progressMeters: 0,
          currentPosition: veh.evacCoords[0] || pickup.location,
        };
      } else {
        // Reserve queue seats needed by this vehicle to reach 80% so subsequent vehicles in bay only board overflow
        const neededFor80Pct = Math.max(
          0,
          Math.ceil(veh.maxCapacity * 0.80) - veh.currentOccupancy
        );
        const remainingQueueAfterBoard = Math.max(0, availableQueueForVeh - boardedNow);
        reservedQueueByPickup.set(
          pickup.id,
          reservedAhead + Math.min(remainingQueueAfterBoard, neededFor80Pct)
        );

        // Still waiting / boarding at Pickup Location / Metro Station
        const pctStr = Math.round(occupancyRatio * 100);
        const waitFormatted = formatMMSS(nextWaitSeconds);
        pickup.maxVehicleWaitSeconds = Math.max(pickup.maxVehicleWaitSeconds, nextWaitSeconds);

        if (!pickup.boardingVehicleInfo || veh.currentOccupancy > 0) {
          if (nextWaitSeconds >= 600.0 && !hasAtLeastOnePassenger) {
            pickup.boardingVehicleInfo = `${veh.fleetName}: 0/${veh.maxCapacity} (Wait ${waitFormatted}/10:00 — Awaiting >=1 passenger)`;
          } else if (availableQueueForVeh > 0 && spaceNeeded > 0) {
            pickup.boardingVehicleInfo = `${veh.fleetName}: ${veh.currentOccupancy}/${veh.maxCapacity} (${pctStr}% | Loading ${loadUnloadSecPerPerson}s/pax | Wait ${waitFormatted})`;
          } else {
            pickup.boardingVehicleInfo = `${veh.fleetName}: ${veh.currentOccupancy}/${veh.maxCapacity} (${pctStr}% | Wait ${waitFormatted})`;
          }
        }

        // If 0 people left for this pickup/source area and vehicle is empty, mark completed
        if (
          remainingUnboardedForPickup === 0 &&
          remainingUnboardedInSource === 0 &&
          veh.currentOccupancy === 0
        ) {
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

    // STATE C: Driving from Pickup Location (or mid-transit diversion) TO Target Shelter at configured transitSpeedKmh
    if (veh.status === 'to_target') {
      const totalEvacDist = Math.max(
        0,
        veh.evacCumulative[veh.evacCumulative.length - 1] ?? 0
      );
      const nextProgress = veh.progressMeters + speedMps * deltaSimSeconds;

      if (nextProgress >= totalEvacDist) {
        const arrivalPos =
          veh.evacCoords[veh.evacCoords.length - 1] || veh.currentPosition;
        const distKmStr = (totalEvacDist / 1000).toFixed(2);

        // If load/unload time per person is 0 (instantaneous) or vehicle is empty, offload immediately
        if (loadUnloadSecPerPerson <= 0 || veh.currentOccupancy <= 0) {
          updatedTargetOccupancies[veh.targetId] =
            (updatedTargetOccupancies[veh.targetId] || 0) + veh.currentOccupancy;

          (['obedient', 'autonomous', 'random'] as PopulationBehaviorType[]).forEach((beh) => {
            const countB = veh.occupancyByBehavior[beh] || 0;
            updatedTelemetry.evacuatedByBehavior[beh] += countB;
            updatedTelemetry.evacuatedPersonSecondsByBehavior[beh] +=
              countB * elapsedSimSeconds;
          });

          pickup.evacuatedCount += veh.currentOccupancy;
          pickup.evacuatedByBehavior.obedient += veh.occupancyByBehavior.obedient;
          pickup.evacuatedByBehavior.autonomous += veh.occupancyByBehavior.autonomous;
          pickup.evacuatedByBehavior.random += veh.occupancyByBehavior.random;

          newLogs.push(
            `${veh.fleetName} arrived at ${veh.targetName} (${distKmStr} km @ ${transitSpeedKmh} km/h), offloading ${veh.currentOccupancy.toLocaleString()} evacuees safely.`
          );

          return finalizeEmptyVehicleAfterUnload(veh);
        }

        // Otherwise, transition to STATE D ('unloading') at the Target Shelter
        newLogs.push(
          `${veh.fleetName} arrived at ${veh.targetName} (${distKmStr} km @ ${transitSpeedKmh} km/h) with ${veh.currentOccupancy.toLocaleString()} evacuees — unloading started (${loadUnloadSecPerPerson}s/person)...`
        );

        return {
          ...veh,
          status: 'unloading' as const,
          progressMeters: totalEvacDist,
          currentPosition: arrivalPos,
          unloadingInitialOccupancy: veh.currentOccupancy,
          unloadingElapsedSeconds: 0,
          unloadingProgressRemainder: 0,
        };
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

    // STATE D: Unloading passengers at Target Shelter accounting for per-person unloading time
    if (veh.status === 'unloading') {
      const nextUnloadElapsed = (veh.unloadingElapsedSeconds || 0) + deltaSimSeconds;
      const initialOcc = Math.max(
        1,
        veh.unloadingInitialOccupancy || veh.currentOccupancy
      );

      let unloadedNow = 0;
      if (loadUnloadSecPerPerson <= 0) {
        unloadedNow = veh.currentOccupancy;
        veh.unloadingProgressRemainder = 0;
      } else {
        // Each individual vehicle in `veh.unitCount` that carried passengers unloads 1 person every `loadUnloadSecPerPerson` seconds in parallel
        const activeUnloadingUnits = Math.max(1, Math.min(veh.unitCount, initialOcc));
        const exactUnloaded =
          (deltaSimSeconds * activeUnloadingUnits) / loadUnloadSecPerPerson +
          (veh.unloadingProgressRemainder || 0);
        unloadedNow = Math.min(veh.currentOccupancy, Math.floor(exactUnloaded));
        veh.unloadingProgressRemainder = exactUnloaded - unloadedNow;
      }

      if (unloadedNow > 0) {
        const unloadedBreakdown = allocateBoardedByBehavior(
          veh.occupancyByBehavior,
          unloadedNow
        );

        veh.currentOccupancy -= unloadedNow;
        veh.occupancyByBehavior.obedient = Math.max(
          0,
          veh.occupancyByBehavior.obedient - unloadedBreakdown.obedient
        );
        veh.occupancyByBehavior.autonomous = Math.max(
          0,
          veh.occupancyByBehavior.autonomous - unloadedBreakdown.autonomous
        );
        veh.occupancyByBehavior.random = Math.max(
          0,
          veh.occupancyByBehavior.random - unloadedBreakdown.random
        );

        updatedTargetOccupancies[veh.targetId] =
          (updatedTargetOccupancies[veh.targetId] || 0) + unloadedNow;

        // Credit evacuated counts & cumulative person-seconds by behavior as evacuees step off into shelter
        (['obedient', 'autonomous', 'random'] as PopulationBehaviorType[]).forEach((beh) => {
          const countB = unloadedBreakdown[beh] || 0;
          updatedTelemetry.evacuatedByBehavior[beh] += countB;
          updatedTelemetry.evacuatedPersonSecondsByBehavior[beh] +=
            countB * elapsedSimSeconds;
        });

        // Credit pickup location shelter delivery statistics
        pickup.evacuatedCount += unloadedNow;
        pickup.evacuatedByBehavior.obedient += unloadedBreakdown.obedient;
        pickup.evacuatedByBehavior.autonomous += unloadedBreakdown.autonomous;
        pickup.evacuatedByBehavior.random += unloadedBreakdown.random;
      }

      if (veh.currentOccupancy <= 0) {
        newLogs.push(
          `${veh.fleetName} finished unloading ${initialOcc.toLocaleString()} evacuees at ${veh.targetName} (unload time: ${formatMMSS(nextUnloadElapsed)} @ ${loadUnloadSecPerPerson}s/pax).`
        );
        return finalizeEmptyVehicleAfterUnload(veh);
      }

      return {
        ...veh,
        unloadingElapsedSeconds: nextUnloadElapsed,
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
    .filter((v) => v.status === 'to_target' || v.status === 'unloading')
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
