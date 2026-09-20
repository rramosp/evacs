# Evacuation Management Application — Functional & Technical Specification

## 1. Overview & Objectives

The **Evacuation Management Application** is an interactive decision-support and simulation tool designed to help emergency management personnel coordinate urban evacuations, compute optimal routing paths around hazards, and simulate crowd and vehicle movement over time.

### Primary Goal (Scoping Phase)
Build a responsive, high-usability web User Interface (UI) backed by OpenStreetMap (OSM) data to allow rapid concept iteration with stakeholders. The system combines interactive GIS zone management, obstacle-aware route computation with designated assembly/pickup points, mid-simulation dynamic scenario editing, and an animated agent/density simulation with real-time heatmap visualization.

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
  5. **Pause & Dynamic Mid-Simulation Editing**:
     - Operators may pause (`Stop simulation`) at any point to modify areas and vehicles (including changing population counts in Source Areas, disabling Target Areas, adding/removing No-Go zones, or adding/removing vehicles) under strict operational safety constraints.
     - Upon restarting (`Run simulation`), routes are dynamically recomputed for all remaining and new evacuees into enabled Target Areas, and any running vehicles currently carrying passengers are immediately routed to the **closest enabled Target Area** before transitioning to the newly recomputed routes.

---

## 3. Domain Entities & Data Models

