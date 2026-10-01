export type PopulationBehaviorType = 'compliant' | 'self-directed' | 'disoriented';

export interface BehavioralDistribution {
  compliant: number;        // percentage 0-100
  'self-directed': number;  // percentage 0-100
  disoriented: number;      // percentage 0-100
}

export interface SourceArea {
  id: string;
  name: string;
  polygon: [number, number][]; // Array of [lat, lng]
  population: number;
  behavior: BehavioralDistribution;
}

export interface TargetArea {
  id: string;
  name: string;
  polygon: [number, number][]; // Array of [lat, lng]
  capacity: number;
  currentOccupancy: number;
  disabled?: boolean; // When true, receives no more people and is excluded from route computation
}

export interface AvoidArea {
  id: string;
  name: string;
  polygon: [number, number][]; // Array of [lat, lng]
}

export type VehicleType = 'Bus' | 'Private Car' | 'Shuttle' | 'Metro';

export interface VehicleFleet {
  id: string;
  name: string;
  type: VehicleType;
  location: [number, number]; // [lat, lng] staging point
  count: number;
  capacityPerUnit: number;
  loadUnloadTimePerPersonSeconds: number; // Average time in seconds to load or unload 1 person
  transitSpeedKmh: number; // Vehicle transit speed in km/h (default 25 km/h)
}

export interface ComputedRoute {
  id: string;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  behaviorType: PopulationBehaviorType | 'vehicle_dispatch';
  pickupLocation: [number, number]; // Specific [lat, lng] pickup point on the Source Area
  pickupLabel: string;              // Descriptive label for the pickup location
  coordinates: [number, number][];  // [lat, lng] path from Pickup Location -> Target Area
  approachCoordinates?: [number, number][]; // [lat, lng] path from Vehicle Depot -> Pickup Location
  distanceMeters: number;
  estimatedDurationSeconds: number;
  assignedPopulation: number;
  avoidedAreaNames: string[];
  isDetour: boolean;
  vehicleFleetId?: string;
  vehicleCountUsed?: number;
}

export type LogLevel = 'INFO' | 'WARN' | 'ROUTING' | 'SIMULATION';

export interface LogEntry {
  id: string;
  timestamp: string;
  simTimeFormatted: string;
  level: LogLevel;
  message: string;
}

export interface BehaviorCounts {
  compliant: number;
  'self-directed': number;
  disoriented: number;
}

export interface SimulationTelemetryStats {
  initialByBehavior: BehaviorCounts;
  evacuatedByBehavior: BehaviorCounts;
  evacuatedPersonSecondsByBehavior: BehaviorCounts;
  pickupArrivedByBehavior: BehaviorCounts;
  pickupArrivalPersonSecondsByBehavior: BehaviorCounts;
  totalCompletedVehicleTrips: number;
}

export interface PickupLocationState {
  id: string;
  routeId: string;
  sourceId: string;
  sourceName: string;
  targetId: string;
  targetName: string;
  label: string;
  location: [number, number];
  waitingPopulation: number;
  waitingByBehavior: BehaviorCounts;
  totalBoardedCount: number;
  boardedByBehavior: BehaviorCounts;
  evacuatedCount: number;
  evacuatedByBehavior: BehaviorCounts;
  completedDeparturesCount: number;
  totalCompletedVehicleWaitSeconds: number;
  maxVehicleWaitSeconds: number;
  totalDepartureOccupancyRatioSum: number;
  boardingVehicleInfo?: string; // e.g., "STIB Bus #1 (64% | Wait 06:15/10:00)"
  isMetro?: boolean;
  metroLine?: string;
  metroColor?: string;
  metroStationName?: string;
  metroTargetStationName?: string;
  dropOffLocation?: [number, number];
}

export interface SourceInternalCluster {
  id: string;
  sourceId: string;
  behavior: PopulationBehaviorType;
  headcount: number;
  position: [number, number];
  targetPickupId: string | null;
  perimeterEdgeIndex: number;
  perimeterProgress: number;
  disorientedHeadingRad: number;
  zigZagSide?: 1 | -1;
  zigZagTimerSeconds?: number;
  zigZagAngleOffsetRad?: number;
  isReversingBrief?: boolean;
  status: 'moving_in_zone' | 'waiting_at_pickup' | 'boarded';
}

