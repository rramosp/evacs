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
  coordinates: [number, number][]; // [lat, lng] path
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

export interface SimulationCohort {
  id: string;
  routeId: string;
  sourceId: string;
  targetId: string;
  behaviorType: PopulationBehaviorType;
  isVehicle: boolean;
  vehicleType?: VehicleType;
  vehicleFleetName?: string;
  vehicleUnits?: number;
  populationCount: number;
  coordinates: [number, number][];
  cumulativeDistances: number[];
  totalDistanceMeters: number;
  progressMeters: number;
  baseSpeedMps: number; // meters per second
  currentSpeedMps: number;
  currentPosition: [number, number];
  status: 'waiting' | 'boarding' | 'en_route' | 'arrived';
  departureDelaySeconds: number;
}

export interface HeatmapPoint {
  lat: number;
  lng: number;
  intensity: number; // normalized or headcount weight
  behavior: PopulationBehaviorType;
}

export type ActiveDrawMode =
  | null
  | { type: 'source' | 'target' | 'nogo'; points: [number, number][] }
  | { type: 'vehicle'; point: [number, number] | null };

export type PresetScenarioId = 'brussels' | 'paris' | 'custom';
