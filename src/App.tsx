import { useState, useEffect, useRef, useCallback } from 'react';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  HeatmapPoint,
  LogEntry,
  PresetScenarioId,
  ActiveDrawMode,
} from './types/evacuation';
import { PRESET_SCENARIOS } from './data/presets';
import { computeAllEvacuationRoutes } from './services/routingEngine';
import {
  initializeSimulationState,
  stepSimulationState,
} from './services/simulationEngine';
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

  const [clusters, setClusters] = useState<SourceInternalCluster[]>([]);
  const [pickupStates, setPickupStates] = useState<PickupLocationState[]>([]);
  const [vehicles, setVehicles] = useState<ActiveVehicleUnit[]>([]);
  const [heatmapPoints, setHeatmapPoints] = useState<HeatmapPoint[]>([]);

  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [simSpeed, setSimSpeed] = useState<number>(2);
  const [elapsedSimSeconds, setElapsedSimSeconds] = useState<number>(0);

  // Telemetry metrics
  const [totalEvacuated, setTotalEvacuated] = useState<number>(0);
  const [totalInTransit, setTotalInTransit] = useState<number>(0);
  const [totalRemainingAtSource, setTotalRemainingAtSource] = useState<number>(0);
  const [totalWaitingAtPickups, setTotalWaitingAtPickups] = useState<number>(0);

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
      setClusters([]);
      setPickupStates([]);
      setVehicles([]);
      setHeatmapPoints([]);

      const totalPop = data.sourceAreas.reduce((acc, s) => acc + s.population, 0);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(totalPop);
      setTotalWaitingAtPickups(0);

      appendLog(
        'INFO',
        `Loaded preset scenario: "${data.name}" (${data.sourceAreas.length} sources, ${data.targetAreas.length} shelters, ${data.noGoAreas.length} no-go zones).`
      );
    } else {
      setSourceAreas([]);
      setTargetAreas([]);
      setNoGoAreas([]);
      setVehicleFleets([]);
      setComputedRoutes([]);
      setClusters([]);
      setPickupStates([]);
      setVehicles([]);
      setHeatmapPoints([]);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(0);
      setTotalWaitingAtPickups(0);
      appendLog(
        'INFO',
        'Initialized blank custom scenario. Use the left panel buttons to draw zones on the map.'
      );
    }
  };

  // Run OSRM + Obstacle Avoidance Route Computation & Establish Blue Square Pickups
  const handleComputeRoutes = useCallback(async () => {
    if (sourceAreas.length === 0 || targetAreas.length === 0) {
      appendLog(
        'WARN',
        'Cannot compute routes: At least 1 Source Area and 1 Target Shelter are required.'
      );
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

      // Initialize micro-simulation state ready for playback
      const initialSimState = initializeSimulationState(
        result.routes,
        sourceAreas,
        targetAreas,
        vehicleFleets
      );

      setClusters(initialSimState.clusters);
      setPickupStates(initialSimState.pickupStates);
      setVehicles(initialSimState.vehicles);
      setHeatmapPoints(initialSimState.heatmapPoints);
      setElapsedSimSeconds(0);

      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(initialSimState.totalRemainingAtSource);
      setTotalWaitingAtPickups(0);
      setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));
    } catch (err) {
      appendLog('WARN', `Route computation encountered an error: ${String(err)}`);
    } finally {
      setIsComputingRoutes(false);
    }
  }, [sourceAreas, targetAreas, noGoAreas, vehicleFleets, appendLog]);

  // Automatically compute routes on initial mount
  useEffect(() => {
    handleComputeRoutes();
  }, []);

  // Run / Resume Simulation
  const handleRunSimulation = () => {
    if (computedRoutes.length === 0) {
      appendLog('WARN', 'Please compute evacuation routes before starting the simulation.');
      return;
    }

    if (totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0) {
      handleResetSimulation();
    }

    setIsSimulating(true);
    appendLog(
      'SIMULATION',
      `Simulation started (${simSpeed}x). Evacuees moving within source zones toward Blue Square pickup locations; vehicles board until 80% occupancy or 10 minutes waiting time (with >=1 passenger).`
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

    const freshState = initializeSimulationState(
      computedRoutes,
      sourceAreas,
      targetAreas,
      vehicleFleets
    );
    setClusters(freshState.clusters);
    setPickupStates(freshState.pickupStates);
    setVehicles(freshState.vehicles);
    setHeatmapPoints(freshState.heatmapPoints);

    setTotalEvacuated(0);
    setTotalInTransit(0);
    setTotalRemainingAtSource(freshState.totalRemainingAtSource);
    setTotalWaitingAtPickups(0);
    setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));

    appendLog(
      'SIMULATION',
      'Simulation reset to t=00:00. All evacuees returned to initial positions inside source zones.'
    );
  };

  // Keep latest simulation state in ref for interval loop
  const simStateRef = useRef({
    clusters,
    pickupStates,
    vehicles,
    targetOccupancies: {} as Record<string, number>,
    elapsedSimSeconds,
    sourceAreas,
    targetAreas,
    simSpeed,
  });

  useEffect(() => {
    const occMap: Record<string, number> = {};
    targetAreas.forEach((t) => {
      occMap[t.id] = t.currentOccupancy;
    });

    simStateRef.current = {
      clusters,
      pickupStates,
      vehicles,
      targetOccupancies: occMap,
      elapsedSimSeconds,
      sourceAreas,
      targetAreas,
      simSpeed,
    };
  }, [clusters, pickupStates, vehicles, elapsedSimSeconds, sourceAreas, targetAreas, simSpeed]);

  useEffect(() => {
    if (!isSimulating) return;

    const intervalMs = 100; // 10 ticks per second
    const timer = setInterval(() => {
      const state = simStateRef.current;
      const deltaSimSec = (intervalMs / 1000) * state.simSpeed * 4.5;
      const nextElapsed = state.elapsedSimSeconds + deltaSimSec;

      const stepResult = stepSimulationState(
        {
          clusters: state.clusters,
          pickupStates: state.pickupStates,
          vehicles: state.vehicles,
          heatmapPoints: [],
          targetOccupancies: state.targetOccupancies,
          newLogs: [],
          totalEvacuated: 0,
          totalInTransit: 0,
          totalRemainingAtSource: 0,
          totalWaitingAtPickups: 0,
        },
        nextElapsed,
        deltaSimSec,
        state.sourceAreas,
        state.targetAreas
      );

      setClusters(stepResult.clusters);
      setPickupStates(stepResult.pickupStates);
      setVehicles(stepResult.vehicles);
      setHeatmapPoints(stepResult.heatmapPoints);
      setElapsedSimSeconds(nextElapsed);

      setTotalEvacuated(stepResult.totalEvacuated);
      setTotalInTransit(stepResult.totalInTransit);
      setTotalRemainingAtSource(stepResult.totalRemainingAtSource);
      setTotalWaitingAtPickups(stepResult.totalWaitingAtPickups);

      setTargetAreas((prev) =>
        prev.map((tgt) => ({
          ...tgt,
          currentOccupancy: stepResult.targetOccupancies[tgt.id] || 0,
        }))
      );

      if (stepResult.newLogs.length > 0) {
        stepResult.newLogs.forEach((msg) => {
          appendLog('SIMULATION', msg, nextElapsed);
        });
      }

      // Auto-complete when source areas are empty and all vehicles have offloaded
      if (
        stepResult.totalRemainingAtSource === 0 &&
        stepResult.totalInTransit === 0 &&
        stepResult.totalEvacuated > 0
      ) {
        setIsSimulating(false);
        appendLog(
          'SIMULATION',
          `Evacuation simulation complete! All ${stepResult.totalEvacuated.toLocaleString()} evacuees transported from pickup locations to target shelters. Source area heatmaps fully cooled.`,
          nextElapsed
        );
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isSimulating, appendLog]);

  // Entity CRUD Handlers
  const handleAddSourceArea = (src: Omit<SourceArea, 'id'>) => {
    const newSrc: SourceArea = { ...src, id: `src-${Date.now()}` };
    setSourceAreas((prev) => [...prev, newSrc]);
    appendLog(
      'INFO',
      `Added Source Area "${newSrc.name}" (${newSrc.population.toLocaleString()} evacuees). Click "Compute evacuation routes" to establish pickup locations.`
    );
  };

  const handleUpdateSourceArea = (updatedSrc: SourceArea) => {
    setSourceAreas((prev) => prev.map((s) => (s.id === updatedSrc.id ? updatedSrc : s)));
    appendLog('INFO', `Modified Source Area "${updatedSrc.name}".`);
  };

  const handleDeleteSourceArea = (id: string) => {
    const target = sourceAreas.find((s) => s.id === id);
    setSourceAreas((prev) => prev.filter((s) => s.id !== id));
    appendLog('WARN', `Deleted Source Area "${target?.name || id}".`);
  };

  const handleAddTargetArea = (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => {
    const newTgt: TargetArea = { ...tgt, id: `tgt-${Date.now()}`, currentOccupancy: 0 };
    setTargetAreas((prev) => [...prev, newTgt]);
    appendLog(
      'INFO',
      `Added Target Shelter "${newTgt.name}" (Capacity: ${newTgt.capacity.toLocaleString()}).`
    );
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
    appendLog(
      'WARN',
      `Defined No-Go Hazard Zone "${newNoGo.name}". Re-compute routes to update detours.`
    );
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
    setVehicleFleets((prev) =>
      prev.map((v) => (v.id === updatedFleet.id ? updatedFleet : v))
    );
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
      appendLog(
        'INFO',
        'Click anywhere on the OSM map to set the Vehicle Fleet depot coordinates.'
      );
    } else {
      setActiveDrawMode({ type, points: [] });
      appendLog(
        'INFO',
        `Drawing mode active: Click on the OSM map to place polygon vertices for new ${type.toUpperCase()} area.`
      );
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
            pickupStates={pickupStates}
            vehicles={vehicles}
            clusters={clusters}
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

        <BottomLogPanel logs={logs} onClearLogs={() => setLogs([])} />
      </main>

      {/* 3. RIGHT SIDE PANEL (25% Width x 100% Height) */}
      <RightTelemetryPanel
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        vehicleFleets={vehicleFleets}
        computedRoutes={computedRoutes}
        pickupStates={pickupStates}
        elapsedSimSeconds={elapsedSimSeconds}
        totalEvacuated={totalEvacuated}
        totalInTransit={totalInTransit}
        totalRemainingAtSource={totalRemainingAtSource}
        totalWaitingAtPickups={totalWaitingAtPickups}
        isSimulating={isSimulating}
      />
    </div>
  );
}

export default App;