export interface ActiveVehicleUnit {
  id: string;
  fleetId: string;
  fleetName: string;
  vehicleType: VehicleType;
  unitCount: number;
  capacityPerUnit: number;
  maxCapacity: number; // unitCount * capacityPerUnit
  loadUnloadTimePerPersonSeconds: number; // Average time in seconds to load or unload 1 person per vehicle
  transitSpeedKmh: number; // Configured vehicle transit speed in km/h (default 25 km/h)
  currentOccupancy: number;
  occupancyByBehavior: BehaviorCounts;
  assignedRouteId: string;
  assignedPickupId: string;
  sourceId: string;
  targetId: string;
  targetName: string;
  status: 'to_pickup' | 'waiting_for_80_pct' | 'to_target' | 'unloading' | 'completed';
  waitingAtPickupSeconds: number; // Elapsed seconds waiting at pickup location (departs at 600s if >=1 passenger)
  loadingProgressRemainder?: number; // Fractional boarding progress accumulator
  loadingElapsedSeconds?: number; // Cumulative seconds spent actively loading passengers on current trip
  unloadingProgressRemainder?: number; // Fractional alighting progress accumulator
  unloadingElapsedSeconds?: number; // Elapsed seconds spent unloading at Target Shelter
  unloadingInitialOccupancy?: number; // Occupancy upon arrival at Target Shelter when unloading began
  currentPosition: [number, number];
  progressMeters: number;
  speedMps: number;
  approachCoords: [number, number][];
  approachCumulative: number[];
  evacCoords: [number, number][];
  evacCumulative: number[];
  departureDelaySeconds: number;
  postOffloadEvacCoords?: [number, number][];
  postOffloadTargetId?: string;
  postOffloadTargetName?: string;
  isMetro?: boolean;
  metroLine?: string;
  metroColor?: string;
  sourceStationName?: string;
  targetStationName?: string;
}

export interface SimulationStateSnapshot {
  clusters: SourceInternalCluster[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  heatmapPoints: HeatmapPoint[];
  targetOccupancies: Record<string, number>;
  telemetryStats: SimulationTelemetryStats;
  newLogs: string[];
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  totalWaitingAtPickups: number;
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  intensity: number; // normalized thermal weight
  behavior: PopulationBehaviorType | 'pickup_hotspot';
}

export type ActiveDrawMode =
  | null
  | { type: 'source' | 'target' | 'avoid'; points: [number, number][] }
  | { type: 'vehicle'; point: [number, number] | null };

export type PresetScenarioId = string;

export type Sentinel2AggregationPeriod =
  | 'last week'
  | 'last 2 weeks'
  | 'last month'
  | 'last three months'
  | 'last six months'
  | 'last year';

export interface Sentinel2LayerState {
  active: boolean;
  visible: boolean;
  tileUrl: string | null;
  imageCount: number;
  poi: [number, number] | null;
  currentDate: string;
  aggregationPeriod: Sentinel2AggregationPeriod;
  visParams: {
    bands: string[];
    min: number;
    max: number;
    gamma: number;
  };
  collection: string;
  dateRange: [string, string];
  opacity: number;
}

export interface Sentinel1LayerState {
  active: boolean;
  visible: boolean;
  tileUrl: string | null;
  imageCount: number;
  poi: [number, number] | null;
  visParams: {
    bands: string[];
    min: number[];
    max: number[];
  };
  collection: string;
  dateRange: [string, string];
  opacity: number;
}

export interface GlofasForecastOverlay {
  band: number;
  leadtimeHours: number;
  label: string;
  description: string;
  rawMin: number;
  rawMax: number;
  clippedMax: number;
  dataUrl: string;
  bounds: [[number, number], [number, number]];
  visible: boolean;
  opacity: number;
}

export interface GlofasForecastState {
  active: boolean;
  cached: boolean;
  date: string;
  center: [number, number] | null;
  radiusKm: number;
  geotiffPath: string | null;
  clipMax: number;
  overlays: GlofasForecastOverlay[];
}

export interface BrusselsMetroLineFeature {
  id: string;
  line: string;
  mode: string;
  variant: number;
  color: string;
  coordinates: [number, number][]; // [lat, lng]
  segments: [number, number][][];
}

export interface BrusselsMetroStationFeature {
  id: string;
  name_fr: string;
  name_nl: string;
  stop_id: string;
  line: string;
  lines: string[];
  position: [number, number]; // [lat, lng]
}

export interface BrusselsMetroMatchedStation {
  station: BrusselsMetroStationFeature;
  areaId: string;
  areaName: string;
  areaType: 'source' | 'target';
  disabled?: boolean;
}

export interface BrusselsMetroCorridor {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceStation: BrusselsMetroStationFeature;
  targetId: string;
  targetName: string;
  targetStation: BrusselsMetroStationFeature;
  lineLabel: string;
  color: string;
  coordinates: [number, number][]; // [lat, lng] along metro line(s) from sourceStation -> targetStation
  distanceMeters: number;
}

export interface BrusselsMetroConfig {
  showNetworkOverlay: boolean;
  useForEvacuation: boolean;
  trainCount: number;
  trainCapacity: number;
}

