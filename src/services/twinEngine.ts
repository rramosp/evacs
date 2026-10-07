import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  RedArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  TwinStateSnapshot,
  HeatmapPoint,
  PopulationBehaviorType,
  BehaviorCounts,
  TwinTelemetryStats,
  BrusselsMetroCorridor,
} from '../types/evacuation';
import {
  getPolygonCentroid,
  toTurfPolygon,
  findClosestPointOnPolyline,
  buildRouteSuffixToPickup,
  buildRouteSuffixToTarget,
  findClosestEvacuationRoute,
  assignFleetsToRoutesByProximity,
  dedupPolylineCoords,
  computeShortestCollisionFreePath,
} from './routingEngine';
import { computeMetroTrackBetweenPositions } from './brusselsMetroService';

export interface MetroEvacuationOptions {
  enabled: boolean;
  corridors: BrusselsMetroCorridor[];
  trainCount: number;
  trainCapacity: number;
}

/**
 * Constant number of evacuees represented by each full dot (cluster) across all Source Areas.
 * A few dots per area may hold < 50 people initially (to match exact Source Area population)
 * or dynamically at pickup points when part of a dot boards a vehicle and part remains waiting.
 */
export const PEOPLE_PER_DOT = 50;

/**
 * Create a zeroed BehaviorCounts object
 */
export function createZeroBehaviorCounts(): BehaviorCounts {
  return { compliant: 0, 'self-directed': 0, disoriented: 0 };
}

/**
 * Compute exact integer headcounts per behavioral group for a single Source Area
 * so `compliant + 'self-directed' + disoriented === Math.max(0, Math.round(src.population))`.
 */
export function computeSourceBehaviorHeadcounts(src: SourceArea): BehaviorCounts {
  const totalPop = Math.max(0, Math.round(src.population));
  if (totalPop === 0) {
    return createZeroBehaviorCounts();
  }

  const keys: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];
  const rawPctSum =
    Math.max(0, src.behavior.compliant) +
    Math.max(0, src.behavior['self-directed']) +
    Math.max(0, src.behavior.disoriented);
  const normDenom = rawPctSum > 0 ? rawPctSum : 100;

  const exactShares = keys.map((k) => {
    const pct = rawPctSum > 0 ? Math.max(0, src.behavior[k]) : k === 'compliant' ? 100 : 0;
    const exact = (totalPop * pct) / normDenom;
    const floored = Math.floor(exact);
    return {
      key: k,
      floored,
      frac: exact - floored,
    };
  });

  const counts = createZeroBehaviorCounts();
  let assigned = 0;
  exactShares.forEach((s) => {
    counts[s.key] = s.floored;
    assigned += s.floored;
  });

  let rem = totalPop - assigned;
  const byRemainder = [...exactShares].sort((a, b) => b.frac - a.frac);
  let idx = 0;
  while (rem > 0 && idx < byRemainder.length) {
    counts[byRemainder[idx].key] += 1;
    rem -= 1;
    idx += 1;
  }

  return counts;
}

/**
 * Compute exact initial behavior headcounts for a list of Source Areas (matching buildClustersForSources)
 */
export function computeBehaviorCountsFromSources(sourceAreas: SourceArea[]): BehaviorCounts {
  const counts = createZeroBehaviorCounts();
  sourceAreas.forEach((src) => {
    if (src.disabled) return;
    const srcCounts = computeSourceBehaviorHeadcounts(src);
    counts.compliant += srcCounts.compliant;
    counts['self-directed'] += srcCounts['self-directed'];
    counts.disoriented += srcCounts.disoriented;
  });
  return counts;
}

/**
 * Allocate `boardedNow` passengers proportionally from `waiting` BehaviorCounts
 * while guaranteeing exact integer sum (`taken.compliant + taken['self-directed'] + taken.disoriented === boardedNow`)
 * and `0 <= taken[b] <= waiting[b]`.
 */
function allocateBoardedByBehavior(waiting: BehaviorCounts, boardedNow: number): BehaviorCounts {
  const totalAvail = waiting.compliant + waiting['self-directed'] + waiting.disoriented;
  if (boardedNow <= 0 || totalAvail <= 0) {
    return createZeroBehaviorCounts();
  }
  if (boardedNow >= totalAvail) {
    return {
      compliant: waiting.compliant,
      'self-directed': waiting['self-directed'],
      disoriented: waiting.disoriented,
    };
  }

  const keys: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];
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
 * Create initial TwinTelemetryStats
 */
