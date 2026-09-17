import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  SimulationCohort,
  HeatmapPoint,
  LogEntry,
  PresetScenarioId,
  ActiveDrawMode,
} from './types/evacuation';
import { PRESET_SCENARIOS } from './data/presets';
import { computeAllEvacuationRoutes, getPolygonCentroid } from './services/routingEngine';
import { createSimulationCohorts, stepSimulation } from './services/simulationEngine';
import { LeftControlPanel } from './components/LeftControlPanel';
import { EvacuationMap } from './components/EvacuationMap';
import { BottomLogPanel } from './components/BottomLogPanel';
import { RightTelemetryPanel } from './components/RightTelemetryPanel';

export function App() {
  // Preset scenario selection
  const [selectedPreset, setSelectedPreset] = useState<PresetScenarioId>('brussels');
  const [mapCenter, setMapCenter] = useState<[number, number]>(PRESET_SCENARIOS.brussels.center);
  const [mapZoom, setMapZoom] = useState<number>(PRESET_SCENARIOS.brussels.zoom);

  // Core domain entities
  const [sourceAreas, setSourceAreas] = useState<SourceArea[]>(
    PRESET_SCENARIOS.brussels.sourceAreas
  );
  const [targetAreas, setTargetAreas] = useState<TargetArea[]>(
    PRESET_SCENARIOS.brussels.targetAreas
  );
  const [noGoAreas, setNoGoAreas] = useState<NoGoArea[]>(
    PRESET_SCENARIOS.brussels.noGoAreas
  );
  const [vehicleFleets, setVehicleFleets] = useState<VehicleFleet[]>(
    PRESET_SCENARIOS.brussels.vehicleFleets
  );

  // Selected entity for map highlight
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  // Drawing / Placement state
  const [activeDrawMode, setActiveDrawMode] = useState<ActiveDrawMode>(null);
  const [pendingDrawnPolygon, setPendingDrawnPolygon] = useState<[number, number][] | null>(null);
  const [pendingPlacedPoint, setPendingPlacedPoint] = useState<[number, number] | null>(null);

  // Routing & Simulation states
  const [computedRoutes, setComputedRoutes] = useState<ComputedRoute[]>([]);
  const [isComputingRoutes, setIsComputingRoutes] = useState<boolean>(false);
  const [cohorts, setCohorts] = useState<SimulationCohort[]>([]);
  const [heatmapPoints, setHeatmapPoints] = useState<HeatmapPoint[]>([]);
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [simSpeed, setSimSpeed] = useState<number>(2);
  const [elapsedSimSeconds, setElapsedSimSeconds] = useState<number>(0);

  // Telemetry metrics
  const [totalEvacuated, setTotalEvacuated] = useState<number>(0);
  const [totalInTransit, setTotalInTransit] = useState<number>(0);
  const [totalRemainingAtSource, setTotalRemainingAtSource] = useState<number>(0);

  // System & Simulation Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const appendLog = useCallback(
    (level: LogEntry['level'], message: string, simSec: number = 0) => {
      const mins = Math.floor(simSec / 60);
      const secs = Math.floor(simSec % 60);
      const simFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      setLogs((prev) => [
        ...prev,
        {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          simTimeFormatted: simFormatted,
          level,
          message,
        },
      ]);
    },
    []
  );

  // Generate initial static heatmap at t=0 (all evacuees inside source polygons)
  const generateInitialHeatmap = useCallback((sources: SourceArea[]) => {
    const pts: HeatmapPoint[] = [];
    sources.forEach((src) => {
      const centroid = getPolygonCentroid(src.polygon);
      const intensity = Math.min(1.0, src.population / 1200);
      pts.push({
        lat: centroid[0],
        lng: centroid[1],
        intensity,
        behavior: 'obedient',
      });
      src.polygon.forEach((corner) => {
        pts.push({
          lat: (centroid[0] + corner[0]) / 2,
          lng: (centroid[1] + corner[1]) / 2,
          intensity: intensity * 0.75,
          behavior: 'obedient',
        });
      });
    });
    setHeatmapPoints(pts);
  }, []);

  // Switch preset scenario
  const handleSelectPreset = (preset: PresetScenarioId) => {
    setIsSimulating(false);
    setElapsedSimSeconds(0);
    setSelectedPreset(preset);
    setSelectedEntityId(null);
    setActiveDrawMode(null);
    setPendingDrawnPolygon(null);
    setPendingPlacedPoint(null);

    if (preset === 'brussels' || preset === 'paris') {
      const data = PRESET_SCENARIOS[preset];
      setMapCenter(data.center);
      setMapZoom(data.zoom);
      setSourceAreas(data.sourceAreas);
      setTargetAreas(data.targetAreas.map((t) => ({ ...t, currentOccupancy: 0 })));
      setNoGoAreas(data.noGoAreas);
      setVehicleFleets(data.vehicleFleets);
      setComputedRoutes([]);
      setCohorts([]);
      const totalPop = data.sourceAreas.reduce((acc, s) => acc + s.population, 0);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(totalPop);
      generateInitialHeatmap(data.sourceAreas);

      appendLog(
        'INFO',
        `Loaded preset scenario: "${data.name}" (${data.sourceAreas.length} sources, ${data.targetAreas.length} shelters, ${data.noGoAreas.length} no-go zones).`
      );
    } else {
      // Custom blank scenario
      setSourceAreas([]);
      setTargetAreas([]);
      setNoGoAreas([]);
      setVehicleFleets([]);
      setComputedRoutes([]);
      setCohorts([]);
      setHeatmapPoints([]);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(0);
      appendLog('INFO', 'Initialized blank custom scenario. Use the left panel buttons to draw zones on the map.');
    }
  };

  // Run OSRM + Obstacle Avoidance Route Computation
  const handleComputeRoutes = useCallback(async () => {
    if (sourceAreas.length === 0 || targetAreas.length === 0) {
      appendLog('WARN', 'Cannot compute routes: At least 1 Source Area and 1 Target Shelter are required.');
      return;
    }

    setIsSimulating(false);
    setIsComputingRoutes(true);

    try {
      const result = await computeAllEvacuationRoutes(
        sourceAreas,
        targetAreas,
        noGoAreas,
        vehicleFleets
      );

      setComputedRoutes(result.routes);
      setLogs((prev) => [...prev, ...result.logs]);

      // Initialize simulation cohorts ready for playback
      const initialCohorts = createSimulationCohorts(
        result.routes,
        sourceAreas,
        vehicleFleets
      );
      setCohorts(initialCohorts);
      setElapsedSimSeconds(0);

      const totalPop = sourceAreas.reduce((acc, s) => acc + s.population, 0);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(totalPop);
      setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));
      generateInitialHeatmap(sourceAreas);
    } catch (err) {
      appendLog('WARN', `Route computation encountered an error: ${String(err)}`);
    } finally {
      setIsComputingRoutes(false);
    }
  }, [sourceAreas, targetAreas, noGoAreas, vehicleFleets, appendLog, generateInitialHeatmap]);

  // Automatically compute routes on initial mount so the user immediately sees the Brussels routes
  useEffect(() => {
    handleComputeRoutes();
  }, []);

  // Run / Resume Simulation
  const handleRunSimulation = () => {
    if (computedRoutes.length === 0) {
      appendLog('WARN', 'Please compute evacuation routes before starting the simulation.');
      return;
    }

    // If simulation already completed, reset first
    if (totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0) {
      handleResetSimulation();
    }

    setIsSimulating(true);
    appendLog(
      'SIMULATION',
      `Simulation playback started at ${simSpeed}x speed. Animating evacuee heatmap and vehicle fleets.`
    );
  };

  // Stop / Pause Simulation
  const handleStopSimulation = () => {
    setIsSimulating(false);
    appendLog('SIMULATION', 'Simulation paused by operator.', elapsedSimSeconds);
  };

  // Reset Simulation back to t = 0
  const handleResetSimulation = () => {
    setIsSimulating(false);
    setElapsedSimSeconds(0);

    const freshCohorts = createSimulationCohorts(computedRoutes, sourceAreas, vehicleFleets);
    setCohorts(freshCohorts);

    const totalPop = sourceAreas.reduce((acc, s) => acc + s.population, 0);
    setTotalEvacuated(0);
    setTotalInTransit(0);
    setTotalRemainingAtSource(totalPop);
    setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));
    generateInitialHeatmap(sourceAreas);

    appendLog('SIMULATION', 'Simulation reset to t=00:00. All evacuees returned to source zones.');
  };

  // Animation Loop for Discrete-Time Simulation
  const simStateRef = useRef({
    cohorts,
    elapsedSimSeconds,
    sourceAreas,
    targetAreas,
    simSpeed,
  });

  useEffect(() => {
    simStateRef.current = {
      cohorts,
      elapsedSimSeconds,
      sourceAreas,
      targetAreas,
      simSpeed,
    };
  }, [cohorts, elapsedSimSeconds, sourceAreas, targetAreas, simSpeed]);

  useEffect(() => {
    if (!isSimulating) return;

    const intervalMs = 100; // 10 ticks per second
    const timer = setInterval(() => {
      const state = simStateRef.current;
      const deltaSimSec = (intervalMs / 1000) * state.simSpeed * 6; // 1 wall second = 6 sim seconds at 1x
      const nextElapsed = state.elapsedSimSeconds + deltaSimSec;

      const stepResult = stepSimulation(
        state.cohorts,
        nextElapsed,
        deltaSimSec,
        state.sourceAreas,
        state.targetAreas
      );

      setCohorts(stepResult.cohorts);
      setHeatmapPoints(stepResult.heatmapPoints);
      setElapsedSimSeconds(nextElapsed);
      setTotalEvacuated(stepResult.totalEvacuated);
      setTotalInTransit(stepResult.totalInTransit);
      setTotalRemainingAtSource(stepResult.totalRemainingAtSource);

      // Update target occupancies
      setTargetAreas((prev) =>
        prev.map((tgt) => ({
          ...tgt,
          currentOccupancy: stepResult.targetOccupancies[tgt.id] || 0,
        }))
      );

      // Emit arrival logs
      if (stepResult.newLogs.length > 0) {
        stepResult.newLogs.forEach((msg) => {
          appendLog('SIMULATION', msg, nextElapsed);
        });
      }

      // Auto-stop when 100% of cohorts have arrived
      const allArrived =
        stepResult.cohorts.length > 0 &&
        stepResult.cohorts.every((c) => c.status === 'arrived');
      if (allArrived) {
        setIsSimulating(false);
        appendLog(
          'SIMULATION',
          `Evacuation simulation completed! All ${stepResult.totalEvacuated.toLocaleString()} evacuees have reached safe target shelters.`,
          nextElapsed
        );
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isSimulating, appendLog]);

  // Entity CRUD Handlers
  const handleAddSourceArea = (src: Omit<SourceArea, 'id'>) => {
    const newSrc: SourceArea = { ...src, id: `src-${Date.now()}` };
    const updated = [...sourceAreas, newSrc];
    setSourceAreas(updated);
    generateInitialHeatmap(updated);
    appendLog('INFO', `Added Source Area "${newSrc.name}" (${newSrc.population.toLocaleString()} evacuees).`);
  };

  const handleUpdateSourceArea = (updatedSrc: SourceArea) => {
    const updated = sourceAreas.map((s) => (s.id === updatedSrc.id ? updatedSrc : s));
    setSourceAreas(updated);
    generateInitialHeatmap(updated);
    appendLog('INFO', `Modified Source Area "${updatedSrc.name}".`);
  };

  const handleDeleteSourceArea = (id: string) => {
    const target = sourceAreas.find((s) => s.id === id);
    const updated = sourceAreas.filter((s) => s.id !== id);
    setSourceAreas(updated);
    generateInitialHeatmap(updated);
    appendLog('WARN', `Deleted Source Area "${target?.name || id}".`);
  };

  const handleAddTargetArea = (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => {
    const newTgt: TargetArea = { ...tgt, id: `tgt-${Date.now()}`, currentOccupancy: 0 };
    setTargetAreas((prev) => [...prev, newTgt]);
    appendLog('INFO', `Added Target Shelter "${newTgt.name}" (Capacity: ${newTgt.capacity.toLocaleString()}).`);
  };

  const handleUpdateTargetArea = (updatedTgt: TargetArea) => {
    setTargetAreas((prev) => prev.map((t) => (t.id === updatedTgt.id ? updatedTgt : t)));
    appendLog('INFO', `Modified Target Shelter "${updatedTgt.name}".`);
  };

  const handleDeleteTargetArea = (id: string) => {
    const target = targetAreas.find((t) => t.id === id);
    setTargetAreas((prev) => prev.filter((t) => t.id !== id));
    appendLog('WARN', `Deleted Target Shelter "${target?.name || id}".`);
  };

  const handleAddNoGoArea = (nogo: Omit<NoGoArea, 'id'>) => {
    const newNoGo: NoGoArea = { ...nogo, id: `nogo-${Date.now()}` };
    setNoGoAreas((prev) => [...prev, newNoGo]);
    appendLog('WARN', `Defined No-Go Hazard Zone "${newNoGo.name}". Re-compute routes to update detours.`);
  };

  const handleUpdateNoGoArea = (updatedNoGo: NoGoArea) => {
    setNoGoAreas((prev) => prev.map((n) => (n.id === updatedNoGo.id ? updatedNoGo : n)));
    appendLog('INFO', `Modified No-Go Hazard Zone "${updatedNoGo.name}".`);
  };

  const handleDeleteNoGoArea = (id: string) => {
    const target = noGoAreas.find((n) => n.id === id);
    setNoGoAreas((prev) => prev.filter((n) => n.id !== id));
    appendLog('INFO', `Removed No-Go Hazard Zone "${target?.name || id}".`);
  };

  const handleAddVehicleFleet = (fleet: Omit<VehicleFleet, 'id'>) => {
    const newFleet: VehicleFleet = { ...fleet, id: `veh-${Date.now()}` };
    setVehicleFleets((prev) => [...prev, newFleet]);
    appendLog(
      'INFO',
      `Added Vehicle Fleet "${newFleet.name}" (${newFleet.count}x ${newFleet.type}).`
    );
  };

  const handleUpdateVehicleFleet = (updatedFleet: VehicleFleet) => {
    setVehicleFleets((prev) => prev.map((v) => (v.id === updatedFleet.id ? updatedFleet : v)));
    appendLog('INFO', `Modified Vehicle Fleet "${updatedFleet.name}".`);
  };

  const handleDeleteVehicleFleet = (id: string) => {
    const target = vehicleFleets.find((v) => v.id === id);
    setVehicleFleets((prev) => prev.filter((v) => v.id !== id));
    appendLog('WARN', `Removed Vehicle Fleet "${target?.name || id}".`);
  };

  // Drawing Handlers
  const handleStartDrawing = (type: 'source' | 'target' | 'nogo' | 'vehicle') => {
    setPendingDrawnPolygon(null);
    setPendingPlacedPoint(null);
    if (type === 'vehicle') {
      setActiveDrawMode({ type: 'vehicle', point: null });
      appendLog('INFO', 'Click anywhere on the OSM map to set the Vehicle Fleet depot coordinates.');
    } else {
      setActiveDrawMode({ type, points: [] });
      appendLog('INFO', `Drawing mode active: Click on the OSM map to place polygon vertices for new ${type.toUpperCase()} area.`);
    }
  };

  const handleFinishDrawingPolygon = (points: [number, number][]) => {
    setPendingDrawnPolygon(points);
  };

  const handleFinishPlacingVehiclePoint = (point: [number, number]) => {
    setPendingPlacedPoint(point);
  };

  const handleClearPendingGeometry = () => {
    setActiveDrawMode(null);
    setPendingDrawnPolygon(null);
    setPendingPlacedPoint(null);
  };

  return (
    <div className="cockpit-grid-layout">
      {/* 1. LEFT SIDE PANEL (25% Width x 100% Height) */}
      <LeftControlPanel
        selectedPreset={selectedPreset}
        onSelectPreset={handleSelectPreset}
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        noGoAreas={noGoAreas}
        vehicleFleets={vehicleFleets}
        onAddSourceArea={handleAddSourceArea}
        onUpdateSourceArea={handleUpdateSourceArea}
        onDeleteSourceArea={handleDeleteSourceArea}
        onAddTargetArea={handleAddTargetArea}
        onUpdateTargetArea={handleUpdateTargetArea}
        onDeleteTargetArea={handleDeleteTargetArea}
        onAddNoGoArea={handleAddNoGoArea}
        onUpdateNoGoArea={handleUpdateNoGoArea}
        onDeleteNoGoArea={handleDeleteNoGoArea}
        onAddVehicleFleet={handleAddVehicleFleet}
        onUpdateVehicleFleet={handleUpdateVehicleFleet}
        onDeleteVehicleFleet={handleDeleteVehicleFleet}
        onComputeRoutes={handleComputeRoutes}
        isComputingRoutes={isComputingRoutes}
        hasComputedRoutes={computedRoutes.length > 0}
        onRunSimulation={handleRunSimulation}
        onStopSimulation={handleStopSimulation}
        onResetSimulation={handleResetSimulation}
        isSimulating={isSimulating}
        simSpeed={simSpeed}
        onChangeSimSpeed={setSimSpeed}
        activeDrawMode={activeDrawMode}
        onStartDrawing={handleStartDrawing}
        pendingDrawnPolygon={pendingDrawnPolygon}
        pendingPlacedPoint={pendingPlacedPoint}
        onClearPendingGeometry={handleClearPendingGeometry}
        selectedEntityId={selectedEntityId}
        onSelectEntity={setSelectedEntityId}
      />

      {/* 2. CENTER AREA COLUMN (50% Width) -> TOP 75% MAP + BOTTOM 25% LOGS */}
      <main className="cockpit-center-column">
        <div className="cockpit-map-area" id="center-osm-map-panel">
          <EvacuationMap
            center={mapCenter}
            zoom={mapZoom}
            sourceAreas={sourceAreas}
            targetAreas={targetAreas}
            noGoAreas={noGoAreas}
            vehicleFleets={vehicleFleets}
            computedRoutes={computedRoutes}
            cohorts={cohorts}
            heatmapPoints={heatmapPoints}
            isSimulating={isSimulating}
            activeDrawMode={activeDrawMode}
            onUpdateDrawMode={setActiveDrawMode}
            onFinishDrawingPolygon={handleFinishDrawingPolygon}
            onFinishPlacingVehiclePoint={handleFinishPlacingVehiclePoint}
            selectedEntityId={selectedEntityId}
            onSelectEntity={setSelectedEntityId}
          />
        </div>

        <BottomLogPanel
          logs={logs}
          onClearLogs={() => setLogs([])}
        />
      </main>

      {/* 3. RIGHT SIDE PANEL (25% Width x 100% Height) */}
      <RightTelemetryPanel
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        vehicleFleets={vehicleFleets}
        computedRoutes={computedRoutes}
        elapsedSimSeconds={elapsedSimSeconds}
        totalEvacuated={totalEvacuated}
        totalInTransit={totalInTransit}
        totalRemainingAtSource={totalRemainingAtSource}
        isSimulating={isSimulating}
      />
    </div>
  );
}

export default App;
