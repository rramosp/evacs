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
  4. Trigger **Run Simulation** to animate the movement of evacuees and vehicles over time from their established pickup locations to target shelters, visualized via a dynamic density heatmap and live telemetry metrics.

---

## 3. Domain Entities & Data Models

### 3.1 Evacuation Source Areas
Geographic zones requiring evacuation.
- **Name**: String identifier (e.g., `"Grand Place"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Total Population**: Integer count of evacuees (`N > 0`).
- **Behavioral Profile Distribution** (percentages summing to 100%):
  - **Obedient (`%`)**: Follow official designated evacuation routes and instructions strictly.
  - **Autonomous (`%`)**: Make dynamic local decisions based on observed conditions (e.g., slowing down or re-routing around visible traffic jams/congestion).
  - **Random (`%`)**: Exhibit panic or non-compliance, taking random or non-optimal exit paths regardless of official instructions.
- **Route Pickup Locations**: Specific `[lat, lng]` assembly points established within or along the perimeter of the Source Area polygon once routes are computed (one distinct pickup point per computed route, visually marked with a **blue square** on the map).

### 3.2 Evacuation Target Areas (Safe Zones)
Designated safe destinations or shelters where evacuees are directed.
- **Name**: String identifier (e.g., `"Parc du Cinquantenaire"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Capacity**: Maximum number of evacuees the area can accommodate (`Integer`).
- **Current Occupancy**: Tracked dynamically during simulation (`0` to `Capacity`).

### 3.3 No-Go Areas (Hazard / Blocked Zones)
Restricted or hazardous areas impassable for evacuation routing.
- **Name**: String identifier (e.g., `"Pont d'Iéna"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Routing Effect**: Any road network edge or segment intersecting a No-Go polygon is marked impassable (infinite weight / removed from routing graph).

### 3.4 Evacuation Vehicle Fleets
Available public or private transport units managed by authorities. To avoid requiring users to place hundreds of individual pins, vehicles are modeled as **Fleets / Staging Depots**:
- **Name**: String identifier (e.g., `"STIB Bus Fleet Alpha"`).
- **Vehicle Type**: Category (`Bus`, `Private Car`, `Shuttle`, etc.).
- **Initial Location**: Point (`GeoJSON Point` — `[lat, lng]`) representing the depot or staging area at `t = 0`.
- **Unit Count**: Number of vehicles in this fleet (`Integer`).
- **Capacity per Unit**: Passenger occupancy per vehicle (e.g., `50` for buses, `4` for cars).
- **Total Fleet Capacity**: `Unit Count × Capacity per Unit`.

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
  - `Stop / Reset Simulation` (Resets time to `t = 0` and clears heatmap state)
  - Simulation Speed Selector (`1x`, `2x`, `5x`, `10x`)

### 4.2 Center Area: Interactive OSM Map (`50% Width × 75% Height`)
- **Base Layer**: OpenStreetMap vector/raster tiles.
- **Interactive Drawing Tools**: Polygon drawing/editing controls for zones and marker placement for vehicle depots.
- **Visual Overlays**:
  - Source Areas: Color-coded polygons (Amber/Orange fill with border).
  - Target Areas: Color-coded polygons (Emerald Green fill with border).
  - No-Go Areas: Cross-hatched Crimson Red polygons.
  - **Route Pickup Locations (Blue Squares)**: Once route computation is completed, each route's specific pickup/assembly point within its Source Area is marked with a distinct **blue square** marker on the map (`#2563eb` / `#3b82f6` with crisp white border). Hovering or clicking displays the assigned route, cohort type, population count, and exact coordinates.
  - Computed Routes: Styled polylines originating from their respective blue square pickup locations to target shelters, showing primary (obedient), secondary (autonomous), random, and vehicle corridors.
  - Dynamic Heatmap Overlay: Time-evolving density layer showing evacuee concentration during simulation.
  - Vehicle Markers: Animated icons moving along routes between depots, blue square pickup points, and target shelters.

### 4.3 Bottom Panel: System & Simulation Console (`50% Width × 25% Height`)
- Timestamped log stream displaying:
  - Routing engine requests, established pickup location coordinates for each route, path lengths, estimated travel times, and detour warnings around No-Go zones.
  - Simulation tick events (e.g., `"[t=04:30] Bus Fleet #1 arrived at Grand Place Pickup Point, boarding 500 evacuees"`).
  - Capacity warnings if a Target Area approaches 100% occupancy.
- Filterable by log level (`INFO`, `WARN`, `ROUTING`, `SIMULATION`).

### 4.4 Right Panel: Telemetry & KPI Dashboard (`25% Width × 100% Height`)
*(Note: Originally left empty in early scoping; designated for live situational awareness metrics, with a toggle button to switch between KPI view and Blank Scoping View).*
- **Evacuation Progress Summary**:
  - Total Evacuated (`Safe at Target`) vs. `In Transit` vs. `Remaining at Source`.
  - Overall progress bar and elapsed simulation clock (`MM:SS`).
- **Target Area Occupancy Cards**:
  - Real-time fill bars (`Current / Capacity`) for each shelter.
- **Population Behavior Breakdown**:
  - Visual indicator of active Obedient, Autonomous, and Random agents.

---

## 5. Routing & Simulation Architecture

### 5.1 Routing Algorithm, Pickup Location Establishment & Obstacle Avoidance
- **Pickup Location Establishment**:
  - When `Compute evacuation routes` is triggered, the engine establishes a specific, distinct **Pickup Location (`[lat, lng]`)** inside or along the perimeter of each Source Area for every route originating from that zone (Obedient cohort route, Autonomous cohort route, Random cohort route, and Vehicle Fleet pickup route).
  - Pickup points are spatially distributed within the Source Area polygon toward the exit vector so crowds and vehicle fleets assemble at dedicated staging coordinates rather than overlapping at a single centroid point.
  - Each pickup point is rendered on the map as a **blue square marker**.
- **Obstacle Avoidance**:
  - *Note on OSRM*: Standard public OSRM HTTP endpoints (`router.project-osrm.org`) calculate fast shortest paths on OSM road networks but **do not natively support arbitrary polygon exclusion (`avoid_polygons`)** in public API requests.
  - **Hybrid Solution**:
    1. Use **OSRM** (or fallback urban road-grid synthesizer) starting from each route's established **Pickup Location** to the Target Area.
    2. Implement an **Obstacle-Aware Graph / Waypoint Detour Engine**: When a route intersects a user-defined No-Go polygon, compute boundary detour waypoints around the polygon's bounding box/hull and geometrically sanitize vertices to guarantee zero traversal through restricted zones.

### 5.2 Simulation & Heatmap Engine
- **Discrete Time-Step Animation**: Runs at configurable tick intervals (10 ticks/sec logical progression, smooth visual interpolation).
- **Agent & Group Dynamics**:
  - At `t = 0`, evacuee cohorts assemble at their respective route's **Blue Square Pickup Location** inside their Source Area.
  - **Vehicles** dispatch from staging depots to the assigned Source Area's **Pickup Location**, board evacuees up to fleet capacity, and transport them along routed road segments to Target Areas.
  - **Pedestrians / Remaining Evacuees** depart from their route's **Pickup Location** at walking speed (`~1.4 m/s` baseline), modulated by their behavioral type (`Obedient`, `Autonomous`, `Random`).
- **Heatmap Rendering**:
  - An HTML5 Canvas thermal heatmap layer renders real-time spatial density based on current cohort coordinates and population weights.

---

## 6. Recommended Technical Stack

- **Frontend Framework**: React 18+ with TypeScript and Vite.
- **UI Styling & Layout**: Vanilla CSS with custom tactical HSL design tokens + Lucide Icons.
- **Map & Geospatial Engine**:
  - **Leaflet** (`leaflet`) with custom HTML5 Canvas thermal heatmap overlay and custom divIcons for polygons, depot pins, and **blue square pickup markers**.
  - **Turf.js** (`@turf/turf`) for client-side polygon intersection checks, point-in-polygon sampling, pickup point distribution, and detour waypoint generation around No-Go polygons.
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
