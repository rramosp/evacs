# EVAC-OPS — Evacuation Management & Routing Simulation Application

An interactive emergency management User Interface (UI) built on OpenStreetMap (OSM) for coordinating urban evacuations, computing obstacle-avoiding evacuation routes, and running animated crowd/vehicle density heatmap simulations.

For full functional and technical specifications, see **[spec.md](./spec.md)**.

![EVAC-OPS UI](imgs/ui.png)

---

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Development Server
```bash
npm run dev -- --host 0.0.0.0 --port 8080
```
Open `http://localhost:8080` in your browser.

### 3. Production Build & Type Check
```bash
npm run build
```

---

## Key Features

- **4-Panel Tactical Cockpit Layout**:
  - **Left Control Panel (`25% Width × 100% Height`)**: Scenario selector (`Brussels`, `Paris`, `Custom`), execution controls (`Compute evacuation routes`, `Run simulation`, `Stop simulation`, `Reset simulation`, speed multiplier), and CRUD management for Source Areas, Target Shelters, No-Go Zones, and Vehicle Fleets.
  - **Center Map Viewport (`50% Width × 75% Height`)**: OpenStreetMap base layer (toggleable Tactical Dark / Standard OSM), interactive polygon drawing & vehicle staging depot placement, color-coded zone overlays, **Blue Square Pickup Locations** established per route on source areas, directional route corridors, and a 60 FPS HTML5 Canvas thermal density heatmap overlay.
  - **Bottom Console Panel (`50% Width × 25% Height`)**: Real-time system, routing, and simulation log stream with level filtering (`ALL`, `ROUTING`, `SIMULATION`, `WARN`, `INFO`).
  - **Right Situational Telemetry Panel (`25% Width × 100% Height`)**: Real-time evacuation KPIs (`Safe at Shelter`, `In Transit`, `At Source`), elapsed simulation clock (`MM:SS`), Target Shelter occupancy bars, population behavioral breakdown (`Obedient`, `Autonomous`, `Random`), and toggleable Scoping Blank View.
- **Obstacle-Avoiding Routing Engine**: Combines OSRM shortest-path queries with client-side `@turf/turf` polygon intersection detection and convex-hull detour waypoint generation to guarantee routes strictly avoid No-Go zones.