### 3.1 Evacuation Source Areas & Internal Population Behavior
Geographic zones requiring evacuation. The population within a Source Area **remains inside that Source Area until picked up by an evacuation vehicle**. Their behavioral profile governs how they move *within* the Source Area to reach a Pickup Location (Blue Square):
- **Name**: String identifier (e.g., `"Grand Place"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Total Population**: Integer count of evacuees (`N >= 0`). Can be modified while the simulation is paused.
- **Deletion Constraint**: **A Source Area cannot be removed while there are still people remaining inside it (`remainingPopulation > 0`)**.
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
- **Disabled State (`disabled: boolean`)**:
  - **Target Areas cannot be removed/deleted**.
  - Instead, Target Areas can be **disabled** (or re-enabled) while the simulation is paused. A disabled Target Area receives **no more people** (excluded from routing and mid-transit vehicle redirection), while retaining its existing `currentOccupancy`.

### 3.3 No-Go Areas (Hazard / Blocked Zones)
Restricted or hazardous areas impassable for evacuation routing.
- **Name**: String identifier (e.g., `"Pont d'Iéna"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **CRUD Rules**: Can be freely added, modified, or removed while the simulation is paused.
- **Routing Effect**: Any road network edge or segment intersecting a No-Go polygon is marked impassable (infinite weight / removed from routing graph).

### 3.4 Evacuation Vehicle Fleets & Dual Departure Condition (80% Occupancy or 10-Minute Timeout)
Available public or private transport units managed by authorities, modeled as **Fleets / Staging Depots**:
- **Name**: String identifier (e.g., `"STIB Bus Fleet Alpha"`).
- **Vehicle Type**: Category (`Bus`, `Private Car`, `Shuttle`, etc.).
- **Initial Location**: Point (`GeoJSON Point` — `[lat, lng]`) representing the depot or staging area at `t = 0`.
- **Unit Count**: Number of vehicles in this fleet (`Integer`).
- **Capacity per Unit**: Passenger occupancy per vehicle (e.g., `50` for buses, `4` for cars).
- **CRUD Rules**: Vehicles can be freely added, modified, or removed while the simulation is paused.
- **Dual Departure Rule (80% Occupancy OR 10 Minutes Waiting Time)**:
  - When a vehicle arrives at a Source Area Pickup Location (Blue Square), a waiting timer (`waitingAtPickupSeconds`) starts at `00:00` and the vehicle boards any waiting evacuees.
  - The vehicle waits at the Pickup Location until **whichever of the following two events happens first**:
    1. **80% Occupancy Reached**: `currentOccupancy >= 0.80 * maxCapacity`.
    2. **10 Minutes Waiting Time Elapsed**: `waitingAtPickupSeconds >= 600` (10 minutes of simulation time).
  - Provided there is **at least 1 passenger** onboard (`currentOccupancy >= 1`), the vehicle immediately departs along the computed route to the Target Area shelter.

---

## 4. Operational Rules for Mid-Simulation Pause, Editing & Restart

### 4.1 Modification Constraints
1. **Pause Requirement**: No area (Source, Target, No-Go) or vehicle definition can be added, modified, disabled, or removed unless the simulation is **paused** (`isSimulating === false`). While the simulation is running, all entity modification controls are locked.
2. **Source Area Removal**: Removing a Source Area is strictly disallowed if there are still people inside it (`remainingPopulation > 0`).
3. **Target Area Removal & Disabling**: Removing a Target Area is strictly disallowed. Target Areas may only be **disabled** (or re-enabled), preventing any further evacuees from being routed or delivered to them.
4. **No-Go Areas & Vehicles**: No-Go areas and Vehicle Fleets can be added or removed whenever the simulation is paused.

### 4.2 Simulation Restart & Dynamic Re-Routing Mechanics
When the user restarts (`Run simulation`) a paused simulation after modifying or adding any Source Area, Target Area, No-Go Area, or Vehicle Fleet:
1. **Dynamic Route Recomputation**:
   - The routing engine automatically recomputes obstacle-avoiding evacuation routes to evacuate all remaining and newly added people in Source Areas into all active (non-disabled) Target Areas (including any newly added Target Areas).
2. **Mid-Transit Loaded Vehicle Redirection**:
   - Any running vehicle that currently holds passengers (`currentOccupancy > 0`) is immediately routed from its current geographic position to the **closest active (non-disabled) Target Area** (avoiding all No-Go areas).
   - Once that vehicle reaches the closest Target Area and offloads its passengers, it seamlessly transitions to follow the **newly recomputed evacuation routes** for all subsequent pickup/drop-off cycles.

---

## 5. UI Layout & UX Architecture

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

### 5.1 Left Panel: Parameters & Controls (`25% Width × 100% Height`)
- **Scenario Selector**: Dropdown to load preset scenarios (`Brussels`, `Paris`, or `Custom / Clear`).
- **Simulation Lock Banner**: Indicates when entity editing is locked during active simulation playback and unlocks automatically when paused.
- **Entity Management Accordion / Tabs**:
  - **Source Areas**: List with live remaining / total population count, behavioral split badge, and `Add (Draw Polygon)`, `Edit` (including population count changes), and `Delete` (enabled only when remaining population is `0`).
  - **Target Areas**: List with capacity/occupancy badges, `Add (Draw Polygon)`, `Edit`, and `Disable / Enable Shelter` toggle (no Delete action allowed).
  - **No-Go Areas**: List with hazard tags and `Add (Draw Polygon)`, `Edit`, `Delete` actions.
  - **Vehicle Fleets**: List with count/capacity summary and `Add (Place Pin)`, `Edit`, `Delete` actions.
- **Execution Toolbar**:
  - `Compute Evacuation Routes`
  - `Run Simulation` / `Resume Simulation`
  - `Stop Simulation` (Pauses simulation and unlocks entity editing)
  - `Reset Simulation` (Resets time to `t = 0` and restores initial source area population)
  - Simulation Speed Selector (`1x`, `2x`, `5x`, `10x`)

### 5.2 Center Area: Interactive OSM Map (`50% Width × 75% Height`)
- **Base Layer**: OpenStreetMap vector/raster tiles (Tactical Dark / Standard OSM).
- **Visual Overlays**:
  - Source Areas: Amber/Orange polygons with live remaining headcount badges.
  - Target Areas: Emerald Green polygons for active shelters; Slate Gray dashed polygons with `🚫 DISABLED` badge for disabled shelters.
  - No-Go Areas: Cross-hatched Crimson Red polygons.
  - **Route Pickup Locations (Blue Squares)**: Marked with a distinct **blue square** (`#2563eb`) displaying live waiting queue counts and active vehicle boarding timers (`MM:SS / 10:00`).
  - **Dynamic Heatmap Overlay**: Hotter around Pickup Locations as queues form; progressively cools down over time as vehicles evacuate people from Source Areas.

### 5.3 Bottom Panel: System & Simulation Console (`50% Width × 25% Height`)
- Timestamped log stream displaying routing computations, mid-simulation edits, route recomputations upon restart, loaded vehicle redirections to closest active shelters, and arrival confirmations.

### 5.4 Right Panel: Telemetry & KPI Dashboard (`25% Width × 100% Height`)
- Live evacuation progress KPIs, Blue Square pickup queues, Target Shelter occupancy meters (with `DISABLED` indicators), and behavioral breakdowns.

---

## 6. Recommended Technical Stack

- **Frontend Framework**: React 18+ with TypeScript and Vite.
- **UI Styling & Layout**: Vanilla CSS with custom tactical HSL design tokens + Lucide Icons.
- **Map & Geospatial Engine**: Leaflet (`leaflet`) + Turf.js (`@turf/turf`).
- **Routing Services**: OSRM HTTP API (`router.project-osrm.org`) paired with client-side Turf.js obstacle-avoidance waypoint routing.

---

## 7. Preset Scenarios

### 7.1 Brussels Scenario
- **Map Center**: `[50.8503, 4.3517]` (Zoom: `13`)
- **Source Areas**:
  1. **Grand Place**: `1,000` people | Behavior: `70% Obedient, 20% Autonomous, 10% Random`
  2. **Midi Station (Gare du Midi)**: `2,000` people | Behavior: `60% Obedient, 30% Autonomous, 10% Random`
- **Target Areas**:
  1. **Parc du Cinquantenaire**: Capacity `50,000` people
  2. **Brussels Expo (Heysel)**: Capacity `20,000` people
- **No-Go Areas**:
  1. **Inner Ring / Wetstraat-Loi Bottleneck Zone**
- **Vehicle Fleets**:
  1. **STIB Bus Fleet**: `100` buses × `50` capacity | Staging Depot: Place Flagey `[50.8276, 4.3725]`
  2. **Municipal Car Pool**: `100` private cars × `4` capacity | Staging Depot: Place Sainctelette `[50.8596, 4.3447]`

### 7.2 Paris Scenario
- **Map Center**: `[48.8647, 2.3333]` (Zoom: `13`)
- **Source Areas**:
  1. **Eiffel Tower (Champ de Mars)**: `1,500` people | Behavior: `65% Obedient, 25% Autonomous, 10% Random`
  2. **Arc de Triomphe (Place Charles de Gaulle)**: `500` people | Behavior: `75% Obedient, 15% Autonomous, 10% Random`
- **Target Areas**:
  1. **Parc de la Villette**: Capacity `50,000` people
  2. **Parc de Bagatelle**: Capacity `20,000` people
- **No-Go Areas**:
  1. **Pont d'Iéna**
  2. **Pont de l'Alma**
- **Vehicle Fleets**:
  1. **RATP Bus Fleet**: `50` buses × `50` capacity | Staging Depot: Esplanade des Invalides `[48.8606, 2.3125]`

---

## 8. Living Specification & Iteration Log

| Iteration | Date | Summary of Specification & Implementation Changes |
| :--- | :--- | :--- |
| **v1.0** | 2026-09-17 | Initial restructured specification & full React/TypeScript/Leaflet implementation of the 4-panel cockpit UI, Brussels & Paris presets, OSRM + Turf.js obstacle-avoiding routing engine, and 60 FPS thermal heatmap simulation. |
| **v1.1** | 2026-09-17 | Added requirement and implementation for **Route Pickup Locations**: once route computation completes, specific pickup/assembly points are established inside each Source Area for every route and marked with **blue squares** on the map (with interactive tooltips and legend entry). |
| **v1.2** | 2026-09-17 | Refined **Population Behavior & Vehicle Boarding Mechanics**: Evacuees remain inside their Source Area until picked up by a vehicle (`obedient` to closest pickup, `random` within 50m, `autonomous` along perimeter limits); heatmap glows hotter around pickup locations and cools down as vehicles evacuate people. |
| **v1.3** | 2026-09-17 | Updated **Vehicle Departure Condition**: Vehicles waiting at a Pickup Location depart when **either** they reach **80% occupancy** **OR** they have been waiting **10 minutes** (`600` simulation seconds), **whichever happens first, provided there is at least 1 passenger onboard**. |
| **v1.4** | 2026-09-19 | Added **Mid-Simulation Pause, Entity Modification Rules & Smart Restart Re-Routing**: (1) All area/vehicle edits require simulation to be paused; (2) Source Areas cannot be deleted if people still remain inside them; (3) Target Areas cannot be deleted, only **disabled** (`disabled: true`) so they receive no more people; (4) No-Go areas and vehicles can be added/removed while paused; (5) Restarting after modifications recomputes routes for all remaining and new people into enabled Target Areas, and routes any **running vehicles with passengers onboard directly to the closest enabled Target Area** before they follow the newly recomputed routes. |
