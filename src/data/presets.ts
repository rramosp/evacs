import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  PresetScenarioId,
} from '../types/evacuation';

export interface PresetScenarioData {
  id: PresetScenarioId;
  name: string;
  description: string;
  center: [number, number];
  zoom: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
}

export const PRESET_SCENARIOS: Record<'brussels' | 'paris', PresetScenarioData> = {
  brussels: {
    id: 'brussels',
    name: 'Brussels — Capital Region Evacuation',
    description:
      'High-density evacuation from Grand Place & Gare du Midi to Parc du Cinquantenaire & Brussels Expo, avoiding the central Inner Ring bottleneck.',
    center: [50.8503, 4.3517],
    zoom: 13,
    sourceAreas: [
      {
        id: 'bxl-src-1',
        name: 'Grand Place',
        population: 1000,
        behavior: { obedient: 70, autonomous: 20, random: 10 },
        polygon: [
          [50.8482, 4.3498],
          [50.8482, 4.3552],
          [50.8451, 4.3552],
          [50.8451, 4.3498],
        ],
      },
      {
        id: 'bxl-src-2',
        name: 'Midi Station (Gare du Midi)',
        population: 2000,
        behavior: { obedient: 60, autonomous: 30, random: 10 },
        polygon: [
          [50.8382, 4.3330],
          [50.8382, 4.3402],
          [50.8335, 4.3402],
          [50.8335, 4.3330],
        ],
      },
    ],
    targetAreas: [
      {
        id: 'bxl-tgt-1',
        name: 'Parc du Cinquantenaire',
        capacity: 50000,
        currentOccupancy: 0,
        polygon: [
          [50.8435, 4.3875],
          [50.8435, 4.3975],
          [50.8380, 4.3975],
          [50.8380, 4.3875],
        ],
      },
      {
        id: 'bxl-tgt-2',
        name: 'Bruxelles Expo (Heysel)',
        capacity: 20000,
        currentOccupancy: 0,
        polygon: [
          [50.8998, 4.3305],
          [50.8998, 4.3405],
          [50.8942, 4.3405],
          [50.8942, 4.3305],
        ],
      },
    ],
    noGoAreas: [
      {
        id: 'bxl-nogo-1',
        name: 'Ring of Brussels (Arts-Loi Inner Ring Sector)',
        polygon: [
          [50.8476, 4.3645],
          [50.8476, 4.3720],
          [50.8415, 4.3720],
          [50.8415, 4.3645],
        ],
      },
    ],
    vehicleFleets: [
      {
        id: 'bxl-veh-1',
        name: 'STIB Bus Fleet Alpha',
        type: 'Bus',
        count: 100,
        capacityPerUnit: 50,
        location: [50.8276, 4.3725], // Place Flagey
      },
      {
        id: 'bxl-veh-2',
        name: 'Municipal Car Pool',
        type: 'Private Car',
        count: 100,
        capacityPerUnit: 4,
        location: [50.8596, 4.3447], // Place Sainctelette
      },
    ],
  },
  paris: {
    id: 'paris',
    name: 'Paris — Seine Bridges Closure Scenario',
    description:
      "Evacuation of Eiffel Tower & Arc de Triomphe with closures on Pont d'Iéna and Pont de l'Alma forcing detours via adjacent river crossings.",
    center: [48.8665, 2.3180],
    zoom: 13,
    sourceAreas: [
      {
        id: 'par-src-1',
        name: 'Eiffel Tower (Champ de Mars)',
        population: 1500,
        behavior: { obedient: 65, autonomous: 25, random: 10 },
        polygon: [
          [48.8595, 2.2922],
          [48.8595, 2.2980],
          [48.8555, 2.2980],
          [48.8555, 2.2922],
        ],
      },
      {
        id: 'par-src-2',
        name: 'Arc de Triomphe',
        population: 500,
        behavior: { obedient: 75, autonomous: 15, random: 10 },
        polygon: [
          [48.8755, 2.2925],
          [48.8755, 2.2978],
          [48.8722, 2.2978],
          [48.8722, 2.2925],
        ],
      },
    ],
    targetAreas: [
      {
        id: 'par-tgt-1',
        name: 'Parc de la Villette',
        capacity: 50000,
        currentOccupancy: 0,
        polygon: [
          [48.8965, 2.3865],
          [48.8965, 2.3960],
          [48.8905, 2.3960],
          [48.8905, 2.3865],
        ],
      },
      {
        id: 'par-tgt-2',
        name: 'Parc de Bagatelle',
        capacity: 20000,
        currentOccupancy: 0,
        polygon: [
          [48.8742, 2.2435],
          [48.8742, 2.2515],
          [48.8692, 2.2515],
          [48.8692, 2.2435],
        ],
      },
    ],
    noGoAreas: [
      {
        id: 'par-nogo-1',
        name: "Pont d'Iéna",
        polygon: [
          [48.8608, 2.2905],
          [48.8608, 2.2938],
          [48.8586, 2.2938],
          [48.8586, 2.2905],
        ],
      },
      {
        id: 'par-nogo-2',
        name: "Pont de l'Alma",
        polygon: [
          [48.8646, 2.3002],
          [48.8646, 2.3035],
          [48.8620, 2.3035],
          [48.8620, 2.3002],
        ],
      },
    ],
    vehicleFleets: [
      {
        id: 'par-veh-1',
        name: 'RATP Bus Fleet',
        type: 'Bus',
        count: 50,
        capacityPerUnit: 50,
        location: [48.8606, 2.3125], // Esplanade des Invalides
      },
    ],
  },
};
