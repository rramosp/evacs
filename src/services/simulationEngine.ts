import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  VehicleFleet,
  ComputedRoute,
  SimulationCohort,
  HeatmapPoint,
} from '../types/evacuation';
import { getPolygonCentroid } from './routingEngine';

/**
 * Precompute cumulative distance array for fast O(log N) coordinate lookup along a polyline
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

  // Binary search for segment
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
 * Initialize simulation cohorts from computed routes
 */
export function createSimulationCohorts(
  routes: ComputedRoute[],
  _sourceAreas: SourceArea[],
  vehicleFleets: VehicleFleet[]
): SimulationCohort[] {
  const cohorts: SimulationCohort[] = [];

  routes.forEach((route) => {
    if (route.coordinates.length < 2) return;
    const { cumulative, total } = buildCumulativeDistances(route.coordinates);

    if (route.behaviorType === 'vehicle_dispatch') {
      const fleet = vehicleFleets.find((f) => f.id === route.vehicleFleetId);
      const numWaves = Math.min(5, Math.max(2, Math.ceil((fleet?.count || 10) / 20)));
      const popPerWave = Math.round(route.assignedPopulation / numWaves);
      const unitsPerWave = Math.max(1, Math.round((fleet?.count || 10) / numWaves));

      for (let w = 0; w < numWaves; w++) {
        cohorts.push({
          id: `cohort-${route.id}-wave-${w}`,
          routeId: route.id,
          sourceId: route.sourceId,
          targetId: route.targetId,
          behaviorType: 'obedient',
          isVehicle: true,
          vehicleType: fleet?.type || 'Bus',
          vehicleFleetName: fleet?.name || 'Evacuation Fleet',
          vehicleUnits: unitsPerWave,
          populationCount: popPerWave,
          coordinates: route.coordinates,
          cumulativeDistances: cumulative,
          totalDistanceMeters: total,
          progressMeters: 0,
          baseSpeedMps: 9.5, // ~34 km/h emergency vehicle transit speed
          currentSpeedMps: 9.5,
          currentPosition: route.coordinates[0],
          status: w === 0 ? 'en_route' : 'waiting',
          departureDelaySeconds: w * 45, // Stagger vehicle dispatches every 45s
        });
      }
    } else {
      // Pedestrian / crowd evacuation waves along obedient, autonomous, or random routes
      const numWaves = 6;
      const popPerWave = Math.max(10, Math.round(route.assignedPopulation / numWaves));

      // Base speeds in meters/sec (scaled slightly so simulation finishes within ~10-15 sim minutes)
      const baseSpeed =
        route.behaviorType === 'obedient'
          ? 4.2
          : route.behaviorType === 'autonomous'
          ? 4.6
          : 3.5;

      for (let w = 0; w < numWaves; w++) {
        cohorts.push({
          id: `cohort-${route.id}-wave-${w}`,
          routeId: route.id,
          sourceId: route.sourceId,
          targetId: route.targetId,
          behaviorType: route.behaviorType,
          isVehicle: false,
          populationCount: popPerWave,
          coordinates: route.coordinates,
          cumulativeDistances: cumulative,
          totalDistanceMeters: total,
          progressMeters: 0,
          baseSpeedMps: baseSpeed,
          currentSpeedMps: baseSpeed,
          currentPosition: route.coordinates[0],
          status: w === 0 ? 'en_route' : 'waiting',
          departureDelaySeconds: w * 35,
        });
      }
    }
  });

  return cohorts;
}

export interface SimulationStepOutput {
  cohorts: SimulationCohort[];
  heatmapPoints: HeatmapPoint[];
  targetOccupancies: Record<string, number>;
  newLogs: string[];
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
}

/**
 * Advance simulation state by `deltaSimSeconds`
 */
