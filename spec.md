# Evacuation Management Application — Functional & Technical Specification

## 1. Overview & Objectives

The **Evacuation Management Application** is an interactive decision-support and simulation tool designed to help emergency management personnel coordinate urban evacuations, compute optimal routing paths around hazards, and simulate crowd and vehicle movement over time.

### Primary Goal (Scoping Phase)
Build a responsive, high-usability web User Interface (UI) backed by OpenStreetMap (OSM) data to allow rapid concept iteration with stakeholders. The system combines interactive GIS zone management, obstacle-aware route computation with designated assembly/pickup points, and an animated agent/density simulation with real-time heatmap visualization.

---

## 2. Target Audience & Core Workflows

- **Target Audience**: Emergency management personnel, urban planners, and civil defense coordinators.
- **Core Workflow**:
  1. Load a preset city scenario (e.g., Brussels, Paris) or define a custom scenario from scratch.
  2. Draw or edit **Source Areas** (evacuation zones), **Target Areas** (safe shelters/assembly points), **No-Go Areas** (hazards/blocked zones), and **Vehicle Fleets** (staging depots).
  3. Trigger **Compute Evacuation Routes** to calculate optimal paths from sources to targets while avoiding No-Go zones, respecting shelter capacities, and establishing specific **Pickup Locations (marked with blue squares)** on each Source Area for every route.
  4. Trigger **Run Simulation** to animate:
     - Evacuees moving *within* each Source Area toward established Pickup Locations according to their behavioral profile (`obedient`, `autonomous`, `random`), causing the heatmap to become hotter around Pickup Locations as queues form.
     - Vehicles arriving at Pickup Locations, boarding waiting evacuees, and departing for Target Shelters when **either 80% occupancy is reached OR 10 minutes of waiting time have elapsed** (whichever happens first, provided there is **at least 1 passenger** onboard).
     - Progressive cooling of the Source Area heatmap over time as vehicles evacuate the population.

---

## 3. Domain Entities & Data Models

