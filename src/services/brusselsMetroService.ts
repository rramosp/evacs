import * as turf from '@turf/turf';
import {
  SourceArea,
  TargetArea,
  BrusselsMetroLineFeature,
  BrusselsMetroStationFeature,
  BrusselsMetroMatchedStation,
  BrusselsMetroCorridor,
} from '../types/evacuation';
import { getPolygonCentroid, toTurfPolygon } from './routingEngine';
import { buildCumulativeDistances } from './simulationEngine';

/**
 * Geographic bounding box for the Brussels-Capital Region & STIB Metro network
 * (covers all 19 Brussels municipalities plus peripheral STIB termini Kraainem/Stockel/Erasme/Heysel)
 */
export const BRUSSELS_REGION_BOUNDS = {
  minLat: 50.76,
  maxLat: 50.95,
  minLng: 4.22,
  maxLng: 4.52,
};

export function isPointInBrusselsRegion(pt: [number, number]): boolean {
  const [lat, lng] = pt;
  return (
    lat >= BRUSSELS_REGION_BOUNDS.minLat &&
    lat <= BRUSSELS_REGION_BOUNDS.maxLat &&
    lng >= BRUSSELS_REGION_BOUNDS.minLng &&
    lng <= BRUSSELS_REGION_BOUNDS.maxLng
  );
}

export function isPolygonInBrusselsRegion(polygon: [number, number][]): boolean {
  if (!polygon || polygon.length === 0) return false;
  if (polygon.some((pt) => isPointInBrusselsRegion(pt))) {
    return true;
  }
  const centroid = getPolygonCentroid(polygon);
  return isPointInBrusselsRegion(centroid);
}

/**
 * Returns true if and only if at least one Source Area or Target Area lies within the Region of Brussels.
 */
export function hasAnyAreaInBrussels(
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[]
): boolean {
  return (
    sourceAreas.some((s) => isPolygonInBrusselsRegion(s.polygon)) ||
    targetAreas.some((t) => isPolygonInBrusselsRegion(t.polygon))
  );
}

/**
 * Find all Brussels Metro stations that fall inside any Source Area or Target Area polygon.
 */
export function findBrusselsMetroStationsInAreas(
  stations: BrusselsMetroStationFeature[],
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[]
): {
  sourceStations: BrusselsMetroMatchedStation[];
  targetStations: BrusselsMetroMatchedStation[];
} {
  const sourceStations: BrusselsMetroMatchedStation[] = [];
  const targetStations: BrusselsMetroMatchedStation[] = [];

  for (const src of sourceAreas) {
    if (!src.polygon || src.polygon.length < 3) continue;
    try {
      const poly = toTurfPolygon(src.polygon);
      for (const st of stations) {
        const pt = turf.point([st.position[1], st.position[0]]);
        if (turf.booleanPointInPolygon(pt, poly)) {
          sourceStations.push({
            station: st,
            areaId: src.id,
            areaName: src.name,
            areaType: 'source',
          });
        }
      }
    } catch {
      // Ignore invalid polygon
    }
  }

  for (const tgt of targetAreas) {
    if (!tgt.polygon || tgt.polygon.length < 3) continue;
    try {
      const poly = toTurfPolygon(tgt.polygon);
      for (const st of stations) {
        const pt = turf.point([st.position[1], st.position[0]]);
        if (turf.booleanPointInPolygon(pt, poly)) {
          targetStations.push({
            station: st,
            areaId: tgt.id,
            areaName: tgt.name,
            areaType: 'target',
            disabled: Boolean(tgt.disabled),
          });
        }
      }
    } catch {
      // Ignore invalid polygon
    }
  }

  return { sourceStations, targetStations };
}

/**
 * Find the vertex index on `coords` closest to `targetPt` ([lat, lng])
 */