export function stepSimulation(
  cohorts: SimulationCohort[],
  elapsedSimSeconds: number,
  deltaSimSeconds: number,
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[]
): SimulationStepOutput {
  const newLogs: string[] = [];
  const targetOccupancies: Record<string, number> = {};
  targetAreas.forEach((t) => {
    targetOccupancies[t.id] = 0;
  });

  let totalEvacuated = 0;
  let totalInTransit = 0;
  let totalRemainingAtSource = 0;

  const updatedCohorts = cohorts.map((cohort) => {
    if (cohort.status === 'arrived') {
      targetOccupancies[cohort.targetId] =
        (targetOccupancies[cohort.targetId] || 0) + cohort.populationCount;
      totalEvacuated += cohort.populationCount;
      return cohort;
    }

    if (elapsedSimSeconds < cohort.departureDelaySeconds) {
      totalRemainingAtSource += cohort.populationCount;
      return {
        ...cohort,
        status: 'waiting' as const,
        currentPosition: cohort.coordinates[0],
      };
    }

    // Apply behavioral velocity modulation
    let speedMultiplier = 1.0;
    if (cohort.behaviorType === 'autonomous') {
      // Autonomous agents speed up or slow down based on local congestion wave
      speedMultiplier = 0.85 + Math.sin(elapsedSimSeconds * 0.05 + cohort.departureDelaySeconds) * 0.25;
    } else if (cohort.behaviorType === 'random') {
      // Random agents have erratic speed fluctuations
      speedMultiplier = 0.65 + Math.abs(Math.cos(elapsedSimSeconds * 0.12 + cohort.departureDelaySeconds)) * 0.55;
    }

    const effectiveSpeed = cohort.baseSpeedMps * speedMultiplier;
    const nextProgress = cohort.progressMeters + effectiveSpeed * deltaSimSeconds;

    if (nextProgress >= cohort.totalDistanceMeters) {
      const targetName =
        targetAreas.find((t) => t.id === cohort.targetId)?.name || 'Target Area';
      if (cohort.isVehicle) {
        newLogs.push(
          `${cohort.vehicleFleetName} (${cohort.vehicleUnits} units) arrived at ${targetName}, offloading ${cohort.populationCount.toLocaleString()} evacuees.`
        );
      } else {
        newLogs.push(
          `${cohort.behaviorType.toUpperCase()} cohort (${cohort.populationCount.toLocaleString()} people) reached safety at ${targetName}.`
        );
      }

      targetOccupancies[cohort.targetId] =
        (targetOccupancies[cohort.targetId] || 0) + cohort.populationCount;
      totalEvacuated += cohort.populationCount;

      return {
        ...cohort,
        progressMeters: cohort.totalDistanceMeters,
        currentSpeedMps: 0,
        currentPosition: cohort.coordinates[cohort.coordinates.length - 1],
        status: 'arrived' as const,
      };
    }

    const newPos = interpolateAlongPolyline(
      cohort.coordinates,
      cohort.cumulativeDistances,
      nextProgress
    );

    totalInTransit += cohort.populationCount;

    return {
      ...cohort,
      status: 'en_route' as const,
      progressMeters: nextProgress,
      currentSpeedMps: effectiveSpeed,
      currentPosition: newPos,
    };
  });

  // Generate spatial HeatmapPoints for source areas, moving cohorts, and target areas
  const heatmapPoints: HeatmapPoint[] = [];

  // 1. Source Area remaining density
  sourceAreas.forEach((src) => {
    const waitingPop = updatedCohorts
      .filter((c) => c.sourceId === src.id && c.status === 'waiting')
      .reduce((acc, c) => acc + c.populationCount, 0);

    if (waitingPop > 0) {
      const centroid = getPolygonCentroid(src.polygon);
      const intensity = Math.min(1.0, waitingPop / 1200);
      // Add central core + surrounding cluster points inside source polygon
      heatmapPoints.push({
        lat: centroid[0],
        lng: centroid[1],
        intensity,
        behavior: 'obedient',
      });
      src.polygon.forEach((corner) => {
        heatmapPoints.push({
          lat: (centroid[0] + corner[0]) / 2,
          lng: (centroid[1] + corner[1]) / 2,
          intensity: intensity * 0.75,
          behavior: 'obedient',
        });
      });
    }
  });

  // 2. Moving Cohorts along routes (creates dynamic flowing heatmap streams)
  updatedCohorts
    .filter((c) => c.status === 'en_route')
    .forEach((c, idx) => {
      const [lat, lng] = c.currentPosition;
      const baseIntensity = Math.min(1.0, Math.max(0.25, c.populationCount / 400));

      // Primary cohort center
      heatmapPoints.push({
        lat,
        lng,
        intensity: baseIntensity,
        behavior: c.behaviorType,
      });

      // Add trailing and leading dispersion kernels along the path so the heatmap looks like a continuous crowd flow
      const trailDist = Math.max(0, c.progressMeters - 85);
      const leadDist = Math.min(c.totalDistanceMeters, c.progressMeters + 85);
      const trailPos = interpolateAlongPolyline(c.coordinates, c.cumulativeDistances, trailDist);
      const leadPos = interpolateAlongPolyline(c.coordinates, c.cumulativeDistances, leadDist);

      // Slight lateral jitter for random/autonomous crowds
      const lateralSpread = c.behaviorType === 'random' ? 0.0007 : 0.00025;
      const offsetLat = Math.sin(idx * 1.7) * lateralSpread;
      const offsetLng = Math.cos(idx * 2.1) * lateralSpread;

      heatmapPoints.push({
        lat: trailPos[0] + offsetLat,
        lng: trailPos[1] + offsetLng,
        intensity: baseIntensity * 0.7,
        behavior: c.behaviorType,
      });
      heatmapPoints.push({
        lat: leadPos[0] - offsetLat,
        lng: leadPos[1] - offsetLng,
        intensity: baseIntensity * 0.7,
        behavior: c.behaviorType,
      });
    });

  // 3. Target Area arrived evacuee density
  targetAreas.forEach((tgt) => {
    const arrivedPop = targetOccupancies[tgt.id] || 0;
    if (arrivedPop > 0) {
      const centroid = getPolygonCentroid(tgt.polygon);
      const intensity = Math.min(1.0, arrivedPop / 2500);
      heatmapPoints.push({
        lat: centroid[0],
        lng: centroid[1],
        intensity,
        behavior: 'obedient',
      });
      tgt.polygon.forEach((corner) => {
        heatmapPoints.push({
          lat: (centroid[0] * 2 + corner[0]) / 3,
          lng: (centroid[1] * 2 + corner[1]) / 3,
          intensity: intensity * 0.65,
          behavior: 'obedient',
        });
      });
    }
  });

  return {
    cohorts: updatedCohorts,
    heatmapPoints,
    targetOccupancies,
    newLogs,
    totalEvacuated,
    totalInTransit,
    totalRemainingAtSource,
  };
}