### 3.1 Evacuation Source Areas & Internal Population Behavior
Geographic zones requiring evacuation. The population within a Source Area **remains inside that Source Area until picked up by an evacuation vehicle**. Their behavioral profile governs how they move *within* the Source Area to reach a Pickup Location (Blue Square):
- **Name**: String identifier (e.g., `"Grand Place"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Total Population**: Integer count of evacuees (`N > 0`).
- **Behavioral Profile Distribution** (percentages summing to 100%):
  - **Obedient (`%`)**: Immediately head directly to the **closest Pickup Location** within the Source Area at `t = 0`.
  - **Autonomous (`%`)**: Wander along the **limits (perimeter boundary)** of the Source Area polygon until they stumble upon a Pickup Location.
  - **Random (`%`)**: Wander randomly throughout the interior of the Source Area polygon until they come within **50 meters** of any Pickup Location, at which point they direct themselves straight to it.
- **Route Pickup Locations (Blue Squares)**: Specific `[lat, lng]` assembly points established on/within the Source Area polygon once routes are computed. Any evacuees arriving at a Pickup Location wait there in queue (`waitingPopulation`) until a vehicle boards them.

### 3.2 Evacuation Target Areas (Safe Zones)
Designated safe destinations or shelters where evacuees are transported by vehicles.
- **Name**: String identifier (e.g., `"Parc du Cinquantenaire"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Capacity**: Maximum number of evacuees the area can accommodate (`Integer`).
- **Current Occupancy**: Tracked dynamically as vehicles offload passengers (`0` to `Capacity`).

### 3.3 No-Go Areas (Hazard / Blocked Zones)
Restricted or hazardous areas impassable for evacuation routing.
- **Name**: String identifier (e.g., `"Pont d'Iéna"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Routing Effect**: Any road network edge or segment intersecting a No-Go polygon is marked impassable (infinite weight / removed from routing graph).

### 3.4 Evacuation Vehicle Fleets & Dual Departure Condition (80% Occupancy or 10-Minute Timeout)
Available public or private transport units managed by authorities, modeled as **Fleets / Staging Depots**:
- **Name**: String identifier (e.g., `"STIB Bus Fleet Alpha"`).
- **Vehicle Type**: Category (`Bus`, `Private Car`, `Shuttle`, etc.).
- **Initial Location**: Point (`GeoJSON Point` — `[lat, lng]`) representing the depot or staging area at `t = 0`.
- **Unit Count**: Number of vehicles in this fleet (`Integer`).
- **Capacity per Unit**: Passenger occupancy per vehicle (e.g., `50` for buses, `4` for cars).
- **Dual Departure Rule (80% Occupancy OR 10 Minutes Waiting Time)**:
  - When a vehicle arrives at a Source Area Pickup Location (Blue Square), a waiting timer (`waitingAtPickupSeconds`) starts at `00:00` and the vehicle boards any waiting evacuees.
  - The vehicle waits at the Pickup Location until **whichever of the following two events happens first**:
    1. **80% Occupancy Reached**: `currentOccupancy >= 0.80 * maxCapacity`.
    2. **10 Minutes Waiting Time Elapsed**: `waitingAtPickupSeconds >= 600` (10 minutes of simulation time).
  - Provided there is **at least 1 passenger** onboard (`currentOccupancy >= 1`), the vehicle immediately departs along the computed route to the Target Area shelter. (If 10 minutes have elapsed but `currentOccupancy == 0`, the vehicle remains at the pickup point until at least 1 passenger boards or until no evacuees remain in the Source Area).

---

## 4. UI Layout & UX Architecture

The viewport is divided into a **4-Panel Cockpit Layout** (`100vw × 100vh`, non-scrolling outer container):

```
+-------------------+-----------------------------------+-------------------+
|                   |                                   |                   |
|                   |                                   |                   |
|                   |            CENTER MAP             |                   |
|    LEFT PANEL     |         (OSM + Overlays)          |    RIGHT PANEL    |
|   (Parameters &   |        50% Width, 75% Height      |  (Live Telemetry  |
|     Controls)     |                                   |   & Analytics)    |
|                   |                                   |                   |
|    25% Width      +-----------------------------------+    25% Width      |
|   100% Height     |           BOTTOM PANEL            |   100% Height     |
|                   |      (System & Simulation Logs)   |                   |
|                   |        50% Width, 25% Height      |                   |
+-------------------+-----------------------------------+-------------------+
```

### 4.1 Left Panel: Parameters & Controls (`25% Width × 100% Height`)
- **Scenario Selector**: Dropdown to load preset scenarios (`Brussels`, `Paris`, or `Custom / Clear`).
- **Entity Management Accordion / Tabs**:
  - **Source Areas**: List with population count, behavioral split badge, and `Add (Draw Polygon)`, `Edit`, `Delete` actions.
  - **Target Areas**: List with capacity badges and `Add (Draw Polygon)`, `Edit`, `Delete` actions.
  - **No-Go Areas**: List with hazard tags and `Add (Draw Polygon)`, `Edit`, `Delete` actions.
  - **Vehicle Fleets**: List with count/capacity summary and `Add (Place Pin)`, `Edit`, `Delete` actions.
- **Execution Toolbar**:
  - `Compute Evacuation Routes` (Primary action button — computes paths and establishes blue square pickup locations on source areas)
  - `Run Simulation` / `Pause Simulation` (Toggleable playback button)
  - `Stop / Reset Simulation` (Resets time to `t = 0` and restores initial source area population)
  - Simulation Speed Selector (`1x`, `2x`, `5x`, `10x`)

### 4.2 Center Area: Interactive OSM Map (`50% Width × 75% Height`)
- **Base Layer**: OpenStreetMap vector/raster tiles (Tactical Dark / Standard OSM).
- **Interactive Drawing Tools**: Polygon drawing/editing controls for zones and marker placement for vehicle depots.
- **Visual Overlays**:
  - Source Areas: Color-coded polygons (Amber/Orange fill with border).
  - Target Areas: Color-coded polygons (Emerald Green fill with border).
  - No-Go Areas: Cross-hatched Crimson Red polygons.
  - **Route Pickup Locations (Blue Squares)**: Marked with a distinct **blue square** (`#2563eb` with crisp white border) on each Source Area. Displays live waiting queue counts (`Waiting: N people`) and active vehicle boarding status including both **occupancy %** and **waiting time (`MM:SS / 10:00`)**.
  - Computed Routes: Styled polylines connecting staging depots, Blue Square pickup points, and Target Shelters while avoiding No-Go zones.
  - **Dynamic Heatmap Overlay**:
    - Shows crowd movement inside Source Areas (`obedient` heading to closest pickup, `autonomous` along perimeter limits, `random` wandering until within 50m).
    - **Hotter around Pickup Locations**: As evacuees reach Pickup Locations and wait for vehicles, thermal density concentrates intensely around the Blue Squares.
    - **Progressive Cooling of Source Areas**: As vehicles depart (upon hitting 80% occupancy or 10 minutes wait with $\ge 1$ passenger), the remaining population inside the Source Area drops and the Source Area heatmap steadily cools down until empty.
  - Vehicle Markers: Animated vehicle icons showing current passenger load, waiting timer, and state (`To Pickup`, `Waiting/Boarding [80% or 10m]`, `En Route to Shelter`).

### 4.3 Bottom Panel: System & Simulation Console (`50% Width × 25% Height`)
- Timestamped log stream displaying:
  - Routing engine requests, established pickup location coordinates, and detour warnings around No-Go zones.
  - Simulation events: Pickup queue growth, vehicle arrivals at Blue Squares, boarding progress, explicit trigger reason upon departure (`80% occupancy rule` vs. `10-min timeout rule`), and shelter offload confirmations.
- Filterable by log level (`INFO`, `WARN`, `ROUTING`, `SIMULATION`).

### 4.4 Right Panel: Telemetry & KPI Dashboard (`25% Width × 100% Height`)
- **Evacuation Progress Summary**:
  - `Safe at Shelter` vs. `On Vehicles` vs. `In Source Area` (broken down by `Waiting at Pickup Squares` vs. `Moving Inside Source Zones`).
  - Overall progress bar and elapsed simulation clock (`MM:SS`).
- **Blue Square Pickup Queues Card**: Live queue count, vehicle boarding occupancy, and 10-minute countdown/elapsed timer for each pickup location.
- **Target Area Occupancy Cards**: Real-time fill bars (`Current / Capacity`) for each shelter.
- **Population Behavior Breakdown**: Live status of Obedient, Autonomous, and Random populations.

---

## 5. Routing & Simulation Architecture

### 5.1 Routing Algorithm & Pickup Location Establishment
- When `Compute evacuation routes` is clicked:
  - Distinct **Pickup Locations (Blue Squares)** are established along the perimeter/exit edges of each Source Area polygon.
  - OSRM + Turf.js obstacle-avoiding routes are computed from Vehicle Staging Depots $\rightarrow$ Source Area Pickup Locations $\rightarrow$ Target Area Shelters (avoiding all No-Go polygons).

### 5.2 Micro-Simulation & Thermal Heatmap Engine
- **Internal Source Area Crowd Dynamics**:
  - Source Area populations are modeled as spatial micro-clusters distributed inside the polygon at `t = 0`:
    1. **Obedient clusters**: Compute geodesic vector to the nearest Pickup Location in their Source Area and walk directly to it (`~1.5 m/s`).
    2. **Autonomous clusters**: Navigate to the nearest polygon boundary edge and traverse along the perimeter limits of the Source Area until they encounter a Pickup Location.
    3. **Random clusters**: Perform a bounded random walk inside the Source Area polygon. At each step, if their distance to any Pickup Location falls $\le 50\text{ meters}$, they transition to direct approach and walk straight to that Pickup Location.
  - Upon reaching a Pickup Location, clusters join that Blue Square's waiting queue (`waitingPopulation`).
- **Vehicle Boarding & Dual Departure Rule (80% Occupancy or 10 Minutes Wait)**:
  - Vehicles dispatch from depots to assigned Pickup Locations.
  - At a Pickup Location, a vehicle boards waiting evacuees from the queue and increments its `waitingAtPickupSeconds` counter.
  - The vehicle departs for the Target Area shelter as soon as **either**:
    - `currentOccupancy >= 0.80 * maxCapacity` (80% occupancy reached), **OR**
    - `waitingAtPickupSeconds >= 600` (10 minutes waiting time elapsed),
    **whichever happens first, provided `currentOccupancy >= 1`** (at least 1 passenger is onboard).
- **Heatmap Thermal Dynamics**:
  - Heatmap intensity at any coordinate is proportional to local evacuee headcount.
  - As evacuees converge on Blue Squares and wait, thermal intensity peaks sharply at the Pickup Locations (`Hotter around pickup locations`).
  - As vehicles depart with boarded passengers, total headcount in the Source Area decreases, causing the Source Area heatmap to progressively cool down (`Cooler over time`).

---

## 6. Recommended Technical Stack

- **Frontend Framework**: React 18+ with TypeScript and Vite.
- **UI Styling & Layout**: Vanilla CSS with custom tactical HSL design tokens + Lucide Icons.
- **Map & Geospatial Engine**:
  - **Leaflet** (`leaflet`) with custom HTML5 Canvas thermal heatmap overlay and custom divIcons for polygons, depot pins, moving vehicles, and **blue square pickup markers with live queue/boarding/timer badges**.
  - **Turf.js** (`@turf/turf`) for polygon containment, perimeter traversal, 50m proximity detection, and No-Go detour waypoint generation.
- **Routing Services**: OSRM HTTP API (`router.project-osrm.org`) paired with client-side Turf.js obstacle-avoidance waypoint routing.

---

## 7. Preset Scenarios

### 7.1 Brussels Scenario
- **Map Center**: `[50.8503, 4.3517]` (Zoom: `13`)
- **Source Areas**:
  1. **Grand Place**: `1,000` people | Behavior: `70% Obedient, 20% Autonomous, 10% Random` | Polygon around `[50.8467, 4.3525]`
  2. **Midi Station (Gare du Midi)**: `2,000` people | Behavior: `60% Obedient, 30% Autonomous, 10% Random` | Polygon around `[50.8357, 4.3365]`
- **Target Areas**:
  1. **Parc du Cinquantenaire**: Capacity `50,000` people | Polygon around `[50.8405, 4.3928]`
  2. **Brussels Expo (Heysel)**: Capacity `20,000` people | Polygon around `[50.8967, 4.3347]`
- **No-Go Areas**:
  1. **Inner Ring / Wetstraat-Loi Bottleneck Zone**: Restricted corridor blocking direct central east-west transit (`[50.8450, 4.3650]` sector), forcing routes to detour north/south around the inner ring.
- **Vehicle Fleets**:
  1. **STIB Bus Fleet**: `100` buses × `50` capacity (`5,000` total cap) | Staging Depot: Place Flagey `[50.8276, 4.3725]`
  2. **Municipal Car Pool**: `100` private cars × `4` capacity (`400` total cap) | Staging Depot: Place Sainctelette `[50.8596, 4.3447]`

### 7.2 Paris Scenario
- **Map Center**: `[48.8647, 2.3333]` (Zoom: `13`)
- **Source Areas**:
  1. **Eiffel Tower (Champ de Mars)**: `1,500` people | Behavior: `65% Obedient, 25% Autonomous, 10% Random` | Polygon around `[48.8584, 2.2945]`
  2. **Arc de Triomphe (Place Charles de Gaulle)**: `500` people | Behavior: `75% Obedient, 15% Autonomous, 10% Random` | Polygon around `[48.8738, 2.2950]`
- **Target Areas**:
  1. **Parc de la Villette**: Capacity `50,000` people | Polygon around `[48.8938, 2.3908]`
  2. **Parc de Bagatelle**: Capacity `20,000` people | Polygon around `[48.8719, 2.2472]`
- **No-Go Areas**:
  1. **Pont d'Iéna**: Bridge polygon crossing the Seine `[48.8598, 2.2921]`, blocking direct river crossing from Eiffel Tower to Trocadéro.
  2. **Pont de l'Alma**: Bridge polygon crossing the Seine `[48.8633, 2.3015]`, blocking the adjacent Seine crossing and forcing detour via Pont de Bir-Hakeim or Pont Alexandre III.
- **Vehicle Fleets**:
  1. **RATP Bus Fleet**: `50` buses × `50` capacity (`2,500` total cap) | Staging Depot: Esplanade des Invalides `[48.8606, 2.3125]`

---

## 8. Living Specification & Iteration Log

This specification is maintained as a living document. Every functional addition, UI refinement, or routing/simulation enhancement requested during iterative reviews is integrated into the core sections above and logged below:

| Iteration | Date | Summary of Specification & Implementation Changes |
| :--- | :--- | :--- |
| **v1.0** | 2026-09-17 | Initial restructured specification & full React/TypeScript/Leaflet implementation of the 4-panel cockpit UI, Brussels & Paris presets, OSRM + Turf.js obstacle-avoiding routing engine, and 60 FPS thermal heatmap simulation. |
| **v1.1** | 2026-09-17 | Added requirement and implementation for **Route Pickup Locations**: once route computation completes, specific pickup/assembly points are established inside each Source Area for every route and marked with **blue squares** on the map (with interactive tooltips and legend entry). |
| **v1.2** | 2026-09-17 | Refined **Population Behavior & Vehicle Boarding Mechanics**: (1) Evacuees remain inside their Source Area until picked up by a vehicle; (2) `Obedient` evacuees head immediately to the closest pickup location, `Random` evacuees wander inside the zone until within **50m** of a pickup location, and `Autonomous` evacuees circulate along the **limits (perimeter)** of the Source Area until encountering a pickup location; (3) Evacuees wait at pickup locations until vehicles arrive, making the heatmap **hotter around pickup locations**; (4) Vehicles wait at pickup locations until reaching **80% occupancy** before departing to Target Shelters, progressively **cooling down the Source Area heatmap** as people are evacuated. |
| **v1.3** | 2026-09-17 | Updated **Vehicle Departure Condition**: Vehicles waiting at a Pickup Location now depart for the Target Area when **either** they reach **80% occupancy** **OR** they have been waiting **10 minutes** (`600` simulation seconds), **whichever happens first, provided there is at least 1 passenger onboard**. Added live waiting timer (`MM:SS / 10:00`) tracking to vehicle state, map tooltips, and telemetry cards. |
