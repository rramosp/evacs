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
  TwinTelemetryStats,
  PopulationBehaviorType,
  BehaviorCounts,
  LogEntry,
  BrusselsMetroConfig,
  BrusselsMetroMatchedStation,
  BrusselsMetroCorridor,
  RoutingAlgorithm,
  Sentinel2LayerState,
  Sentinel1LayerState,
  GlofasForecastState,
  DataOverlayLayer,
} from '../types/evacuation';
import {
  formatMMSS,
  createZeroBehaviorCounts,
  computeSourceBehaviorHeadcounts,
} from './twinEngine';
import { getPolygonCentroid, toTurfPolygon } from './routingEngine';

export interface AiAssessmentPromptInput {
  userInstructions: string;
  scenarioName: string;
  routingAlgorithm: RoutingAlgorithm;
  elapsedTwinSeconds: number;
  twinSpeed: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  redAreas: RedArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  clusters: SourceInternalCluster[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  telemetryStats: TwinTelemetryStats;
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  totalWaitingAtPickups: number;
  logs: LogEntry[];
  hasBrusselsAreas: boolean;
  brusselsMetroConfig: BrusselsMetroConfig;
  sourceMetroStations: BrusselsMetroMatchedStation[];
  targetMetroStations: BrusselsMetroMatchedStation[];
  metroCorridors: BrusselsMetroCorridor[];
  sentinel2Layer?: Sentinel2LayerState;
  sentinel1Layer?: Sentinel1LayerState;
  glofasForecast?: GlofasForecastState;
  dataOverlays?: DataOverlayLayer[];
}

const BEHAVIORS: PopulationBehaviorType[] = ['compliant', 'self-directed', 'disoriented'];

function formatDurationFull(sec: number): string {
  const totalSec = Math.max(0, Math.round(sec));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const remSec = totalSec % 60;
  if (hours > 0) {
    return `${hours}h ${String(mins).padStart(2, '0')}m ${String(remSec).padStart(2, '0')}s (${totalSec}s)`;
  }
  return `${formatMMSS(totalSec)} (${totalSec}s)`;
}

function fmtMeanSec(personSec: number, count: number): string {
  if (count <= 0) return 'N/A (0 samples)';
  const mean = personSec / count;
  return `${formatMMSS(mean)} (${mean.toFixed(1)}s)`;
}

function getPolygonGeometryMetrics(polygon: [number, number][]): {
  areaKm2: number;
  perimeterKm: number;
  centroid: [number, number];
} {
  const centroid = getPolygonCentroid(polygon);
  if (!polygon || polygon.length < 3) {
    return { areaKm2: 0, perimeterKm: 0, centroid };
  }
  try {
    const turfPoly = toTurfPolygon(polygon);
    const areaKm2 = turf.area(turfPoly) / 1e6;
    const perimeterKm = turf.length(turfPoly, { units: 'kilometers' });
    return { areaKm2, perimeterKm, centroid };
  } catch {
    return { areaKm2: 0, perimeterKm: 0, centroid };
  }
}

export const DEFAULT_AI_ASSESSMENT_INSTRUCTIONS = `Perform a comprehensive tactical and operational assessment of this urban evacuation digital twin simulation. Specifically:
1. Evaluate overall evacuation performance, completion rate, clearance speed, and stage-by-stage timing bottlenecks across pedestrian walking, pickup queue waiting, boarding, transit, and shelter unloading.
2. Perform a granular Assets Efficiency Analysis covering street vehicle fleets (unit counts, capacities, transit speeds, load/unload times, 80% occupancy vs 10-minute wait dispatch triggers, depot staging locations, and dynamic reassignments), pickup & drop-off point spatial coverage, target shelter utilization, and Brussels Metro underground rail utilization.
3. Identify all Contingency Points, operational vulnerabilities, and failure modes (e.g., queue buildup hotspots, long pedestrian walking distances, disoriented/self-directed straggler tail delays, Red Area detour penalties, shelter capacity saturation risks, or underutilized fleets/corridors).
4. Provide concrete, quantified Parameter Optimization Recommendations to re-parametrize the simulation for faster total evacuation clearance and higher resource efficiency (specifying exact suggested adjustments to fleet counts/capacities/speeds/depots, pickup/drop-off points, target shelter capacities, and Metro train count/capacity settings).`;

/**
 * Build an enriched, comprehensive Markdown prompt combining user instructions with all
 * simulation parameters, real-time & cumulative telemetry, event logs, and multi-dimensional summaries.
 */
export function buildAiAssessmentPrompt(input: AiAssessmentPromptInput): string {
  const {
    userInstructions,
    scenarioName,
    routingAlgorithm,
    elapsedTwinSeconds,
    twinSpeed,
    sourceAreas,
    targetAreas,
    redAreas,
    vehicleFleets,
    computedRoutes,
    clusters,
    pickupStates,
    vehicles,
    telemetryStats,
    totalEvacuated,
    totalInTransit,
    logs,
    hasBrusselsAreas,
    brusselsMetroConfig,
    sourceMetroStations,
    targetMetroStations,
    metroCorridors,
    sentinel2Layer,
    sentinel1Layer,
    glofasForecast,
    dataOverlays,
  } = input;

  const trimmedInstructions =
    userInstructions.trim() || DEFAULT_AI_ASSESSMENT_INSTRUCTIONS;

  // --- Global Population Accounting & Stage Breakdown ---
  const movingInZoneByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  const movingBySourceAndBehavior = new Map<string, BehaviorCounts>();
  sourceAreas.forEach((s) => movingBySourceAndBehavior.set(s.id, createZeroBehaviorCounts()));

  clusters
    .filter((c) => c.status === 'moving_in_zone' && c.headcount > 0)
    .forEach((c) => {
      movingInZoneByBehavior[c.behavior] += c.headcount;
      const srcMap = movingBySourceAndBehavior.get(c.sourceId) || createZeroBehaviorCounts();
      srcMap[c.behavior] += c.headcount;
      movingBySourceAndBehavior.set(c.sourceId, srcMap);
    });

  const waitingInQueueByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  pickupStates.forEach((p) => {
    if (p.waitingByBehavior) {
      waitingInQueueByBehavior.compliant += p.waitingByBehavior.compliant || 0;
      waitingInQueueByBehavior['self-directed'] +=
        p.waitingByBehavior['self-directed'] || 0;
      waitingInQueueByBehavior.disoriented += p.waitingByBehavior.disoriented || 0;
    }
  });

  const boardingInVehiclesByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  const inTransitByBehavior: BehaviorCounts = createZeroBehaviorCounts();

  vehicles.forEach((v) => {
    const occ = v.occupancyByBehavior || createZeroBehaviorCounts();
    if (v.status === 'waiting_for_80_pct' && v.currentOccupancy > 0) {
      boardingInVehiclesByBehavior.compliant += occ.compliant || 0;
      boardingInVehiclesByBehavior['self-directed'] += occ['self-directed'] || 0;
      boardingInVehiclesByBehavior.disoriented += occ.disoriented || 0;
    } else if ((v.status === 'to_target' || v.status === 'unloading') && v.currentOccupancy > 0) {
      inTransitByBehavior.compliant += occ.compliant || 0;
      inTransitByBehavior['self-directed'] += occ['self-directed'] || 0;
      inTransitByBehavior.disoriented += occ.disoriented || 0;
    }
  });

  const hasActiveEntities =
    clusters.length > 0 || totalEvacuated > 0 || totalInTransit > 0;

  const fallbackInitialByBehavior = createZeroBehaviorCounts();
  sourceAreas.forEach((s) => {
    if (s.disabled) return;
    const c = computeSourceBehaviorHeadcounts(s);
    fallbackInitialByBehavior.compliant += c.compliant;
    fallbackInitialByBehavior['self-directed'] += c['self-directed'];
    fallbackInitialByBehavior.disoriented += c.disoriented;
  });

  const waitingAtPickupsByBehavior: BehaviorCounts = {
    compliant: waitingInQueueByBehavior.compliant + boardingInVehiclesByBehavior.compliant,
    'self-directed':
      waitingInQueueByBehavior['self-directed'] +
      boardingInVehiclesByBehavior['self-directed'],
    disoriented:
      waitingInQueueByBehavior.disoriented + boardingInVehiclesByBehavior.disoriented,
  };

  const notEvacuatedByBehavior: BehaviorCounts = hasActiveEntities
    ? {
        compliant:
          movingInZoneByBehavior.compliant +
          waitingAtPickupsByBehavior.compliant +
          inTransitByBehavior.compliant,
        'self-directed':
          movingInZoneByBehavior['self-directed'] +
          waitingAtPickupsByBehavior['self-directed'] +
          inTransitByBehavior['self-directed'],
        disoriented:
          movingInZoneByBehavior.disoriented +
          waitingAtPickupsByBehavior.disoriented +
          inTransitByBehavior.disoriented,
      }
    : fallbackInitialByBehavior;

  const evacuatedByBehavior: BehaviorCounts = telemetryStats?.evacuatedByBehavior || {
    compliant: 0,
    'self-directed': 0,
    disoriented: 0,
  };

  const initialByBehavior: BehaviorCounts = {
    compliant: evacuatedByBehavior.compliant + notEvacuatedByBehavior.compliant,
    'self-directed':
      evacuatedByBehavior['self-directed'] + notEvacuatedByBehavior['self-directed'],
    disoriented: evacuatedByBehavior.disoriented + notEvacuatedByBehavior.disoriented,
  };

  const totalNotEvacuated =
    notEvacuatedByBehavior.compliant +
    notEvacuatedByBehavior['self-directed'] +
    notEvacuatedByBehavior.disoriented;
  const totalInitialPopulation = totalEvacuated + totalNotEvacuated;
  const completionPct =
    totalInitialPopulation > 0 ? (totalEvacuated / totalInitialPopulation) * 100 : 0;

  const simStatusLabel =
    totalNotEvacuated === 0 && totalEvacuated > 0
      ? 'COMPLETED (100.0% Evacuated)'
      : elapsedTwinSeconds > 0
      ? `STOPPED / PAUSED AT T+${formatDurationFull(elapsedTwinSeconds)} (${completionPct.toFixed(1)}% Evacuated)`
      : 'PRE-SIMULATION / INITIAL SNAPSHOT (T+00:00)';

  const elapsedMinutes = elapsedTwinSeconds / 60;
  const overallThroughputPaxPerMin =
    elapsedMinutes > 0 ? totalEvacuated / elapsedMinutes : 0;
  const totalBoardedAllPickups = pickupStates.reduce(
    (acc, p) => acc + (p.totalBoardedCount || 0),
    0
  );
  const boardingRatePaxPerMin =
    elapsedMinutes > 0 ? totalBoardedAllPickups / elapsedMinutes : 0;

  // Global Timing Aggregates across all Pickups
  const globalWalkPersonSec = createZeroBehaviorCounts();
  const globalWalkArrived = createZeroBehaviorCounts();
  const globalQueueWaitPersonSec = createZeroBehaviorCounts();
  const globalInVehiclePersonSec = createZeroBehaviorCounts();
  const globalEvacPersonSec = createZeroBehaviorCounts();

  pickupStates.forEach((p) => {
    BEHAVIORS.forEach((b) => {
      globalWalkArrived[b] += p.arrivedByBehavior?.[b] || 0;
      globalWalkPersonSec[b] += p.arrivedPersonSecondsByBehavior?.[b] || 0;
      globalQueueWaitPersonSec[b] += p.passengerWaitPersonSecondsByBehavior?.[b] || 0;
      globalInVehiclePersonSec[b] += p.inVehiclePersonSecondsByBehavior?.[b] || 0;
      globalEvacPersonSec[b] += p.evacuatedPersonSecondsByBehavior?.[b] || 0;
    });
  });

  // Fallback to telemetryStats if pickup-level arrived/evacuated counters were zero
  BEHAVIORS.forEach((b) => {
    if (globalWalkArrived[b] === 0 && telemetryStats?.pickupArrivedByBehavior?.[b]) {
      globalWalkArrived[b] = telemetryStats.pickupArrivedByBehavior[b];
      globalWalkPersonSec[b] = telemetryStats.pickupArrivalPersonSecondsByBehavior?.[b] || 0;
    }
    if (globalEvacPersonSec[b] === 0 && telemetryStats?.evacuatedPersonSecondsByBehavior?.[b]) {
      globalEvacPersonSec[b] = telemetryStats.evacuatedPersonSecondsByBehavior[b];
    }
  });

  const lines: string[] = [];

  // =========================================================================
  // 1. HEADER & USER INSTRUCTIONS FOR AI
  // =========================================================================
  lines.push('# EVAC-TWIN SIMULATION — COMPREHENSIVE AI ASSESSMENT & OPTIMIZATION PROMPT');
  lines.push('');
  lines.push(
    'You are a Senior Civil Defense Evacuation Planner, Urban Transportation Systems Engineer, and Operations Research Analyst. Below is the complete parameter specification, multi-stage telemetry dataset, event log, and disaggregated performance summary of an urban evacuation digital twin run in **EVAC-TWIN**.'
  );
  lines.push('');
  lines.push('## 1. User Instructions for AI Assessment');
  lines.push('```text');
  lines.push(trimmedInstructions);
  lines.push('```');
  lines.push('');

  // =========================================================================
  // 2. INPUT PARAMETERS & SCENARIO CONFIGURATION
  // =========================================================================
  lines.push('## 2. Simulation Input Parameters & Scenario Configuration');
  lines.push('');
  lines.push('### 2.1 Global Execution Parameters');
  lines.push(`- **Scenario Name**: ${scenarioName}`);
  lines.push(`- **Simulation State**: ${simStatusLabel}`);
  lines.push(`- **Elapsed Twin Time**: ${formatDurationFull(elapsedTwinSeconds)}`);
  lines.push(`- **Playback Speed Multiplier**: ${twinSpeed}x (1:1 real-world kinematics in twin clock)`);
  lines.push(`- **Street Routing Algorithm**: \`${routingAlgorithm}\` (strictly avoids active Red Areas via 2D Obstacle Visibility Graph + OSRM road network)`);
  lines.push(`- **Pedestrian Walking Speed inside Source Areas**: \`5.0 km/h\` (1.39 m/s)`);
  lines.push(`- **Cluster Granularity**: \`50 people/dot\` (spatially uniform R2 low-discrepancy + Centroidal Voronoi distribution inside each Source Area polygon)`);
  lines.push(`- **Street Vehicle Departure Rule**: Dual threshold at Pickup Points — departs when **Occupancy >= 80%** OR **Pickup Wait Time >= 10 minutes (600s)** (or final cleanup sweep), provided \`occupancy >= 1\`.`);
  lines.push(`- **Brussels Metro Region Active**: ${hasBrusselsAreas ? 'Yes (Region of Brussels detected)' : 'No'}`);
  lines.push(
    `- **Brussels Metro Underground Evacuation Enabled**: ${
      hasBrusselsAreas && brusselsMetroConfig.useForEvacuation
        ? `ENABLED (${brusselsMetroConfig.trainCount} trains × ${brusselsMetroConfig.trainCapacity} pax/train = ${(
            brusselsMetroConfig.trainCount * brusselsMetroConfig.trainCapacity
          ).toLocaleString()} underground seats @ 45 km/h, 0.2s/pax boarding/alighting, >=25s platform dispatch cadence; unaffected by surface Red Areas)`
        : 'DISABLED'
    }`
  );
  lines.push('');

  // 2.2 Source Areas
  lines.push(`### 2.2 Source Areas (${sourceAreas.length} total, ${sourceAreas.filter((s) => !s.disabled).length} active)`);
  if (sourceAreas.length === 0) {
    lines.push('_No Source Areas defined._');
  } else {
    sourceAreas.forEach((src, idx) => {
      const geom = getPolygonGeometryMetrics(src.polygon);
      const pickupsForSrc = pickupStates.filter((p) => p.sourceId === src.id);
      const boardedFromSrc = pickupsForSrc.reduce((acc, p) => acc + (p.totalBoardedCount || 0), 0);
      const movingInSrc = clusters
        .filter((c) => c.sourceId === src.id && c.status === 'moving_in_zone')
        .reduce((acc, c) => acc + c.headcount, 0);
      const waitingInSrc = pickupsForSrc.reduce((acc, p) => acc + p.waitingPopulation, 0);
      const onboardAtPickupSrc = vehicles
        .filter((v) => v.sourceId === src.id && v.status === 'waiting_for_80_pct')
        .reduce((acc, v) => acc + v.currentOccupancy, 0);
      const estInitialPop = hasActiveEntities
        ? movingInSrc + waitingInSrc + onboardAtPickupSrc + boardedFromSrc
        : src.population;
      const density = geom.areaKm2 > 0 ? Math.round(estInitialPop / geom.areaKm2) : 0;
      const srcMetroList = sourceMetroStations
        .filter((m) => m.areaId === src.id)
        .map((m) => `${m.station.name_fr} [Lines: ${m.station.lines.join(',')}]`);

      lines.push(
        `${idx + 1}. **${src.name}** (\`id: ${src.id}\`) — Status: **${
          src.disabled ? 'DISABLED' : 'ACTIVE'
        }**`
      );
      lines.push(
        `   - **Initial Population**: ${estInitialPop.toLocaleString()} pax | **Configured Behavioral Split**: Compliant \`${src.behavior.compliant}%\`, Self-Directed \`${src.behavior['self-directed']}%\`, Disoriented \`${src.behavior.disoriented}%\``
      );
      lines.push(
        `   - **Geometry**: Centroid \`[${geom.centroid[0].toFixed(5)}, ${geom.centroid[1].toFixed(5)}]\` | Area: \`${geom.areaKm2.toFixed(3)} km²\` | Perimeter: \`${geom.perimeterKm.toFixed(2)} km\` | Pop. Density: ~\`${density.toLocaleString()} pax/km²\``
      );
      lines.push(
        `   - **Pickup Coverage**: ${pickupsForSrc.filter((p) => !p.isMetro).length} street Blue Square pickup(s), ${pickupsForSrc.filter((p) => p.isMetro).length} active Metro pickup(s)${
          srcMetroList.length > 0 ? ` (Stations inside zone: ${srcMetroList.join('; ')})` : ''
        }`
      );
    });
  }
  lines.push('');

  // 2.3 Target Areas
  lines.push(`### 2.3 Target Areas / Safe Shelters (${targetAreas.length} total, ${targetAreas.filter((t) => !t.disabled).length} active)`);
  if (targetAreas.length === 0) {
    lines.push('_No Target Areas defined._');
  } else {
    targetAreas.forEach((tgt, idx) => {
      const geom = getPolygonGeometryMetrics(tgt.polygon);
      const tgtMetroList = targetMetroStations
        .filter((m) => m.areaId === tgt.id)
        .map((m) => `${m.station.name_fr} [Lines: ${m.station.lines.join(',')}]`);
      const utilPct = tgt.capacity > 0 ? (tgt.currentOccupancy / tgt.capacity) * 100 : 0;
      lines.push(
        `${idx + 1}. **${tgt.name}** (\`id: ${tgt.id}\`) — Status: **${
          tgt.disabled ? 'DISABLED' : 'ACTIVE'
        }**`
      );
      lines.push(
        `   - **Capacity**: ${tgt.capacity.toLocaleString()} pax | **Current Arrived Occupancy**: ${tgt.currentOccupancy.toLocaleString()} pax (\`${utilPct.toFixed(1)}%\`) | **Remaining Headroom**: ${Math.max(
          0,
          tgt.capacity - tgt.currentOccupancy
        ).toLocaleString()} pax`
      );
      lines.push(
        `   - **Geometry**: Centroid \`[${geom.centroid[0].toFixed(5)}, ${geom.centroid[1].toFixed(5)}]\` | Area: \`${geom.areaKm2.toFixed(3)} km²\`${
          tgtMetroList.length > 0 ? ` | Metro Stations inside Shelter: ${tgtMetroList.join('; ')}` : ''
        }`
      );
    });
  }
  lines.push('');

  // 2.4 Red Areas
  lines.push(`### 2.4 Red Areas / Hazard Exclusion Zones (${redAreas.length} total, ${redAreas.filter((r) => !r.disabled).length} active)`);
  if (redAreas.length === 0) {
    lines.push('_No Red Areas defined._');
  } else {
    redAreas.forEach((red, idx) => {
      const geom = getPolygonGeometryMetrics(red.polygon);
      const ringsCount = red.polygons ? red.polygons.length : 1;
      const detouredRoutes = computedRoutes.filter((r) =>
        r.avoidedRedAreaNames?.includes(red.name)
      );
      lines.push(
        `${idx + 1}. **${red.name}** (\`id: ${red.id}\`) — Status: **${
          red.disabled ? 'DISABLED (Routes Allowed)' : 'ACTIVE (Strict Non-Intersection)'
        }** | Rings: ${ringsCount} | Area: \`${geom.areaKm2.toFixed(3)} km²\` | Centroid: \`[${geom.centroid[0].toFixed(5)}, ${geom.centroid[1].toFixed(5)}]\` | Detoured Street Routes: ${detouredRoutes.length}`
      );
    });
  }
  lines.push('');

  // 2.5 Vehicle Fleets
  const totalStreetUnits = vehicleFleets.reduce((acc, f) => acc + f.count, 0);
  const totalStreetSeats = vehicleFleets.reduce(
    (acc, f) => acc + f.count * f.capacityPerUnit,
    0
  );
  lines.push(
    `### 2.5 Street Vehicle Fleets (${vehicleFleets.length} fleets, ${totalStreetUnits} total street vehicles, ${totalStreetSeats.toLocaleString()} total concurrent street seats)`
  );
  if (vehicleFleets.length === 0) {
    lines.push('_No street Vehicle Fleets configured._');
  } else {
    vehicleFleets.forEach((fleet, idx) => {
      const fleetSeats = fleet.count * fleet.capacityPerUnit;
      const spdKmh = fleet.transitSpeedKmh ?? 25;
      const loadSec = fleet.loadUnloadTimePerPersonSeconds ?? 2;
      const fullLoadSec = fleet.capacityPerUnit * loadSec;
      lines.push(
        `${idx + 1}. **${fleet.name}** (\`id: ${fleet.id}\`, Type: \`${fleet.type}\`) — **${fleet.count} units** × **${fleet.capacityPerUnit} pax/unit** = **${fleetSeats.toLocaleString()} total seats**`
      );
      lines.push(
        `   - **Staging Depot**: \`[${fleet.location[0].toFixed(5)}, ${fleet.location[1].toFixed(5)}]\` | **Transit Speed**: \`${spdKmh} km/h\` (${((spdKmh * 1000) / 3600).toFixed(2)} m/s) | **Load/Unload Rate**: \`${loadSec}s/pax\` (${fullLoadSec.toFixed(0)}s per full ${fleet.capacityPerUnit}-pax unit load or unload)`
      );
    });
  }
  lines.push('');

  // 2.6 Computed Evacuation Routes & Active Overlays
  lines.push(`### 2.6 Computed Street Evacuation Corridors (${computedRoutes.length} routes)`);
  if (computedRoutes.length === 0) {
    lines.push('_No street evacuation routes computed._');
  } else {
    computedRoutes.forEach((r, idx) => {
      const distKm = r.distanceMeters / 1000;
      const dropOff =
        r.dropOffLocation ||
        (r.coordinates.length > 0 ? r.coordinates[r.coordinates.length - 1] : r.pickupLocation);
      lines.push(
        `${idx + 1}. **${r.pickupLabel}** (\`${r.sourceName} -> ${r.targetName}\`, \`id: ${r.id}\`): Distance \`${distKm.toFixed(2)} km\`, Est. One-Way Transit \`${formatMMSS(
          r.estimatedDurationSeconds
        )}\` (${Math.round(r.estimatedDurationSeconds)}s), Assigned Pop: \`${r.assignedPopulation.toLocaleString()}\`, Pickup \`[${r.pickupLocation[0].toFixed(5)}, ${r.pickupLocation[1].toFixed(5)}]\` -> Drop-Off \`[${dropOff[0].toFixed(5)}, ${dropOff[1].toFixed(5)}]\`, Detour: **${
          r.isDetour ? `YES (Avoided: ${r.avoidedRedAreaNames.join(', ')})` : 'No (Direct)'
        }**`
      );
    });
  }

  const visibleOverlays = (dataOverlays || []).filter((o) => o.visible);
  const activeSpaceLayers: string[] = [];
  if (sentinel2Layer?.active) {
    activeSpaceLayers.push(
      `Sentinel-2 Optical RGB (${sentinel2Layer.dateRange[0]} to ${sentinel2Layer.dateRange[1]}, ${sentinel2Layer.imageCount} scenes)`
    );
  }
  if (sentinel1Layer?.active) {
    activeSpaceLayers.push(
      `Sentinel-1 SAR False Color (${sentinel1Layer.dateRange[0]} to ${sentinel1Layer.dateRange[1]}, ${sentinel1Layer.imageCount} scenes)`
    );
  }
  if (glofasForecast?.active) {
    activeSpaceLayers.push(
      `CEMS GloFAS River Discharge Forecast (24h/48h/72h around ${glofasForecast.date}, clip max ${glofasForecast.clipMax} m³/s)`
    );
  }
  visibleOverlays.forEach((ov) => activeSpaceLayers.push(`Overlay: ${ov.name} (${ov.format})`));
  if (activeSpaceLayers.length > 0) {
    lines.push(`- **Active Earth Observation / Hazard Overlays**: ${activeSpaceLayers.join('; ')}`);
  }
  lines.push('');

  // =========================================================================
  // 3. MULTI-DIMENSIONAL SIMULATION SUMMARY (6 REQUIRED DIMENSIONS)
  // =========================================================================
  lines.push('## 3. Comprehensive Simulation Summary & Disaggregated Telemetry');
  lines.push('');
  lines.push('### 3.0 Global KPI Summary');
  lines.push(`- **Total Initial Population**: ${totalInitialPopulation.toLocaleString()} pax`);
  lines.push(
    `- **Evacuated to Safe Shelters**: **${totalEvacuated.toLocaleString()} pax (${completionPct.toFixed(2)}%)**`
  );
  lines.push(
    `- **Still Not Evacuated**: **${totalNotEvacuated.toLocaleString()} pax (${(
      100 - completionPct
    ).toFixed(2)}%)**`
  );
  lines.push(
    `  - Walking inside Source Areas: ${(
      movingInZoneByBehavior.compliant +
      movingInZoneByBehavior['self-directed'] +
      movingInZoneByBehavior.disoriented
    ).toLocaleString()} pax`
  );
  lines.push(
    `  - Waiting in Queues at Pickup Points: ${(
      waitingInQueueByBehavior.compliant +
      waitingInQueueByBehavior['self-directed'] +
      waitingInQueueByBehavior.disoriented
    ).toLocaleString()} pax`
  );
  lines.push(
    `  - Currently Boarding Waiting Vehicles at Pickups: ${(
      boardingInVehiclesByBehavior.compliant +
      boardingInVehiclesByBehavior['self-directed'] +
      boardingInVehiclesByBehavior.disoriented
    ).toLocaleString()} pax`
  );
  lines.push(
    `  - In Transit / Unloading on Vehicles: ${totalInTransit.toLocaleString()} pax`
  );
  lines.push(
    `- **Overall Mean Pedestrian Time to Reach Pickup**: ${fmtMeanSec(
      globalWalkPersonSec.compliant +
        globalWalkPersonSec['self-directed'] +
        globalWalkPersonSec.disoriented,
      globalWalkArrived.compliant +
        globalWalkArrived['self-directed'] +
        globalWalkArrived.disoriented
    )}`
  );
  lines.push(
    `- **Overall Mean Pickup Queue Wait Time per Boarded/Arrived Evacuee**: ${fmtMeanSec(
      globalQueueWaitPersonSec.compliant +
        globalQueueWaitPersonSec['self-directed'] +
        globalQueueWaitPersonSec.disoriented,
      Math.max(
        1,
        globalWalkArrived.compliant +
          globalWalkArrived['self-directed'] +
          globalWalkArrived.disoriented
      )
    )}`
  );
  lines.push(
    `- **Overall Mean Time Onboard Vehicles (Boarding + Transit + Unloading)**: ${fmtMeanSec(
      globalInVehiclePersonSec.compliant +
        globalInVehiclePersonSec['self-directed'] +
        globalInVehiclePersonSec.disoriented,
      Math.max(1, totalBoardedAllPickups)
    )}`
  );
  lines.push(
    `- **Overall Mean End-to-End Evacuation Time (t=0 to Shelter Offload)**: ${fmtMeanSec(
      globalEvacPersonSec.compliant +
        globalEvacPersonSec['self-directed'] +
        globalEvacPersonSec.disoriented,
      totalEvacuated
    )}`
  );
  lines.push(
    `- **System Evacuation Throughput**: \`${overallThroughputPaxPerMin.toFixed(2)} pax/min\` delivered to shelter | **System Boarding Rate**: \`${boardingRatePaxPerMin.toFixed(2)} pax/min\` boarded | **Completed Vehicle/Train Trips**: \`${telemetryStats?.totalCompletedVehicleTrips || 0}\``
  );
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (1): Metrics per Source Area and per Target Area
  // -------------------------------------------------------------------------
  lines.push('### 3.1 (1) Metrics per Source Area & per Target Area');
  lines.push('#### A. Source Areas — Population Stage Counts & Disaggregated Timings by Behavior');
  sourceAreas.forEach((src, idx) => {
    const srcPickups = pickupStates.filter((p) => p.sourceId === src.id);
    const movingByBeh = movingBySourceAndBehavior.get(src.id) || createZeroBehaviorCounts();
    const queueByBeh = createZeroBehaviorCounts();
    const boardedByBeh = createZeroBehaviorCounts();
    const evacByBeh = createZeroBehaviorCounts();
    const arrivedByBeh = createZeroBehaviorCounts();
    const walkPersonSecByBeh = createZeroBehaviorCounts();
    const waitPersonSecByBeh = createZeroBehaviorCounts();
    const inVehPersonSecByBeh = createZeroBehaviorCounts();
    const evacPersonSecByBeh = createZeroBehaviorCounts();

    srcPickups.forEach((p) => {
      BEHAVIORS.forEach((b) => {
        queueByBeh[b] += p.waitingByBehavior?.[b] || 0;
        boardedByBeh[b] += p.boardedByBehavior?.[b] || 0;
        evacByBeh[b] += p.evacuatedByBehavior?.[b] || 0;
        arrivedByBeh[b] += p.arrivedByBehavior?.[b] || 0;
        walkPersonSecByBeh[b] += p.arrivedPersonSecondsByBehavior?.[b] || 0;
        waitPersonSecByBeh[b] += p.passengerWaitPersonSecondsByBehavior?.[b] || 0;
        inVehPersonSecByBeh[b] += p.inVehiclePersonSecondsByBehavior?.[b] || 0;
        evacPersonSecByBeh[b] += p.evacuatedPersonSecondsByBehavior?.[b] || 0;
      });
    });

    const boardingVehByBeh = createZeroBehaviorCounts();
    const transitVehByBeh = createZeroBehaviorCounts();
    vehicles
      .filter((v) => v.sourceId === src.id)
      .forEach((v) => {
        const occ = v.occupancyByBehavior || createZeroBehaviorCounts();
        if (v.status === 'waiting_for_80_pct') {
          BEHAVIORS.forEach((b) => {
            boardingVehByBeh[b] += occ[b] || 0;
          });
        } else if (v.status === 'to_target' || v.status === 'unloading') {
          BEHAVIORS.forEach((b) => {
            transitVehByBeh[b] += occ[b] || 0;
          });
        }
      });

    const totalMoving =
      movingByBeh.compliant + movingByBeh['self-directed'] + movingByBeh.disoriented;
    const totalQueue =
      queueByBeh.compliant + queueByBeh['self-directed'] + queueByBeh.disoriented;
    const totalBoarding =
      boardingVehByBeh.compliant +
      boardingVehByBeh['self-directed'] +
      boardingVehByBeh.disoriented;
    const totalTransit =
      transitVehByBeh.compliant +
      transitVehByBeh['self-directed'] +
      transitVehByBeh.disoriented;
    const totalEvac =
      evacByBeh.compliant + evacByBeh['self-directed'] + evacByBeh.disoriented;
    const totalInit = hasActiveEntities
      ? totalMoving + totalQueue + totalBoarding + totalTransit + totalEvac
      : src.population;
    const srcPct = totalInit > 0 ? (totalEvac / totalInit) * 100 : 0;

    lines.push(
      `- **Source Area ${idx + 1}: ${src.name}** (${src.disabled ? 'DISABLED' : 'ACTIVE'}):`
    );
    lines.push(
      `  - **Progress**: Evacuated **${totalEvac.toLocaleString()} / ${totalInit.toLocaleString()} (${srcPct.toFixed(1)}%)** | In Transit/Unloading: ${totalTransit.toLocaleString()} | Boarding on Waiting Vehicles: ${totalBoarding.toLocaleString()} | Waiting in Pickup Queues: ${totalQueue.toLocaleString()} | Still Walking in Zone: ${totalMoving.toLocaleString()}`
    );
    BEHAVIORS.forEach((b) => {
      const label =
        b === 'compliant'
          ? 'Compliant'
          : b === 'self-directed'
          ? 'Self-Directed'
          : 'Disoriented';
      lines.push(
        `  - **${label}**: Evacuated=${evacByBeh[b]}, InTransit=${transitVehByBeh[b]}, Boarding=${boardingVehByBeh[b]}, QueueWaiting=${queueByBeh[b]}, WalkingInZone=${movingByBeh[b]} | Mean Time to Pickup=${fmtMeanSec(
          walkPersonSecByBeh[b],
          arrivedByBeh[b]
        )} | Mean Queue Wait=${fmtMeanSec(
          waitPersonSecByBeh[b],
          arrivedByBeh[b]
        )} | Mean Time in Vehicle=${fmtMeanSec(
          inVehPersonSecByBeh[b],
          boardedByBeh[b]
        )} | Mean Total Evacuation Time=${fmtMeanSec(evacPersonSecByBeh[b], evacByBeh[b])}`
      );
    });
  });
  lines.push('');

  lines.push('#### B. Target Areas — Shelter Utilization, Modal Split & Arrival Timings');
  targetAreas.forEach((tgt, idx) => {
    const tgtPickups = pickupStates.filter((p) => p.targetId === tgt.id);
    const streetDelivered = tgtPickups
      .filter((p) => !p.isMetro)
      .reduce((acc, p) => acc + (p.evacuatedCount || 0), 0);
    const metroDelivered = tgtPickups
      .filter((p) => p.isMetro)
      .reduce((acc, p) => acc + (p.evacuatedCount || 0), 0);
    const evacByBeh = createZeroBehaviorCounts();
    let totalEvacPersonSec = 0;
    let totalEvacCount = 0;
    tgtPickups.forEach((p) => {
      BEHAVIORS.forEach((b) => {
        evacByBeh[b] += p.evacuatedByBehavior?.[b] || 0;
        totalEvacPersonSec += p.evacuatedPersonSecondsByBehavior?.[b] || 0;
        totalEvacCount += p.evacuatedByBehavior?.[b] || 0;
      });
    });
    const inboundVehicles = vehicles.filter(
      (v) => v.targetId === tgt.id && (v.status === 'to_target' || v.status === 'unloading')
    );
    const inboundPax = inboundVehicles.reduce((acc, v) => acc + v.currentOccupancy, 0);
    const utilPct = tgt.capacity > 0 ? (tgt.currentOccupancy / tgt.capacity) * 100 : 0;

    lines.push(
      `- **Target Shelter ${idx + 1}: ${tgt.name}** (${tgt.disabled ? 'DISABLED' : 'ACTIVE'}):`
    );
    lines.push(
      `  - **Occupancy**: **${tgt.currentOccupancy.toLocaleString()} / ${tgt.capacity.toLocaleString()} (${utilPct.toFixed(1)}%)** | Remaining Headroom: ${Math.max(
        0,
        tgt.capacity - tgt.currentOccupancy
      ).toLocaleString()} pax | Inbound on Vehicles/Unloading: ${inboundPax.toLocaleString()} pax (${inboundVehicles.length} active units)`
    );
    lines.push(
      `  - **Modal & Behavioral Delivery Split**: Street Vehicles=${streetDelivered.toLocaleString()} pax, Brussels Metro=${metroDelivered.toLocaleString()} pax | Compliant=${evacByBeh.compliant.toLocaleString()}, Self-Directed=${evacByBeh['self-directed'].toLocaleString()}, Disoriented=${evacByBeh.disoriented.toLocaleString()} | Mean End-to-End Arrival Time=${fmtMeanSec(
        totalEvacPersonSec,
        totalEvacCount
      )}`
    );
  });
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (2): Metrics per Pickup Point
  // -------------------------------------------------------------------------
  lines.push(`### 3.2 (2) Metrics per Pickup Point (${pickupStates.length} Pickup Locations)`);
  if (pickupStates.length === 0) {
    lines.push('_No active pickup points._');
  } else {
    pickupStates.forEach((p, idx) => {
      const waitingVehs = vehicles.filter(
        (v) => v.assignedPickupId === p.id && v.status === 'waiting_for_80_pct'
      );
      const onboardWaiting = waitingVehs.reduce((acc, v) => acc + v.currentOccupancy, 0);
      const inTransitPax = vehicles
        .filter(
          (v) =>
            v.assignedPickupId === p.id &&
            (v.status === 'to_target' || v.status === 'unloading')
        )
        .reduce((acc, v) => acc + v.currentOccupancy, 0);
      const completedDeps = p.completedDeparturesCount || 0;
      const activeWaitSecSum = waitingVehs.reduce(
        (acc, v) => acc + v.waitingAtPickupSeconds,
        0
      );
      const waitObs = completedDeps + waitingVehs.length;
      const meanVehWaitSec =
        waitObs > 0
          ? ((p.totalCompletedVehicleWaitSeconds || 0) + activeWaitSecSum) / waitObs
          : null;
      const avgLoadFactorPct =
        completedDeps > 0
          ? ((p.totalDepartureOccupancyRatioSum || 0) / completedDeps) * 100
          : null;
      const totArrived =
        (p.arrivedByBehavior?.compliant || 0) +
        (p.arrivedByBehavior?.['self-directed'] || 0) +
        (p.arrivedByBehavior?.disoriented || 0);
      const totWalkSec =
        (p.arrivedPersonSecondsByBehavior?.compliant || 0) +
        (p.arrivedPersonSecondsByBehavior?.['self-directed'] || 0) +
        (p.arrivedPersonSecondsByBehavior?.disoriented || 0);
      const totQueueWaitSec =
        (p.passengerWaitPersonSecondsByBehavior?.compliant || 0) +
        (p.passengerWaitPersonSecondsByBehavior?.['self-directed'] || 0) +
        (p.passengerWaitPersonSecondsByBehavior?.disoriented || 0);

      lines.push(
        `${idx + 1}. **${p.label}** (\`id: ${p.id}\`, Mode: **${
          p.isMetro ? `Metro Station [${p.metroLine || 'STIB'}]` : 'Street Blue Square'
        }**, Source: \`${p.sourceName}\` -> Target: \`${p.targetName}\`, Coords: \`[${p.location[0].toFixed(5)}, ${p.location[1].toFixed(5)}]\`)`
      );
      lines.push(
        `   - **Passenger Volumes**: Arrived=${totArrived.toLocaleString()} | Active Queue=${p.waitingPopulation.toLocaleString()} (Cp:${p.waitingByBehavior?.compliant || 0}, Sd:${p.waitingByBehavior?.['self-directed'] || 0}, Ds:${p.waitingByBehavior?.disoriented || 0}) | Onboard Waiting Veh=${onboardWaiting.toLocaleString()} | Total Boarded=${(p.totalBoardedCount || 0).toLocaleString()} (Cp:${p.boardedByBehavior?.compliant || 0}, Sd:${p.boardedByBehavior?.['self-directed'] || 0}, Ds:${p.boardedByBehavior?.disoriented || 0}) | In Transit=${inTransitPax.toLocaleString()} | Delivered to Shelter=${(p.evacuatedCount || 0).toLocaleString()} (Cp:${p.evacuatedByBehavior?.compliant || 0}, Sd:${p.evacuatedByBehavior?.['self-directed'] || 0}, Ds:${p.evacuatedByBehavior?.disoriented || 0})`
      );
      lines.push(
        `   - **Passenger & Vehicle Timings**: Mean Walk Time to Pickup=${fmtMeanSec(
          totWalkSec,
          totArrived
        )} [Cp:${fmtMeanSec(
          p.arrivedPersonSecondsByBehavior?.compliant || 0,
          p.arrivedByBehavior?.compliant || 0
        )}, Sd:${fmtMeanSec(
          p.arrivedPersonSecondsByBehavior?.['self-directed'] || 0,
          p.arrivedByBehavior?.['self-directed'] || 0
        )}, Ds:${fmtMeanSec(
          p.arrivedPersonSecondsByBehavior?.disoriented || 0,
          p.arrivedByBehavior?.disoriented || 0
        )}] | Mean Passenger Queue Wait=${fmtMeanSec(
          totQueueWaitSec,
          totArrived
        )} | Completed Vehicle Departures=${completedDeps} (Active Waiting Veh=${waitingVehs.length}) | Mean Vehicle Dwell Time=${
          meanVehWaitSec !== null ? `${formatMMSS(meanVehWaitSec)} (${meanVehWaitSec.toFixed(1)}s)` : 'N/A'
        } (Peak=${formatMMSS(p.maxVehicleWaitSeconds || 0)}) | Avg Departure Load Factor=${
          avgLoadFactorPct !== null ? `${avgLoadFactorPct.toFixed(1)}%` : 'N/A'
        }`
      );
    });
  }
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (3): Metrics per Drop-Off Point
  // -------------------------------------------------------------------------
  interface DropOffPointGroup {
    key: string;
    label: string;
    isMetro: boolean;
    targetId: string;
    targetName: string;
    coords: [number, number];
    sourceNames: Set<string>;
    pickupLabels: Set<string>;
    evacuatedTotal: number;
    evacuatedByBehavior: BehaviorCounts;
    inTransitPax: number;
    unloadingPax: number;
    completedDeparturesFromPickups: number;
    evacPersonSecTotal: number;
    inVehiclePersonSecTotal: number;
    boardedTotal: number;
  }

  const dropOffMap = new Map<string, DropOffPointGroup>();
  pickupStates.forEach((p) => {
    const matchedRoute = computedRoutes.find((r) => r.id === p.routeId);
    const coords: [number, number] =
      p.dropOffLocation ||
      matchedRoute?.dropOffLocation ||
      (matchedRoute?.coordinates && matchedRoute.coordinates.length > 0
        ? matchedRoute.coordinates[matchedRoute.coordinates.length - 1]
        : p.location);
    const key = p.isMetro
      ? `metro-dropoff-${p.metroTargetStationName || p.targetId}`
      : `street-dropoff-${p.targetId}-${coords[0].toFixed(4)}-${coords[1].toFixed(4)}`;
    const label = p.isMetro
      ? `Metro Drop-Off: ${p.metroTargetStationName || p.targetName} (${p.targetName})`
      : `Shelter Drop-Off: ${p.targetName} [${coords[0].toFixed(4)}, ${coords[1].toFixed(4)}]`;

    const existing = dropOffMap.get(key) || {
      key,
      label,
      isMetro: Boolean(p.isMetro),
      targetId: p.targetId,
      targetName: p.targetName,
      coords,
      sourceNames: new Set<string>(),
      pickupLabels: new Set<string>(),
      evacuatedTotal: 0,
      evacuatedByBehavior: createZeroBehaviorCounts(),
      inTransitPax: 0,
      unloadingPax: 0,
      completedDeparturesFromPickups: 0,
      evacPersonSecTotal: 0,
      inVehiclePersonSecTotal: 0,
      boardedTotal: 0,
    };

    existing.sourceNames.add(p.sourceName);
    existing.pickupLabels.add(p.label);
    existing.evacuatedTotal += p.evacuatedCount || 0;
    existing.boardedTotal += p.totalBoardedCount || 0;
    existing.completedDeparturesFromPickups += p.completedDeparturesCount || 0;
    BEHAVIORS.forEach((b) => {
      existing.evacuatedByBehavior[b] += p.evacuatedByBehavior?.[b] || 0;
      existing.evacPersonSecTotal += p.evacuatedPersonSecondsByBehavior?.[b] || 0;
      existing.inVehiclePersonSecTotal += p.inVehiclePersonSecondsByBehavior?.[b] || 0;
    });

    vehicles
      .filter((v) => v.assignedPickupId === p.id)
      .forEach((v) => {
        if (v.status === 'to_target') {
          existing.inTransitPax += v.currentOccupancy;
        } else if (v.status === 'unloading') {
          existing.unloadingPax += v.currentOccupancy;
        }
      });

    dropOffMap.set(key, existing);
  });

  const dropOffList = Array.from(dropOffMap.values());
  lines.push(`### 3.3 (3) Metrics per Drop-Off Point (${dropOffList.length} Drop-Off Locations)`);
  if (dropOffList.length === 0) {
    lines.push('_No active drop-off points._');
  } else {
    dropOffList.forEach((d, idx) => {
      lines.push(
        `${idx + 1}. **${d.label}** (Parent Shelter: \`${d.targetName}\`, Mode: **${
          d.isMetro ? 'Underground Metro' : 'Street Vehicle'
        }**, Coords: \`[${d.coords[0].toFixed(5)}, ${d.coords[1].toFixed(5)}]\`)`
      );
      lines.push(
        `   - **Fed by Sources**: ${Array.from(d.sourceNames).join(', ')} | **Serving Pickups**: ${Array.from(
          d.pickupLabels
        ).join('; ')}`
      );
      lines.push(
        `   - **Offload & Inbound Volumes**: Total Offloaded to Shelter=**${d.evacuatedTotal.toLocaleString()} pax** (Cp:${d.evacuatedByBehavior.compliant.toLocaleString()}, Sd:${d.evacuatedByBehavior['self-directed'].toLocaleString()}, Ds:${d.evacuatedByBehavior.disoriented.toLocaleString()}) | Currently Unloading at Drop-Off=${d.unloadingPax.toLocaleString()} pax | En Route to Drop-Off=${d.inTransitPax.toLocaleString()} pax | Dispatched Convoys=${d.completedDeparturesFromPickups}`
      );
      lines.push(
        `   - **Timings**: Mean In-Vehicle Duration=${fmtMeanSec(
          d.inVehiclePersonSecTotal,
          d.boardedTotal
        )} | Mean Total Evacuation Time at Drop-Off=${fmtMeanSec(
          d.evacPersonSecTotal,
          d.evacuatedTotal
        )}`
      );
    });
  }
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (4): Metrics per Population Type
  // -------------------------------------------------------------------------
  lines.push('### 3.4 (4) Metrics per Population Behavior Type (`compliant`, `self-directed`, `disoriented`)');
  BEHAVIORS.forEach((b) => {
    const title =
      b === 'compliant'
        ? 'Compliant (Direct walk at 5 km/h to closest pickup)'
        : b === 'self-directed'
        ? 'Self-Directed (Random zig-zag +/-22..50° at 5 km/h with occasional 1.2-2.4s brief reversals)'
        : 'Disoriented (2D Brownian diffusion + stochastic pickup drift at 5 km/h; direct capture within 135m/160m)';
    const initB = initialByBehavior[b];
    const evacB = evacuatedByBehavior[b];
    const notEvacB = notEvacuatedByBehavior[b];
    const pctB = initB > 0 ? (evacB / initB) * 100 : 0;
    const totalBoardedB = pickupStates.reduce(
      (acc, p) => acc + (p.boardedByBehavior?.[b] || 0),
      0
    );

    lines.push(`- **${title}**:`);
    lines.push(
      `  - **Headcounts**: Initial=${initB.toLocaleString()} pax | Evacuated=**${evacB.toLocaleString()} pax (${pctB.toFixed(1)}%)** | Remaining Un-evacuated=**${notEvacB.toLocaleString()} pax** (Walking in Zone=${movingInZoneByBehavior[b].toLocaleString()}, Waiting in Pickup Queue=${waitingInQueueByBehavior[b].toLocaleString()}, Boarding Waiting Vehicles=${boardingInVehiclesByBehavior[b].toLocaleString()}, In Transit/Unloading=${inTransitByBehavior[b].toLocaleString()})`
    );
    lines.push(
      `  - **Stage Timings**: Mean Walk Time to Pickup=${fmtMeanSec(
        globalWalkPersonSec[b],
        globalWalkArrived[b]
      )} | Mean Pickup Queue Wait=${fmtMeanSec(
        globalQueueWaitPersonSec[b],
        globalWalkArrived[b]
      )} | Mean Time in Vehicle=${fmtMeanSec(
        globalInVehiclePersonSec[b],
        totalBoardedB
      )} | Mean End-to-End Evacuation Time=**${fmtMeanSec(globalEvacPersonSec[b], evacB)}**`
    );
  });
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (5): Metrics per Vehicle Fleet & Active Units
  // -------------------------------------------------------------------------
  lines.push('### 3.5 (5) Metrics per Vehicle Fleet (Street Fleets & Underground Metro Fleet)');
  const allFleetGroups: {
    id: string;
    name: string;
    isMetro: boolean;
    typeLabel: string;
    configuredUnits: number;
    capacityPerUnit: number;
    speedKmh: number;
    loadUnloadSec: number;
    units: ActiveVehicleUnit[];
  }[] = vehicleFleets.map((f) => ({
    id: f.id,
    name: f.name,
    isMetro: false,
    typeLabel: f.type,
    configuredUnits: f.count,
    capacityPerUnit: f.capacityPerUnit,
    speedKmh: f.transitSpeedKmh ?? 25,
    loadUnloadSec: f.loadUnloadTimePerPersonSeconds ?? 2,
    units: vehicles.filter((v) => v.fleetId === f.id && !v.isMetro),
  }));

  const metroVehicleUnits = vehicles.filter((v) => v.isMetro || v.vehicleType === 'Metro');
  if (metroVehicleUnits.length > 0 || (hasBrusselsAreas && brusselsMetroConfig.useForEvacuation)) {
    allFleetGroups.push({
      id: 'brussels-metro-fleet',
      name: 'STIB Brussels Metro Underground Trains',
      isMetro: true,
      typeLabel: 'Metro',
      configuredUnits: brusselsMetroConfig.trainCount,
      capacityPerUnit: brusselsMetroConfig.trainCapacity,
      speedKmh: 45,
      loadUnloadSec: 0.2,
      units: metroVehicleUnits,
    });
  }

  allFleetGroups.forEach((fg, idx) => {
    const statusCounts = {
      to_pickup: 0,
      waiting_for_80_pct: 0,
      to_target: 0,
      unloading: 0,
      completed: 0,
    };
    let trips = 0;
    let boarded = 0;
    let delivered = 0;
    let currentOnboard = 0;
    let distMeters = 0;
    let driveSec = 0;
    let waitSec = 0;
    let unloadSec = 0;
    let reassignments = 0;

    fg.units.forEach((u) => {
      statusCounts[u.status] = (statusCounts[u.status] || 0) + u.unitCount;
      trips += u.totalTripsCompleted || 0;
      boarded += u.totalPassengersBoarded || 0;
      delivered += u.totalPassengersDelivered || 0;
      currentOnboard += u.currentOccupancy || 0;
      distMeters += u.totalDistanceTraveledMeters || 0;
      driveSec += u.totalDrivingSeconds || 0;
      waitSec += u.totalWaitingSeconds || 0;
      unloadSec += u.totalUnloadingSeconds || 0;
      reassignments += u.reassignmentCount || 0;
    });

    const totalUnitTime = driveSec + waitSec + unloadSec;
    const driveSharePct = totalUnitTime > 0 ? (driveSec / totalUnitTime) * 100 : 0;
    const waitSharePct = totalUnitTime > 0 ? (waitSec / totalUnitTime) * 100 : 0;
    const unloadSharePct = totalUnitTime > 0 ? (unloadSec / totalUnitTime) * 100 : 0;
    const shareOfEvacPct = totalEvacuated > 0 ? (delivered / totalEvacuated) * 100 : 0;

    lines.push(
      `${idx + 1}. **${fg.name}** (\`${fg.typeLabel}\`, ${fg.configuredUnits} units × ${fg.capacityPerUnit} pax = ${(
        fg.configuredUnits * fg.capacityPerUnit
      ).toLocaleString()} seats, Speed \`${fg.speedKmh} km/h\`, Load/Unload \`${fg.loadUnloadSec}s/pax\`):`
    );
    lines.push(
      `   - **Throughput & Utilization**: Total Boarded=**${boarded.toLocaleString()} pax** | Delivered to Shelter=**${delivered.toLocaleString()} pax (${shareOfEvacPct.toFixed(1)}% of total evacuated)** | Currently Onboard=${currentOnboard.toLocaleString()} pax | Completed Delivery Trips=${trips} | Dynamic Reassignments=${reassignments} | Total Distance Traveled=\`${(
        distMeters / 1000
      ).toFixed(2)} km\``
    );
    lines.push(
      `   - **Unit State Breakdown**: Driving to Pickup=${statusCounts.to_pickup}, Waiting/Boarding at Pickup=${statusCounts.waiting_for_80_pct}, Driving to Shelter=${statusCounts.to_target}, Unloading at Shelter=${statusCounts.unloading}, Completed/Idle=${statusCounts.completed}`
    );
    lines.push(
      `   - **Cumulative Time Allocation**: Driving \`${formatMMSS(driveSec)}\` (${driveSharePct.toFixed(1)}%) | Waiting/Loading at Pickup \`${formatMMSS(waitSec)}\` (${waitSharePct.toFixed(1)}%) | Unloading at Shelter \`${formatMMSS(unloadSec)}\` (${unloadSharePct.toFixed(1)}%)`
    );
  });
  lines.push('');

  // -------------------------------------------------------------------------
  // DIMENSION (6): Metrics Regarding Usage of Brussels Metro Lines
  // -------------------------------------------------------------------------
  lines.push('### 3.6 (6) Metrics Regarding Brussels Metro Lines Usage During Evaluation');
  if (!hasBrusselsAreas) {
    lines.push(
      '- Scenario areas lie outside the Brussels Metro regional bounding box; underground metro transit does not apply.'
    );
  } else {
    const metroPickups = pickupStates.filter((p) => p.isMetro);
    const totalMetroEvac = metroPickups.reduce((acc, p) => acc + (p.evacuatedCount || 0), 0);
    const totalMetroBoarded = metroPickups.reduce(
      (acc, p) => acc + (p.totalBoardedCount || 0),
      0
    );
    const totalMetroQueue = metroPickups.reduce((acc, p) => acc + p.waitingPopulation, 0);
    const metroSharePct = totalEvacuated > 0 ? (totalMetroEvac / totalEvacuated) * 100 : 0;

    lines.push(
      `- **Metro Stations Matched in Source Areas (${sourceMetroStations.length})**: ${
        sourceMetroStations.length > 0
          ? sourceMetroStations
              .map(
                (m) =>
                  `${m.station.name_fr} (in "${m.areaName}"${
                    m.disabled ? ' [DISABLED]' : ''
                  }, Lines: ${m.station.lines.join(',')})`
              )
              .join('; ')
          : 'None'
      }`
    );
    lines.push(
      `- **Metro Stations Matched in Target Areas (${targetMetroStations.length})**: ${
        targetMetroStations.length > 0
          ? targetMetroStations
              .map(
                (m) =>
                  `${m.station.name_fr} (in "${m.areaName}"${
                    m.disabled ? ' [DISABLED]' : ''
                  }, Lines: ${m.station.lines.join(',')})`
              )
              .join('; ')
          : 'None'
      }`
    );
    lines.push(
      `- **Underground Metro Evacuation Active in Run**: **${
        brusselsMetroConfig.useForEvacuation ? 'YES (ENABLED)' : 'NO (DISABLED)'
      }** | Configured Fleet: \`${brusselsMetroConfig.trainCount} trains\` × \`${brusselsMetroConfig.trainCapacity} pax\` (\`${(
        brusselsMetroConfig.trainCount * brusselsMetroConfig.trainCapacity
      ).toLocaleString()} simultaneous train seats\`)`
    );
    lines.push(
      `- **Metro Modal Contribution**: Boarded=${totalMetroBoarded.toLocaleString()} pax | Delivered to Shelter=**${totalMetroEvac.toLocaleString()} pax (${metroSharePct.toFixed(1)}% of all evacuated)** | Current Platform Queue=${totalMetroQueue.toLocaleString()} pax`
    );

    if (metroCorridors.length > 0) {
      lines.push(`- **Identified STIB Underground Corridors (${metroCorridors.length})**:`);
      metroCorridors.forEach((mc, i) => {
        const matchingPickup = metroPickups.find(
          (p) => p.metroStationName === mc.sourceStation.name_fr && p.targetId === mc.targetId
        );
        lines.push(
          `  ${i + 1}. **${mc.sourceStation.name_fr}** (\`${mc.sourceName}\`) -> **${mc.targetStation.name_fr}** (\`${mc.targetName}\`) via **${mc.lineLabel}** (\`${(
            mc.distanceMeters / 1000
          ).toFixed(2)} km\`, one-way rail time \`${formatMMSS(
            mc.distanceMeters / (45000 / 3600)
          )}\` @ 45 km/h)${
            matchingPickup
              ? ` — Boarded: ${matchingPickup.totalBoardedCount}, Delivered: ${matchingPickup.evacuatedCount}, Queue: ${matchingPickup.waitingPopulation}`
              : ''
          }`
        );
      });
    }
  }
  lines.push('');

  // =========================================================================
  // 4. TELEMETRY TIME-SERIES & SIMULATION EVENT LOGS
  // =========================================================================
  lines.push('## 4. Telemetry Time-Series & Chronological Simulation Events');
  const rawSeries = telemetryStats?.evacuationTimeSeries || [];
  if (rawSeries.length > 0) {
    // Downsample to at most 25 milestone points so the prompt stays compact yet complete
    const step = Math.max(1, Math.ceil(rawSeries.length / 25));
    const sampled = rawSeries.filter(
      (_, idx) => idx === 0 || idx === rawSeries.length - 1 || idx % step === 0
    );
    lines.push('### 4.1 Evacuation Cumulative Curve (`evacuationTimeSeries` Milestones)');
    lines.push(
      sampled
        .map((pt) => `\`T+${formatMMSS(pt.timeSeconds)}\`: ${pt.evacuatedCount.toLocaleString()} pax`)
        .join(' -> ')
    );
    lines.push('');
  }

  lines.push(`### 4.2 Captured Simulation Event Log (${logs.length} total log entries)`);
  if (logs.length === 0) {
    lines.push('_No simulation log events recorded yet._');
  } else {
    const maxLogsToInclude = 120;
    const selectedLogs =
      logs.length <= maxLogsToInclude
        ? logs
        : [
            ...logs.slice(0, 40),
            {
              id: 'omitted-marker',
              timestamp: '...',
              twinTimeFormatted: '...',
              level: 'INFO' as const,
              message: `[... ${logs.length - maxLogsToInclude} intermediate routine log entries omitted for brevity; ${logs.length} total events ...]`,
            },
            ...logs.slice(logs.length - 80),
          ];
    lines.push('```log');
    selectedLogs.forEach((entry) => {
      lines.push(`[T+${entry.twinTimeFormatted} | ${entry.level}] ${entry.message}`);
    });
    lines.push('```');
  }
  lines.push('');

  // =========================================================================
  // 5. REQUIRED ASSESSMENT & OPTIMIZATION DELIVERABLES
  // =========================================================================
  lines.push('## 5. Required Structure of Your AI Assessment');
  lines.push(
    'Based on the **User Instructions for AI Assessment** (Section 1) and all quantitative parameters, disaggregated timings, pickup/drop-off queues, fleet utilization, and event logs above, provide a thorough, data-backed engineering assessment structured into:'
  );
  lines.push(
    '1. **Executive Performance Summary**: Overall clearance performance, bottlenecks governing total evacuation time, and behavioral equity across `compliant`, `self-directed`, and `disoriented` populations.'
  );
  lines.push(
    '2. **Assets Efficiency Analysis**: Quantitative evaluation of every street Vehicle Fleet, individual pickup & drop-off point load factors and dwell times, Target Shelter headroom distribution, and Brussels Metro train utilization.'
  );
  lines.push(
    '3. **Contingency Points & Bottleneck Identification**: Pinpoint exact choke points (e.g., high-wait pickup squares, under-served large-polygon source zones with long pedestrian walk times, Red Area detours inflating round-trip transit time, shelter capacity bottlenecks, or fleet imbalances).'
  );
  lines.push(
    '4. **Concrete Parameter Optimization Plan**: Specific, actionable parameter changes in EVAC-TWIN (fleet unit counts, capacities per unit, depot locations, transit speeds, load/unload rates, enabling/scaling Brussels Metro trains, adding/enabling Target Shelters, or adjusting Source Area pickup coverage) with estimated quantitative impact on total evacuation clearance time.'
  );

  return lines.join('\n');
}
