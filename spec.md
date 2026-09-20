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
     - Evacuees moving *within* each Source Area toward established Pickup Locations according to their behavioral profile (`obedient`, `autonomous`, `random` via 2D Brownian motion), causing the heatmap to become hotter around Pickup Locations as queues form.
     - Vehicles arriving at Pickup Locations, boarding waiting evacuees, and departing for Target Shelters when **either 80% occupancy is reached OR 10 minutes of waiting time have elapsed** (whichever happens first, provided there is **at least 1 passenger** onboard).
     - Whenever vehicles depart empty to pick up population, they **always follow one of the existing computed routes** (reversing the existing route polyline from Target Shelter to Pickup Location).
     - Progressive cooling of the Source Area heatmap over time as vehicles evacuate the population.
  5. **Pause & Dynamic Mid-Simulation Editing**:
     - Operators may pause (`Pause simulation`) at any point to modify areas and vehicles (including changing population counts in Source Areas, disabling Target Areas, adding/removing No-Go zones, or adding/removing vehicles) under strict operational safety constraints.
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
  - **Random (`%`)**: Diffuse inside the Source Area polygon following a true **2D Brownian motion (Wiener process)** with independent Gaussian displacements $(\Delta x, \Delta y) \sim \mathcal{N}(0, \sigma^2 \Delta t)$ at every simulation tick (reflecting off polygon boundaries) until they come within **50 meters** of any Pickup Location, at which point they direct themselves straight to it.
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
- **Strict Non-Intersection Guarantee (Zero Crossings)**:
  - **Evacuation routes, vehicle approach routes, and mid-simulation vehicle redirection routes must never cross or touch any No-Go polygon** (`turf.booleanIntersects(routeSegment, noGoPolygon) === false` across every polyline segment).
  - The routing engine enforces this invariant using a **2D Obstacle Visibility Graph + Dijkstra Shortest-Path Solver** over multi-tier buffered exterior vertices around all No-Go polygons:
    1. Collision-free detour waypoints are computed around all No-Go polygons and passed to OSRM for road-network routing.
    2. Whenever any segment or sub-path returned by OSRM enters or crosses a No-Go polygon, surgical segment-level repair replaces that sub-path with the shortest collision-free exterior visibility-graph detour around the obstacle.

### 3.4 Evacuation Vehicle Fleets, Empty Return Routing & Dual Departure Condition
Available public or private transport units managed by authorities, modeled as **Fleets / Staging Depots**:
- **Name**: String identifier (e.g., `"STIB Bus Fleet Alpha"`).
- **Vehicle Type**: Category (`Bus`, `Private Car`, `Shuttle`, etc.).
- **Initial Location**: Point (`GeoJSON Point` — `[lat, lng]`) representing the depot or staging area at `t = 0`.
- **Unit Count**: Number of vehicles in this fleet (`Integer`).
- **Capacity per Unit**: Passenger occupancy per vehicle (e.g., `50` for buses, `4` for cars).
- **CRUD Rules**: Vehicles can be freely added, modified, or removed while the simulation is paused.
- **Initial Depot Dispatch vs. Subsequent Empty Return Routing**:
  - **Initial Dispatch from Designated Fleet Depots ($t = 0$ and Newly Added Fleets)**: When the simulation starts (or when a newly added Vehicle Fleet is deployed), vehicles originate at their designated **Vehicle Fleet staging location (`fleet.location`)** and travel along the computed obstacle-avoiding approach route (`route.approachCoordinates`) to their assigned Pickup Location (`route.pickupLocation`).
  - **Subsequent Empty Return Trips (Post-Offload)**: After offloading passengers at a Target Area shelter, empty vehicles return to pick up additional population by reversing the existing computed evacuation route polyline (`Target Area -> Pickup Location`).
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
   - Once that vehicle reaches the closest Target Area and offloads its passengers, it seamlessly transitions to follow the **newly recomputed evacuation routes** (traveling empty along the existing route polyline back to its assigned Pickup Location).

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
  - `Pause Simulation` (Pauses simulation and unlocks entity editing)
  - `Reset Simulation` (Resets time to `t = 0` and restores initial source area population)
  - Simulation Speed Selector (`1x`, `2x`, `5x`, `10x`)
