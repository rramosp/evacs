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
  2. Draw or edit **Source Areas** (evacuation zones), **Target Areas** (safe shelters/assembly points), **Avoid Areas** (hazards/blocked zones), and **Vehicle Fleets** (staging depots).
  3. Trigger **Compute Evacuation Routes** to calculate optimal paths from sources to targets while avoiding Avoid Areas, respecting shelter capacities, and establishing specific **Pickup Locations (marked with blue squares)** on each Source Area for every route.
  4. Trigger **Run Simulation** to animate:
      - Evacuees moving *within* each Source Area toward established Pickup Locations (including underground Brussels Metro stations when enabled) according to their behavioral profile (`obedient`, `autonomous`, `random` via 2D Brownian motion), causing the heatmap to become hotter around Pickup Locations as queues form.
      - Street vehicles traveling along computed OpenStreetMap road routes at each fleet's configured **transit speed (`transitSpeedKmh`, default `25 km/h`)** using exact Haversine geodesic distances along the underlying map polylines, arriving at Pickup Locations, progressively boarding waiting evacuees according to each vehicle's configured **average time in seconds to load/unload one person (`loadUnloadTimePerPersonSeconds`)**, and departing for Target Shelters when **either 80% occupancy is reached OR 10 minutes of waiting time have elapsed** (whichever happens first, provided there is **at least 1 passenger** onboard).
      - When **Brussels Metro Evacuation** (`Use these stations for evacuation`) is enabled, underground metro trains operate concurrently along the static STIB metro rail trajectories (`data/brussels_metro_lines.parquet` and `data/brussels_metro_stations.parquet`) between metro stations inside Source Areas and metro stations inside active Target Areas, completely independent of `Compute Evacuation Routes` and unaffected by surface `Avoid Areas`.
      - Upon reaching a Target Shelter (or Target Metro Station), vehicles and metro trains transition into an **unloading** state (`status: 'unloading'`) and progressively offload passengers into the shelter according to `loadUnloadTimePerPersonSeconds` before departing empty along the reversed route polyline (`Target Shelter -> Pickup Location`) to pick up more people.
      - Progressive cooling of the Source Area heatmap over time as vehicles and metro trains evacuate the population.
   5. **Pause & Dynamic Mid-Simulation Editing**:
      - Operators may pause (`Pause simulation`) at any point to modify areas and vehicles (including changing population counts in Source Areas, disabling Target Areas, adding/removing Avoid Areas, adding/modifying/removing vehicles, their `transitSpeedKmh`, and their per-person load/unload times, or toggling Brussels Metro evacuation parameters) under strict operational safety constraints.
      - Upon restarting (`Run simulation`), routes are dynamically recomputed for all remaining and new evacuees into enabled Target Areas, and any running vehicles currently carrying passengers are immediately routed to the **closest enabled Target Area** before transitioning to the newly recomputed routes.

---

## 3. Domain Entities & Data Models

