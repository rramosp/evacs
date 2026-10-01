import {
  SourceArea,
  TargetArea,
  AvoidArea,
  VehicleFleet,
  PresetScenarioId,
} from '../types/evacuation';

/**
 * TypeScript schema for preset scenarios dynamically loaded at runtime
 * from `data/scenarios/*.pkl` via `/api/scenarios` (`server/scenarios.py`).
 *
 * Scenario contents (polygons, coordinates, areas, vehicle fleets, names)
 * are never hardcoded in the application or configuration files.
 */
export interface PresetScenarioData {
  id: PresetScenarioId;
  name: string;
  description: string;
  center: [number, number];
  zoom: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  avoidAreas: AvoidArea[];
  vehicleFleets: VehicleFleet[];
}
