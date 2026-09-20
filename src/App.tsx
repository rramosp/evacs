import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import {
  computeAllEvacuationRoutes,
  computeDirectRouteToClosestTarget,
} from './services/routingEngine';
import {
  initializeSimulationState,
  reconcileSimulationOnRestart,
  stepSimulationState,
  getRemainingPopulationBySource,
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

  // Track whether topology/population/vehicle edits occurred while paused
  const [hasPendingTopologyChanges, setHasPendingTopologyChanges] = useState<boolean>(false);

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

  // Live remaining population per Source Area ID
  const remainingBySource = useMemo(() => {
    // When paused after edits or before start, respect src.population if user edited it
    if (!isSimulating) {
      const map: Record<string, number> = {};
      sourceAreas.forEach((s) => {
        map[s.id] = s.population;
      });
      return map;
    }
    return getRemainingPopulationBySource(
      sourceAreas,
      clusters,
      pickupStates,
      elapsedSimSeconds > 0
    );
  }, [sourceAreas, clusters, pickupStates, elapsedSimSeconds, isSimulating]);

  // Switch preset scenario (only when paused)
  const handleSelectPreset = (preset: PresetScenarioId) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before switching preset scenarios.');
      return;
    }

    setIsSimulating(false);
    setElapsedSimSeconds(0);
    setHasPendingTopologyChanges(false);
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
      setTargetAreas(
        data.targetAreas.map((t) => ({ ...t, currentOccupancy: 0, disabled: false }))
      );
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
    const activeTargets = targetAreas.filter((t) => !t.disabled);
    if (sourceAreas.length === 0 || activeTargets.length === 0) {
      appendLog(
        'WARN',
        'Cannot compute routes: At least 1 Source Area and 1 active (enabled) Target Shelter are required.'
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
      setHasPendingTopologyChanges(false);

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

  // Run / Resume Simulation (with automatic mid-simulation route recomputation & vehicle diversion if topology changed)
  const handleRunSimulation = async () => {
    const activeTargets = targetAreas.filter((t) => !t.disabled);
    if (activeTargets.length === 0) {
      appendLog('WARN', 'Cannot run simulation: All Target Shelters are disabled! Enable at least one Target Shelter.');
      return;
    }

    // If topology/population/fleets were modified while paused, recompute routes before resuming!
    if (hasPendingTopologyChanges || computedRoutes.length === 0) {
      setIsComputingRoutes(true);
      try {
        appendLog(
          'ROUTING',
          'Topology/population changes detected while paused — recomputing evacuation routes for remaining & new populations across active Target Areas...',
          elapsedSimSeconds
        );

        const routeResult = await computeAllEvacuationRoutes(
          sourceAreas,
          targetAreas,
          noGoAreas,
          vehicleFleets
        );

        setComputedRoutes(routeResult.routes);
        setLogs((prev) => [...prev, ...routeResult.logs]);

        if (elapsedSimSeconds > 0 && vehicles.length > 0) {
          // Compute direct routes from each loaded vehicle's current position to the CLOSEST active Target Area
          const directRoutesToClosestTarget: Record<
            string,
            { target: TargetArea; coordinates: [number, number][] }
          > = {};

          const loadedVehicles = vehicles.filter((v) => v.currentOccupancy > 0);
          for (const veh of loadedVehicles) {
            directRoutesToClosestTarget[veh.id] = await computeDirectRouteToClosestTarget(
              veh.currentPosition,
              targetAreas,
              noGoAreas
            );
          }

          const currentTargetOccupancies: Record<string, number> = {};
          targetAreas.forEach((t) => {
            currentTargetOccupancies[t.id] = t.currentOccupancy;
          });

          const reconciled = reconcileSimulationOnRestart(
            routeResult.routes,
            sourceAreas,
            targetAreas,
            vehicleFleets,
            vehicles,
            currentTargetOccupancies,
            directRoutesToClosestTarget
          );

          setClusters(reconciled.clusters);
          setPickupStates(reconciled.pickupStates);
          setVehicles(reconciled.vehicles);
          setHeatmapPoints(reconciled.heatmapPoints);
          setTotalEvacuated(reconciled.totalEvacuated);
          setTotalInTransit(reconciled.totalInTransit);
          setTotalRemainingAtSource(reconciled.totalRemainingAtSource);
          setTotalWaitingAtPickups(reconciled.totalWaitingAtPickups);

          reconciled.newLogs.forEach((msg) =>
            appendLog('SIMULATION', msg, elapsedSimSeconds)
          );
        } else {
          // Fresh start at t = 0
          const initialSimState = initializeSimulationState(
            routeResult.routes,
            sourceAreas,
            targetAreas,
            vehicleFleets
          );
          setClusters(initialSimState.clusters);
          setPickupStates(initialSimState.pickupStates);
          setVehicles(initialSimState.vehicles);
          setHeatmapPoints(initialSimState.heatmapPoints);
          setTotalEvacuated(0);
          setTotalInTransit(0);
          setTotalRemainingAtSource(initialSimState.totalRemainingAtSource);
          setTotalWaitingAtPickups(0);
        }

        setHasPendingTopologyChanges(false);
      } catch (err) {
        appendLog('WARN', `Failed to recompute routes on restart: ${String(err)}`);
        setIsComputingRoutes(false);
        return;
      } finally {
        setIsComputingRoutes(false);
      }
    }

    if (totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0) {
      handleResetSimulation();
    }

    setIsSimulating(true);
    appendLog(
      'SIMULATION',
      `Simulation running (${simSpeed}x). Evacuees moving within source zones toward Blue Square pickup locations; vehicles board until 80% occupancy or 10 minutes waiting time (with >=1 passenger).`,
      elapsedSimSeconds
    );
  };

  // Pause Simulation and snapshot remaining people into sourceAreas
  const handleStopSimulation = () => {
    setIsSimulating(false);

    // Sync each Source Area's population property to the exact remaining unboarded headcount
    const liveRemaining = getRemainingPopulationBySource(
      sourceAreas,
      clusters,
      pickupStates,
      elapsedSimSeconds > 0
    );

    setSourceAreas((prev) =>
      prev.map((src) => ({
        ...src,
        population: liveRemaining[src.id] ?? src.population,
      }))
    );

    appendLog(
      'SIMULATION',
      'Simulation paused. You can now modify Source/Target/No-Go areas, adjust population counts, disable Target Shelters, or add/remove vehicles.',
      elapsedSimSeconds
    );
  };

  // Reset Simulation back to t = 0
  const handleResetSimulation = () => {
    setIsSimulating(false);
    setElapsedSimSeconds(0);
    setHasPendingTopologyChanges(false);

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
        setSourceAreas((prev) => prev.map((s) => ({ ...s, population: 0 })));
        appendLog(
          'SIMULATION',
          `Evacuation simulation complete! All ${stepResult.totalEvacuated.toLocaleString()} evacuees transported from pickup locations to target shelters. Source area heatmaps fully cooled.`,
          nextElapsed
        );
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isSimulating, appendLog]);

  // Entity CRUD Handlers (All strictly enforce pause state)
  const handleAddSourceArea = (src: Omit<SourceArea, 'id'>) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before adding a Source Area.');
      return;
    }
    const newSrc: SourceArea = { ...src, id: `src-${Date.now()}` };
    setSourceAreas((prev) => [...prev, newSrc]);
    setHasPendingTopologyChanges(true);
    setTotalRemainingAtSource((prev) => prev + newSrc.population);
    appendLog(
      'INFO',
      `Added Source Area "${newSrc.name}" (${newSrc.population.toLocaleString()} evacuees). Routes will recompute automatically when simulation restarts.`,
      elapsedSimSeconds
    );
  };

  const handleUpdateSourceArea = (updatedSrc: SourceArea) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before modifying a Source Area.');
      return;
    }
    setSourceAreas((prev) => prev.map((s) => (s.id === updatedSrc.id ? updatedSrc : s)));
    setHasPendingTopologyChanges(true);

    // Recalculate total remaining across sources
    const newTotalRem = sourceAreas
      .map((s) => (s.id === updatedSrc.id ? updatedSrc : s))
      .reduce((acc, s) => acc + s.population, 0);
    setTotalRemainingAtSource(newTotalRem);

    appendLog(
      'INFO',
      `Modified Source Area "${updatedSrc.name}" (Remaining people set to ${updatedSrc.population.toLocaleString()}). Routes will recompute on restart.`,
      elapsedSimSeconds
    );
  };

  const handleDeleteSourceArea = (id: string) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before deleting a Source Area.');
      return;
    }
    const target = sourceAreas.find((s) => s.id === id);
    const remaining = remainingBySource[id] ?? target?.population ?? 0;

    if (remaining > 0) {
      appendLog(
        'WARN',
        `Cannot remove Source Area "${target?.name || id}": There are still ${remaining.toLocaleString()} people remaining inside!`,
        elapsedSimSeconds
      );
      return;
    }

    setSourceAreas((prev) => prev.filter((s) => s.id !== id));
    setHasPendingTopologyChanges(true);
    appendLog(
      'WARN',
      `Removed empty Source Area "${target?.name || id}" (0 people remaining).`,
      elapsedSimSeconds
    );
  };

  const handleAddTargetArea = (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before adding a Target Area.');
      return;
    }
    const newTgt: TargetArea = {
      ...tgt,
      id: `tgt-${Date.now()}`,
      currentOccupancy: 0,
      disabled: false,
    };
    setTargetAreas((prev) => [...prev, newTgt]);
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Added Target Shelter "${newTgt.name}" (Capacity: ${newTgt.capacity.toLocaleString()}). Routes will recompute on restart.`,
      elapsedSimSeconds
    );
  };

  const handleUpdateTargetArea = (updatedTgt: TargetArea) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before modifying a Target Area.');
      return;
    }
    setTargetAreas((prev) => prev.map((t) => (t.id === updatedTgt.id ? updatedTgt : t)));
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Modified Target Shelter "${updatedTgt.name}". Routes will recompute on restart.`,
      elapsedSimSeconds
    );
  };

  const handleToggleDisableTargetArea = (id: string) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before disabling/enabling a Target Area.');
      return;
    }
    const target = targetAreas.find((t) => t.id === id);
    if (!target) return;

    const nextDisabled = !target.disabled;
    setTargetAreas((prev) =>
      prev.map((t) => (t.id === id ? { ...t, disabled: nextDisabled } : t))
    );
    setHasPendingTopologyChanges(true);

    appendLog(
      nextDisabled ? 'WARN' : 'INFO',
      nextDisabled
        ? `Disabled Target Shelter "${target.name}" — it will receive no more people. Routes will redirect to active shelters on restart.`
        : `Re-enabled Target Shelter "${target.name}" to receive evacuees.`,
      elapsedSimSeconds
    );
  };

  const handleAddNoGoArea = (nogo: Omit<NoGoArea, 'id'>) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before adding a No-Go Area.');
      return;
    }
    const newNoGo: NoGoArea = { ...nogo, id: `nogo-${Date.now()}` };
    setNoGoAreas((prev) => [...prev, newNoGo]);
    setHasPendingTopologyChanges(true);
    appendLog(
      'WARN',
      `Defined No-Go Hazard Zone "${newNoGo.name}". Routes will detour around it on restart.`,
      elapsedSimSeconds
    );
  };

  const handleUpdateNoGoArea = (updatedNoGo: NoGoArea) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before modifying a No-Go Area.');
      return;
    }
    setNoGoAreas((prev) => prev.map((n) => (n.id === updatedNoGo.id ? updatedNoGo : n)));
    setHasPendingTopologyChanges(true);
    appendLog('INFO', `Modified No-Go Hazard Zone "${updatedNoGo.name}".`, elapsedSimSeconds);
  };

  const handleDeleteNoGoArea = (id: string) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before removing a No-Go Area.');
      return;
    }
    const target = noGoAreas.find((n) => n.id === id);
    setNoGoAreas((prev) => prev.filter((n) => n.id !== id));
    setHasPendingTopologyChanges(true);
    appendLog('INFO', `Removed No-Go Hazard Zone "${target?.name || id}".`, elapsedSimSeconds);
  };

  const handleAddVehicleFleet = (fleet: Omit<VehicleFleet, 'id'>) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before adding a Vehicle Fleet.');
      return;
    }
    const newFleet: VehicleFleet = { ...fleet, id: `veh-${Date.now()}` };
    setVehicleFleets((prev) => [...prev, newFleet]);
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Added Vehicle Fleet "${newFleet.name}" (${newFleet.count}x ${newFleet.type}). Will be deployed on simulation restart.`,
      elapsedSimSeconds
    );
  };

  const handleUpdateVehicleFleet = (updatedFleet: VehicleFleet) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before modifying a Vehicle Fleet.');
      return;
    }
    setVehicleFleets((prev) =>
      prev.map((v) => (v.id === updatedFleet.id ? updatedFleet : v))
    );
    setHasPendingTopologyChanges(true);
    appendLog('INFO', `Modified Vehicle Fleet "${updatedFleet.name}".`, elapsedSimSeconds);
  };

  const handleDeleteVehicleFleet = (id: string) => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before removing a Vehicle Fleet.');
      return;
    }
    const target = vehicleFleets.find((v) => v.id === id);
    setVehicleFleets((prev) => prev.filter((v) => v.id !== id));
    setHasPendingTopologyChanges(true);
    appendLog('WARN', `Removed Vehicle Fleet "${target?.name || id}".`, elapsedSimSeconds);
  };

  // Drawing Handlers
  const handleStartDrawing = (type: 'source' | 'target' | 'nogo' | 'vehicle') => {
    if (isSimulating) {
      appendLog('WARN', 'Pause simulation before drawing or placing entities.');
      return;
    }
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
        remainingBySource={remainingBySource}
        onAddSourceArea={handleAddSourceArea}
        onUpdateSourceArea={handleUpdateSourceArea}
        onDeleteSourceArea={handleDeleteSourceArea}
        onAddTargetArea={handleAddTargetArea}
        onUpdateTargetArea={handleUpdateTargetArea}
        onToggleDisableTargetArea={handleToggleDisableTargetArea}
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
