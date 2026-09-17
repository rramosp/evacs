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
} from '../types/evacuation';
import { getPolygonCentroid, toTurfPolygon } from './routingEngine';

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

    // Deterministic quasi-random sampling inside bbox
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
 * Generate initial heatmap points from clusters and pickup states
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
    // Include people waiting in queue + people currently sitting in a boarding vehicle at this pickup
    const boardingHere = vehicles
      .filter((v) => v.assignedPickupId === p.id && v.status === 'waiting_for_80_pct')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);

    const totalAtPickup = p.waitingPopulation + boardingHere;

    if (totalAtPickup > 0) {
      const coreIntensity = Math.min(1.0, 0.35 + totalAtPickup / 180);

      // Primary hotspot core right on the Blue Square
      pts.push({
        lat: p.location[0],
        lng: p.location[1],
        intensity: coreIntensity,
        behavior: 'pickup_hotspot',
      });

      // Multi-point thermal aura around the Blue Square so the heatmap glows intensely hot around the pickup square
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
 * Initialize full simulation state:
 * - PickupLocationStates for each route's Blue Square
 * - SourceInternalClusters distributed inside each Source Area polygon
 * - ActiveVehicleUnits dispatched from VehicleFleets
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
    totalBoardedCount: 0,
  }));

  const clusters: SourceInternalCluster[] = [];

  sourceAreas.forEach((src) => {
    const numClusters = 75; // 75 spatial clusters per source area
    const totalPop = src.population;
    const obCount = Math.round((numClusters * src.behavior.obedient) / 100);
    const auCount = Math.round((numClusters * src.behavior.autonomous) / 100);

    let popAllocated = 0;

    for (let i = 0; i < numClusters; i++) {
      const isLast = i === numClusters - 1;
      const headcount = isLast
        ? Math.max(1, totalPop - popAllocated)
        : Math.round(totalPop / numClusters);
      popAllocated += headcount;

      let behavior: PopulationBehaviorType = 'random';
      if (i < obCount) {
        behavior = 'obedient';
      } else if (i < obCount + auCount) {
        behavior = 'autonomous';
      }

      const startPos = samplePointInsidePolygon(src.polygon, i);
      const nearestEdgeIdx = i % Math.max(1, src.polygon.length);

      clusters.push({
        id: `cluster-${src.id}-${i}`,
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

  // Initialize Vehicle Units cycling to Pickups and Targets
  const vehicles: ActiveVehicleUnit[] = [];

  routes.forEach((route, rIdx) => {
    const pickup = pickupStates.find((p) => p.routeId === route.id);
    if (!pickup) return;

    const fleet =
      vehicleFleets.find((f) => f.id === route.vehicleFleetId) ||
      vehicleFleets[rIdx % Math.max(1, vehicleFleets.length)];

    const approachCoords =
      route.approachCoordinates && route.approachCoordinates.length >= 2
        ? route.approachCoordinates
        : [fleet ? fleet.location : route.pickupLocation, route.pickupLocation];

    const evacCoords =
      route.coordinates && route.coordinates.length >= 2
        ? route.coordinates
        : [route.pickupLocation, route.pickupLocation];

    const approachDist = buildCumulativeDistances(approachCoords);
    const evacDist = buildCumulativeDistances(evacCoords);

    // Create 4 staggered vehicle dispatch waves per corridor so vehicles arrive continuously
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
        assignedRouteId: route.id,
        assignedPickupId: pickup.id,
        sourceId: route.sourceId,
        targetId: route.targetId,
        targetName: route.targetName,
        status: 'to_pickup',
        currentPosition: approachCoords[0],
        progressMeters: 0,
        speedMps: 18.0, // Urban emergency transit speed
        approachCoords,
        approachCumulative: approachDist.cumulative,
        evacCoords,
        evacCumulative: evacDist.cumulative,
        departureDelaySeconds: w * 22, // Staggered dispatch every 22 sim seconds
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
    newLogs: [],
    totalEvacuated: 0,
    totalInTransit: 0,
    totalRemainingAtSource,
    totalWaitingAtPickups: 0,
  };
}

/**
 * Step simulation forward by `deltaSimSeconds` implementing:
 * 1. Obedient population moving immediately to closest pickup location
 * 2. Random population wandering inside Source Area until within 50m of a pickup location
 * 3. Autonomous population wandering along Source Area perimeter limits until stumbling on a pickup location
 * 4. Vehicles waiting at pickup locations until occupancy >= 80% before departing to Target Shelters
 * 5. Dynamic heatmap updating (hotter around pickup locations as queues build, cooler over time as source empties)
 */
export function stepSimulationState(
  prevState: SimulationStateSnapshot,
  elapsedSimSeconds: number,
  deltaSimSeconds: number,
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[]
): SimulationStateSnapshot {
  const newLogs: string[] = [];

  // Deep clone pickup states so we can mutate waiting counts cleanly
  const pickupMap = new Map<string, PickupLocationState>();
  prevState.pickupStates.forEach((p) => {
    pickupMap.set(p.id, { ...p, boardingVehicleInfo: undefined });
  });

  const sourceMap = new Map<string, SourceArea>();
  sourceAreas.forEach((s) => sourceMap.set(s.id, s));

  // Speed of pedestrians moving inside Source Area (in degrees/sec equivalent ~ 3.2 m/s scaled for visual clarity)
  const walkSpeedMetersPerSec = 5.2;

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

    // Helper to find distance (in meters) to all pickup points in this source zone
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

    // --- BEHAVIOR 2: RANDOM ---
    // Wander around the source area until within 50m of ANY pickup point, then direct straight to it
    if (cluster.behavior === 'random') {
      if (closest.distMeters <= 50.0) {
        // Within 50m! Lock onto this pickup location and walk directly to it
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
        // Wander inside the Source Area polygon
        const stepDeg = (walkSpeedMetersPerSec * deltaSimSeconds) / 111000;
        let heading = cluster.randomHeadingRad + (Math.sin(elapsedSimSeconds + cluster.headcount) * 0.35);
        let candidateLat = cluster.position[0] + Math.sin(heading) * stepDeg;
        let candidateLng = cluster.position[1] + Math.cos(heading) * stepDeg;

        // Keep inside Source Area polygon
        if (src && src.polygon.length >= 3) {
          try {
            const poly = toTurfPolygon(src.polygon);
            if (!turf.booleanPointInPolygon(turf.point([candidateLng, candidateLat]), poly)) {
              // Bounce heading toward polygon centroid
              const centroid = getPolygonCentroid(src.polygon);
              heading = Math.atan2(
                centroid[0] - cluster.position[0],
                centroid[1] - cluster.position[1]
              );
              candidateLat = cluster.position[0] + Math.sin(heading) * stepDeg;
              candidateLng = cluster.position[1] + Math.cos(heading) * stepDeg;
            }
          } catch {
            // Ignore turf error
          }
        }

        return {
          ...cluster,
          position: [candidateLat, candidateLng] as [number, number],
          randomHeadingRad: heading,
        };
      }
    }

    // --- BEHAVIOR 3: AUTONOMOUS ---
    // Wander around the LIMITS (perimeter boundary) of the source area until stumbling upon a pickup location
    if (cluster.behavior === 'autonomous') {
      // Stumble threshold along perimeter: if within 55m of a pickup location, direct straight to it
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

      // Otherwise circulate along the polygon perimeter edges
      if (src && src.polygon.length >= 3) {
        const poly = src.polygon;
        const pStart = poly[cluster.perimeterEdgeIndex % poly.length];
        const pEnd = poly[(cluster.perimeterEdgeIndex + 1) % poly.length];

        const edgeDistMeters =
          turf.distance([pStart[1], pStart[0]], [pEnd[1], pEnd[0]], { units: 'kilometers' }) *
          1000;
        const stepMeters = walkSpeedMetersPerSec * 1.2 * deltaSimSeconds;
        const progressDelta = edgeDistMeters > 0 ? stepMeters / edgeDistMeters : 0.2;

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

        // Smoothly pull cluster position onto the perimeter edge
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

  // --- STEP 2: Process Vehicle Dispatches, 80% Boarding Rule, and Shelter Offloads ---
  const updatedVehicles = prevState.vehicles.map((veh) => {
    if (veh.status === 'completed') return veh;
    if (elapsedSimSeconds < veh.departureDelaySeconds) return veh;

    const pickup = pickupMap.get(veh.assignedPickupId);
    if (!pickup) return veh;

    // STATE A: Driving from Depot / Shelter TO Pickup Location (Blue Square)
    if (veh.status === 'to_pickup') {
      const totalApproachDist =
        veh.approachCumulative[veh.approachCumulative.length - 1] || 1;
      const nextProgress = veh.progressMeters + veh.speedMps * deltaSimSeconds;

      if (nextProgress >= totalApproachDist) {
        return {
          ...veh,
          status: 'waiting_for_80_pct' as const,
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

    // STATE B: At Blue Square Pickup Location — Board waiting evacuees & WAIT UNTIL >= 80% OCCUPANCY
    if (veh.status === 'waiting_for_80_pct') {
      const spaceNeeded = veh.maxCapacity - veh.currentOccupancy;
      if (spaceNeeded > 0 && pickup.waitingPopulation > 0) {
        const boardedNow = Math.min(spaceNeeded, pickup.waitingPopulation);
        veh.currentOccupancy += boardedNow;
        pickup.waitingPopulation -= boardedNow;
        pickup.totalBoardedCount += boardedNow;
      }

      const occupancyRatio = veh.currentOccupancy / Math.max(1, veh.maxCapacity);
      const remainingUnboardedInSource = getUnboardedInSource(veh.sourceId);

      // 80% Occupancy Departure Condition (or last remaining evacuees boarded)
      const isAtLeast80PctFull = occupancyRatio >= 0.80;
      const isLastCleanupSweep =
        remainingUnboardedInSource === 0 && veh.currentOccupancy > 0;

      if (isAtLeast80PctFull || isLastCleanupSweep) {
        const pctStr = Math.round(occupancyRatio * 100);
        newLogs.push(
          `${veh.fleetName} reached ${pctStr}% occupancy (${veh.currentOccupancy}/${veh.maxCapacity} seats) at ${pickup.label} -> Departing to ${veh.targetName}.`
        );

        return {
          ...veh,
          status: 'to_target' as const,
          progressMeters: 0,
          currentPosition: veh.evacCoords[0] || pickup.location,
        };
      } else {
        // Still waiting at Blue Square for more evacuees to arrive and reach 80% occupancy
        const pctStr = Math.round(occupancyRatio * 100);
        pickup.boardingVehicleInfo = `${veh.fleetName}: ${veh.currentOccupancy}/${veh.maxCapacity} (${pctStr}% — Waiting for 80%)`;

        // If 0 people left anywhere in source area and vehicle is empty, mark completed
        if (remainingUnboardedInSource === 0 && veh.currentOccupancy === 0) {
          return {
            ...veh,
            status: 'completed' as const,
          };
        }

        return {
          ...veh,
          currentPosition: pickup.location,
        };
      }
    }

    // STATE C: Driving from Pickup Location TO Target Shelter
    if (veh.status === 'to_target') {
      const totalEvacDist = veh.evacCumulative[veh.evacCumulative.length - 1] || 1;
      const nextProgress = veh.progressMeters + veh.speedMps * deltaSimSeconds;

      if (nextProgress >= totalEvacDist) {
        // Arrived at Target Shelter! Offload passengers
        updatedTargetOccupancies[veh.targetId] =
          (updatedTargetOccupancies[veh.targetId] || 0) + veh.currentOccupancy;

        newLogs.push(
          `${veh.fleetName} arrived at ${veh.targetName}, offloading ${veh.currentOccupancy.toLocaleString()} evacuees safely.`
        );

        const offloadedVeh = {
          ...veh,
          currentOccupancy: 0,
          progressMeters: 0,
          currentPosition: veh.evacCoords[veh.evacCoords.length - 1],
        };

        // Check if more evacuees remain in the Source Area for another round trip
        const remainingInSource = getUnboardedInSource(veh.sourceId);
        if (remainingInSource > 0) {
          // Reverse evacCoords as return approach back to the Blue Square pickup point
          const returnCoords = [...veh.evacCoords].reverse();
          const returnDist = buildCumulativeDistances(returnCoords);
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

  // Generate dynamic spatial HeatmapPoints
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
    newLogs,
    totalEvacuated,
    totalInTransit,
    totalRemainingAtSource,
    totalWaitingAtPickups,
  };
}