### 3.1 Evacuation Source Areas & Internal Population Behavior
Geographic zones requiring evacuation. The population within a Source Area **remains inside that Source Area until picked up by an evacuation vehicle**. Their behavioral profile governs how they move *within* the Source Area to reach a Pickup Location (Blue Square):
- **Name**: String identifier (e.g., `"Grand Place"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Total Population**: Integer count of evacuees (`N >= 0`). Can be modified while the simulation is paused.
- **Remove with Confirmation**: Every Source Area includes a **`Remove`** button (enabled while paused). Clicking **`Remove`** opens a confirmation popup modal (`#confirm-remove-area-modal`); upon confirmation, the Source Area is removed from the configuration, map, routes, clusters, pickup locations, vehicles, and heatmap memory.
- **Behavioral Profile Distribution** (percentages summing to 100%):
  - **Obedient (`%`)**: Immediately head directly to the **closest Pickup Location** within the Source Area at `t = 0`.
  - **Autonomous (`%`)**: Wander along the **limits (perimeter boundary)** of the Source Area polygon until they stumble upon a Pickup Location.
  - **Random (`%`)**: Diffuse inside the Source Area polygon following a true **2D Brownian motion (Wiener process)** with independent Gaussian displacements $(\Delta x, \Delta y) \sim \mathcal{N}(0, \sigma^2 \Delta t)$ at every simulation tick (reflecting off polygon boundaries) until they come within **50 meters** of any Pickup Location, at which point they direct themselves straight to it.
- **Route Pickup Locations (Blue Squares)**: Specific `[lat, lng]` assembly points established on/within the Source Area polygon once routes are computed. Any evacuees arriving at a Pickup Location wait there in queue (`waitingPopulation`) until a vehicle boards them.

### 3.2 Evacuation Target Areas (Safe Zones)
Designated safe destinations or shelters where evacuees are transported by vehicles.
- **Name**: String identifier (e.g., `"Parc du Cinquantenaire"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **Capacity**: Maximum number of evacuees the area can accommodate (`Integer`).
- **Current Occupancy**: Tracked dynamically as vehicles offload passengers (`0` to `Capacity`).
- **Disabled State (`disabled: boolean`) & Remove with Confirmation**:
  - Target Areas can be **disabled** (or re-enabled) while the simulation is paused via the **`Disable` / `Enable`** button. A disabled Target Area receives **no more people** (excluded from routing and mid-transit vehicle redirection), while retaining its existing `currentOccupancy`.
  - Every Target Area also includes a **`Remove`** button (enabled while paused) alongside **`Disable` / `Enable`**. Clicking **`Remove`** opens a confirmation popup modal (`#confirm-remove-area-modal`); upon confirmation, the Target Area is removed from the configuration, map, routes, pickup states, and simulation memory.

### 3.3 Avoid Areas (Hazard / Blocked Zones)
Restricted or hazardous areas impassable for evacuation routing.
- **Name**: String identifier (e.g., `"Pont d'Iéna"`).
- **Geometry**: Polygon (`GeoJSON Polygon`) drawn on the map.
- **CRUD Rules & Remove with Confirmation**: Can be freely added, modified, or removed while the simulation is paused. Clicking **`Remove`** on an Avoid Area opens a confirmation popup modal (`#confirm-remove-area-modal`); upon confirmation, the Avoid Area is removed from the configuration and map.
- **Strict Non-Intersection Guarantee (Zero Crossings)**:
  - **Evacuation routes, vehicle approach routes, and mid-simulation vehicle redirection routes must never cross or touch any Avoid Area polygon** (`turf.booleanIntersects(routeSegment, avoidPolygon) === false` across every polyline segment).
  - The routing engine enforces this invariant using a **2D Obstacle Visibility Graph + Dijkstra Shortest-Path Solver** over multi-tier buffered exterior vertices around all Avoid Area polygons:
    1. Collision-free detour waypoints are computed around all Avoid Area polygons and passed to OSRM for road-network routing.
    2. Whenever any segment or sub-path returned by OSRM enters or crosses an Avoid Area polygon, surgical segment-level repair replaces that sub-path with the shortest collision-free exterior visibility-graph detour around the obstacle.

### 3.4 Evacuation Vehicle Fleets, Transit Speed (`km/h`), Per-Person Loading/Unloading Time, Empty Return Routing & Dual Departure Condition
Available public or private transport units managed by authorities, modeled as **Fleets / Staging Depots**:
- **Name**: String identifier (e.g., `"STIB Bus Fleet Alpha"`).
- **Vehicle Type**: Category (`Bus`, `Private Car`, `Shuttle`, etc.).
- **Initial Location**: Point (`GeoJSON Point` — `[lat, lng]`) representing the depot or staging area at `t = 0`.
- **Unit Count**: Number of vehicles in this fleet (`Integer`).
- **Capacity per Unit**: Passenger occupancy per vehicle (e.g., `50` for buses, `4` for cars).
- **Transit Speed (`transitSpeedKmh`)**: Configured physical transit speed of vehicles in kilometers per hour (`km/h`), defaulting to **`25 km/h`** ($\approx 6.944\text{ m/s}$). Configurable when creating or editing a Vehicle Fleet.
- **Average Load / Unload Time per Person (`loadUnloadTimePerPersonSeconds`)**: Average time in seconds required to load (board) or unload (disembark) one person into or out of each vehicle (e.g., `2` seconds/person for buses, `3` seconds/person for private cars). Configurable when creating or editing a Vehicle Fleet.
- **CRUD Rules**: Vehicles (and their count, capacity, `transitSpeedKmh`, and `loadUnloadTimePerPersonSeconds`) can be freely added, modified, or removed while the simulation is paused.
- **Realistic Map-Distance Kinematics & True 1:1 Simulation Clock**:
  - Every route polyline (`approachCoords` and `evacCoords`) has its exact vertex-to-vertex geodesic segment lengths computed in meters via the spherical Haversine formula (`haversineMeters` / `buildCumulativeDistances`) over the underlying OpenStreetMap coordinates.
  - The simulation clock runs at a true 1:1 ratio with wall-clock time at `1x` playback speed (`deltaSimSec = wallDeltaSec * simSpeed`), and each vehicle advances along its route polyline by $\Delta d = v_{\text{m/s}} \cdot \Delta t_{\text{sim}}$ where $v_{\text{m/s}} = \text{transitSpeedKmh} \times \frac{1000}{3600}$. For example, a vehicle configured at `25 km/h` (`6.944 m/s`) traversing a `3.0 km` OpenStreetMap route takes exactly `432` simulation seconds (`07:12`).
- **Initial Depot Dispatch vs. Subsequent Empty Return Routing**:
  - **Initial Dispatch from Designated Fleet Depots ($t = 0$ and Newly Added Fleets)**: When the simulation starts (or when a newly added Vehicle Fleet is deployed), vehicles originate at their designated **Vehicle Fleet staging location (`fleet.location`)** and travel along the computed obstacle-avoiding approach route (`route.approachCoordinates`) at `transitSpeedKmh` to their assigned Pickup Location (`route.pickupLocation`).
  - **Subsequent Empty Return Trips (Post-Offload)**: After completing passenger unloading at a Target Area shelter, empty vehicles return to pick up additional population by reversing the existing computed evacuation route polyline (`Target Area -> Pickup Location`) at `transitSpeedKmh`.
- **Progressive Passenger Loading at Pickup Locations & Dual Departure Rule (80% Occupancy OR 10 Minutes Waiting Time)**:
  - When a vehicle arrives at a Source Area Pickup Location (Blue Square), a waiting timer (`waitingAtPickupSeconds`) starts at `00:00` and waiting evacuees board the vehicle at a rate governed by `loadUnloadTimePerPersonSeconds` (`1` person per `loadUnloadTimePerPersonSeconds` seconds per active vehicle in the convoy, with fractional progress accumulated across ticks via `loadingProgressRemainder`).
  - Lead waiting vehicles at a Pickup Location reserve their required queue seats up to 80% capacity so they fill and depart first without splitting non-overflow queues across waiting vehicles.
  - The vehicle waits and boards at the Pickup Location until **whichever of the following events happens first**:
    1. **80% Occupancy Reached**: `currentOccupancy >= 0.80 * maxCapacity`.
    2. **10 Minutes Waiting Time Elapsed**: `waitingAtPickupSeconds >= 600` (10 minutes of simulation time).
    3. **Final Evacuees Boarded**: All remaining evacuees for that pickup/source area have finished boarding.
  - Provided there is **at least 1 passenger** onboard (`currentOccupancy >= 1`), the vehicle immediately departs along the computed route to the Target Area shelter.
- **Progressive Passenger Unloading at Target Shelters (`status: 'unloading'`)**:
  - When a loaded vehicle reaches its Target Area shelter, it enters `status: 'unloading'` and unloads passengers into the shelter at a rate governed by `loadUnloadTimePerPersonSeconds` (`1` person per `loadUnloadTimePerPersonSeconds` seconds per active vehicle in the convoy, with fractional progress accumulated via `unloadingProgressRemainder`).
  - As passengers step off the vehicle on each tick, they are transferred from `veh.currentOccupancy` (in-transit) to `target.currentOccupancy` (`totalEvacuated`), preserving exact population conservation ($\text{totalEvacuated} + \text{totalInTransit} + \text{totalRemainingAtSource} = \text{Total Population}$) at every tick. Once `currentOccupancy` reaches `0`, the vehicle departs empty along the reversed route polyline to pick up more people (or marks itself `'completed'` if the source zone is cleared).

### 3.5 Brussels Metro Network & Underground Train Evacuation
Underground rapid-transit rail network for the Region of Brussels, backed by GeoParquet datasets [`data/brussels_metro_lines.parquet`](data/brussels_metro_lines.parquet) (8 directional STIB Metro track geometries across Lines `1`, `2`, `5`, and `6`) and [`data/brussels_metro_stations.parquet`](data/brussels_metro_stations.parquet) (60 STIB Metro stations with `name_fr`, `name_nl`, `stop_id`, `line`, and point geometry):
- **Server & Static Data Pipeline**:
  - Server-side Python script [`server/brussels_metro.py`](server/brussels_metro.py) (exposed at `GET /api/brussels-metro/network` in [`vite.config.ts`](vite.config.ts)) reads both Parquet files via `geopandas`, reprojects geometries to `EPSG:4326` (`[lat, lng]`), and returns all line segments and stations, with pre-parsed fallback data in [`src/data/brusselsMetroData.ts`](src/data/brusselsMetroData.ts).
- **Brussels Region Geospatial Activation Check (`hasAnyAreaInBrussels`)**:
  - Evaluated via `BRUSSELS_REGION_BOUNDS` (`lat: 50.76..50.95`, `lng: 4.22..4.52`) in [`src/services/brusselsMetroService.ts`](src/services/brusselsMetroService.ts). The **`Brussels Metro`** UI section (`#brussels-metro-section`) is rendered **if and only if** at least one Source Area or Target Area polygon lies within the Region of Brussels.
- **Station-in-Area Detection (`findBrusselsMetroStationsInAreas`)**:
  - Automatically checks all 60 STIB Metro stations against every Source Area and Target Area polygon using `turf.booleanPointInPolygon`.
  - Lists all matched stations inside Source Areas (`#brussels-metro-source-stations`) and inside Target Areas (`#brussels-metro-target-stations`) with their station name, parent area name, and served metro line badges (`M1` `#B5378C`, `M2` `#ED6C23`, `M5` `#F6A90B`, `M6` `#0066A3`).
- **Static Underground Metro Corridors, Station Pickup/Drop-Off Establishment & Train Evacuation (`buildBrusselsMetroEvacuationCorridors` & `appendMetroPickupsAndTrains`)**:
  - When at least one metro station lies inside a Source Area and at least one metro station lies inside an active (non-disabled) Target Area, an evacuation control panel (`#brussels-metro-evacuation-controls`) appears with:
    1. Checkbox **`Use these stations for evacuation`** (`#chk-use-metro-for-evacuation`, `useForEvacuation: boolean`, enabled by default).
    2. Input **`number of trains available`** (`#input-metro-trains-available`, default `8` trains).
    3. Input **`capacity of each train`** (`#input-metro-train-capacity`, default `300` passengers/train).
  - **Source Area Metro Stations as Pickup Points & Target Area Metro Stations as Drop-Off Points**:
    - Every metro station located inside a Source Area is established as a **Metro Pickup Point** (`location: corridor.sourceStation.position`), and every metro station located inside an active Target Area is established as a **Metro Drop-Off Point** (`dropOffLocation: corridor.targetStation.position`, `metroTargetStationName: corridor.targetStation.name_fr`).
    - `buildBrusselsMetroEvacuationCorridors` connects every Source Area metro station to its optimal active Target Area metro station (and ensures every active Target Area metro station is connected from its optimal Source Area metro station) along the **exact static STIB metro rail geometry** (`computeMetroTrajectoryBetweenStations`, preferring direct same-line connections first and supporting cross-line transfers at STIB interchange hubs such as `Gare de l'Ouest`, `Beekkant`, and `Arts-Loi`).
  - **Independence from Street Route Computation & Immunity to Avoid Areas**:
    - Metro lines are fixed underground rail trajectories (`isMetro: true`). Clicking **`Compute Evacuation Routes`** is not required when evacuating via Brussels Metro (users can run Metro-only scenarios without any street routes or street vehicle fleets), and surface **`Avoid Areas`** do **not** block or detour underground metro trains.
    - For any Source Area served by active Brussels Metro corridors, all population clusters inside that Source Area (`obedient`, `random` 2D Brownian walk, and `autonomous`) converge directly to the Source Area's interior **Metro Station Pickup Point(s)** so the station platforms and Metro trains are exclusively and effectively used to evacuate that Source Area.
  - **Underground Train Simulation & Platform Dispatch Cadence (`appendMetroPickupsAndTrains` & `stepSimulationState`)**:
    - Each available train (`1..trainCount`, distributed across active corridors) is instantiated as an individual `ActiveVehicleUnit` (`vehicleType: 'Metro'`, `unitCount: 1`, `maxCapacity: trainCapacity`, transit speed `45 km/h`, multi-door boarding/alighting `0.2 s/person`) starting at its Source Area Metro Station Pickup Point (`corridor.sourceStation.position`) with short staggered platform headways (`tIdx * 18s`).
    - While waiting at a Source Area Metro Station Pickup Point, a Metro train boards waiting evacuees at `0.2 s/person` (pooling across sibling corridors sharing the same Source Station platform when needed) and departs along the exact metro line polyline (`status: 'to_target'`) as soon as it reaches **80% occupancy**, **OR** all remaining evacuees have boarded, **OR** the platform queue is emptied (`remainingQueueForVeh === 0`) after at least `25s` of platform dwell time (`reachedMetroCadence`) with at least `1` passenger onboard.
    - Upon reaching the **Target Area Metro Station Drop-Off Point** (`corridor.targetStation.position`), the train transitions to `status: 'unloading'` (`0.2 s/person`) to disembark passengers into the Target Area shelter occupancy, and then returns empty (`status: 'to_pickup'`) along the reversed metro line polyline back to the Source Area Metro Station Pickup Point for subsequent trips until 100% of the Source Area is evacuated.

---

## 4. Operational Rules for Mid-Simulation Pause, Editing & Restart

### 4.1 Modification Constraints
1. **Pause Requirement**: No area (Source, Target, Avoid) or vehicle definition can be added, modified, disabled, or removed unless the simulation is **paused** (`isSimulating === false`). While the simulation is running, all entity modification controls are locked.
2. **Area Removal with Confirmation Popup**: Every Source Area, Target Area, and Avoid Area has a **`Remove`** button in the Parameters panel. Clicking **`Remove`** displays a confirmation popup window (`#confirm-remove-area-modal`) asking the user to confirm; if confirmed, the area is removed from the configuration, map, routes, and simulation memory.
3. **Target Area Disabling Preserved**: In addition to the **`Remove`** button, Target Areas retain their **`Disable` / `Enable`** button (`disabled: boolean`), allowing operators to temporarily disable a shelter from receiving additional evacuees without deleting it.
4. **Avoid Areas & Vehicles**: Avoid Areas and Vehicle Fleets can be added or removed whenever the simulation is paused.

### 4.2 Simulation Restart & Dynamic Re-Routing Mechanics
When the user restarts (`Run simulation`) a paused simulation after modifying or adding any Source Area, Target Area, Avoid Area, or Vehicle Fleet:
1. **Dynamic Route Recomputation**:
   - The routing engine automatically recomputes obstacle-avoiding evacuation routes to evacuate all remaining and newly added people in Source Areas into all active (non-disabled) Target Areas (including any newly added Target Areas).
2. **Mid-Transit Loaded Vehicle Redirection**:
   - Any running vehicle that currently holds passengers (`currentOccupancy > 0`) is immediately routed from its current geographic position to the **closest active (non-disabled) Target Area** (avoiding all Avoid Areas).
   - Once that vehicle reaches the closest Target Area and offloads its passengers, it seamlessly transitions to follow the **newly recomputed evacuation routes** (traveling empty along the existing route polyline back to its assigned Pickup Location).

---

## 5. UI Layout & UX Architecture

The viewport is divided into a **4-Panel Cockpit Layout** (`100vw × 100vh`, non-scrolling outer flex container) where the **Left Control Panel**, **Bottom Log Panel**, and **Right Telemetry Panel** are **independently collapsible**, dynamically giving all reclaimed horizontal and vertical space to the **Center Map Viewport**:

```
+-------------------+-----------------------------------+-------------------+
|                   |                                   |                   |
|                   |                                   |                   |
|                   |            CENTER MAP             |                   |
|    LEFT PANEL     |         (OSM + Overlays)          |    RIGHT PANEL    |
|   (Parameters &   |   Default: 50% W × 75% H          |  (Live Telemetry  |
|     Controls)     |   Expands dynamically (`flex: 1`) |   & Analytics)    |
|                   |   up to ~100% W × ~100% H         |                   |
|  25% W (or 38px   +-----------------------------------+  25% W (or 38px   |
|  collapsed rail)  |           BOTTOM PANEL            |  collapsed rail)  |
|   100% Height     |      (System & Simulation Logs)   |   100% Height     |
|   [Collapsible]   |   25% H (or 36px collapsed bar)   |   [Collapsible]   |
+-------------------+-----------------------------------+-------------------+
```

- **Independent Panel Collapse & Dynamic Center Map Expansion**:
  - **Left Panel Collapse (`#btn-toggle-left-panel`)**: Collapses the Left Control Panel (`25%` width) into a `38px` vertical tactical rail displaying an expand button and rotated `EVAC-OPS — PARAMETERS & CONTROLS` label.
  - **Right Panel Collapse (`#btn-toggle-right-panel`)**: Collapses the Right Situational Telemetry Panel (`25%` width) into a `38px` vertical tactical rail displaying an expand button, a live evacuation progress percentage badge (`{progressPercent}%`), and rotated `SITUATIONAL TELEMETRY` label.
  - **Bottom Log Panel Collapse (`#btn-toggle-bottom-panel`)**: Collapses the Bottom Log Console (`25vh` height) into a compact `36px` header bar that retains the event counter badge, a live one-line preview of the most recent log entry, and an `Expand Logs` button.
  - **Automatic Map & Heatmap Canvas Resize (`ResizeObserver`)**: The Center Column (`.cockpit-center-column`) and Map Area (`.cockpit-map-area`) use `flex: 1; min-width: 0; min-height: 0;` and attach a `ResizeObserver` to the Leaflet container in [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx) that automatically calls `map.invalidateSize({ animate: false })` and `renderHeatmapCanvas()` whenever any panel is collapsed or expanded.

### 5.1 Left Panel: Parameters & Controls (`25% Width × 100% Height`, Independently Collapsible)
- **Brand Header Logo ([`imgs/evac-logo.png`](imgs/evac-logo.png)) & Panel Collapse Toggle (`#btn-toggle-left-panel`)**: Displays the `imgs/evac-logo.png` (`EVAC-SIM`) logo banner at the top of the Left Panel alongside the `#btn-toggle-left-panel` button (`Collapse`), which collapses the Left Panel to a `38px` vertical rail and expands the Center Map horizontally.
- **Scenario Selector**: Dropdown to load preset scenarios (`Brussels`, `Paris`, or `Custom / Clear`).
- **Top-Justified Stack of Collapsible Sections (`.left-panel-sections-stack`, `justify-content: flex-start`, All Startup-Collapsed by Default)**:
  All collapsible sections below start **collapsed (`true`)** when the application starts and are top-justified immediately beneath the Preset Scenario selector in the following order:
  1. **Parameters Section (Collapsible — `#toggle-parameters-section`, Placed Above Execution & Simulation)**:
     - Collapsible section header (`PARAMETERS`) wrapping the **Simulation Lock Banner** (when simulation is running), the **New Entity Creation Modal Card** (when drawing/placing), the **Entity Category Navigation Tabs** (`Sources`, `Targets`, `Avoid Areas`, `Vehicles`), and the **Entity List**:
       - **Source Areas**: List with live remaining / total population count, behavioral split badge, and `Add (Draw Polygon)`, `Edit` (including population count changes), and `Remove` (opens confirmation popup modal `#confirm-remove-area-modal`).
       - **Target Areas**: List with capacity/occupancy badges, `Add (Draw Polygon)`, `Edit`, `Disable / Enable` toggle, and `Remove` (opens confirmation popup modal `#confirm-remove-area-modal`).
       - **Avoid Areas**: List with hazard tags and `Add (Draw Polygon)`, `Edit`, and `Remove` (opens confirmation popup modal `#confirm-remove-area-modal`).
       - **Vehicle Fleets**: List with unit count, seat capacity, transit speed (`transitSpeedKmh` in `km/h`, default `25 km/h`), and per-person load/unload time (`loadUnloadTimePerPersonSeconds` in `s/pax`) summary, plus `Add (Place Pin)`, `Edit` (count, capacity per unit, transit speed `km/h`, and load/unload time per person), and `Delete` actions.
  2. **Execution & Simulation Section (Collapsible — `#toggle-execution-section`, Placed Below Parameters)**:
     - Collapsible section header (`EXECUTION & SIMULATION`) allowing the user to expand or collapse the execution and simulation controls:
       - `Compute Evacuation Routes` (Disabled while a simulation is running / in progress until the simulation finishes or is reset via `Reset Simulation`)
       - `Run Simulation` / `Resume Simulation`
       - `Pause Simulation` (Pauses simulation and unlocks entity editing)
       - `Reset Simulation` (Resets time to `t = 0`, restores initial source area population, and re-enables `Compute Evacuation Routes`)
       - **`Simulation report` Button (`#btn-simulation-report`)**: Enabled **only when the simulation is paused** (`!isSimulating`). Clicking **`Simulation report`** opens a popup modal (`#simulation-report-modal`) centered in the browser window via React portal (`SimulationReportModal.tsx`), displaying a comprehensive simulation report including:
         1. **Number of people evacuated to shelter** (`totalEvacuated`, completion `%`, and shelter-level arrivals).
         2. **Number of people still not evacuated**, with exact breakdown per population behaviour (`obedient`, `autonomous`, `random`) and sub-stage breakdown (moving inside Source Zone, waiting/boarding at Pickup Locations, and in transit/unloading on vehicles).
         3. **Mean evacuation time per person**, overall and broken down per population behaviour (`obedient`, `autonomous`, `random`), alongside mean pickup assembly time per behaviour.
         4. **Number of people evacuated at each pick up location** (both total boarded at pickup with `obedient`/`autonomous`/`random` breakdown and total delivered to shelter, plus active queue count).
         5. **Mean vehicle wait time at each pick up location** (`MM:SS` and raw seconds across completed departures and active waiting vehicles, plus peak wait time and average vehicle departure load factor `%`).
         6. **Additional operational metrics**: Shelter capacity utilization & remaining headroom bars, evacuation & boarding velocity (`pax/min`), estimated time to 100% clearance (`ETA`), completed vehicle convoys, Avoid Area avoidance summary, and `Export JSON` download button.
       - Simulation Speed Selector (`1x`, `2x`, `5x`, `10x`, `25x`, `50x`, `100x`)
  3. **Space Data Section (Collapsible — `#toggle-space-data-section`, Placed Below Execution & Simulation)**:
     - Collapsible section header (`SPACE DATA`) stacked directly below the `Execution & Simulation` section.
  - **Current Date Text Box**: Located at the top of the Space Data section (`YYYY-MM-DD`, defaulting to today's date).
  - **`aggregation period` Dropdown Selector**: Located above the action button with options:
    - `'last week'`
    - `'last 2 weeks'`
    - `'last month'` (default)
    - `'last three months'`
    - `'last six months'`
    - `'last year'`
  - **Compact `Sentinel 2 Optical Data` Button** (`#btn-sentinel2-optical-data`): Styled as a compact button below the `aggregation period` selector.
  - **Compact `Sentinel 1 SAR Data` Button** (`#btn-sentinel1-sar-data`): Placed directly below the **`Sentinel 2 Optical Data`** button.
  - **Compact `Planet Scope` Button (`#btn-planet-scope-data`) & Popup Modal (`#planet-scope-modal`)**: Placed directly below the **`Sentinel 1 SAR Data`** button. Clicking **`Planet Scope`** opens a modal popup displaying `"Not yet available"` with a **`Dismiss`** button (`#btn-dismiss-planet-scope-modal`) to close the popup.
  - Clicking **`Sentinel 2 Optical Data`** computes the derived date window `[start_date, end_date]` from the **Current Date** text box and selected **`aggregation period`**, logs the actual derived dates (`start_date` to `end_date`) in the Bottom Logging Panel, and invokes `POST /api/space-data/sentinel2`, which executes `server/ee_sentinel2.py` using Google Earth Engine (`ee`) on the server side:
    ```python
    ee.Authenticate()
    ee.Initialize(project='geo-stars')

    # 3. Load the Sentinel-2 Surface Reflectance collection and apply filters
    s2_collection = (
        ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(poi)                              # Filter by location
        .filterDate(start_date, end_date)               # Filter by derived date range
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10)) # Keep images with < 10% clouds
    )

    # 4. Reduce the collection to a single image using the median value per pixel
    median_image = s2_collection.median()

    # 5. Define visualization parameters for True Color (Red, Green, Blue bands)
    vis_params = {
        'bands': ['B4', 'B3', 'B2'], # B4=Red, B3=Green, B2=Blue
        'min': 0,
        'max': 3000,
        'gamma': 1.4
    }
    ```
  - Clicking **`Sentinel 1 SAR Data`** computes the derived date window `[start_date, end_date]` from the **Current Date** text box and selected **`aggregation period`**, logs the actual derived dates (`start_date` to `end_date`) in the Bottom Logging Panel, and invokes `POST /api/space-data/sentinel1`, which executes `server/ee_sentinel1.py` using Google Earth Engine (`ee`) on the server side for collection `COPERNICUS/S1_GRD`, creating a false color composite with bands `VV`, `VH`, and `VV/VH`:
    ```python
    ee.Authenticate()
    ee.Initialize(project='geo-stars')

    s1_collection = (
        ee.ImageCollection('COPERNICUS/S1_GRD')
        .filterBounds(poi)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VV'))
        .filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH'))
        .filter(ee.Filter.eq('instrumentMode', 'IW'))
    )

    median_image = s1_collection.median()
    vv = median_image.select('VV')
    vh = median_image.select('VH')
    vv_vh = vv.divide(vh).rename('VV/VH')
    composite_image = median_image.addBands(vv_vh)

    vis_params = {
        'bands': ['VV', 'VH', 'VV/VH'],
        'min': [-25, -30, 0],
        'max': [0, -5, 1],
    }
    ```
  - Displays layer metadata, visibility toggle (`Visible`/`Hidden`), and opacity slider for both `COPERNICUS/S2_SR_HARMONIZED` (`B4, B3, B2` RGB) and `COPERNICUS/S1_GRD` (`VV, VH, VV/VH` false color composite).
  - **CEMS Early Warning River Discharge Prediction Sub-Section**:
    - Located under **Space Data** and invokes [`scripts/download_glofas.py`](scripts/download_glofas.py) via `/api/cems-glofas/forecast`.
    - Downloads CEMS GloFAS (`cems-glofas-forecast`, operational v3.1 LISFLOOD control forecast) river discharge forecasts for the next **24, 48, and 72 hours** (`leadtime_hour: ["24", "48", "72"]`) for the current date on a **100 km radius** around the current center point of the map (`--lat`, `--lon`, `--radius 100000`).
    - Stores all downloaded GRIB2 and converted 3-band GeoTIFF files in the temporary folder **`tmp_downloads/`**.
    - **Automatic Cleanup & Caching**:
      - On application startup (`/api/cems-glofas/cleanup`) and whenever a download is requested, every file in `tmp_downloads/` from previous days (not matching today's date) is automatically deleted.
      - If a GeoTIFF file for today and the requested region already exists in `tmp_downloads/`, it is reused immediately without re-downloading from the CDS API to spare download time.
    - **Three Overlays, `< 10` Transparency Threshold & White-to-Red Color Map (Clipped at 80)**:
      - Produces a 3-band GeoTIFF (Band 1: `24h Forecast`, Band 2: `48h Forecast`, Band 3: `72h Forecast`).
      - **Full Transparency Below `10 m³/s`**: Any pixel value below `10` (`<= 10.0 m³/s`) is rendered as **fully transparent (`alpha = 0`)**. Only pixel values above `10` (`> 10.0 m³/s`) appear on the map (`alpha = 255`) and have their transparency controlled by the corresponding band's transparency/opacity slider (`0%` to `100%`).
      - Clips every pixel value above `80` to `80` (`np.clip(arr, 0.0, 80.0)`) and applies a continuous **Red Scale Color Map from White (`0`) to Red (`80`)**.
      - Adds **three independent image overlays** (`24h`, `48h`, `72h`) on the map along with a color map legend (`< 10 Transparent` | `10` &rarr; `80` Red) and individual visibility/opacity controls.
  4. **Conditional `Brussels Metro` Section (Collapsible — `#brussels-metro-section` / `#toggle-brussels-metro-section`, Shown Only When Any Source or Target Area Is in the Region of Brussels)**:
     - Rendered **if and only if** `hasAnyAreaInBrussels(sourceAreas, targetAreas)` is `true` (e.g., visible in the Brussels preset or when custom areas are drawn in Brussels; hidden in the Paris preset or when all Brussels areas are removed).
     - **`Show Brussels Metro Network` Toggle Button (`#btn-show-brussels-metro-network`)**: Toggles the on-map Brussels Metro network overlay showing all 4 STIB Metro lines in their official distinct colors (`Line 1: #B5378C`, `Line 2: #ED6C23`, `Line 5: #F6A90B`, `Line 6: #0066A3`) and all 60 stations with their station name label right beside each station marker, plus an inline line-color legend (`#brussels-metro-legend`).
     - **Metro Stations in Areas Info Panel (`#brussels-metro-info-panel`)**:
       - **Stations in Source Areas — Pickup Points (`#brussels-metro-source-stations`)**: Lists every metro station located inside any Source Area polygon (e.g., `Gare du Midi` inside `Midi Station`) with a **`PICKUP`** badge, its parent Source Area name, and served line badges.
       - **Stations in Target Areas — Drop-Off Points (`#brussels-metro-target-stations`)**: Lists every metro station located inside any Target Area polygon (e.g., `Schuman` and `Merode` inside `Parc du Cinquantenaire`, `Heysel` inside `Brussels Expo`) with a **`DROP-OFF`** badge, its parent Target Area name, and served line badges.
     - **Underground Metro Evacuation Controls (`#brussels-metro-evacuation-controls`)**:
       - Rendered whenever at least one metro station is inside a Source Area and at least one metro station is inside an active Target Area.
       - Includes the **`Use these stations for evacuation`** checkbox (`#chk-use-metro-for-evacuation`), **`number of trains available`** input (`#input-metro-trains-available`), **`capacity of each train`** input (`#input-metro-train-capacity`), and a summary of the active underground metro corridors (`Pickup: sourceStation → Drop-Off: targetStation`, line label, and track distance in `km`).

### 5.2 Center Area: Interactive OpenStreetMap Viewport (`50% Width × 75% Height`)
- **Base Layer (Zero API Key Required)**: Exclusively uses public, open-source **OpenStreetMap** tile layers that require **no API key**:
  1. **Standard OpenStreetMap** (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) — default base layer showing full street network, building footprints, parks, bridges, rivers, and transit stations.
  2. **Humanitarian OSM (HOT)** (`https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`) — Humanitarian OpenStreetMap Team emergency-response cartography.
  3. **CyclOSM** (`https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`) — high-contrast open-source OpenStreetMap urban/topographic tiles.
- **Visual Overlays**:
  - **Sentinel-2 True Color RGB Satellite Layer**: When loaded via **Space Data -> Sentinel 2 Optical Data**, renders the Google Earth Engine `median_image` tile layer (`vis_params`: `bands: ['B4', 'B3', 'B2']`, `min: 0`, `max: 3000`, `gamma: 1.4`) directly on the center Leaflet map.
  - **Sentinel-1 SAR False-Color Composite Layer**: When loaded via **Space Data -> Sentinel 1 SAR Data**, renders the Google Earth Engine `COPERNICUS/S1_GRD` false-color composite tile layer (`vis_params`: `bands: ['VV', 'VH', 'VV/VH']`, `min: [-25, -30, 0]`, `max: [0, -5, 1]`) directly on the center Leaflet map.
  - **CEMS GloFAS River Discharge Forecast Overlays (24h, 48h, 72h)**: Renders three georeferenced RGBA image overlays (`L.imageOverlay`) for the 24h, 48h, and 72h river discharge forecasts within a 100 km radius around the map center. Pixels with discharge values below `10 m³/s` are rendered as **fully transparent (`alpha = 0`)**, while pixels above `10 m³/s` (clipped at `80 m³/s`) are colored using the **White (`0`) to Red (`80`)** scale color map and governed directly by the corresponding band's transparency slider (`ov.opacity`). Accompanied by a floating on-map colorbar legend.
  - **Brussels Metro Network Layer, Station Pickup & Drop-Off Point Markers & Active Underground Metro Trains**:
    - When **`Show Brussels Metro Network`** is active, renders all STIB Metro lines (`M1` `#B5378C`, `M2` `#ED6C23`, `M5` `#F6A90B`, `M6` `#0066A3`) with white casing and renders all 60 metro stations as circular metro badges with the **station name label displayed right beside each station** (`.brussels-metro-station-label`). Stations falling inside Source or Target Areas are highlighted.
    - When **`Use these stations for evacuation`** is checked, highlights the active underground metro evacuation corridor polylines, renders **`🚇 PICKUP`** station markers at every Source Area metro station (showing live platform waiting queue and drop-off destination), renders **`🚇 DROP-OFF`** station markers at every Target Area metro station (showing live passengers dropped off at that station andactive unloading train status), and animates **`🚇 M`** underground metro train markers (`zIndexOffset: 1080`, STIB line color border/glow) running along the metro tracks between the Source Pickup stations and Target Drop-Off stations.
  - Source Areas: Amber/Orange polygons with live remaining headcount badges.
  - Target Areas: Emerald Green polygons for active shelters; Slate Gray dashed polygons with `🚫 DISABLED` badge for disabled shelters.
  - Avoid Areas: Cross-hatched Crimson Red polygons.
  - **Route Pickup Locations (Blue Squares)**: Marked with a distinct **blue square** (`#2563eb`) displaying live waiting queue counts and active vehicle boarding timers (`MM:SS / 10:00`).
  - **Dynamic Heatmap Overlay**: Hotter around Pickup Locations as queues form; progressively cools down over time as vehicles evacuate people.

### 5.3 Bottom Panel: System & Simulation Console (`25% Height` Default, Independently Collapsible to `36px`)
- **Panel Collapse Toggle (`#btn-toggle-bottom-panel`)**: Located in the right controls group of the Bottom Panel header (`Collapse` / `Expand Logs`), collapsing the console to a `36px` bar (with a live preview of the most recent log entry) so the Center Map expands vertically from `75vh` to `calc(100vh - 36px)`.
- Timestamped log stream displaying routing computations, mid-simulation edits, route recomputations upon restart, loaded vehicle redirections to closest active shelters, arrival confirmations, **Space Data (Sentinel-2 Optical & Sentinel-1 SAR) requests including the actual derived date range (`start_date` to `end_date`) computed from the user's Current Date and `aggregation period` selection**, **CEMS Early Warning River Discharge Prediction cleanup, cache-hit/download status in `tmp_downloads/`, and 24h/48h/72h overlay rendering**, and **Brussels Metro network overlay toggles and underground train evacuation dispatches/arrivals**.

### 5.4 Right Panel: Telemetry & KPI Dashboard (`25% Width × 100% Height`, Independently Collapsible)
- **Panel Collapse Toggle (`#btn-toggle-right-panel`)**: Located in the top-right of the Right Panel header (`Collapse`), collapsing the telemetry panel into a `38px` vertical rail (showing a live `{progressPercent}%` badge) so the Center Map expands horizontally.
- Live evacuation progress KPIs, Blue Square and **Metro Station Pickup & Drop-Off** queue/delivery cards, Target Shelter occupancy meters (with `DISABLED` indicators), and behavioral breakdowns.
- **Exact Population Conservation & Progress Invariant**:
  - Total population across the system satisfies exact conservation: $\text{Total Population} = \text{Safe at Shelter } (\text{totalEvacuated}) + \text{On Vehicles } (\text{totalInTransit}) + \text{In Source Area } (\text{totalRemainingAtSource})$.
  - Source Area cluster headcounts are partitioned via exact integer Euclidean division ($\lfloor N/k \rfloor$ plus remainder distribution) so the sum of cluster headcounts equals `source.population` with zero over-allocation.
  - The **Overall Evacuation Progress** bar is strictly bounded below `100%` (`Math.min(99, Math.floor((totalEvacuated / totalPopulation) * 100))`) whenever any evacuees remain in Source Areas (`totalRemainingAtSource > 0`) or on vehicles (`totalInTransit > 0`), reaching `100%` **if and only if** `totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0`.

---

## 6. Recommended Technical Stack

- **Frontend Framework**: React 18+ with TypeScript and Vite.
- **UI Styling & Layout**: Vanilla CSS with custom tactical HSL design tokens + Lucide Icons.
- **Map & Geospatial Engine**: Leaflet (`leaflet`) + Turf.js (`@turf/turf`) using public, zero-API-key OpenStreetMap tile servers (`tile.openstreetmap.org`).
- **Routing Services**: OSRM HTTP API (`router.project-osrm.org`) paired with client-side Turf.js obstacle-avoidance waypoint routing, plus static GeoParquet STIB Metro rail corridor extraction ([`src/services/brusselsMetroService.ts`](src/services/brusselsMetroService.ts) & [`server/brussels_metro.py`](server/brussels_metro.py)).

---

## 7. Preset Scenarios

### 7.1 Brussels Scenario
- **Map Center**: `[50.8503, 4.3517]` (Zoom: `13`)
- **Source Areas**:
  1. **Grand Place**: `1,000` people | Behavior: `70% Obedient, 20% Autonomous, 10% Random`
  2. **Midi Station (Gare du Midi)**: `2,000` people | Behavior: `60% Obedient, 30% Autonomous, 10% Random` (Contains STIB Metro Station `Gare du Midi` on Lines `2, 6`)
- **Target Areas**:
  1. **Parc du Cinquantenaire**: Capacity `50,000` people (Contains STIB Metro Stations `Schuman` and `Merode` on Lines `1, 5`)
  2. **Brussels Expo (Heysel)**: Capacity `20,000` people (Contains STIB Metro Station `Heysel` on Line `6`)
- **Avoid Areas**:
  1. **Inner Ring / Wetstraat-Loi Bottleneck Zone**
- **Vehicle Fleets**:
  1. **STIB Bus Fleet**: `100` buses × `50` capacity | Transit Speed: `25` km/h | Load/Unload: `2` s/person | Staging Depot: Place Flagey `[50.8276, 4.3725]`
  2. **Municipal Car Pool**: `100` private cars × `4` capacity | Transit Speed: `25` km/h | Load/Unload: `3` s/person | Staging Depot: Place Sainctelette `[50.8596, 4.3447]`

### 7.2 Paris Scenario
- **Map Center**: `[48.8647, 2.3333]` (Zoom: `13`)
- **Source Areas**:
  1. **Eiffel Tower (Champ de Mars)**: `1,500` people | Behavior: `65% Obedient, 25% Autonomous, 10% Random`
  2. **Arc de Triomphe (Place Charles de Gaulle)**: `500` people | Behavior: `75% Obedient, 15% Autonomous, 10% Random`
- **Target Areas**:
  1. **Parc de la Villette**: Capacity `50,000` people
  2. **Parc de Bagatelle**: Capacity `20,000` people
- **Avoid Areas**:
  1. **Pont d'Iéna**
  2. **Pont de l'Alma**
- **Vehicle Fleets**:
  1. **RATP Bus Fleet**: `50` buses × `50` capacity | Transit Speed: `25` km/h | Load/Unload: `2` s/person | Staging Depot: Esplanade des Invalides `[48.8606, 2.3125]`

---

## 8. Living Specification & Iteration Log

| Iteration | Date | Summary of Specification & Implementation Changes |
| :--- | :--- | :--- |
| **v1.0** | 2026-09-17 | Initial restructured specification & full React/TypeScript/Leaflet implementation of the 4-panel cockpit UI, Brussels & Paris presets, OSRM + Turf.js obstacle-avoiding routing engine, and 60 FPS thermal heatmap simulation. |
| **v1.1** | 2026-09-17 | Added requirement and implementation for **Route Pickup Locations**: once route computation completes, specific pickup/assembly points are established inside each Source Area for every route and marked with **blue squares** on the map (with interactive tooltips and legend entry). |
| **v1.2** | 2026-09-17 | Refined **Population Behavior & Vehicle Boarding Mechanics**: Evacuees remain inside their Source Area until picked up by a vehicle (`obedient` to closest pickup, `random` within 50m, `autonomous` along perimeter limits); heatmap glows hotter around pickup locations and cools down as vehicles evacuate people. |
| **v1.3** | 2026-09-17 | Updated **Vehicle Departure Condition**: Vehicles waiting at a Pickup Location depart when **either** they reach **80% occupancy** **OR** they have been waiting **10 minutes** (`600` simulation seconds), **whichever happens first, provided there is at least 1 passenger onboard**. |
| **v1.4** | 2026-09-19 | Added **Mid-Simulation Pause, Entity Modification Rules & Smart Restart Re-Routing**: (1) All area/vehicle edits require simulation to be paused; (2) Source Areas cannot be deleted if people still remain inside them; (3) Target Areas cannot be deleted, only **disabled** (`disabled: true`) so they receive no more people; (4) Avoid areas and vehicles can be added/removed while paused; (5) Restarting after modifications recomputes routes for all remaining and new people into enabled Target Areas, and routes any **running vehicles with passengers onboard directly to the closest enabled Target Area** before they follow the newly recomputed routes. |
| **v1.5** | 2026-09-19 | Fixed two simulation dynamics: (1) **Empty Vehicle Return/Approach Routing**: Whenever vehicles depart empty to pick up population, they **always follow one of the existing computed routes** (reversing the existing route polyline from Target Area back to Pickup Location) rather than straight lines; (2) **2D Brownian Motion for `random` Population**: Replaced straight/smooth-drift movement for `random` population clusters with true stochastic **2D Brownian motion** (independent Gaussian random walk steps $d\mathbf{X}_t = \sigma \, d\mathbf{W}_t$ at every simulation tick) until coming within `50m` of a Pickup Location. |
| **v1.6** | 2026-09-19 | Updated **Center Map Panel Base Layers**: Configured map viewport to exclusively use public, open-source **OpenStreetMap** tile layers that require **no API key** (`https://tile.openstreetmap.org/{z}/{x}/{y}.png` Standard OpenStreetMap by default, plus Humanitarian OSM and CyclOSM open-source options). |
| **v1.7** | 2026-09-19 | Overhauled **Avoid Area Route Avoidance Algorithm**: Replaced radial vertex pushing with a **2D Obstacle Visibility Graph + Dijkstra Shortest-Path Solver** (`computeShortestCollisionFreePath` & `enforceStrictAvoidAreaAvoidance`) over multi-tier buffered exterior vertices around all Avoid Area polygons. Every segment of every evacuation, approach, and mid-simulation redirection route is strictly verified via `turf.booleanIntersects(segment, avoidPolygon) === false` so routes **never cross Avoid Areas**. |
| **v1.8** | 2026-09-19 | Fixed **Initial Vehicle Fleet Departure Origin**: Updated `initializeSimulationState` and `reconcileSimulationOnRestart` (`getDepotToPickupApproachCoords`) so that at simulation start ($t = 0$) and when newly added fleets are deployed, vehicles depart from their designated **Vehicle Fleet staging depot location (`fleet.location`)** along `route.approachCoordinates` to the Pickup Location, rather than starting from the Target Area. Subsequent post-offload empty return trips continue to reverse the existing evacuation route from Target Area back to Pickup Location. |
| **v1.9** | 2026-09-19 | Fixed **Overall Evacuation Progress Bar & Exact Population Conservation**: (1) Replaced `Math.round(totalPop / numClusters)` over-allocation in `buildClustersForSources` with exact integer Euclidean division so cluster headcounts sum identically to `source.population`; (2) Updated `RightTelemetryPanel` to compute total population from exact conservation (`totalEvacuated + totalInTransit + totalRemainingAtSource`) and strictly cap progress at $\le 99\%$ while any evacuees remain in Source Areas or on vehicles, reaching `100%` if and only if `totalRemainingAtSource === 0 && totalInTransit === 0`. |
| **v1.10** | 2026-09-20 | Added **Space Data Section & Server-Side Google Earth Engine Sentinel-2 Optical Data Integration**: (1) Added a **Space Data** section on the Left Panel with a **`Sentinel 2 Optical Data`** button; (2) Implemented server-side Python script [`server/ee_sentinel2.py`](server/ee_sentinel2.py) and Vite server API endpoint (`/api/space-data/sentinel2` in [`vite.config.ts`](vite.config.ts)) executing the exact Google Earth Engine `COPERNICUS/S2_SR_HARMONIZED` median composite query (`2024-06-01` to `2024-08-31`, `<10%` clouds) with True Color RGB `vis_params` (`bands: ['B4', 'B3', 'B2']`, `min: 0`, `max: 3000`, `gamma: 1.4`); (3) Rendered the returned Earth Engine `median_image` tile layer directly on the center map panel with interactive visibility and opacity controls. |
| **v1.11** | 2026-09-20 | Updated **Server-Side Earth Engine Authentication & Project Initialization**: Configured [`server/ee_sentinel2.py`](server/ee_sentinel2.py) to authenticate and initialize explicitly with `ee.Authenticate()` followed by `ee.Initialize(project='geo-stars')` using pre-existing server-side authorization. |
| **v1.12** | 2026-09-20 | Updated **Space Data Panel Layout, Date Controls & Dynamic Sentinel-2 Date Aggregation**: (1) Moved the **Space Data** section to the bottom of the Left Panel below all other sections; (3) Added a **Current Date** text box at the top of the Space Data section; (3) Made the **`Sentinel 2 Optical Data`** button more compact and added an **`aggregation period`** dropdown selector (`'last week'`, `'last 2 weeks'`, `'last month'` default, `'last three months'`, `'last six months'`, `'last year'`); (4) Updated [`server/ee_sentinel2.py`](server/ee_sentinel2.py) and `/api/space-data/sentinel2` to filter `COPERNICUS/S2_SR_HARMONIZED` dynamically using the derived `[start_date, end_date]` window; (5) Added log messages in the Bottom Logging Panel displaying the actual derived dates used from the user's selection. |
| **v1.13** | 2026-09-20 | Added **Sentinel-1 SAR Data (`COPERNICUS/S1_GRD`) False Color Composite (`VV`, `VH`, `VV/VH`)**: (1) Added a **`Sentinel 1 SAR Data`** button directly below **`Sentinel 2 Optical Data`** in the Left Panel **Space Data** section; (2) Created server-side Google Earth Engine script [`server/ee_sentinel1.py`](server/ee_sentinel1.py) (`ee.Authenticate()`, `ee.Initialize(project='geo-stars')`) and `/api/space-data/sentinel1` endpoint to filter `COPERNICUS/S1_GRD` by the derived `[start_date, end_date]` window, reduce to median, compute the `VV/VH` ratio band, and generate a false-color composite with bands `['VV', 'VH', 'VV/VH']`; (3) Added map tile overlay rendering, visibility/opacity controls, and derived date range logging in the Bottom Logging Panel. |
| **v1.14** | 2026-09-20 | Added **CEMS Early Warning River Discharge Prediction (`scripts/download_glofas.py`)**: (1) Added **`CEMS Early Warning River Discharge Prediction`** section under **Space Data**; (2) Updated [`scripts/download_glofas.py`](scripts/download_glofas.py) to accept configurable region coordinates (`--lat`, `--lon`, `--radius 100000` for a 100 km radius around current map center) and store all files in **`tmp_downloads/`**; (3) Implemented automatic deletion of all files from previous days in `tmp_downloads/` on application startup and on every download, while reusing today's existing GeoTIFF when present to spare download time; (4) Rendered three map overlays (`24h`, `48h`, `72h` forecast bands) with pixel values above `80` clipped to `80`, a **White (`0`) to Red (`80`)** scale color map, and an interactive color map legend. |
| **v1.15** | 2026-09-20 | Made **"Execution & Simulation"** and **"Space Data"** panels collapsible in [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) via interactive toggle headers (`#toggle-execution-section` and `#toggle-space-data-section`) with chevron state indicators. |
| **v1.16** | 2026-09-20 | Updated [`README.md`](README.md) with detailed end-to-end setup and operational instructions covering Conda geospatial environment creation, Google Earth Engine GCP project setup (`geo-stars`), `earthengine` CLI authentication (local and headless SSH modes), Copernicus CEMS / EWDS account registration, dataset license acceptance, `~/.cdsapirc` API token configuration, `tmp_downloads/` caching/cleanup lifecycle, and standalone script verification. |
| **v1.17** | 2026-09-21 | Made the **Left Control Panel** (`#btn-toggle-left-panel`), **Bottom System & Simulation Log Panel** (`#btn-toggle-bottom-panel`), and **Right Situational Telemetry Panel** (`#btn-toggle-right-panel`) **independently collapsible** across [`App.tsx`](src/App.tsx), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`BottomLogPanel.tsx`](src/components/BottomLogPanel.tsx), [`RightTelemetryPanel.tsx`](src/components/RightTelemetryPanel.tsx), and [`index.css`](src/index.css), dynamically expanding the Center Map Viewport (`flex: 1`) horizontally and vertically and attaching a `ResizeObserver` in [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx) to automatically resize Leaflet tiles and the HTML5 heatmap canvas. |
| **v1.18** | 2026-09-21 | Gathered the entity tabs (`Sources`, `Targets`, `Avoid Areas`, `Vehicles`) and entity list into a collapsible **"Parameters"** section (`#toggle-parameters-section`) in [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) and [`index.css`](src/index.css) (`.left-panel-sections-stack`), so the Left Panel now features three **top-justified** collapsible sections: **"Execution & Simulation"**, **"Parameters"**, and **"Space Data"**. |
| **v1.19** | 2026-09-21 | Updated **CEMS GloFAS River Discharge Prediction Map Rendering** across [`scripts/download_glofas.py`](scripts/download_glofas.py), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), and [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) so that any pixel value below `10` (`<= 10.0 m³/s`) appears as **fully transparent (`alpha = 0`)**, while only pixel values above `10` (`> 10.0 m³/s`, clipped at `80`) appear on the map (`alpha = 255`) and are subject to the corresponding band's transparency/opacity slider (`0%` to `100%`). |
| **v1.20** | 2026-09-21 | Replaced the `"EVAC-OPS Evacuation Command"` text title at the top of the Left Control Panel ([`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx)) with the application logo image [`imgs/evac-logo.png`](imgs/evac-logo.png). |
| **v1.21** | 2026-09-21 | Updated Left Control Panel ([`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx)): (1) Configured all three collapsible sections (**"Parameters"**, **"Execution & Simulation"**, **"Space Data"**) to start **collapsed by default** on application startup; (2) Moved the **"Parameters"** section above the **"Execution & Simulation"** section; (3) Added a **`Planet Scope`** button (`#btn-planet-scope-data`) directly below the **`Sentinel 1 SAR Data`** button in the **"Space Data"** section that opens a popup dialog (`#planet-scope-modal`) displaying `"Not yet available"` with a **`Dismiss`** button (`#btn-dismiss-planet-scope-modal`). |
| **v1.22** | 2026-09-21 | Added **`Simulation report`** button (`#btn-simulation-report`) in the Left Control Panel's **Execution & Simulation** section ([`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx)), enabled only when the simulation is paused (`!isSimulating`). Clicking it opens a centered browser-window popup modal ([`SimulationReportModal.tsx`](src/components/SimulationReportModal.tsx)) backed by per-behavior and per-pickup telemetry in [`simulationEngine.ts`](src/services/simulationEngine.ts) and [`evacuation.ts`](src/types/evacuation.ts), reporting: (1) number of people evacuated to shelter; (2) number of people still not evacuated with full detail per population behaviour (`obedient`, `autonomous`, `random`) and stage (in source zone, at pickup, in transit); (3) mean evacuation time per person overall and per population behaviour (`obedient`, `autonomous`, `random`); (4) number of people evacuated at each pickup location; (5) mean vehicle wait time at each pickup location; and (6) additional operational telemetry (shelter occupancy/headroom, throughput `pax/min`, clearance ETA, vehicle load factors, and JSON report export). |
| **v1.23** | 2026-09-29 | Added **Per-Person Vehicle Loading & Unloading Time (`loadUnloadTimePerPersonSeconds`)** across [`evacuation.ts`](src/types/evacuation.ts), [`presets.ts`](src/data/presets.ts), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`simulationEngine.ts`](src/services/simulationEngine.ts), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), [`SimulationReportModal.tsx`](src/components/SimulationReportModal.tsx), and [`App.tsx`](src/App.tsx): (1) Added `loadUnloadTimePerPersonSeconds` (average time in seconds to load or unload 1 person) to `VehicleFleet` and `ActiveVehicleUnit`, configurable in the vehicle creation and inline edit forms in [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) and displayed on vehicle fleet cards and map markers; (2) Updated `stepSimulationState` in [`simulationEngine.ts`](src/services/simulationEngine.ts) so that vehicles at Pickup Locations (`waiting_for_80_pct`) board waiting passengers progressively over time according to `loadUnloadTimePerPersonSeconds`, and vehicles arriving at Target Shelters transition into `status: 'unloading'` to progressively disembark passengers into shelter occupancy over `loadUnloadTimePerPersonSeconds` per person per vehicle before departing empty back along the route. |
| **v1.24** | 2026-09-29 | Added **Vehicle Transit Speed (`transitSpeedKmh`, default `25 km/h`) & Realistic Geodesic Map-Distance Kinematics** across [`evacuation.ts`](src/types/evacuation.ts), [`presets.ts`](src/data/presets.ts), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`routingEngine.ts`](src/services/routingEngine.ts), [`simulationEngine.ts`](src/services/simulationEngine.ts), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), [`SimulationReportModal.tsx`](src/components/SimulationReportModal.tsx), and [`App.tsx`](src/App.tsx): (1) Added `transitSpeedKmh` (default `25` km/h) to `VehicleFleet` and `ActiveVehicleUnit`, configurable in the vehicle creation and inline edit forms in [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) and displayed on vehicle cards, depot pins, and active vehicle map tooltips; (2) Updated [`routingEngine.ts`](src/services/routingEngine.ts) to compute `estimatedDurationSeconds` from the exact geodesic path distance in meters divided by `kmhToMps(transitSpeedKmh)`; (3) Updated [`simulationEngine.ts`](src/services/simulationEngine.ts) and [`App.tsx`](src/App.tsx) so the simulation clock runs at a true 1:1 ratio with wall-clock time at `1x` speed (`deltaSimSec = wallDeltaSec * simSpeed`) and each vehicle advances along the exact Haversine cumulative distance table (`approachCumulative` and `evacCumulative`) of the OpenStreetMap route polylines at $v_{\text{m/s}} = \text{transitSpeedKmh} \times \frac{1000}{3600}$ with sub-tick departure and arrival interpolation. |
| **v1.25** | 2026-09-29 | Added **`Remove` Button & Confirmation Popup Window for Every Area (`Source`, `Target`, `Avoid`)** across [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx) and [`App.tsx`](src/App.tsx) while preserving the existing **`Disable` / `Enable`** toggle on Target Areas: (1) Added a **`Remove`** button (`#btn-remove-source-{id}`, `#btn-remove-target-{id}`, `#btn-remove-avoid-{id}`) on every Source, Target, and Avoid area card in the **Parameters** section; (2) Clicking **`Remove`** opens a centered confirmation popup modal (`#confirm-remove-area-modal` rendered via `createPortal`) asking the user to confirm deletion (`#btn-confirm-remove-area`) or cancel (`#btn-cancel-remove-area`); (3) Confirming removal deletes the area from the simulation parameters (`sourceAreas`, `targetAreas`, or `avoidAreas`), removes its polygons/markers/routes from the map, and purges all associated runtime state (`computedRoutes`, `clusters`, `pickupStates`, `vehicles`, `heatmapPoints`, `selectedEntityId`, and KPI counters). |
| **v1.26** | 2026-09-29 | Renamed **"No-Go Areas"** to **"Avoid Areas"** across the entire codebase, UI, CSS, preset data, and documentation ([`evacuation.ts`](src/types/evacuation.ts), [`presets.ts`](src/data/presets.ts), [`routingEngine.ts`](src/services/routingEngine.ts), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), [`SimulationReportModal.tsx`](src/components/SimulationReportModal.tsx), [`App.tsx`](src/App.tsx), [`index.css`](src/index.css), [`README.md`](README.md), and [`spec.md`](spec.md)): renamed `NoGoArea` to `AvoidArea`, `noGoAreas` to `avoidAreas`, `avoidedNoGoNames` to `avoidedAreaNames`, `'nogo'` draw mode to `'avoid'`, CSS classes/variables (`--accent-avoid`, `.avoid-add`, `.avoid-dot`, `.avoid-swatch`, `.map-zone-avoid`), and all UI labels/logs (`Avoid Areas`, `Avoid Area`, `⛔ AVOID AREA`). |
| **v1.27** | 2026-09-29 | Added **`50x` and `100x` Playback Speeds** and **Disabled `Compute Evacuation Routes` While Simulation is Running/In Progress Until Completion or Reset** across [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`App.tsx`](src/App.tsx), and [`index.css`](src/index.css): (1) Added `50x` and `100x` playback speed buttons (`[1, 2, 5, 10, 25, 50, 100]`) in [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx); (2) Tracked `isSimulationInProgress` in [`App.tsx`](src/App.tsx) (`true` once the simulation starts running and reset to `false` only when the simulation finishes or when `Reset simulation` / preset switch is triggered) and disabled `#btn-compute-routes` (`Compute evacuation routes`) whenever `isSimulating || isSimulationInProgress`. |
| **v1.28** | 2026-09-29 | Added **Conditional `Brussels Metro` Section, Network Overlay & Underground Train Evacuation** across [`server/brussels_metro.py`](server/brussels_metro.py), [`vite.config.ts`](vite.config.ts), [`brusselsMetroData.ts`](src/data/brusselsMetroData.ts), [`brusselsMetroService.ts`](src/services/brusselsMetroService.ts), [`evacuation.ts`](src/types/evacuation.ts), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), [`simulationEngine.ts`](src/services/simulationEngine.ts), and [`App.tsx`](src/App.tsx): (1) Reads `data/brussels_metro_lines.parquet` and `data/brussels_metro_stations.parquet`; (2) Renders the **`Brussels Metro`** section (`#brussels-metro-section`) on the Left Panel if and only if at least one Source or Target Area falls within the Region of Brussels (`hasAnyAreaInBrussels`); (3) Added **`Show Brussels Metro Network`** button (`#btn-show-brussels-metro-network`) toggling a map overlay layer with each metro line in its distinct colour (`M1: #B5378C`, `M2: #ED6C23`, `M5: #F6A90B`, `M6: #0066A3`) and all 60 stations with their station name label right beside them on the map; (4) Added an information panel (`#brussels-metro-info-panel`) listing metro stations inside Source Areas (`#brussels-metro-source-stations`) and Target Areas (`#brussels-metro-target-stations`); (5) When stations exist in both Source and Target Areas, displays the **`Use these stations for evacuation`** checkbox (`#chk-use-metro-for-evacuation`) and a form for **`number of trains available`** (`#input-metro-trains-available`) and **`capacity of each train`** (`#input-metro-train-capacity`); (6) When checked, the simulation dispatches underground metro trains along the static metro line trajectories in addition to street routes/vehicles (unaffected by `Compute evacuation routes` and immune to `Avoid Areas`), accelerating evacuation. |
| **v1.29** | 2026-09-29 | Fixed **Brussels Metro Station Pickup & Drop-Off Establishment and Visible Metro Train Evacuation along Metro Lines** across [`evacuation.ts`](src/types/evacuation.ts), [`brusselsMetroService.ts`](src/services/brusselsMetroService.ts), [`simulationEngine.ts`](src/services/simulationEngine.ts), [`EvacuationMap.tsx`](src/components/EvacuationMap.tsx), [`LeftControlPanel.tsx`](src/components/LeftControlPanel.tsx), [`RightTelemetryPanel.tsx`](src/components/RightTelemetryPanel.tsx), and [`App.tsx`](src/App.tsx): (1) Established every Metro Station inside a Source Area as a **Metro Pickup Point** (`location`, `🚇 PICKUP` map marker & Left Panel badge) and every Metro Station inside an active Target Area as a **Metro Drop-Off Point** (`dropOffLocation`, `metroTargetStationName`, `🚇 DROP-OFF` map marker & Left Panel badge); (2) Fixed `App.tsx` so Metro Pickups and Metro Trains initialize and run even when no street routes have been computed (`computedRoutes.length === 0`) or when `vehicleFleets` is empty (removing phantom default street buses); (3) Directed all population clusters (`obedient`, `random`, and `autonomous`) in Source Areas served by active Metro corridors to converge directly to their interior **Metro Station Pickup Point(s)** rather than perimeter street pickups; (4) Spawned individual Metro Train units (`1..trainCount`, `maxCapacity: trainCapacity`) directly at Source Area Metro Station Pickup Points with short staggered headways (`tIdx * 18s`) and a platform dispatch cadence (`reachedMetroCadence` once the platform queue is emptied after `>= 25s` or upon reaching 80% occupancy), so Metro Trains visibly board evacuees on the platform, run along the STIB Metro line polylines (`zIndexOffset: 1080` with STIB line color border/glow) to the Target Area Metro Station Drop-Off Points, unload there (`status: 'unloading'`), and return along the metro line for subsequent trips. |

