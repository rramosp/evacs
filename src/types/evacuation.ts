export type PopulationBehaviorType = 'obedient' | 'autonomous' | 'random';

export interface BehavioralDistribution {
  obedient: number;   // percentage 0-100
  autonomous: number; // percentage 0-100
  random: number;     // percentage 0-100
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

export interface NoGoArea {
  id: string;
  name: string;
  polygon: [number, number][]; // Array of [lat, lng]
}

export type VehicleType = 'Bus' | 'Private Car' | 'Shuttle';

export interface VehicleFleet {
  id: string;
  name: string;
  type: VehicleType;
  location: [number, number]; // [lat, lng] staging point
  count: number;
  capacityPerUnit: number;
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
  avoidedNoGoNames: string[];
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
  totalBoardedCount: number;
  boardingVehicleInfo?: string; // e.g., "STIB Bus #1 (64% | Wait 06:15/10:00)"
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
  randomHeadingRad: number;
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
  currentOccupancy: number;
  assignedRouteId: string;
  assignedPickupId: string;
  sourceId: string;
  targetId: string;
  targetName: string;
  status: 'to_pickup' | 'waiting_for_80_pct' | 'to_target' | 'completed';
  waitingAtPickupSeconds: number; // Elapsed seconds waiting at pickup location (departs at 600s if >=1 passenger)
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
}

export interface SimulationStateSnapshot {
  clusters: SourceInternalCluster[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  heatmapPoints: HeatmapPoint[];
  targetOccupancies: Record<string, number>;
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
  | { type: 'source' | 'target' | 'nogo'; points: [number, number][] }
  | { type: 'vehicle'; point: [number, number] | null };

export type PresetScenarioId = 'brussels' | 'paris' | 'custom';