- **Space Data Section (Positioned Below All Other Left Panel Sections)**:
  - Placed at the very bottom of the Left Control Panel, below all other sections (Scenario Preset Selector, Simulation Execution Toolbar, and Entity Management Accordion / Tabs).
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
    - **Three Overlays & White-to-Red Color Map (Clipped at 80)**:
      - Produces a 3-band GeoTIFF (Band 1: `24h Forecast`, Band 2: `48h Forecast`, Band 3: `72h Forecast`).
      - Clips every pixel value above `80` to `80` (`np.clip(arr, 0.0, 80.0)`) and applies a continuous **Red Scale Color Map from White (`0`) to Red (`80`)**.
      - Adds **three independent image overlays** (`24h`, `48h`, `72h`) on the map along with a color map legend (`0` White &rarr; `80` Red) and individual visibility/opacity controls.

### 5.2 Center Area: Interactive OpenStreetMap Viewport (`50% Width × 75% Height`)
- **Base Layer (Zero API Key Required)**: Exclusively uses public, open-source **OpenStreetMap** tile layers that require **no API key**:
  1. **Standard OpenStreetMap** (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`) — default base layer showing full street network, building footprints, parks, bridges, rivers, and transit stations.
  2. **Humanitarian OSM (HOT)** (`https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png`) — Humanitarian OpenStreetMap Team emergency-response cartography.
  3. **CyclOSM** (`https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png`) — high-contrast open-source OpenStreetMap urban/topographic tiles.
- **Visual Overlays**:
  - **Sentinel-2 True Color RGB Satellite Layer**: When loaded via **Space Data -> Sentinel 2 Optical Data**, renders the Google Earth Engine `median_image` tile layer (`vis_params`: `bands: ['B4', 'B3', 'B2']`, `min: 0`, `max: 3000`, `gamma: 1.4`) directly on the center Leaflet map.
  - **Sentinel-1 SAR False-Color Composite Layer**: When loaded via **Space Data -> Sentinel 1 SAR Data**, renders the Google Earth Engine `COPERNICUS/S1_GRD` false-color composite tile layer (`vis_params`: `bands: ['VV', 'VH', 'VV/VH']`, `min: [-25, -30, 0]`, `max: [0, -5, 1]`) directly on the center Leaflet map.
  - **CEMS GloFAS River Discharge Forecast Overlays (24h, 48h, 72h)**: Renders three georeferenced RGBA image overlays (`L.imageOverlay`) for the 24h, 48h, and 72h river discharge forecasts within a 100 km radius around the map center, with pixel values above `80` clipped to `80`, colored using a **White (`0`) to Red (`80`)** scale color map, and accompanied by a floating on-map colorbar legend.
  - Source Areas: Amber/Orange polygons with live remaining headcount badges.
  - Target Areas: Emerald Green polygons for active shelters; Slate Gray dashed polygons with `🚫 DISABLED` badge for disabled shelters.
  - No-Go Areas: Cross-hatched Crimson Red polygons.
  - **Route Pickup Locations (Blue Squares)**: Marked with a distinct **blue square** (`#2563eb`) displaying live waiting queue counts and active vehicle boarding timers (`MM:SS / 10:00`).
  - **Dynamic Heatmap Overlay**: Hotter around Pickup Locations as queues form; progressively cools down over time as vehicles evacuate people from Source Areas.

### 5.3 Bottom Panel: System & Simulation Console (`50% Width × 25% Height`)
- Timestamped log stream displaying routing computations, mid-simulation edits, route recomputations upon restart, loaded vehicle redirections to closest active shelters, arrival confirmations, **Space Data (Sentinel-2 Optical & Sentinel-1 SAR) requests including the actual derived date range (`start_date` to `end_date`) computed from the user's Current Date and `aggregation period` selection**, and **CEMS Early Warning River Discharge Prediction cleanup, cache-hit/download status in `tmp_downloads/`, and 24h/48h/72h overlay rendering**.

### 5.4 Right Panel: Telemetry & KPI Dashboard (`25% Width × 100% Height`)
- Live evacuation progress KPIs, Blue Square pickup queues, Target Shelter occupancy meters (with `DISABLED` indicators), and behavioral breakdowns.
- **Exact Population Conservation & Progress Invariant**:
  - Total population across the system satisfies exact conservation: $\text{Total Population} = \text{Safe at Shelter } (\text{totalEvacuated}) + \text{On Vehicles } (\text{totalInTransit}) + \text{In Source Area } (\text{totalRemainingAtSource})$.
  - Source Area cluster headcounts are partitioned via exact integer Euclidean division ($\lfloor N/k \rfloor$ plus remainder distribution) so the sum of cluster headcounts equals `source.population` with zero over-allocation.
  - The **Overall Evacuation Progress** bar is strictly bounded below `100%` (`Math.min(99, Math.floor((totalEvacuated / totalPopulation) * 100))`) whenever any evacuees remain in Source Areas (`totalRemainingAtSource > 0`) or on vehicles (`totalInTransit > 0`), reaching `100%` **if and only if** `totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0`.

---

## 6. Recommended Technical Stack

- **Frontend Framework**: React 18+ with TypeScript and Vite.
- **UI Styling & Layout**: Vanilla CSS with custom tactical HSL design tokens + Lucide Icons.
- **Map & Geospatial Engine**: Leaflet (`leaflet`) + Turf.js (`@turf/turf`) using public, zero-API-key OpenStreetMap tile servers (`tile.openstreetmap.org`).
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
| **v1.5** | 2026-09-19 | Fixed two simulation dynamics: (1) **Empty Vehicle Return/Approach Routing**: Whenever vehicles depart empty to pick up population, they **always follow one of the existing computed routes** (reversing the existing route polyline from Target Area back to Pickup Location) rather than straight lines; (2) **2D Brownian Motion for `random` Population**: Replaced straight/smooth-drift movement for `random` population clusters with true stochastic **2D Brownian motion** (independent Gaussian random walk steps $d\mathbf{X}_t = \sigma \, d\mathbf{W}_t$ at every simulation tick) until coming within `50m` of a Pickup Location. |
| **v1.6** | 2026-09-19 | Updated **Center Map Panel Base Layers**: Configured map viewport to exclusively use public, open-source **OpenStreetMap** tile layers that require **no API key** (`https://tile.openstreetmap.org/{z}/{x}/{y}.png` Standard OpenStreetMap by default, plus Humanitarian OSM and CyclOSM open-source options). |
| **v1.7** | 2026-09-19 | Overhauled **No-Go Zone Route Avoidance Algorithm**: Replaced radial vertex pushing with a **2D Obstacle Visibility Graph + Dijkstra Shortest-Path Solver** (`computeShortestCollisionFreePath` & `enforceStrictNoGoAvoidance`) over multi-tier buffered exterior vertices around all No-Go polygons. Every segment of every evacuation, approach, and mid-simulation redirection route is strictly verified via `turf.booleanIntersects(segment, noGoPolygon) === false` so routes **never cross No-Go zones**. |
| **v1.8** | 2026-09-19 | Fixed **Initial Vehicle Fleet Departure Origin**: Updated `initializeSimulationState` and `reconcileSimulationOnRestart` (`getDepotToPickupApproachCoords`) so that at simulation start ($t = 0$) and when newly added fleets are deployed, vehicles depart from their designated **Vehicle Fleet staging depot location (`fleet.location`)** along `route.approachCoordinates` to the Pickup Location, rather than starting from the Target Area. Subsequent post-offload empty return trips continue to reverse the existing evacuation route from Target Area back to Pickup Location. |
| **v1.9** | 2026-09-19 | Fixed **Overall Evacuation Progress Bar & Exact Population Conservation**: (1) Replaced `Math.round(totalPop / numClusters)` over-allocation in `buildClustersForSources` with exact integer Euclidean division so cluster headcounts sum identically to `source.population`; (2) Updated `RightTelemetryPanel` to compute total population from exact conservation (`totalEvacuated + totalInTransit + totalRemainingAtSource`) and strictly cap progress at $\le 99\%$ while any evacuees remain in Source Areas or on vehicles, reaching `100%` if and only if `totalRemainingAtSource === 0 && totalInTransit === 0`. |
| **v1.10** | 2026-09-20 | Added **Space Data Section & Server-Side Google Earth Engine Sentinel-2 Optical Data Integration**: (1) Added a **Space Data** section on the Left Panel with a **`Sentinel 2 Optical Data`** button; (2) Implemented server-side Python script [`server/ee_sentinel2.py`](server/ee_sentinel2.py) and Vite server API endpoint (`/api/space-data/sentinel2` in [`vite.config.ts`](vite.config.ts)) executing the exact Google Earth Engine `COPERNICUS/S2_SR_HARMONIZED` median composite query (`2024-06-01` to `2024-08-31`, `<10%` clouds) with True Color RGB `vis_params` (`bands: ['B4', 'B3', 'B2']`, `min: 0`, `max: 3000`, `gamma: 1.4`); (3) Rendered the returned Earth Engine `median_image` tile layer directly on the center map panel with interactive visibility and opacity controls. |
| **v1.11** | 2026-09-20 | Updated **Server-Side Earth Engine Authentication & Project Initialization**: Configured [`server/ee_sentinel2.py`](server/ee_sentinel2.py) to authenticate and initialize explicitly with `ee.Authenticate()` followed by `ee.Initialize(project='geo-stars')` using pre-existing server-side authorization. |
| **v1.12** | 2026-09-20 | Updated **Space Data Panel Layout, Date Controls & Dynamic Sentinel-2 Date Aggregation**: (1) Moved the **Space Data** section to the bottom of the Left Panel below all other sections; (2) Added a **Current Date** text box at the top of the Space Data section; (3) Made the **`Sentinel 2 Optical Data`** button more compact and added an **`aggregation period`** dropdown selector (`'last week'`, `'last 2 weeks'`, `'last month'` default, `'last three months'`, `'last six months'`, `'last year'`); (4) Updated [`server/ee_sentinel2.py`](server/ee_sentinel2.py) and `/api/space-data/sentinel2` to filter `COPERNICUS/S2_SR_HARMONIZED` dynamically using the derived `[start_date, end_date]` window; (5) Added log messages in the Bottom Logging Panel displaying the actual derived dates used from the user's selection. |
| **v1.13** | 2026-09-20 | Added **Sentinel-1 SAR Data (`COPERNICUS/S1_GRD`) False Color Composite (`VV`, `VH`, `VV/VH`)**: (1) Added a **`Sentinel 1 SAR Data`** button directly below **`Sentinel 2 Optical Data`** in the Left Panel **Space Data** section; (2) Created server-side Google Earth Engine script [`server/ee_sentinel1.py`](server/ee_sentinel1.py) (`ee.Authenticate()`, `ee.Initialize(project='geo-stars')`) and `/api/space-data/sentinel1` endpoint to filter `COPERNICUS/S1_GRD` by the derived `[start_date, end_date]` window, reduce to median, compute the `VV/VH` ratio band, and generate a false-color composite with bands `['VV', 'VH', 'VV/VH']`; (3) Added map tile overlay rendering, visibility/opacity controls, and derived date range logging in the Bottom Logging Panel. |
| **v1.14** | 2026-09-20 | Added **CEMS Early Warning River Discharge Prediction (`scripts/download_glofas.py`)**: (1) Added **`CEMS Early Warning River Discharge Prediction`** section under **Space Data**; (2) Updated [`scripts/download_glofas.py`](scripts/download_glofas.py) to accept configurable region coordinates (`--lat`, `--lon`, `--radius 100000` for a 100 km radius around current map center) and store all files in **`tmp_downloads/`**; (3) Implemented automatic deletion of all files from previous days in `tmp_downloads/` on application startup and on every download, while reusing today's existing GeoTIFF when present to spare download time; (4) Rendered three map overlays (`24h`, `48h`, `72h` forecast bands) with pixel values above `80` clipped to `80`, a **White (`0`) to Red (`80`)** scale color map, and an interactive color map legend. |