function findClosestVertexIndex(
  coords: [number, number][],
  targetPt: [number, number]
): number {
  let bestIdx = 0;
  let bestDistSq = Infinity;
  const cosLat = Math.cos((targetPt[0] * Math.PI) / 180);

  for (let i = 0; i < coords.length; i++) {
    const dLat = coords[i][0] - targetPt[0];
    const dLng = (coords[i][1] - targetPt[1]) * cosLat;
    const dSq = dLat * dLat + dLng * dLng;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Extract the sub-polyline along a single metro line `lineFeature` from `fromPos` to `toPos`.
 */
function extractSingleLineSlice(
  lineFeature: BrusselsMetroLineFeature,
  fromPos: [number, number],
  toPos: [number, number]
): { coordinates: [number, number][]; distanceMeters: number } {
  const coords = lineFeature.coordinates;
  if (!coords || coords.length < 2) {
    const fallback: [number, number][] = [fromPos, toPos];
    return {
      coordinates: fallback,
      distanceMeters: buildCumulativeDistances(fallback).total,
    };
  }

  const iStart = findClosestVertexIndex(coords, fromPos);
  const iEnd = findClosestVertexIndex(coords, toPos);

  let directSlice: [number, number][];
  if (iStart <= iEnd) {
    directSlice = coords.slice(iStart, iEnd + 1);
  } else {
    directSlice = coords.slice(iEnd, iStart + 1).reverse();
  }

  const fullDirect: [number, number][] = [fromPos, ...directSlice, toPos];
  const directDist = buildCumulativeDistances(fullDirect).total;

  // Check if this line is a closed loop (Line 2 at Simonis/Elisabeth) where wrapping around the terminus is shorter
  const startEndGapKm = turf.distance(
    [coords[0][1], coords[0][0]],
    [coords[coords.length - 1][1], coords[coords.length - 1][0]],
    { units: 'kilometers' }
  );

  if (startEndGapKm < 0.25 && iStart !== iEnd) {
    let wrapSlice: [number, number][];
    if (iStart <= iEnd) {
      // Go from iStart -> 0, then (length - 1) -> iEnd
      const part1 = coords.slice(0, iStart + 1).reverse();
      const part2 = coords.slice(iEnd).reverse();
      wrapSlice = [fromPos, ...part1, ...part2, toPos];
    } else {
      // Go from iStart -> (length - 1), then 0 -> iEnd
      const part1 = coords.slice(iStart);
      const part2 = coords.slice(0, iEnd + 1);
      wrapSlice = [fromPos, ...part1, ...part2, toPos];
    }
    const wrapDist = buildCumulativeDistances(wrapSlice).total;
    if (wrapDist < directDist) {
      return { coordinates: wrapSlice, distanceMeters: wrapDist };
    }
  }

  return { coordinates: fullDirect, distanceMeters: directDist };
}

/**
 * Compute the exact trajectory along Brussels Metro lines from `sourceStation` to `targetStation`.
 * Supports both direct same-line travel and transfers via interchange hubs (Arts-Loi, Beekkant, Gare de l'Ouest).
 */
export function computeMetroTrajectoryBetweenStations(
  sourceStation: BrusselsMetroStationFeature,
  targetStation: BrusselsMetroStationFeature,
  lines: BrusselsMetroLineFeature[],
  allStations: BrusselsMetroStationFeature[]
): {
  coordinates: [number, number][];
  distanceMeters: number;
  lineLabel: string;
  color: string;
} {
  // Use variant 1 of each unique line ('1', '2', '5', '6') as canonical track geometry
  const lineMap = new Map<string, BrusselsMetroLineFeature>();
  for (const lf of lines) {
    if (lf.variant === 1 || !lineMap.has(lf.line)) {
      lineMap.set(lf.line, lf);
    }
  }

  // 1. Check shared lines (Direct single-line trajectory)
  const sharedLines = sourceStation.lines.filter((l) =>
    targetStation.lines.includes(l)
  );

  let bestDirect: {
    coordinates: [number, number][];
    distanceMeters: number;
    lineLabel: string;
    color: string;
  } | null = null;

  for (const lineId of sharedLines) {
    const lf = lineMap.get(lineId);
    if (!lf) continue;
    const slice = extractSingleLineSlice(
      lf,
      sourceStation.position,
      targetStation.position
    );
    if (!bestDirect || slice.distanceMeters < bestDirect.distanceMeters) {
      bestDirect = {
        coordinates: slice.coordinates,
        distanceMeters: slice.distanceMeters,
        lineLabel: `Metro Line ${lineId}`,
        color: lf.color || '#0066A3',
      };
    }
  }

  if (bestDirect) {
    return bestDirect;
  }

  // 2. Cross-line transfer via major STIB interchange hubs (Arts-Loi, Beekkant, Gare de l'Ouest)
  let bestTransfer: {
    coordinates: [number, number][];
    distanceMeters: number;
    lineLabel: string;
    color: string;
  } | null = null;

  for (const lA of sourceStation.lines) {
    const lfA = lineMap.get(lA);
    if (!lfA) continue;

    for (const lB of targetStation.lines) {
      const lfB = lineMap.get(lB);
      if (!lfB) continue;

      // Find transfer stations that serve both lA and lB
      const transferStations = allStations.filter(
        (st) => st.lines.includes(lA) && st.lines.includes(lB)
      );

      for (const hub of transferStations) {
        const leg1 = extractSingleLineSlice(
          lfA,
          sourceStation.position,
          hub.position
        );
        const leg2 = extractSingleLineSlice(
          lfB,
          hub.position,
          targetStation.position
        );
        const totalDist = leg1.distanceMeters + leg2.distanceMeters;
        if (!bestTransfer || totalDist < bestTransfer.distanceMeters) {
          bestTransfer = {
            coordinates: [...leg1.coordinates, ...leg2.coordinates.slice(1)],
            distanceMeters: totalDist,
            lineLabel: `Metro Line ${lA} → Line ${lB} (via ${hub.name_fr})`,
            color: lfA.color || '#0066A3',
          };
        }
      }
    }
  }

  if (bestTransfer) {
    return bestTransfer;
  }

  // Fallback straight line if no line geometry found
  const fallbackCoords: [number, number][] = [
    sourceStation.position,
    targetStation.position,
  ];
  return {
    coordinates: fallbackCoords,
    distanceMeters: buildCumulativeDistances(fallbackCoords).total,
    lineLabel: `Metro Line ${sourceStation.lines[0] || '1'}`,
    color: '#0066A3',
  };
}

/**
 * Build all Brussels Metro Evacuation Corridors connecting stations inside Source Areas
 * (established as Pickup Points) to stations inside active (non-disabled) Target Areas
 * (established as Drop-Off Points).
 */
export function buildBrusselsMetroEvacuationCorridors(
  sourceAreas: SourceArea[],
  targetAreas: TargetArea[],
  lines: BrusselsMetroLineFeature[],
  stations: BrusselsMetroStationFeature[]
): BrusselsMetroCorridor[] {
  const { sourceStations, targetStations } = findBrusselsMetroStationsInAreas(
    stations,
    sourceAreas,
    targetAreas
  );

  const activeTargetStations = targetStations.filter((t) => !t.disabled);
  if (sourceStations.length === 0 || activeTargetStations.length === 0) {
    return [];
  }

  const corridors: BrusselsMetroCorridor[] = [];
  const connectedPairs = new Set<string>();
  const connectedTargetKeys = new Set<string>();

  // 1. For each station inside a Source Area (Pickup Point), connect it to the best station
  //    inside an active Target Area (Drop-Off Point), preferring direct same-line Target Stations first
  sourceStations.forEach((srcMatch) => {
    const candidates = activeTargetStations.map((tgtMatch) => {
      const sharesLine = srcMatch.station.lines.some((l) =>
        tgtMatch.station.lines.includes(l)
      );
      const traj = computeMetroTrajectoryBetweenStations(
        srcMatch.station,
        tgtMatch.station,
        lines,
        stations
      );
      return {
        tgtMatch,
        sharesLine,
        traj,
      };
    });

    candidates.sort((a, b) => {
      if (a.sharesLine !== b.sharesLine) {
        return a.sharesLine ? -1 : 1;
      }
      return a.traj.distanceMeters - b.traj.distanceMeters;
    });

    const best = candidates[0];
    if (!best) return;

    const pairKey = `${srcMatch.areaId}:${srcMatch.station.id}->${best.tgtMatch.areaId}:${best.tgtMatch.station.id}`;
    if (connectedPairs.has(pairKey)) return;
    connectedPairs.add(pairKey);
    connectedTargetKeys.add(`${best.tgtMatch.areaId}:${best.tgtMatch.station.id}`);

    corridors.push({
      id: `metro-corridor-${srcMatch.areaId}-${srcMatch.station.id}-to-${best.tgtMatch.areaId}-${best.tgtMatch.station.id}`,
      sourceId: srcMatch.areaId,
      sourceName: srcMatch.areaName,
      sourceStation: srcMatch.station,
      targetId: best.tgtMatch.areaId,
      targetName: best.tgtMatch.areaName,
      targetStation: best.tgtMatch.station,
      lineLabel: best.traj.lineLabel,
      color: best.traj.color,
      coordinates: best.traj.coordinates,
      distanceMeters: best.traj.distanceMeters,
    });
  });

  // 2. Ensure every Metro Station inside an active Target Area is also established as a Drop-Off Point
  //    by connecting any not-yet-connected Target Station from its optimal Source Area Metro Station
  activeTargetStations.forEach((tgtMatch) => {
    const tgtKey = `${tgtMatch.areaId}:${tgtMatch.station.id}`;
    if (connectedTargetKeys.has(tgtKey)) return;

    const candidates = sourceStations.map((srcMatch) => {
      const sharesLine = srcMatch.station.lines.some((l) =>
        tgtMatch.station.lines.includes(l)
      );
      const traj = computeMetroTrajectoryBetweenStations(
        srcMatch.station,
        tgtMatch.station,
        lines,
        stations
      );
      return {
        srcMatch,
        sharesLine,
        traj,
      };
    });

    candidates.sort((a, b) => {
      if (a.sharesLine !== b.sharesLine) {
        return a.sharesLine ? -1 : 1;
      }
      return a.traj.distanceMeters - b.traj.distanceMeters;
    });

    const best = candidates[0];
    if (!best) return;

    const pairKey = `${best.srcMatch.areaId}:${best.srcMatch.station.id}->${tgtMatch.areaId}:${tgtMatch.station.id}`;
    if (connectedPairs.has(pairKey)) return;
    connectedPairs.add(pairKey);
    connectedTargetKeys.add(tgtKey);

    corridors.push({
      id: `metro-corridor-${best.srcMatch.areaId}-${best.srcMatch.station.id}-to-${tgtMatch.areaId}-${tgtMatch.station.id}`,
      sourceId: best.srcMatch.areaId,
      sourceName: best.srcMatch.areaName,
      sourceStation: best.srcMatch.station,
      targetId: tgtMatch.areaId,
      targetName: tgtMatch.areaName,
      targetStation: tgtMatch.station,
      lineLabel: best.traj.lineLabel,
      color: best.traj.color,
      coordinates: best.traj.coordinates,
      distanceMeters: best.traj.distanceMeters,
    });
  });

  return corridors;
}