export function createInitialTelemetryStats(
  sourceAreas: SourceArea[],
  clusters?: SourceInternalCluster[]
): TwinTelemetryStats {
  const initialByBehavior = createZeroBehaviorCounts();
  if (clusters && clusters.length > 0) {
    clusters.forEach((c) => {
      initialByBehavior[c.behavior] += c.headcount;
    });
  } else {
    const computed = computeBehaviorCountsFromSources(sourceAreas);
    initialByBehavior.compliant = computed.compliant;
    initialByBehavior['self-directed'] = computed['self-directed'];
    initialByBehavior.disoriented = computed.disoriented;
  }

  return {
    initialByBehavior,
    evacuatedByBehavior: createZeroBehaviorCounts(),
    evacuatedPersonSecondsByBehavior: createZeroBehaviorCounts(),
    pickupArrivedByBehavior: createZeroBehaviorCounts(),
    pickupArrivalPersonSecondsByBehavior: createZeroBehaviorCounts(),
    totalCompletedVehicleTrips: 0,
    evacuationTimeSeries: [{ timeSeconds: 0, evacuatedCount: 0 }],
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
 * to the Pickup Location (`route.pickupLocation`):
 * - Uses `route.approachCoordinates` when precomputed for this depot (which goes from the depot
 *   to the closest point on `route.coordinates` and then follows `route.coordinates` to `route.pickupLocation`).
 * - Otherwise, projects `startDepot` onto the closest point on `route.coordinates` and follows
 *   `route.coordinates` in reverse from that closest point all the way to `route.pickupLocation`.
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
    const precomputedStart = route.approachCoordinates[0];
    const depotDistMeters =
      turf.distance(
        [startDepot[1], startDepot[0]],
        [precomputedStart[1], precomputedStart[0]],
        { units: 'kilometers' }
      ) * 1000;

    if (depotDistMeters <= 35) {
      const coords = [...route.approachCoordinates];
      coords[0] = startDepot;
      coords[coords.length - 1] = route.pickupLocation;
      return coords;
    }
  }

  if (route.coordinates && route.coordinates.length >= 2) {
    const snap = findClosestPointOnPolyline(startDepot, route.coordinates);
    const onRouteToPickup = buildRouteSuffixToPickup(route.coordinates, snap);
    return dedupPolylineCoords([startDepot, ...onRouteToPickup]);
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
 * Build an empty approach path from `currentPos` to the closest point on `route.coordinates`
 * and then along `route.coordinates` in reverse to `route.pickupLocation`.
 */
function getEmptyApproachAlongExistingRoute(
  route: ComputedRoute,
  currentPos?: [number, number]
): [number, number][] {
  if (!route.coordinates || route.coordinates.length < 2) {
    return currentPos ? [currentPos, route.pickupLocation] : [route.pickupLocation, route.pickupLocation];
  }

  if (!currentPos) {
    return [...route.coordinates].reverse();
  }

  const snap = findClosestPointOnPolyline(currentPos, route.coordinates);
  const onRouteToPickup = buildRouteSuffixToPickup(route.coordinates, snap);
  return snap.distanceMeters > 3
    ? dedupPolylineCoords([currentPos, ...onRouteToPickup])
    : onRouteToPickup;
}

/**
 * Fast ray-casting point-in-polygon check for `[lat, lng]` ring coordinates.
 */
function isPointInPolygonRing(lat: number, lng: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const latI = ring[i][0];
    const lngI = ring[i][1];
    const latJ = ring[j][0];
    const lngJ = ring[j][1];

    const intersects =
      lngI > lng !== lngJ > lng &&
      lat < ((latJ - latI) * (lng - lngI)) / (lngJ - lngI) + latI;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Sample `count` points spatially uniformly inside a polygon using a 2D Roberts R2
 * low-discrepancy sequence over the polygon interior refined by discrete Centroidal
 * Voronoi Tessellation (Lloyd relaxation) in isotropic metric coordinates.
 */
function sampleUniformPointsInsidePolygon(
  polygonCoords: [number, number][],
  count: number
): [number, number][] {
  if (count <= 0) return [];
  const centroid = getPolygonCentroid(polygonCoords);
  if (!polygonCoords || polygonCoords.length < 3) {
    return Array.from({ length: count }, () => [...centroid] as [number, number]);
  }

  try {
    const poly = toTurfPolygon(polygonCoords);
    const bbox = turf.bbox(poly); // [minLng, minLat, maxLng, maxLat]
    const minLng = bbox[0];
    const minLat = bbox[1];
    const maxLng = bbox[2];
    const maxLat = bbox[3];
    const spanLat = maxLat - minLat;
    const spanLng = maxLng - minLng;

    if (spanLat > 0 && spanLng > 0) {
      const cosLat = Math.max(0.1, Math.cos(((minLat + maxLat) * 0.5 * Math.PI) / 180));

      // 2D Roberts R2 low-discrepancy quasi-random sequence constants (plastic constant phi_2)
      const phi2 = 1.324717957244746;
      const alpha1 = 1 / phi2;
      const alpha2 = 1 / (phi2 * phi2);

      const targetSamples = Math.max(count * 8, 450);
      const maxAttempts = targetSamples * 12;
      const samples: [number, number][] = [];

      for (let k = 1; k <= maxAttempts && samples.length < targetSamples; k++) {
        const u = (0.5 + k * alpha1) % 1;
        const v = (0.5 + k * alpha2) % 1;
        const lat = minLat + u * spanLat;
        const lng = minLng + v * spanLng;
        if (isPointInPolygonRing(lat, lng, polygonCoords)) {
          samples.push([lat, lng]);
        }
      }

      if (samples.length >= count) {
        // Initialize cluster centers from the first `count` R2 low-discrepancy interior points
        // (naturally uncorrelated in index order, keeping behavioral groups uniformly interleaved)
        const centers: [number, number][] = [];
        for (let i = 0; i < count; i++) {
          centers.push([samples[i][0], samples[i][1]]);
        }

        const assignment = new Int32Array(samples.length);

        // 3 iterations of discrete Centroidal Voronoi (Lloyd) relaxation for even spatial spacing
        for (let iter = 0; iter < 3; iter++) {
          const sumLat = new Float64Array(count);
          const sumLng = new Float64Array(count);
          const cellCounts = new Int32Array(count);

          for (let s = 0; s < samples.length; s++) {
            const sLat = samples[s][0];
            const sLng = samples[s][1];
            let bestIdx = 0;
            let bestDistSq = Infinity;
            for (let c = 0; c < count; c++) {
              const dLat = sLat - centers[c][0];
              const dLng = (sLng - centers[c][1]) * cosLat;
              const dSq = dLat * dLat + dLng * dLng;
              if (dSq < bestDistSq) {
                bestDistSq = dSq;
                bestIdx = c;
              }
            }
            assignment[s] = bestIdx;
            sumLat[bestIdx] += sLat;
            sumLng[bestIdx] += sLng;
            cellCounts[bestIdx] += 1;
          }

          for (let c = 0; c < count; c++) {
            if (cellCounts[c] <= 0) continue;
            const meanLat = sumLat[c] / cellCounts[c];
            const meanLng = sumLng[c] / cellCounts[c];

            if (isPointInPolygonRing(meanLat, meanLng, polygonCoords)) {
              centers[c] = [meanLat, meanLng];
            } else {
              // Concave boundary fallback: snap to the interior sample in cell `c` closest to the cell mean
              let bestSampleLat = centers[c][0];
              let bestSampleLng = centers[c][1];
              let bestDistSq = Infinity;
              for (let s = 0; s < samples.length; s++) {
                if (assignment[s] !== c) continue;
                const dLat = samples[s][0] - meanLat;
                const dLng = (samples[s][1] - meanLng) * cosLat;
                const dSq = dLat * dLat + dLng * dLng;
                if (dSq < bestDistSq) {
                  bestDistSq = dSq;
                  bestSampleLat = samples[s][0];
                  bestSampleLng = samples[s][1];
                }
              }
              centers[c] = [bestSampleLat, bestSampleLng];
            }
          }
        }

        return centers;
      } else if (samples.length > 0) {
        return Array.from(
          { length: count },
          (_, i) => [...samples[i % samples.length]] as [number, number]
        );
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: evenly distributed around full perimeter with area-uniform radial factor
  return Array.from({ length: count }, (_, i) => {
    const vertexIdx =
      Math.floor((i * polygonCoords.length) / Math.max(1, count)) % polygonCoords.length;
    const corner = polygonCoords[vertexIdx];
    const radialU = ((i + 0.5) * 0.61803398875) % 1;
    const t = 0.15 + 0.75 * Math.sqrt(radialU);
    return [
      centroid[0] + (corner[0] - centroid[0]) * t,
      centroid[1] + (corner[1] - centroid[1]) * t,
    ] as [number, number];
  });
}

/**
 * Compute remaining unboarded population per Source Area ID
 */
export function getRemainingPopulationBySource(
  sourceAreas: SourceArea[],
  clusters: SourceInternalCluster[],
  pickupStates: PickupLocationState[],
  hasTwinStarted: boolean
): Record<string, number> {
  const result: Record<string, number> = {};
  sourceAreas.forEach((src) => {
    if (!hasTwinStarted) {
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

export function generateHeatmapFromState(
  _clusters: SourceInternalCluster[],
  _pickupStates: PickupLocationState[],
  _vehicles: ActiveVehicleUnit[],
  _targetAreas: TargetArea[],
  _targetOccupancies: Record<string, number>
): HeatmapPoint[] {
  return [];
}

/**
 * Helper to generate internal clusters (dots) for a list of Source Areas:
 * - Constant 50 people per dot (`PEOPLE_PER_DOT = 50`) across all Source Areas, so areas with fewer people have fewer dots.
 * - Up to 1 remainder dot per active behavioral group in an area may have < 50 people to match the exact population and behavioral split.
 * - Spatially uniform distribution across each Source Area polygon with interleaved behavioral types.
 */
export function buildClustersForSources(sourceAreas: SourceArea[]): SourceInternalCluster[] {
  const clusters: SourceInternalCluster[] = [];
  const behaviorOrder: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];

  sourceAreas.forEach((src) => {
    if (src.disabled) return;
    const totalPop = Math.max(0, Math.round(src.population));
    if (totalPop === 0) return;

    const behCounts = computeSourceBehaviorHeadcounts(src);
    const dotSpecs: {
      behavior: PopulationBehaviorType;
      headcount: number;
      interleaveRank: number;
    }[] = [];

    behaviorOrder.forEach((behavior, bIdx) => {
      const popB = behCounts[behavior];
      if (popB <= 0) return;

      const fullDots = Math.floor(popB / PEOPLE_PER_DOT);
      const remHeadcount = popB % PEOPLE_PER_DOT;
      const totalDotsForB = fullDots + (remHeadcount > 0 ? 1 : 0);

      for (let d = 0; d < fullDots; d++) {
        dotSpecs.push({
          behavior,
          headcount: PEOPLE_PER_DOT,
          interleaveRank: (d + 0.5) / totalDotsForB + bIdx * 1e-6,
        });
      }
      if (remHeadcount > 0) {
        dotSpecs.push({
          behavior,
          headcount: remHeadcount,
          interleaveRank: (fullDots + 0.5) / totalDotsForB + bIdx * 1e-6,
        });
      }
    });

    if (dotSpecs.length === 0) return;

    // Interleave behavioral types evenly so the R2/Lloyd uniform positions have a balanced spatial mix
    dotSpecs.sort((a, b) => a.interleaveRank - b.interleaveRank);

    const numClusters = dotSpecs.length;
    const uniformPositions = sampleUniformPointsInsidePolygon(src.polygon, numClusters);

    for (let i = 0; i < numClusters; i++) {
      const { behavior, headcount } = dotSpecs[i];
      if (headcount <= 0) continue;

      const startPos = uniformPositions[i] || getPolygonCentroid(src.polygon);

      // Find the perimeter vertex closest to startPos
      let nearestEdgeIdx = 0;
      let nearestDistSq = Infinity;
      for (let vIdx = 0; vIdx < src.polygon.length; vIdx++) {
        const dLat = src.polygon[vIdx][0] - startPos[0];
        const dLng = src.polygon[vIdx][1] - startPos[1];
        const dSq = dLat * dLat + dLng * dLng;
        if (dSq < nearestDistSq) {
          nearestDistSq = dSq;
          nearestEdgeIdx = vIdx;
        }
      }

      const initialSide: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const initialTackDeg = 36 + ((i * 19) % 28); // 36 deg to 63 deg

      clusters.push({
        id: `cluster-${src.id}-${i}-${Date.now()}`,
        sourceId: src.id,
        behavior,
        headcount,
        position: startPos,
        targetPickupId: null,
        perimeterEdgeIndex: nearestEdgeIdx,
        perimeterProgress: 0,
        disorientedHeadingRad: ((i * 73) % 360) * (Math.PI / 180),
        zigZagSide: initialSide,
        zigZagTimerSeconds: 3.0 + ((i * 11) % 6),
        zigZagAngleOffsetRad: initialSide * ((initialTackDeg * Math.PI) / 180),
        isReversingBrief: false,
        status: 'moving_in_zone',
      });
    }
  });

  return clusters;
}

/**
 * Helper to append Brussels Metro Station Pickups and Metro Train units
 * along static Metro Line trajectories (unaffected by Red Areas).
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

    const evacCoords =
      corridor.coordinates.length >= 2
        ? corridor.coordinates
        : [corridor.sourceStation.position, corridor.targetStation.position];
    const evacDist = buildCumulativeDistances(evacCoords);

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
      routeCoords: evacCoords,
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
 * Initialize full twin state from scratch.
 * Every empty vehicle departing to pick up population strictly follows the existing route polyline!
 */
export function initializeTwinState(
  routes: ComputedRoute[],
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  vehicleFleets: VehicleFleet[],
  metroEvacuation?: MetroEvacuationOptions
): TwinStateSnapshot {
  const newLogs: string[] = [];

  const activeSources = sourceAreas.filter((s) => !s.disabled);
  const activeSourceIds = new Set(activeSources.map((s) => s.id));
  const activeTargetIds = new Set(targetAreas.filter((t) => !t.disabled).map((t) => t.id));

  // All calculated street evacuation routes between active Source and Target Areas are used concurrently
  // alongside any active Brussels Metro evacuation corridors
  const activeStreetRoutes =
    vehicleFleets.length > 0
      ? routes.filter((r) => activeSourceIds.has(r.sourceId) && activeTargetIds.has(r.targetId))
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
    const routeCoords =
      r.coordinates && r.coordinates.length >= 2
        ? r.coordinates
        : [r.pickupLocation, r.dropOffLocation || r.pickupLocation];
    pickupStates.push({
      id: `pickup-${r.id}`,
      routeId: r.id,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      targetId: r.targetId,
      targetName: r.targetName,
      label: r.pickupLabel || `Pickup Point #${idx + 1}`,
      location: r.pickupLocation,
      dropOffLocation: r.dropOffLocation,
      routeCoords,
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

  const clusters = buildClustersForSources(activeSources);
  const telemetryStats = createInitialTelemetryStats(activeSources, clusters);

  const routeCoordsList: [number, number][][] = activeStreetRoutes.map((r) =>
    r.coordinates && r.coordinates.length >= 2
      ? r.coordinates
      : [r.pickupLocation, r.dropOffLocation || r.pickupLocation]
  );
  const proximityFleetIds = assignFleetsToRoutesByProximity(routeCoordsList, vehicleFleets);
  const assignedFleetIds = new Set<string>();

  const spawnFleetWavesForRoute = (
    route: ComputedRoute,
    fleet: VehicleFleet,
    idPrefix: string
  ) => {
    const pickup = pickupStates.find((p) => p.routeId === route.id);
    if (!pickup || fleet.count <= 0) return;

    assignedFleetIds.add(fleet.id);

    // Initial dispatch at t = 0 starts from the designated Vehicle Fleet staging depot location,
    // goes to the closest point on the evacuation route, and follows it from there to the pickup point
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
        id: `${idPrefix}-${route.id}-${fleet.id}-wave-${w}`,
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
  };

  activeStreetRoutes.forEach((route, rIdx) => {
    const preferredFleetId = route.vehicleFleetId || proximityFleetIds[rIdx];
    const fleet =
      vehicleFleets.find((f) => f.id === preferredFleetId) ||
      vehicleFleets[rIdx % Math.max(1, vehicleFleets.length)];
    if (!fleet || fleet.count <= 0) return;
    spawnFleetWavesForRoute(route, fleet, 'veh');
  });

  // Ensure any remaining active parking station (when there are more fleets than routes)
  // also dispatches its buses to its closest evacuation route and follows it to the pickup point
  if (activeStreetRoutes.length > 0) {
    vehicleFleets.forEach((fleet) => {
      if (fleet.count <= 0 || assignedFleetIds.has(fleet.id)) return;
      const closestMatch = findClosestEvacuationRoute(fleet.location, activeStreetRoutes);
      const targetRoute = closestMatch?.route || activeStreetRoutes[0];
      if (targetRoute) {
        spawnFleetWavesForRoute(targetRoute, fleet, 'veh-extra');
      }
    });
  }

  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = 0;
  });

  const totalRemainingAtSource = activeSources.reduce((acc, s) => acc + s.population, 0);

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
 * Reconcile twin state upon restarting or recalculating routes after mid-twin pause & topology/fleet edits:
 * - Rebuilds pickup states & internal clusters for remaining/modified/new Source Area populations
 * - Buses that remain on their originally assigned evacuation route continue along it
 * - Buses that are off any evacuation route (or whose assigned route was removed/reconfigured)
 *   direct themselves to the CLOSEST evacuation route and follow it from there
 */
export function reconcileTwinOnRestart(
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
  existingTelemetryStats?: TwinTelemetryStats,
  existingPickupStates?: PickupLocationState[],
  metroEvacuation?: MetroEvacuationOptions,
  existingClusters?: SourceInternalCluster[],
  rejoinRoutesToClosestEvacRoute?: Record<
    string,
    { route: ComputedRoute; coordinates: [number, number][] }
  >
): TwinStateSnapshot {
  const newLogs: string[] = [];

  const activeSources = sourceAreas.filter((s) => !s.disabled);
  const activeSourceIds = new Set(activeSources.map((s) => s.id));
  const activeTargetIds = new Set(targetAreas.filter((t) => !t.disabled).map((t) => t.id));

  // All calculated street evacuation routes between active Source and Target Areas remain active
  // concurrently alongside any Brussels Metro evacuation corridors
  const activeStreetRoutes =
    vehicleFleets.length > 0
      ? newRoutes.filter((r) => activeSourceIds.has(r.sourceId) && activeTargetIds.has(r.targetId))
      : [];

  // 1. Establish new Pickup Location states from recomputed street routes, preserving cumulative history if matched
  const pickupStates: PickupLocationState[] = activeStreetRoutes.map((r, idx) => {
    const label = r.pickupLabel || `Pickup Point #${idx + 1}`;
    const prevPickup = existingPickupStates?.find(
      (p) => p.routeId === r.id || (p.sourceId === r.sourceId && p.label === label)
    );
    const routeCoords =
      r.coordinates && r.coordinates.length >= 2
        ? r.coordinates
        : [r.pickupLocation, r.dropOffLocation || r.pickupLocation];
    return {
      id: `pickup-${r.id}`,
      routeId: r.id,
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      targetId: r.targetId,
      targetName: r.targetName,
      label,
      location: r.pickupLocation,
      dropOffLocation: r.dropOffLocation,
      routeCoords,
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

  // 2. Reconcile street vehicles (exclude old empty metro trains, keep loaded metro trains until offload):
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

    const isStillAtDepot =
      veh.progressMeters === 0 &&
      Boolean(fleet) &&
      turf.distance(
        [veh.currentPosition[1], veh.currentPosition[0]],
        [fleet!.location[1], fleet!.location[0]],
        { units: 'kilometers' }
      ) *
        1000 <=
        50;

    // Check if the bus is still on its originally assigned evacuation route (within 40m of the route polyline)
    const origRoute = activeStreetRoutes.find((r) => r.id === veh.assignedRouteId);
    const origSnap =
      origRoute && origRoute.coordinates && origRoute.coordinates.length >= 2
        ? findClosestPointOnPolyline(veh.currentPosition, origRoute.coordinates)
        : null;
    const isOnOrigEvacRoute =
      !isStillAtDepot &&
      origRoute !== undefined &&
      origSnap !== null &&
      origSnap.distanceMeters <= 40;

    // Find closest active evacuation route for off-route / depot vehicles
    const rejoinEntry = rejoinRoutesToClosestEvacRoute?.[veh.id];
    const closestRouteMatch = findClosestEvacuationRoute(
      isStillAtDepot && fleet ? fleet.location : veh.currentPosition,
      activeStreetRoutes
    );
    const selectedRoute = isOnOrigEvacRoute
      ? origRoute!
      : rejoinEntry?.route || closestRouteMatch?.route || defaultNextRoute || newRoutes[0];

    if (!selectedRoute && veh.currentOccupancy === 0) return;

    // CASE A: Running, waiting, or unloading vehicle carrying passengers (`currentOccupancy > 0`)
    if (veh.currentOccupancy > 0) {
      if (isOnOrigEvacRoute && origRoute && origSnap) {
        const origPickup =
          pickupStates.find((p) => p.routeId === origRoute.id) || pickupStates[0];
        if (!origPickup) return;

        const preserveUnloadingAtSameTarget =
          veh.status === 'unloading' && veh.targetId === origRoute.targetId;
        const remainingToTargetCoords = preserveUnloadingAtSameTarget
          ? veh.evacCoords
          : buildRouteSuffixToTarget(origRoute.coordinates, origSnap);
        const remainingToTargetDist = buildCumulativeDistances(remainingToTargetCoords);

        updatedVehicles.push({
          ...veh,
          capacityPerUnit: updatedCapPerUnit,
          maxCapacity: updatedMaxCap,
          loadUnloadTimePerPersonSeconds: updatedLoadUnloadSec,
          transitSpeedKmh: updatedTransitSpeedKmh,
          speedMps: updatedSpeedMps,
          occupancyByBehavior: veh.occupancyByBehavior
            ? { ...veh.occupancyByBehavior }
            : { compliant: veh.currentOccupancy, 'self-directed': 0, disoriented: 0 },
          status: preserveUnloadingAtSameTarget ? 'unloading' : 'to_target',
          waitingAtPickupSeconds: 0,
          loadingProgressRemainder: 0,
          progressMeters: preserveUnloadingAtSameTarget ? veh.progressMeters : 0,
          targetId: origRoute.targetId,
          targetName: origRoute.targetName,
          evacCoords: remainingToTargetCoords,
          evacCumulative: remainingToTargetDist.cumulative,
          assignedRouteId: origRoute.id,
          assignedPickupId: origPickup.id,
          sourceId: origRoute.sourceId,
          postOffloadEvacCoords: origRoute.coordinates,
          postOffloadTargetId: origRoute.targetId,
          postOffloadTargetName: origRoute.targetName,
          departureDelaySeconds: 0,
        });
        return;
      }

      // Off-route loaded bus: direct to the closest evacuation route and follow it to its Target Area
      // (or fallback to directRoutesToClosestTarget if no active street route exists)
      if (selectedRoute && selectedRoute.coordinates && selectedRoute.coordinates.length >= 2) {
        const snapOnClosest = findClosestPointOnPolyline(
          veh.currentPosition,
          selectedRoute.coordinates
        );
        const rejoinToTargetCoords =
          rejoinEntry && rejoinEntry.coordinates.length >= 2
            ? rejoinEntry.coordinates
            : dedupPolylineCoords([
                veh.currentPosition,
                ...buildRouteSuffixToTarget(selectedRoute.coordinates, snapOnClosest),
              ]);
        const rejoinDist = buildCumulativeDistances(rejoinToTargetCoords);
        const connectedPickup =
          pickupStates.find((p) => p.routeId === selectedRoute.id) || pickupStates[0];
        if (!connectedPickup) return;

        const preserveUnloadingAtSameTarget =
          veh.status === 'unloading' && veh.targetId === selectedRoute.targetId;

        if (!preserveUnloadingAtSameTarget) {
          newLogs.push(
            `Off-route loaded bus redirected: ${veh.fleetName} (${veh.currentOccupancy} pax) directed from [${veh.currentPosition[0].toFixed(4)}, ${veh.currentPosition[1].toFixed(4)}] to closest evacuation route ${selectedRoute.pickupLabel} -> "${selectedRoute.targetName}".`
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
            : { compliant: veh.currentOccupancy, 'self-directed': 0, disoriented: 0 },
          status: preserveUnloadingAtSameTarget ? 'unloading' : 'to_target',
          waitingAtPickupSeconds: 0,
          loadingProgressRemainder: 0,
          progressMeters: preserveUnloadingAtSameTarget ? veh.progressMeters : 0,
          targetId: selectedRoute.targetId,
          targetName: selectedRoute.targetName,
          evacCoords: preserveUnloadingAtSameTarget ? veh.evacCoords : rejoinToTargetCoords,
          evacCumulative: preserveUnloadingAtSameTarget
            ? veh.evacCumulative
            : rejoinDist.cumulative,
          assignedRouteId: selectedRoute.id,
          assignedPickupId: connectedPickup.id,
          sourceId: selectedRoute.sourceId,
          postOffloadEvacCoords: selectedRoute.coordinates,
          postOffloadTargetId: selectedRoute.targetId,
          postOffloadTargetName: selectedRoute.targetName,
          departureDelaySeconds: 0,
        });
        return;
      }

      const direct = directRoutesToClosestTarget[veh.id];
      const closestTarget =
        direct?.target || targetAreas.find((t) => !t.disabled) || targetAreas[0];
      const directCoords =
        direct && direct.coordinates.length >= 2
          ? direct.coordinates
          : [veh.currentPosition, getPolygonCentroid(closestTarget.polygon)];
      const directDist = buildCumulativeDistances(directCoords);
      const fallbackRoute = newRoutes[0];
      const fallbackPickup = pickupStates[0];
      if (!fallbackRoute || !fallbackPickup) return;

      updatedVehicles.push({
        ...veh,
        capacityPerUnit: updatedCapPerUnit,
        maxCapacity: updatedMaxCap,
        loadUnloadTimePerPersonSeconds: updatedLoadUnloadSec,
        transitSpeedKmh: updatedTransitSpeedKmh,
        speedMps: updatedSpeedMps,
        occupancyByBehavior: veh.occupancyByBehavior
          ? { ...veh.occupancyByBehavior }
          : { compliant: veh.currentOccupancy, 'self-directed': 0, disoriented: 0 },
        status: 'to_target',
        waitingAtPickupSeconds: 0,
        loadingProgressRemainder: 0,
        progressMeters: 0,
        targetId: closestTarget.id,
        targetName: closestTarget.name,
        evacCoords: directCoords,
        evacCumulative: directDist.cumulative,
        assignedRouteId: fallbackRoute.id,
        assignedPickupId: fallbackPickup.id,
        sourceId: fallbackRoute.sourceId,
        postOffloadEvacCoords: fallbackRoute.coordinates,
        postOffloadTargetId: fallbackRoute.targetId,
        postOffloadTargetName: fallbackRoute.targetName,
        departureDelaySeconds: 0,
      });
    } else {
      // CASE B: Empty vehicle (`currentOccupancy === 0`)
      if (!selectedRoute) return;
      const nextPickup = pickupStates.find((p) => p.routeId === selectedRoute.id);
      if (!nextPickup) return;

      // Preserve waiting_for_80_pct if the bus is already waiting at the pickup of its on-route corridor
      const distToSelectedPickupMeters =
        turf.distance(
          [veh.currentPosition[1], veh.currentPosition[0]],
          [selectedRoute.pickupLocation[1], selectedRoute.pickupLocation[0]],
          { units: 'kilometers' }
        ) * 1000;
      const preserveWaitingAtPickup =
        isOnOrigEvacRoute &&
        veh.status === 'waiting_for_80_pct' &&
        distToSelectedPickupMeters <= 35;

      let approachCoords: [number, number][];
      if (isStillAtDepot && fleet) {
        approachCoords = getDepotToPickupApproachCoords(selectedRoute, fleet);
      } else if (isOnOrigEvacRoute && origRoute && origSnap) {
        approachCoords = buildRouteSuffixToPickup(origRoute.coordinates, origSnap);
      } else if (rejoinEntry && rejoinEntry.coordinates.length >= 2) {
        approachCoords = rejoinEntry.coordinates;
        newLogs.push(
          `Off-route bus redirected: ${veh.fleetName} directed from [${veh.currentPosition[0].toFixed(4)}, ${veh.currentPosition[1].toFixed(4)}] to closest evacuation route ${selectedRoute.pickupLabel}.`
        );
      } else {
        approachCoords = getEmptyApproachAlongExistingRoute(selectedRoute, veh.currentPosition);
        if (!isStillAtDepot) {
          newLogs.push(
            `Off-route bus redirected: ${veh.fleetName} directed from [${veh.currentPosition[0].toFixed(4)}, ${veh.currentPosition[1].toFixed(4)}] to closest evacuation route ${selectedRoute.pickupLabel}.`
          );
        }
      }

      const approachDist = buildCumulativeDistances(approachCoords);
      const evacDist = buildCumulativeDistances(selectedRoute.coordinates);

      updatedVehicles.push({
        ...veh,
        capacityPerUnit: updatedCapPerUnit,
        maxCapacity: updatedMaxCap,
        loadUnloadTimePerPersonSeconds: updatedLoadUnloadSec,
        transitSpeedKmh: updatedTransitSpeedKmh,
        speedMps: updatedSpeedMps,
        occupancyByBehavior: createZeroBehaviorCounts(),
        status: preserveWaitingAtPickup ? 'waiting_for_80_pct' : 'to_pickup',
        waitingAtPickupSeconds: preserveWaitingAtPickup ? veh.waitingAtPickupSeconds : 0,
        loadingProgressRemainder: 0,
        loadingElapsedSeconds: 0,
        unloadingProgressRemainder: 0,
        unloadingElapsedSeconds: 0,
        unloadingInitialOccupancy: 0,
        progressMeters: preserveWaitingAtPickup ? approachDist.total : 0,
        currentPosition: preserveWaitingAtPickup
          ? selectedRoute.pickupLocation
          : approachCoords[0],
        assignedRouteId: selectedRoute.id,
        assignedPickupId: nextPickup.id,
        sourceId: selectedRoute.sourceId,
        targetId: selectedRoute.targetId,
        targetName: selectedRoute.targetName,
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords: selectedRoute.coordinates,
        evacCumulative: evacDist.cumulative,
        postOffloadEvacCoords: undefined,
        postOffloadTargetId: undefined,
        postOffloadTargetName: undefined,
        departureDelaySeconds: isStillAtDepot ? veh.departureDelaySeconds : 0,
      });
    }
  });

  // 3. Spawn vehicles for any NEWLY ADDED fleets — departing from their designated fleet staging location
  //    towards their closest evacuation route and following it to the pickup point
  const representedFleetIds = new Set(survivingVehicles.map((v) => v.fleetId));
  const newFleets = vehicleFleets.filter((f) => !representedFleetIds.has(f.id));

  newFleets.forEach((fleet, fIdx) => {
    const closestMatch = findClosestEvacuationRoute(fleet.location, activeStreetRoutes);
    const route =
      closestMatch?.route || activeStreetRoutes[fIdx % Math.max(1, activeStreetRoutes.length)];
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
      `Deployed new fleet "${fleet.name}" (${fleet.count} × ${fleet.type}, ${transitSpeedKmh} km/h, ${loadUnloadTimeSec}s/pax load/unload) via closest route ${route.pickupLabel} -> ${route.targetName}.`
    );
  });

  // 4. Append Brussels Metro Station Pickups and Metro Trains if enabled
  appendMetroPickupsAndTrains(
    pickupStates,
    updatedVehicles,
    metroEvacuation,
    existingPickupStates,
    newLogs
  );

  // 5. Reconcile or build clusters (dots) for each active Source Area:
  //    - If a Source Area's unboarded population was not manually edited while paused, preserve its existing
  //      moving and waiting/partially-boarded (<50) dots in place.
  //    - Otherwise (edited population or newly added Source Area), generate fresh 50-person dots (with <50 remainder dots).
  const clusters: SourceInternalCluster[] = [];
  activeSources.forEach((src) => {
    const targetPop = Math.max(0, Math.round(src.population));
    if (targetPop === 0) return;

    const existingSrcClusters = (existingClusters || []).filter(
      (c) =>
        c.sourceId === src.id &&
        (c.status === 'moving_in_zone' || c.status === 'waiting_at_pickup') &&
        c.headcount > 0
    );
    const existingUnboardedSum = existingSrcClusters.reduce((acc, c) => acc + c.headcount, 0);

    if (existingSrcClusters.length > 0 && existingUnboardedSum === targetPop) {
      const pickupsInSrc = pickupStates.filter((p) => p.sourceId === src.id);
      existingSrcClusters.forEach((c) => {
        if (c.status === 'waiting_at_pickup') {
          const matchedPickup =
            pickupsInSrc.find((p) => p.id === c.targetPickupId) ||
            pickupsInSrc.find(
              (p) =>
                turf.distance(
                  [p.location[1], p.location[0]],
                  [c.position[1], c.position[0]],
                  { units: 'kilometers' }
                ) *
                  1000 <=
                35
            );
          if (matchedPickup) {
            matchedPickup.waitingPopulation += c.headcount;
            matchedPickup.waitingByBehavior[c.behavior] += c.headcount;
            clusters.push({
              ...c,
              targetPickupId: matchedPickup.id,
              status: 'waiting_at_pickup',
            });
          } else {
            // Pickup point relocated due to topology edit -> walk from current position to the new pickup
            clusters.push({
              ...c,
              targetPickupId: null,
              status: 'moving_in_zone',
            });
          }
        } else {
          clusters.push({ ...c });
        }
      });
    } else {
      clusters.push(...buildClustersForSources([src]));
    }
  });

  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = existingTargetOccupancies[t.id] || 0;
  });

  const totalEvacuated = Object.values(targetOccupancies).reduce((acc, v) => acc + v, 0);
  const totalInTransit = updatedVehicles
    .filter((v) => v.status === 'to_target' || v.status === 'unloading')
    .reduce((acc, v) => acc + v.currentOccupancy, 0);
  const totalWaitingInQueues = pickupStates.reduce((acc, p) => acc + p.waitingPopulation, 0);
  const totalBoardingInVehicles = updatedVehicles
    .filter((v) => v.status === 'waiting_for_80_pct')
    .reduce((acc, v) => acc + v.currentOccupancy, 0);
  const totalMovingInZone = clusters
    .filter((c) => c.status === 'moving_in_zone')
    .reduce((acc, c) => acc + c.headcount, 0);
  const totalWaitingAtPickups = totalWaitingInQueues + totalBoardingInVehicles;
  const totalRemainingAtSource = totalMovingInZone + totalWaitingAtPickups;

  // Recompute telemetryStats preserving already evacuated + in-transit + remaining clusters
  const newClustersByBehavior = createZeroBehaviorCounts();
  clusters.forEach((c) => {
    newClustersByBehavior[c.behavior] += c.headcount;
  });

  const inTransitByBehavior = createZeroBehaviorCounts();
  updatedVehicles.forEach((v) => {
    if (v.currentOccupancy > 0 && v.occupancyByBehavior) {
      inTransitByBehavior.compliant += v.occupancyByBehavior.compliant;
      inTransitByBehavior['self-directed'] += v.occupancyByBehavior['self-directed'];
      inTransitByBehavior.disoriented += v.occupancyByBehavior.disoriented;
    }
  });

  const baseTelemetry = existingTelemetryStats || createInitialTelemetryStats(sourceAreas, clusters);
  const reconciledTelemetry: TwinTelemetryStats = {
    initialByBehavior: {
      compliant:
        baseTelemetry.evacuatedByBehavior.compliant +
        inTransitByBehavior.compliant +
        newClustersByBehavior.compliant,
      'self-directed':
        baseTelemetry.evacuatedByBehavior['self-directed'] +
        inTransitByBehavior['self-directed'] +
        newClustersByBehavior['self-directed'],
      disoriented:
        baseTelemetry.evacuatedByBehavior.disoriented +
        inTransitByBehavior.disoriented +
        newClustersByBehavior.disoriented,
    },
    evacuatedByBehavior: { ...baseTelemetry.evacuatedByBehavior },
    evacuatedPersonSecondsByBehavior: { ...baseTelemetry.evacuatedPersonSecondsByBehavior },
    pickupArrivedByBehavior: { ...baseTelemetry.pickupArrivedByBehavior },
    pickupArrivalPersonSecondsByBehavior: { ...baseTelemetry.pickupArrivalPersonSecondsByBehavior },
    totalCompletedVehicleTrips: baseTelemetry.totalCompletedVehicleTrips,
    evacuationTimeSeries: baseTelemetry.evacuationTimeSeries
      ? [...baseTelemetry.evacuationTimeSeries]
      : [{ timeSeconds: 0, evacuatedCount: 0 }],
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
    totalWaitingAtPickups,
  };
}

/**
 * Strictly enforce that a cluster's next position stays inside its initial designated Source Area polygon.
 * If `candidatePos` steps outside `srcTurfPoly`, attempts angular deflections along the interior boundary,
 * inward reflection toward `interiorTarget`, and fractional steps before falling back to `prevPos`.
 */
function ensurePointInsideSourcePolygon(
  prevPos: [number, number],
  candidatePos: [number, number],
  srcTurfPoly: ReturnType<typeof toTurfPolygon> | undefined,
  interiorTarget: [number, number]
): { position: [number, number]; bounced: boolean } {
  if (!srcTurfPoly) {
    return { position: candidatePos, bounced: false };
  }

  try {
    if (turf.booleanPointInPolygon(turf.point([candidatePos[1], candidatePos[0]]), srcTurfPoly)) {
      return { position: candidatePos, bounced: false };
    }

    const dLat = candidatePos[0] - prevPos[0];
    const dLng = candidatePos[1] - prevPos[1];
    const cosLat = Math.max(0.1, Math.cos((prevPos[0] * Math.PI) / 180));

    // 1. Try rotated deflections across a full 360° fan and multiple step scales with randomized left/right parity
    // so dots near sharp vertices or concave corners slide out smoothly instead of ping-ponging
    const stepLat = dLat;
    const stepLngScaled = dLng * cosLat;
    const parity = Math.random() < 0.5 ? 1 : -1;
    const baseAngles = [
      25 * parity,
      -25 * parity,
      50 * parity,
      -50 * parity,
      75 * parity,
      -75 * parity,
      105 * parity,
      -105 * parity,
      135 * parity,
      -135 * parity,
      160 * parity,
      -160 * parity,
      180,
    ];
    for (const scale of [0.95, 0.55, 1.35]) {
      for (const deg of baseAngles) {
        const rad = (deg * Math.PI) / 180;
        const c = Math.cos(rad);
        const s = Math.sin(rad);
        const rotLat = stepLat * c - stepLngScaled * s;
        const rotLng = (stepLat * s + stepLngScaled * c) / cosLat;
        const candLat = prevPos[0] + rotLat * scale;
        const candLng = prevPos[1] + rotLng * scale;
        if (turf.booleanPointInPolygon(turf.point([candLng, candLat]), srcTurfPoly)) {
          return { position: [candLat, candLng], bounced: true };
        }
      }
    }

    // 2. Try inward reflection with bias toward interiorTarget
    const reflLat =
      prevPos[0] - dLat * 0.65 + (interiorTarget[0] - prevPos[0]) * 0.18;
    const reflLng =
      prevPos[1] - dLng * 0.65 + (interiorTarget[1] - prevPos[1]) * 0.18;
    if (turf.booleanPointInPolygon(turf.point([reflLng, reflLat]), srcTurfPoly)) {
      return { position: [reflLat, reflLng], bounced: true };
    }

    // 3. Try fractional step along prevPos -> candidatePos or prevPos -> interiorTarget
    for (const alpha of [0.5, 0.25, 0.1]) {
      const subLat = prevPos[0] + dLat * alpha;
      const subLng = prevPos[1] + dLng * alpha;
      if (turf.booleanPointInPolygon(turf.point([subLng, subLat]), srcTurfPoly)) {
        return { position: [subLat, subLng], bounced: true };
      }
    }

    for (const beta of [0.08, 0.18, 0.32]) {
      const inLat = prevPos[0] + (interiorTarget[0] - prevPos[0]) * beta;
      const inLng = prevPos[1] + (interiorTarget[1] - prevPos[1]) * beta;
      if (turf.booleanPointInPolygon(turf.point([inLng, inLat]), srcTurfPoly)) {
        return { position: [inLat, inLng], bounced: true };
      }
    }

    // 4. Radial 16-direction escape probe around prevPos (10m..28m) biased toward interiorTarget
    // Guarantees a dot wedged in a tight corner vertex always finds an interior escape step
    const metersPerDegLat = 111320;
    const metersPerDegLng = Math.max(1000, 111320 * cosLat);
    const startAngleRad = Math.random() * Math.PI * 2;
    let bestEscape: [number, number] | null = null;
    let bestTargetDistSq = Infinity;
    for (const probeMeters of [12, 22, 35]) {
      for (let k = 0; k < 16; k++) {
        const theta = startAngleRad + (k * Math.PI * 2) / 16;
        const pLat = prevPos[0] + (Math.cos(theta) * probeMeters) / metersPerDegLat;
        const pLng = prevPos[1] + (Math.sin(theta) * probeMeters) / metersPerDegLng;
        if (turf.booleanPointInPolygon(turf.point([pLng, pLat]), srcTurfPoly)) {
          const distSq =
            (pLat - interiorTarget[0]) * (pLat - interiorTarget[0]) +
            (pLng - interiorTarget[1]) * (pLng - interiorTarget[1]) * cosLat * cosLat;
          if (distSq < bestTargetDistSq) {
            bestTargetDistSq = distSq;
            bestEscape = [pLat, pLng];
          }
        }
      }
      if (bestEscape) {
        return { position: bestEscape, bounced: true };
      }
    }
  } catch {
    // Fallback to prevPos below
  }

  return { position: prevPos, bounced: true };
}

/**
 * Compute a deterministic waiting position for a dot around its Pickup Location
 * (within a 5.5m–13.5m ring), guaranteed to remain inside the Source Area polygon.
 */
function computeWaitingDotPosition(
  clusterId: string,
  prevPos: [number, number],
  pickupLocation: [number, number],
  srcTurfPoly: ReturnType<typeof toTurfPolygon> | undefined,
  srcCentroid: [number, number]
): [number, number] {
  let hash = 0;
  for (let i = 0; i < clusterId.length; i++) {
    hash = (hash * 31 + clusterId.charCodeAt(i)) | 0;
  }
  const absHash = Math.abs(hash);
  const angleRad = ((absHash % 360) * Math.PI) / 180;
  const ringMeters = 5.5 + (absHash % 9); // 5.5m to 13.5m around pickup square

  const metersPerDegLat = 111320;
  const metersPerDegLng = Math.max(
    1000,
    111320 * Math.cos((pickupLocation[0] * Math.PI) / 180)
  );

  const candidateLat = pickupLocation[0] + (Math.cos(angleRad) * ringMeters) / metersPerDegLat;
  const candidateLng = pickupLocation[1] + (Math.sin(angleRad) * ringMeters) / metersPerDegLng;

  const ringAttempt = ensurePointInsideSourcePolygon(
    prevPos,
    [candidateLat, candidateLng],
    srcTurfPoly,
    srcCentroid
  );
  if (!ringAttempt.bounced) {
    return ringAttempt.position;
  }

  return ensurePointInsideSourcePolygon(
    prevPos,
    pickupLocation,
    srcTurfPoly,
    srcCentroid
  ).position;
}

/**
 * Deduct `boardedByBehavior` passengers from the `headcount` of dots currently waiting
 * (`status === 'waiting_at_pickup'`) at `pickupId` (or within `sourceId` as fallback).
 * Partial dots (`headcount < PEOPLE_PER_DOT`) are boarded first in FIFO order so a partially-boarded
 * dot finishes boarding before splitting the next 50-person dot; while `0 < headcount < 50`,
 * that dot remains waiting at the pickup for subsequent vehicles, and once `headcount === 0`
 * its status transitions to `'boarded'`.
 */
function deductBoardedFromWaitingClusters(
  clusters: SourceInternalCluster[],
  pickupId: string,
  sourceId: string,
  boardedByBehavior: BehaviorCounts
): void {
  const behaviors: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];

  behaviors.forEach((b) => {
    let rem = boardedByBehavior[b];
    if (rem <= 0) return;

    const candidates = clusters.filter(
      (c) =>
        c.status === 'waiting_at_pickup' &&
        c.targetPickupId === pickupId &&
        c.behavior === b &&
        c.headcount > 0
    );
    candidates.sort((a, bDot) => {
      const aPartial = a.headcount < PEOPLE_PER_DOT ? 0 : 1;
      const bPartial = bDot.headcount < PEOPLE_PER_DOT ? 0 : 1;
      return aPartial - bPartial;
    });

    for (const c of candidates) {
      if (rem <= 0) break;
      const take = Math.min(c.headcount, rem);
      c.headcount -= take;
      rem -= take;
      if (c.headcount <= 0) {
        c.headcount = 0;
        c.status = 'boarded';
      }
    }

    if (rem > 0) {
      const fallbackCandidates = clusters.filter(
        (c) =>
          c.status === 'waiting_at_pickup' &&
          (c.targetPickupId === pickupId || c.sourceId === sourceId) &&
          c.headcount > 0
      );
      for (const c of fallbackCandidates) {
        if (rem <= 0) break;
        const take = Math.min(c.headcount, rem);
        c.headcount -= take;
        rem -= take;
        if (c.headcount <= 0) {
          c.headcount = 0;
          c.status = 'boarded';
        }
      }
    }
  });
}

/**
 * Transfer `transferredByBehavior` waiting evacuees on `waiting_at_pickup` dots from `fromPickup` to `toPickup`
 * within the same Source Area, splitting a dot if only part of its headcount is transferred.
 */
function transferWaitingClustersBetweenPickups(
  clusters: SourceInternalCluster[],
  fromPickup: PickupLocationState,
  toPickup: PickupLocationState,
  transferredByBehavior: BehaviorCounts,
  srcTurfPoly: ReturnType<typeof toTurfPolygon> | undefined,
  srcCentroid: [number, number]
): void {
  const behaviors: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];

  behaviors.forEach((b) => {
    let rem = transferredByBehavior[b];
    if (rem <= 0) return;

    const candidates = clusters.filter(
      (c) =>
        c.status === 'waiting_at_pickup' &&
        c.targetPickupId === fromPickup.id &&
        c.behavior === b &&
        c.headcount > 0
    );
    candidates.sort((a, bDot) => {
      const aPartial = a.headcount < PEOPLE_PER_DOT ? 0 : 1;
      const bPartial = bDot.headcount < PEOPLE_PER_DOT ? 0 : 1;
      return aPartial - bPartial;
    });

    for (const c of candidates) {
      if (rem <= 0) break;
      if (c.headcount <= rem) {
        rem -= c.headcount;
        c.targetPickupId = toPickup.id;
        c.position = computeWaitingDotPosition(
          c.id,
          c.position,
          toPickup.location,
          srcTurfPoly,
          srcCentroid
        );
      } else {
        c.headcount -= rem;
        const splitId = `${c.id}-xfer-${toPickup.id}-${Date.now()}`;
        const splitPos = computeWaitingDotPosition(
          splitId,
          c.position,
          toPickup.location,
          srcTurfPoly,
          srcCentroid
        );
        clusters.push({
          ...c,
          id: splitId,
          headcount: rem,
          position: splitPos,
          targetPickupId: toPickup.id,
          status: 'waiting_at_pickup',
        });
        rem = 0;
      }
    }
  });
}

/**
 * Step twin forward by `deltaTwinSeconds` implementing:
 * 1. Compliant population moving immediately to closest pickup location (strictly within Source Area)
 * 2. Disoriented population diffusing inside Source Area via 2D Brownian motion with stochastic pickup-seeking drift
 *    and enhanced capture radius so they have a higher chance of reaching pickup points randomly
 * 3. Self-Directed population moving towards the closest pickup point in a random zig-zag pattern,
 *    sometimes walking in the opposite direction for very short periods of time, with adaptive corner escape
 *    so dots never get stuck in corners of Source Areas
 * 4. All populations always stay within their initial designated Source Areas
 * 5. Vehicles waiting at pickup locations until EITHER:
 *    - Occupancy reaches >= 80%, OR
 *    - Waiting time reaches 10 minutes (600s) (or Metro platform dispatch cadence for Metro Trains)
 *    Whichever happens first, departing to Target Area provided there is at least 1 passenger onboard!
 * 6. When vehicles depart empty to pick up population, they ALWAYS follow the existing computed route polyline!
 */
export function stepTwinState(
  prevState: TwinStateSnapshot,
  elapsedTwinSeconds: number,
  deltaTwinSeconds: number,
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  redAreas: RedArea[] = []
): TwinStateSnapshot {
  const newLogs: string[] = [];

  const prevTelemetry =
    prevState.telemetryStats || createInitialTelemetryStats(sourceAreas, prevState.clusters);
  const updatedTelemetry: TwinTelemetryStats = {
    initialByBehavior: { ...prevTelemetry.initialByBehavior },
    evacuatedByBehavior: { ...prevTelemetry.evacuatedByBehavior },
    evacuatedPersonSecondsByBehavior: { ...prevTelemetry.evacuatedPersonSecondsByBehavior },
    pickupArrivedByBehavior: { ...prevTelemetry.pickupArrivedByBehavior },
    pickupArrivalPersonSecondsByBehavior: { ...prevTelemetry.pickupArrivalPersonSecondsByBehavior },
    totalCompletedVehicleTrips: prevTelemetry.totalCompletedVehicleTrips,
    evacuationTimeSeries: prevTelemetry.evacuationTimeSeries
      ? [...prevTelemetry.evacuationTimeSeries]
      : [{ timeSeconds: 0, evacuatedCount: 0 }],
  };

  const pickupMap = new Map<string, PickupLocationState>();
  prevState.pickupStates.forEach((p) => {
    const waitingByBeh = p.waitingByBehavior
      ? { ...p.waitingByBehavior }
      : createZeroBehaviorCounts();
    const waitPersonSec = p.passengerWaitPersonSecondsByBehavior
      ? { ...p.passengerWaitPersonSecondsByBehavior }
      : createZeroBehaviorCounts();
    waitPersonSec.compliant += (waitingByBeh.compliant || 0) * deltaTwinSeconds;
    waitPersonSec['self-directed'] += (waitingByBeh['self-directed'] || 0) * deltaTwinSeconds;
    waitPersonSec.disoriented += (waitingByBeh.disoriented || 0) * deltaTwinSeconds;

    pickupMap.set(p.id, {
      ...p,
      waitingByBehavior: waitingByBeh,
      boardedByBehavior: p.boardedByBehavior
        ? { ...p.boardedByBehavior }
        : createZeroBehaviorCounts(),
      evacuatedByBehavior: p.evacuatedByBehavior
        ? { ...p.evacuatedByBehavior }
        : createZeroBehaviorCounts(),
      arrivedByBehavior: p.arrivedByBehavior
        ? { ...p.arrivedByBehavior }
        : createZeroBehaviorCounts(),
      arrivedPersonSecondsByBehavior: p.arrivedPersonSecondsByBehavior
        ? { ...p.arrivedPersonSecondsByBehavior }
        : createZeroBehaviorCounts(),
      passengerWaitPersonSecondsByBehavior: waitPersonSec,
      inVehiclePersonSecondsByBehavior: p.inVehiclePersonSecondsByBehavior
        ? { ...p.inVehiclePersonSecondsByBehavior }
        : createZeroBehaviorCounts(),
      evacuatedPersonSecondsByBehavior: p.evacuatedPersonSecondsByBehavior
        ? { ...p.evacuatedPersonSecondsByBehavior }
        : createZeroBehaviorCounts(),
      boardingVehicleInfo: undefined,
    });
  });

  const sourceMap = new Map<string, SourceArea>();
  const sourceTurfPolyMap = new Map<string, ReturnType<typeof toTurfPolygon>>();
  const sourceCentroidMap = new Map<string, [number, number]>();
  sourceAreas.forEach((s) => {
    sourceMap.set(s.id, s);
    sourceCentroidMap.set(s.id, getPolygonCentroid(s.polygon));
    if (s.polygon && s.polygon.length >= 3) {
      try {
        sourceTurfPolyMap.set(s.id, toTurfPolygon(s.polygon));
      } catch {
        // Ignore invalid polygon
      }
    }
  });

  // Speed of population groups moving inside Source Area toward pickup points: 5 km/h (1.3889 m/s)
  const walkSpeedMetersPerSec = kmhToMps(5);

  // --- STEP 1: Move internal Source Area crowd clusters ---
  const updatedClusters: SourceInternalCluster[] = prevState.clusters.map((cluster) => {
    if (cluster.status !== 'moving_in_zone' || cluster.headcount <= 0) {
      return { ...cluster };
    }

    const srcTurfPoly = sourceTurfPolyMap.get(cluster.sourceId);
    const srcCentroid = sourceCentroidMap.get(cluster.sourceId) || cluster.position;
    const allPickupsInZone = Array.from(pickupMap.values()).filter(
      (p) => p.sourceId === cluster.sourceId
    );

    if (allPickupsInZone.length === 0) return { ...cluster };

    // Consider all active Pickup Points inside the Source Area (both street Blue Square pickups
    // and Brussels Metro Station pickups) so clusters walk to their closest available pickup
    const pickupsInZone = allPickupsInZone;

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
      if (closest.pickup.arrivedByBehavior) {
        closest.pickup.arrivedByBehavior[cluster.behavior] += cluster.headcount;
      }
      if (closest.pickup.arrivedPersonSecondsByBehavior) {
        closest.pickup.arrivedPersonSecondsByBehavior[cluster.behavior] +=
          cluster.headcount * elapsedTwinSeconds;
      }
      updatedTelemetry.pickupArrivedByBehavior[cluster.behavior] += cluster.headcount;
      updatedTelemetry.pickupArrivalPersonSecondsByBehavior[cluster.behavior] +=
        cluster.headcount * elapsedTwinSeconds;

      const safeArrivalPos = computeWaitingDotPosition(
        cluster.id,
        cluster.position,
        closest.pickup.location,
        srcTurfPoly,
        srcCentroid
      );

      return {
        ...cluster,
        position: safeArrivalPos,
        status: 'waiting_at_pickup' as const,
        targetPickupId: closest.pickup.id,
      };
    }

    // --- BEHAVIOR 1: COMPLIANT ---
    // Immediately go straight to the closest pickup location at 5 km/h (always remaining inside the Source Area)
    if (cluster.behavior === 'compliant') {
      const stepDist = walkSpeedMetersPerSec * deltaTwinSeconds;
      const ratio = Math.min(1.0, stepDist / Math.max(1, closest.distMeters));
      const rawLat =
        cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * ratio;
      const rawLng =
        cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * ratio;

      const { position: safePos } = ensurePointInsideSourcePolygon(
        cluster.position,
        [rawLat, rawLng],
        srcTurfPoly,
        closest.pickup.location
      );

      return {
        ...cluster,
        position: safePos,
        targetPickupId: closest.pickup.id,
      };
    }

    // --- BEHAVIOR 2: DISORIENTED (2D BROWNIAN MOTION WITH ENHANCED PICKUP REACHABILITY AT 5 KM/H) ---
    // Diffuse via 2D Brownian motion combined with a stochastic radial pull toward pickup points and an
    // expanded capture radius at 5 km/h walking speed.
    if (cluster.behavior === 'disoriented') {
      const captureDistMeters = closest.pickup.isMetro ? 160.0 : 135.0;
      if (closest.distMeters <= captureDistMeters) {
        const stepDist = walkSpeedMetersPerSec * deltaTwinSeconds;
        const ratio = Math.min(1.0, stepDist / Math.max(1, closest.distMeters));
        const rawLat =
          cluster.position[0] + (closest.pickup.location[0] - cluster.position[0]) * ratio;
        const rawLng =
          cluster.position[1] + (closest.pickup.location[1] - cluster.position[1]) * ratio;

        const { position: safePos } = ensurePointInsideSourcePolygon(
          cluster.position,
          [rawLat, rawLng],
          srcTurfPoly,
          closest.pickup.location
        );

        return {
          ...cluster,
          position: safePos,
          targetPickupId: closest.pickup.id,
        };
      } else {
        // Box-Muller transform for independent standard normal N(0, 1) Gaussian variates
        const u1 = Math.max(1e-7, Math.random());
        const u2 = Math.random();
        const mag = Math.sqrt(-2.0 * Math.log(u1));
        const zNorth = mag * Math.cos(2.0 * Math.PI * u2);
        const zEast = mag * Math.sin(2.0 * Math.PI * u2);

        const metersPerDegLat = 111320;
        const metersPerDegLng = Math.max(
          1000,
          111320 * Math.cos((cluster.position[0] * Math.PI) / 180)
        );

        // Combine random Brownian direction with stochastic radial pull toward pickup point,
        // normalized to move at walkSpeedMetersPerSec (5 km/h)
        const randomPickupTarget =
          pickupsWithDist.length > 1 && Math.random() < 0.25
            ? pickupsWithDist[Math.floor(Math.random() * pickupsWithDist.length)]
            : closest;
        const toTargetNorth =
          (randomPickupTarget.pickup.location[0] - cluster.position[0]) * metersPerDegLat;
        const toTargetEast =
          (randomPickupTarget.pickup.location[1] - cluster.position[1]) * metersPerDegLng;
        const toTargetNorm = Math.max(1, Math.hypot(toTargetNorth, toTargetEast));
        const unitDriftNorth = toTargetNorth / toTargetNorm;
        const unitDriftEast = toTargetEast / toTargetNorm;

        const randomDriftWeight = 0.45 + Math.random() * 0.55;
        const rawVecNorth = zNorth + unitDriftNorth * randomDriftWeight;
        const rawVecEast = zEast + unitDriftEast * randomDriftWeight;
        const rawVecNorm = Math.max(1e-6, Math.hypot(rawVecNorth, rawVecEast));

        const stepDistMeters = Math.min(
          walkSpeedMetersPerSec * deltaTwinSeconds,
          closest.distMeters
        );
        const dNorthMeters = (rawVecNorth / rawVecNorm) * stepDistMeters;
        const dEastMeters = (rawVecEast / rawVecNorm) * stepDistMeters;

        const candidateLat = cluster.position[0] + dNorthMeters / metersPerDegLat;
        const candidateLng = cluster.position[1] + dEastMeters / metersPerDegLng;

        const { position: safePos } = ensurePointInsideSourcePolygon(
          cluster.position,
          [candidateLat, candidateLng],
          srcTurfPoly,
          closest.pickup.location
        );

        return {
          ...cluster,
          position: safePos,
          targetPickupId: closest.pickup.id,
        };
      }
    }

    // --- BEHAVIOR 3: SELF-DIRECTED (RANDOM ZIG-ZAG TOWARDS CLOSEST PICKUP WITH CORNER-ESCAPE RANDOMNESS AT 5 KM/H) ---
    // Move towards the closest pickup point in a random zig-zag pattern at 5 km/h, sometimes walking in the
    // opposite direction for very short periods of time, while always staying within the Source Area
    // and adapting heading when encountering polygon boundaries/corners so dots never get stuck in corners.
    if (cluster.behavior === 'self-directed') {
      const metersPerDegLat = 111320;
      const metersPerDegLng = Math.max(
        1000,
        111320 * Math.cos((cluster.position[0] * Math.PI) / 180)
      );

      const toPickupNorth =
        (closest.pickup.location[0] - cluster.position[0]) * metersPerDegLat;
      const toPickupEast =
        (closest.pickup.location[1] - cluster.position[1]) * metersPerDegLng;
      const targetBearingRad = Math.atan2(toPickupEast, toPickupNorth);

      let zigZagSide: 1 | -1 = cluster.zigZagSide ?? 1;
      let zigZagTimerSeconds = (cluster.zigZagTimerSeconds ?? 0) - deltaTwinSeconds;
      let zigZagAngleOffsetRad =
        cluster.zigZagAngleOffsetRad ?? zigZagSide * ((38 * Math.PI) / 180);
      let isReversingBrief = Boolean(cluster.isReversingBrief);

      if (zigZagTimerSeconds <= 0) {
        // Switch lateral zig-zag tack (left <-> right)
        zigZagSide = zigZagSide === 1 ? -1 : 1;

        // Sometimes (~12% of legs when not already reversing and >35m from pickup),
        // walk in the opposite direction (away from pickup) for a very short period (1.2s to 2.4s)
        if (!isReversingBrief && closest.distMeters > 35 && Math.random() < 0.12) {
          isReversingBrief = true;
          zigZagTimerSeconds = 1.2 + Math.random() * 1.2;
          const revCantRad = zigZagSide * (((15 + Math.random() * 30) * Math.PI) / 180);
          zigZagAngleOffsetRad = Math.PI + revCantRad;
        } else {
          isReversingBrief = false;
          zigZagTimerSeconds = 3.2 + Math.random() * 4.5;
          const tackAngleDeg = 22 + Math.random() * 28; // 22 deg to 50 deg zig-zag tack
          zigZagAngleOffsetRad = zigZagSide * ((tackAngleDeg * Math.PI) / 180);
        }
      }

      // Damp lateral offset when close (<28m) so the zig-zag converges reliably into the pickup
      const effectiveOffsetRad =
        closest.distMeters <= 28 && !isReversingBrief
          ? zigZagAngleOffsetRad * 0.35
          : zigZagAngleOffsetRad;

      // Add organic random angular jitter on each step
      const stepJitterRad = (Math.random() - 0.5) * 0.32;
      const headingRad = targetBearingRad + effectiveOffsetRad + stepJitterRad;

      const stepDistMeters = walkSpeedMetersPerSec * deltaTwinSeconds;
      const dNorthMeters = stepDistMeters * Math.cos(headingRad);
      const dEastMeters = stepDistMeters * Math.sin(headingRad);

      const candidateLat = cluster.position[0] + dNorthMeters / metersPerDegLat;
      const candidateLng = cluster.position[1] + dEastMeters / metersPerDegLng;

      // Use a randomized blend of pickup location and centroid as the interior reference when bouncing
      const bounceBlend = 0.55 + Math.random() * 0.35;
      const targetRef: [number, number] = [
        closest.pickup.location[0] * bounceBlend + srcCentroid[0] * (1 - bounceBlend),
        closest.pickup.location[1] * bounceBlend + srcCentroid[1] * (1 - bounceBlend),
      ];
      const { position: safePos, bounced } = ensurePointInsideSourcePolygon(
        cluster.position,
        [candidateLat, candidateLng],
        srcTurfPoly,
        targetRef
      );

      if (bounced) {
        // Instead of deterministically flipping to +/-38 deg (which ping-pongs between two walls of a corner),
        // align the next tack with the actual interior escape direction that succeeded, plus random angular jitter
        isReversingBrief = false;
        const actualNorth = (safePos[0] - cluster.position[0]) * metersPerDegLat;
        const actualEast = (safePos[1] - cluster.position[1]) * metersPerDegLng;
        const actualMoveMeters = Math.hypot(actualNorth, actualEast);

        if (actualMoveMeters > 0.25) {
          const actualBearingRad = Math.atan2(actualEast, actualNorth);
          let deltaRad = actualBearingRad - targetBearingRad;
          while (deltaRad > Math.PI) deltaRad -= Math.PI * 2;
          while (deltaRad < -Math.PI) deltaRad += Math.PI * 2;
          const escapeJitterRad = ((Math.random() - 0.5) * 40 * Math.PI) / 180;
          zigZagAngleOffsetRad = deltaRad * 0.75 + escapeJitterRad;
          zigZagSide = zigZagAngleOffsetRad >= 0 ? 1 : -1;
        } else {
          // Random full-range escape angle if displacement was minimal
          zigZagSide = Math.random() < 0.5 ? 1 : -1;
          zigZagAngleOffsetRad = ((Math.random() * 140 - 70) * Math.PI) / 180;
        }
        zigZagTimerSeconds = 3.5 + Math.random() * 3.0;
      }

      return {
        ...cluster,
        position: safePos,
        zigZagSide,
        zigZagTimerSeconds,
        zigZagAngleOffsetRad,
        isReversingBrief,
        targetPickupId: closest.pickup.id,
      };
    }

    return { ...cluster };
  });

  // Calculate remaining moving evacuees in a Source Area
  const getMovingInSource = (sourceId: string): number => {
    return updatedClusters
      .filter((c) => c.sourceId === sourceId && c.status === 'moving_in_zone')
      .reduce((acc, c) => acc + c.headcount, 0);
  };

  // Check whether any moving clusters in the pickup's Source Area are walking toward this pickup
  const hasClustersWalkingToPickup = (pickupObj: PickupLocationState): boolean => {
    return updatedClusters.some(
      (c) =>
        c.sourceId === pickupObj.sourceId &&
        c.status === 'moving_in_zone' &&
        c.headcount > 0 &&
        (!c.targetPickupId || c.targetPickupId === pickupObj.id)
    );
  };

  const updatedTargetOccupancies = { ...prevState.targetOccupancies };

  // Reassign an empty vehicle whose original pickup/route has no more evacuees randomly
  // to another compatible pickup point with evacuees still waiting (or moving toward it).
  // Street vehicles are only reassigned to street pickups; Metro trains are only reassigned
  // to Metro station pickups and travel strictly along STIB Brussels Metro lines.
  const reassignEmptyVehicleOrComplete = (
    veh: ActiveVehicleUnit,
    requireUnreservedIfCurrentHasQueue = false
  ): ActiveVehicleUnit => {
    const compatiblePickups = Array.from(pickupMap.values()).filter(
      (p) => Boolean(p.isMetro) === Boolean(veh.isMetro) && p.id !== veh.assignedPickupId
    );

    const getReservedAtPickup = (pickupId: string): number =>
      prevState.vehicles
        .filter(
          (v) =>
            v.id !== veh.id &&
            v.assignedPickupId === pickupId &&
            v.status === 'waiting_for_80_pct'
        )
        .reduce((acc, v) => acc + Math.max(0, v.maxCapacity - v.currentOccupancy), 0);

    const waitingWithUnreserved = compatiblePickups.filter(
      (p) => p.waitingPopulation > getReservedAtPickup(p.id)
    );
    const waitingAny = compatiblePickups.filter((p) => p.waitingPopulation > 0);
    const movingTowards = compatiblePickups.filter((p) => hasClustersWalkingToPickup(p));

    let candidates: PickupLocationState[] = [];
    if (waitingWithUnreserved.length > 0) {
      candidates = waitingWithUnreserved;
    } else if (!requireUnreservedIfCurrentHasQueue && waitingAny.length > 0) {
      candidates = waitingAny;
    } else if (movingTowards.length > 0) {
      candidates = movingTowards;
    }

    if (candidates.length === 0) {
      if (requireUnreservedIfCurrentHasQueue) {
        return veh;
      }
      return {
        ...veh,
        status: 'completed' as const,
      };
    }

    const nextPickup = candidates[Math.floor(Math.random() * candidates.length)];
    const nextEvacCoords: [number, number][] =
      nextPickup.routeCoords && nextPickup.routeCoords.length >= 2
        ? nextPickup.routeCoords
        : [nextPickup.location, nextPickup.dropOffLocation || nextPickup.location];
    const nextEvacDist = buildCumulativeDistances(nextEvacCoords);

    let approachCoords: [number, number][];
    if (veh.isMetro) {
      const metroApproach = computeMetroTrackBetweenPositions(
        veh.currentPosition,
        nextPickup.location,
        nextPickup.metroStationName
      );
      approachCoords = metroApproach.coordinates;
    } else {
      const snap = findClosestPointOnPolyline(veh.currentPosition, nextEvacCoords);
      const pathToSnap = computeShortestCollisionFreePath(
        veh.currentPosition,
        snap.point,
        redAreas
      );
      const suffixToPickup = buildRouteSuffixToPickup(nextEvacCoords, snap);
      approachCoords = dedupPolylineCoords([...pathToSnap, ...suffixToPickup]);
      if (approachCoords.length < 2) {
        approachCoords = [veh.currentPosition, nextPickup.location];
      }
    }

    const approachDist = buildCumulativeDistances(approachCoords);
    const prevPickup = pickupMap.get(veh.assignedPickupId);
    const prevLabel = prevPickup ? prevPickup.label : veh.assignedPickupId;

    newLogs.push(
      `🔄 ${veh.fleetName} reassigned from completed ${prevLabel} -> ${nextPickup.label} (${nextPickup.waitingPopulation} waiting, route -> ${nextPickup.targetName}).`
    );

    const updatedBase: ActiveVehicleUnit = {
      ...veh,
      assignedRouteId: nextPickup.routeId,
      assignedPickupId: nextPickup.id,
      sourceId: nextPickup.sourceId,
      targetId: nextPickup.targetId,
      targetName: nextPickup.targetName,
      evacCoords: nextEvacCoords,
      evacCumulative: nextEvacDist.cumulative,
      waitingAtPickupSeconds: 0,
      loadingProgressRemainder: 0,
      loadingElapsedSeconds: 0,
      unloadingProgressRemainder: 0,
      unloadingElapsedSeconds: 0,
      unloadingInitialOccupancy: 0,
      progressMeters: 0,
      postOffloadEvacCoords: undefined,
      postOffloadTargetId: undefined,
      postOffloadTargetName: undefined,
      reassignmentCount: (veh.reassignmentCount || 0) + 1,
      ...(veh.isMetro
        ? {
            metroLine: nextPickup.metroLine || veh.metroLine,
            metroColor: nextPickup.metroColor || veh.metroColor,
            sourceStationName: nextPickup.metroStationName || veh.sourceStationName,
            targetStationName: nextPickup.metroTargetStationName || veh.targetStationName,
          }
        : {}),
    };

    if (approachDist.total <= 5) {
      return {
        ...updatedBase,
        status: 'waiting_for_80_pct' as const,
        currentPosition: nextPickup.location,
        approachCoords: [nextPickup.location, nextPickup.location],
        approachCumulative: [0, 0],
      };
    }

    return {
      ...updatedBase,
      status: 'to_pickup' as const,
      currentPosition: approachCoords[0],
      approachCoords,
      approachCumulative: approachDist.cumulative,
    };
  };

  // Helper to transition an empty vehicle after completing unloading at a Target Shelter
  const finalizeEmptyVehicleAfterUnload = (veh: ActiveVehicleUnit): ActiveVehicleUnit => {
    updatedTelemetry.totalCompletedVehicleTrips += 1;

    // If this vehicle was diverted mid-twin to the closest Target Area and has a post-offload recomputed route,
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
      totalTripsCompleted: (veh.totalTripsCompleted || 0) + 1,
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
    const assignedStillHasEvacuees =
      Boolean(assignedPickup) &&
      (assignedPickup!.waitingPopulation > 0 || hasClustersWalkingToPickup(assignedPickup!));

    if (assignedStillHasEvacuees) {
      return {
        ...offloadedVeh,
        status: 'to_pickup' as const,
        approachCoords: returnCoords,
        approachCumulative: returnDist.cumulative,
      };
    } else {
      return reassignEmptyVehicleOrComplete(offloadedVeh);
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
      deliveredByBehavior: rawVeh.deliveredByBehavior
        ? { ...rawVeh.deliveredByBehavior }
        : createZeroBehaviorCounts(),
    };

    if (veh.status === 'completed') {
      const hasAnyCompatibleWork = Array.from(pickupMap.values()).some(
        (p) =>
          Boolean(p.isMetro) === Boolean(veh.isMetro) &&
          (p.waitingPopulation > 0 || hasClustersWalkingToPickup(p))
      );
      if (!hasAnyCompatibleWork) return veh;
      return reassignEmptyVehicleOrComplete(veh);
    }
    if (elapsedTwinSeconds < veh.departureDelaySeconds) return veh;

    const pickup = pickupMap.get(veh.assignedPickupId);
    if (!pickup) return reassignEmptyVehicleOrComplete(veh);

    // Accumulate in-vehicle person-seconds for passengers already onboard this vehicle
    if (veh.currentOccupancy > 0 && pickup.inVehiclePersonSecondsByBehavior) {
      pickup.inVehiclePersonSecondsByBehavior.compliant +=
        (veh.occupancyByBehavior.compliant || 0) * deltaTwinSeconds;
      pickup.inVehiclePersonSecondsByBehavior['self-directed'] +=
        (veh.occupancyByBehavior['self-directed'] || 0) * deltaTwinSeconds;
      pickup.inVehiclePersonSecondsByBehavior.disoriented +=
        (veh.occupancyByBehavior.disoriented || 0) * deltaTwinSeconds;
    }

    const loadUnloadSecPerPerson = Math.max(0, veh.loadUnloadTimePerPersonSeconds ?? 2);

    // Account for exact active time within tick if vehicle just passed its departureDelaySeconds
    const effectiveDeltaSec =
      veh.progressMeters === 0 && veh.status === 'to_pickup' && veh.departureDelaySeconds > 0
        ? Math.min(deltaTwinSeconds, Math.max(0, elapsedTwinSeconds - veh.departureDelaySeconds))
        : deltaTwinSeconds;

    // STATE A: Driving empty along existing route TO Pickup Location (Blue Square or Metro Station) at configured transitSpeedKmh
    if (veh.status === 'to_pickup') {
      // If the currently assigned pickup has no more evacuees waiting or walking toward it,
      // immediately reassign the empty vehicle to another compatible pickup that still needs service
      if (pickup.waitingPopulation === 0 && !hasClustersWalkingToPickup(pickup)) {
        return reassignEmptyVehicleOrComplete(veh);
      }

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
          totalDrivingSeconds: (veh.totalDrivingSeconds || 0) + driveTimeUsedSec,
          totalWaitingSeconds: (veh.totalWaitingSeconds || 0) + leftoverWaitSec,
          totalDistanceTraveledMeters:
            (veh.totalDistanceTraveledMeters || 0) + remainingDistToPickup,
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
        totalDrivingSeconds: (veh.totalDrivingSeconds || 0) + effectiveDeltaSec,
        totalDistanceTraveledMeters: (veh.totalDistanceTraveledMeters || 0) + stepMeters,
        currentPosition: pos,
      };
    }

    // STATE B: At Blue Square Pickup Location (or Metro Station) — Board waiting evacuees accounting for per-person loading time
    // & WAIT UNTIL: (1) Occupancy >= 80%, OR (2) Waiting time >= 10 minutes (600 seconds) (or Metro platform cadence)
    // Whichever happens first, depart to Target Area IF there is at least 1 passenger!
    if (veh.status === 'waiting_for_80_pct') {
      const nextWaitSeconds = veh.waitingAtPickupSeconds + deltaTwinSeconds;
      veh.totalWaitingSeconds = (veh.totalWaitingSeconds || 0) + deltaTwinSeconds;

      const reservedAhead = reservedQueueByPickup.get(pickup.id) || 0;
      const spaceNeeded = veh.maxCapacity - veh.currentOccupancy;

      // Pool waiting evacuees across sibling corridors at the same physical Metro station,
      // or draw excess unreserved evacuees from other pickups in the same Source Area when
      // all clusters have reached a pickup (or when no clusters are walking toward this pickup).
      if (spaceNeeded > Math.max(0, pickup.waitingPopulation - reservedAhead)) {
        const movingInSource = getMovingInSource(veh.sourceId);
        const hasClustersWalkingToThisPickup = hasClustersWalkingToPickup(pickup);

        for (const otherPickup of pickupMap.values()) {
          const currentAvail = Math.max(0, pickup.waitingPopulation - reservedAhead);
          const deficit = spaceNeeded - currentAvail;
          if (deficit <= 0) break;
          if (
            otherPickup.sourceId === veh.sourceId &&
            otherPickup.id !== pickup.id &&
            otherPickup.waitingPopulation > 0
          ) {
            const isSameMetroStation = Boolean(
              pickup.isMetro &&
                otherPickup.isMetro &&
                pickup.metroStationName &&
                pickup.metroStationName === otherPickup.metroStationName
            );

            // Calculate how many waiting evacuees at otherPickup are needed by vehicles currently boarding there
            const reservedAtOther = prevState.vehicles
              .filter(
                (v) =>
                  v.id !== veh.id &&
                  v.assignedPickupId === otherPickup.id &&
                  v.status === 'waiting_for_80_pct'
              )
              .reduce((acc, v) => acc + Math.max(0, v.maxCapacity - v.currentOccupancy), 0);

            const unreservedAtOther = isSameMetroStation
              ? Math.max(
                  0,
                  otherPickup.waitingPopulation - (reservedQueueByPickup.get(otherPickup.id) || 0)
                )
              : Math.max(0, otherPickup.waitingPopulation - reservedAtOther);

            const canTransferFromOther =
              isSameMetroStation ||
              movingInSource === 0 ||
              (!hasClustersWalkingToThisPickup && pickup.waitingPopulation === 0);

            if (canTransferFromOther && unreservedAtOther > 0) {
              const transferCount = Math.min(deficit, unreservedAtOther);
              if (transferCount > 0) {
                const transferredByBehavior = allocateBoardedByBehavior(
                  otherPickup.waitingByBehavior,
                  transferCount
                );
                otherPickup.waitingPopulation -= transferCount;
                otherPickup.waitingByBehavior.compliant = Math.max(
                  0,
                  otherPickup.waitingByBehavior.compliant - transferredByBehavior.compliant
                );
                otherPickup.waitingByBehavior['self-directed'] = Math.max(
                  0,
                  otherPickup.waitingByBehavior['self-directed'] -
                    transferredByBehavior['self-directed']
                );
                otherPickup.waitingByBehavior.disoriented = Math.max(
                  0,
                  otherPickup.waitingByBehavior.disoriented - transferredByBehavior.disoriented
                );

                pickup.waitingPopulation += transferCount;
                pickup.waitingByBehavior.compliant += transferredByBehavior.compliant;
                pickup.waitingByBehavior['self-directed'] += transferredByBehavior['self-directed'];
                pickup.waitingByBehavior.disoriented += transferredByBehavior.disoriented;

                transferWaitingClustersBetweenPickups(
                  updatedClusters,
                  otherPickup,
                  pickup,
                  transferredByBehavior,
                  sourceTurfPolyMap.get(veh.sourceId),
                  sourceCentroidMap.get(veh.sourceId) || pickup.location
                );
              }
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
            (deltaTwinSeconds * activeLoadingUnits) / loadUnloadSecPerPerson +
            (veh.loadingProgressRemainder || 0);
          boardedNow = Math.min(
            spaceNeeded,
            availableQueueForVeh,
            Math.floor(exactBoarded)
          );
          veh.loadingProgressRemainder = exactBoarded - boardedNow;
          veh.loadingElapsedSeconds = (veh.loadingElapsedSeconds || 0) + deltaTwinSeconds;
        }

        if (boardedNow > 0) {
          const boardedBreakdown = allocateBoardedByBehavior(
            pickup.waitingByBehavior,
            boardedNow
          );

          veh.currentOccupancy += boardedNow;
          veh.totalPassengersBoarded = (veh.totalPassengersBoarded || 0) + boardedNow;
          veh.occupancyByBehavior.compliant += boardedBreakdown.compliant;
          veh.occupancyByBehavior['self-directed'] += boardedBreakdown['self-directed'];
          veh.occupancyByBehavior.disoriented += boardedBreakdown.disoriented;

          pickup.waitingPopulation -= boardedNow;
          pickup.waitingByBehavior.compliant = Math.max(
            0,
            pickup.waitingByBehavior.compliant - boardedBreakdown.compliant
          );
          pickup.waitingByBehavior['self-directed'] = Math.max(
            0,
            pickup.waitingByBehavior['self-directed'] - boardedBreakdown['self-directed']
          );
          pickup.waitingByBehavior.disoriented = Math.max(
            0,
            pickup.waitingByBehavior.disoriented - boardedBreakdown.disoriented
          );

          pickup.totalBoardedCount += boardedNow;
          pickup.boardedByBehavior.compliant += boardedBreakdown.compliant;
          pickup.boardedByBehavior['self-directed'] += boardedBreakdown['self-directed'];
          pickup.boardedByBehavior.disoriented += boardedBreakdown.disoriented;

          deductBoardedFromWaitingClusters(
            updatedClusters,
            pickup.id,
            veh.sourceId,
            boardedBreakdown
          );
        }
      } else {
        veh.loadingProgressRemainder = 0;
      }

      const hasAtLeastOnePassenger = veh.currentOccupancy >= 1;
      const occupancyRatio = veh.currentOccupancy / Math.max(1, veh.maxCapacity);
      const remainingQueueForVeh = Math.max(0, pickup.waitingPopulation - reservedAhead);
      const anyClustersWalkingHere = hasClustersWalkingToPickup(pickup);

      // Departure Conditions:
      const reached80Percent = occupancyRatio >= 0.80;
      const reached10Minutes = nextWaitSeconds >= 600.0; // 10 minutes = 600 twin seconds
      const reachedMetroCadence =
        Boolean(veh.isMetro) &&
        remainingQueueForVeh === 0 &&
        nextWaitSeconds >= 25.0;
      const isLastCleanupSweep =
        remainingQueueForVeh === 0 &&
        !anyClustersWalkingHere &&
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

        // If no more evacuees are available for this empty vehicle at this pickup (and none are walking toward it),
        // reassign it randomly to another compatible pickup that still has people waiting (or mark completed if none remain)
        if (
          remainingQueueForVeh === 0 &&
          !anyClustersWalkingHere &&
          veh.currentOccupancy === 0
        ) {
          const reassigned = reassignEmptyVehicleOrComplete(
            { ...veh, waitingAtPickupSeconds: nextWaitSeconds },
            pickup.waitingPopulation > 0
          );
          if (
            reassigned.assignedPickupId !== veh.assignedPickupId ||
            reassigned.status === 'completed'
          ) {
            return reassigned;
          }
        }

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
      const stepMeters = speedMps * deltaTwinSeconds;
      const nextProgress = veh.progressMeters + stepMeters;

      if (nextProgress >= totalEvacDist) {
        const remainingDistToTarget = Math.max(0, totalEvacDist - veh.progressMeters);
        const driveTimeUsedSec = speedMps > 0 ? remainingDistToTarget / speedMps : 0;
        const arrivalPos =
          veh.evacCoords[veh.evacCoords.length - 1] || veh.currentPosition;
        const distKmStr = (totalEvacDist / 1000).toFixed(2);

        veh.totalDrivingSeconds = (veh.totalDrivingSeconds || 0) + driveTimeUsedSec;
        veh.totalDistanceTraveledMeters =
          (veh.totalDistanceTraveledMeters || 0) + remainingDistToTarget;

        // If load/unload time per person is 0 (instantaneous) or vehicle is empty, offload immediately
        if (loadUnloadSecPerPerson <= 0 || veh.currentOccupancy <= 0) {
          updatedTargetOccupancies[veh.targetId] =
            (updatedTargetOccupancies[veh.targetId] || 0) + veh.currentOccupancy;

          (['compliant', 'self-directed', 'disoriented'] as PopulationBehaviorType[]).forEach((beh) => {
            const countB = veh.occupancyByBehavior[beh] || 0;
            updatedTelemetry.evacuatedByBehavior[beh] += countB;
            updatedTelemetry.evacuatedPersonSecondsByBehavior[beh] +=
              countB * elapsedTwinSeconds;
            if (pickup.evacuatedPersonSecondsByBehavior) {
              pickup.evacuatedPersonSecondsByBehavior[beh] += countB * elapsedTwinSeconds;
            }
            if (veh.deliveredByBehavior) {
              veh.deliveredByBehavior[beh] += countB;
            }
          });

          veh.totalPassengersDelivered =
            (veh.totalPassengersDelivered || 0) + veh.currentOccupancy;
          pickup.evacuatedCount += veh.currentOccupancy;
          pickup.evacuatedByBehavior.compliant += veh.occupancyByBehavior.compliant;
          pickup.evacuatedByBehavior['self-directed'] += veh.occupancyByBehavior['self-directed'];
          pickup.evacuatedByBehavior.disoriented += veh.occupancyByBehavior.disoriented;

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
        totalDrivingSeconds: (veh.totalDrivingSeconds || 0) + deltaTwinSeconds,
        totalDistanceTraveledMeters: (veh.totalDistanceTraveledMeters || 0) + stepMeters,
        currentPosition: pos,
      };
    }

    // STATE D: Unloading passengers at Target Shelter accounting for per-person unloading time
    if (veh.status === 'unloading') {
      const nextUnloadElapsed = (veh.unloadingElapsedSeconds || 0) + deltaTwinSeconds;
      veh.totalUnloadingSeconds = (veh.totalUnloadingSeconds || 0) + deltaTwinSeconds;
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
          (deltaTwinSeconds * activeUnloadingUnits) / loadUnloadSecPerPerson +
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
        veh.totalPassengersDelivered = (veh.totalPassengersDelivered || 0) + unloadedNow;
        veh.occupancyByBehavior.compliant = Math.max(
          0,
          veh.occupancyByBehavior.compliant - unloadedBreakdown.compliant
        );
        veh.occupancyByBehavior['self-directed'] = Math.max(
          0,
          veh.occupancyByBehavior['self-directed'] - unloadedBreakdown['self-directed']
        );
        veh.occupancyByBehavior.disoriented = Math.max(
          0,
          veh.occupancyByBehavior.disoriented - unloadedBreakdown.disoriented
        );

        updatedTargetOccupancies[veh.targetId] =
          (updatedTargetOccupancies[veh.targetId] || 0) + unloadedNow;

        // Credit evacuated counts & cumulative person-seconds by behavior as evacuees step off into shelter
        (['compliant', 'self-directed', 'disoriented'] as PopulationBehaviorType[]).forEach((beh) => {
          const countB = unloadedBreakdown[beh] || 0;
          updatedTelemetry.evacuatedByBehavior[beh] += countB;
          updatedTelemetry.evacuatedPersonSecondsByBehavior[beh] +=
            countB * elapsedTwinSeconds;
          if (pickup.evacuatedPersonSecondsByBehavior) {
            pickup.evacuatedPersonSecondsByBehavior[beh] += countB * elapsedTwinSeconds;
          }
          if (veh.deliveredByBehavior) {
            veh.deliveredByBehavior[beh] += countB;
          }
        });

        // Credit pickup location shelter delivery statistics
        pickup.evacuatedCount += unloadedNow;
        pickup.evacuatedByBehavior.compliant += unloadedBreakdown.compliant;
        pickup.evacuatedByBehavior['self-directed'] += unloadedBreakdown['self-directed'];
        pickup.evacuatedByBehavior.disoriented += unloadedBreakdown.disoriented;
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

  // Record time-series sample for the People Evacuated vs. Time chart
  const series = updatedTelemetry.evacuationTimeSeries || [{ timeSeconds: 0, evacuatedCount: 0 }];
  const roundedElapsed = Math.round(elapsedTwinSeconds);
  const lastSample = series[series.length - 1];
  if (!lastSample) {
    series.push({ timeSeconds: roundedElapsed, evacuatedCount: totalEvacuated });
  } else if (lastSample.timeSeconds === roundedElapsed) {
    if (lastSample.evacuatedCount !== totalEvacuated) {
      series[series.length - 1] = { timeSeconds: roundedElapsed, evacuatedCount: totalEvacuated };
    }
  } else if (
    lastSample.evacuatedCount !== totalEvacuated ||
    roundedElapsed - lastSample.timeSeconds >= 10
  ) {
    series.push({ timeSeconds: roundedElapsed, evacuatedCount: totalEvacuated });
  }
  updatedTelemetry.evacuationTimeSeries = series;

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
