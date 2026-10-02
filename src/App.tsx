import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  SourceArea,
  TargetArea,
  AvoidArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  HeatmapPoint,
  LogEntry,
  PresetScenarioId,
  ActiveDrawMode,
  Sentinel2LayerState,
  Sentinel1LayerState,
  Sentinel2AggregationPeriod,
  GlofasForecastState,
  GlofasForecastOverlay,
  TwinTelemetryStats,
  BrusselsMetroLineFeature,
  BrusselsMetroStationFeature,
  BrusselsMetroConfig,
  RoutingAlgorithm,
} from './types/evacuation';
import { PresetScenarioData } from './data/presets';
import { BRUSSELS_METRO_INITIAL_DATA } from './data/brusselsMetroData';
import {
  hasAnyAreaInBrussels,
  findBrusselsMetroStationsInAreas,
  buildBrusselsMetroEvacuationCorridors,
} from './services/brusselsMetroService';
import {
  computeAllEvacuationRoutes,
  computeDirectRouteToClosestTarget,
  computeRejoinPathToClosestRoute,
  findClosestPointOnPolyline,
} from './services/routingEngine';
import {
  initializeTwinState,
  reconcileTwinOnRestart,
  stepTwinState,
  getRemainingPopulationBySource,
  createInitialTelemetryStats,
  generateHeatmapFromState,
} from './services/twinEngine';
import { LeftControlPanel } from './components/LeftControlPanel';
import { EvacuationMap } from './components/EvacuationMap';
import { BottomLogPanel } from './components/BottomLogPanel';
import { RightTelemetryPanel } from './components/RightTelemetryPanel';
import { TwinReportModal } from './components/TwinReportModal';

export function App() {
  // Dynamic preset scenarios loaded exclusively at runtime from data/scenarios/*.pkl
  const [presetScenarios, setPresetScenarios] = useState<
    Record<string, PresetScenarioData>
  >({});

  // Preset scenario selection
  const [selectedPreset, setSelectedPreset] = useState<PresetScenarioId>('custom');
  const [mapCenter, setMapCenter] = useState<[number, number]>([50.8503, 4.3517]);
  const [mapZoom, setMapZoom] = useState<number>(12);

  // Core domain entities (populated dynamically from /api/scenarios on startup)
  const [sourceAreas, setSourceAreas] = useState<SourceArea[]>([]);
  const [targetAreas, setTargetAreas] = useState<TargetArea[]>([]);
  const [avoidAreas, setAvoidAreas] = useState<AvoidArea[]>([]);
  const [vehicleFleets, setVehicleFleets] = useState<VehicleFleet[]>([]);

  // Track baseline initial populations for each Source Area so Reset / Post-Finish Compute restores them
  const baselinePopulationsRef = useRef<Record<string, number>>({});

  // Track whether topology/population/vehicle edits occurred while paused
  const [hasPendingTopologyChanges, setHasPendingTopologyChanges] = useState<boolean>(false);

  // Selected entity for map highlight
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null);

  // Drawing / Placement state
  const [activeDrawMode, setActiveDrawMode] = useState<ActiveDrawMode>(null);
  const [pendingDrawnPolygon, setPendingDrawnPolygon] = useState<[number, number][] | null>(null);
  const [pendingPlacedPoint, setPendingPlacedPoint] = useState<[number, number] | null>(null);

  // Routing & Twin states
  const [routingAlgorithm, setRoutingAlgorithm] = useState<RoutingAlgorithm>('Basic OSM');
  const [computedRoutes, setComputedRoutes] = useState<ComputedRoute[]>([]);
  const [isComputingRoutes, setIsComputingRoutes] = useState<boolean>(false);
  const routeComputeAbortRef = useRef<AbortController | null>(null);

  const [clusters, setClusters] = useState<SourceInternalCluster[]>([]);
  const [pickupStates, setPickupStates] = useState<PickupLocationState[]>([]);
  const [vehicles, setVehicles] = useState<ActiveVehicleUnit[]>([]);
  const [heatmapPoints, setHeatmapPoints] = useState<HeatmapPoint[]>([]);
  const [telemetryStats, setTelemetryStats] = useState<TwinTelemetryStats>(() =>
    createInitialTelemetryStats([])
  );

  const [isTwinning, setIsTwinning] = useState<boolean>(false);
  const [isTwinInProgress, setIsTwinInProgress] = useState<boolean>(false);
  const [twinSpeed, setTwinSpeed] = useState<number>(2);
  const [elapsedTwinSeconds, setElapsedTwinSeconds] = useState<number>(0);
  const [isTwinReportOpen, setIsTwinReportOpen] = useState<boolean>(false);

  // Telemetry metrics
  const [totalEvacuated, setTotalEvacuated] = useState<number>(0);
  const [totalInTransit, setTotalInTransit] = useState<number>(0);
  const [totalRemainingAtSource, setTotalRemainingAtSource] = useState<number>(0);
  const [totalWaitingAtPickups, setTotalWaitingAtPickups] = useState<number>(0);

  // System & Twin Logs
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Independent Cockpit Panel Collapse States & Map Labels Visibility
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState<boolean>(false);
  const [isBottomPanelCollapsed, setIsBottomPanelCollapsed] = useState<boolean>(false);
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState<boolean>(false);
  const [showLabels, setShowLabels] = useState<boolean>(true);

  // Brussels Metro Network data loaded from data/brussels_metro_lines.parquet and data/brussels_metro_stations.parquet
  const [brusselsMetroNetwork, setBrusselsMetroNetwork] = useState<{
    lines: BrusselsMetroLineFeature[];
    stations: BrusselsMetroStationFeature[];
  }>({
    lines: BRUSSELS_METRO_INITIAL_DATA.lines,
    stations: BRUSSELS_METRO_INITIAL_DATA.stations,
  });

  const [brusselsMetroConfig, setBrusselsMetroConfig] = useState<BrusselsMetroConfig>({
    showNetworkOverlay: false,
    useForEvacuation: false,
    trainCount: 4,
    trainCapacity: 300,
  });

  // Dynamically load Preset Scenarios from data/scenarios/*.pkl via server endpoint on application startup
  useEffect(() => {
    let cancelled = false;

    fetch('/api/scenarios')
      .then((r) => r.json())
      .then(async (data) => {
        if (cancelled) return;
        if (data?.ok && Array.isArray(data.scenarios) && data.scenarios.length > 0) {
          const scenarios = data.scenarios as PresetScenarioData[];
          const map: Record<string, PresetScenarioData> = {};
          for (const s of scenarios) {
            map[s.id] = s;
          }
          setPresetScenarios(map);

          const firstScenario = scenarios[0];
          const freshSources = firstScenario.sourceAreas.map((s) => ({
            ...s,
            disabled: false,
          }));
          const freshTargets = firstScenario.targetAreas.map((t) => ({
            ...t,
            currentOccupancy: 0,
            disabled: false,
          }));
          const freshAvoids = firstScenario.avoidAreas.map((a) => ({
            ...a,
            disabled: false,
          }));

          baselinePopulationsRef.current = Object.fromEntries(
            freshSources.map((s) => [s.id, s.population])
          );

          const initialTwin = initializeTwinState(
            [],
            freshSources,
            freshTargets,
            firstScenario.vehicleFleets
          );

          setSelectedPreset(firstScenario.id);
          setMapCenter(firstScenario.center);
          setMapZoom(firstScenario.zoom);
          setSourceAreas(freshSources);
          setTargetAreas(freshTargets);
          setAvoidAreas(freshAvoids);
          setVehicleFleets(firstScenario.vehicleFleets);
          setComputedRoutes([]);
          setClusters(initialTwin.clusters);
          setPickupStates(initialTwin.pickupStates);
          setVehicles(initialTwin.vehicles);
          setHeatmapPoints(initialTwin.heatmapPoints);
          setTelemetryStats(initialTwin.telemetryStats);
          setTotalEvacuated(0);
          setTotalInTransit(0);
          setTotalRemainingAtSource(initialTwin.totalRemainingAtSource);
          setTotalWaitingAtPickups(0);

          const nowFormatted = new Date().toLocaleTimeString();
          setLogs((prev) => [
            ...prev,
            {
              id: `log-startup-${Date.now()}`,
              timestamp: nowFormatted,
              twinTimeFormatted: '00:00',
              level: 'INFO',
              message: `Dynamically loaded ${scenarios.length} scenario(s) from data/scenarios/*.pkl. Active scenario: "${firstScenario.name}" (${freshSources.length} sources, ${freshTargets.length} shelters, ${freshAvoids.length} avoid areas, ${firstScenario.vehicleFleets.length} vehicle fleets).`,
            },
          ]);

          // Compute initial evacuation routes for the dynamically loaded startup scenario
          const activeSources = freshSources.filter((s) => !s.disabled);
          const activeTargets = freshTargets.filter((t) => !t.disabled);
          if (activeSources.length > 0 && activeTargets.length > 0) {
            setIsComputingRoutes(true);
            try {
              const routeResult = await computeAllEvacuationRoutes(
                freshSources,
                freshTargets,
                freshAvoids,
                firstScenario.vehicleFleets
              );
              if (cancelled) return;
              setComputedRoutes(routeResult.routes);
              setLogs((prev) => [...prev, ...routeResult.logs]);

              const routedTwin = initializeTwinState(
                routeResult.routes,
                freshSources,
                freshTargets,
                firstScenario.vehicleFleets
              );
              setClusters(routedTwin.clusters);
              setPickupStates(routedTwin.pickupStates);
              setVehicles(routedTwin.vehicles);
              setHeatmapPoints(routedTwin.heatmapPoints);
              setTelemetryStats(routedTwin.telemetryStats);
              setTotalRemainingAtSource(routedTwin.totalRemainingAtSource);
            } catch (err) {
              if (!cancelled) {
                setLogs((prev) => [
                  ...prev,
                  {
                    id: `log-startup-err-${Date.now()}`,
                    timestamp: new Date().toLocaleTimeString(),
                    twinTimeFormatted: '00:00',
                    level: 'WARN',
                    message: `Initial route computation encountered an error: ${String(err)}`,
                  },
                ]);
              }
            } finally {
              if (!cancelled) {
                setIsComputingRoutes(false);
              }
            }
          }
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLogs((prev) => [
            ...prev,
            {
              id: `log-scenarios-err-${Date.now()}`,
              timestamp: new Date().toLocaleTimeString(),
              twinTimeFormatted: '00:00',
              level: 'WARN',
              message: `Could not load preset scenarios from /api/scenarios: ${String(err)}`,
            },
          ]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Load Brussels Metro parquet files via server endpoint on mount
  useEffect(() => {
    fetch('/api/brussels-metro/network')
      .then((r) => r.json())
      .then((data) => {
        if (data?.ok && Array.isArray(data.lines) && Array.isArray(data.stations)) {
          setBrusselsMetroNetwork({
            lines: data.lines,
            stations: data.stations,
          });
        }
      })
      .catch(() => {
        // Fallback to BRUSSELS_METRO_INITIAL_DATA generated from the same parquet files
      });
  }, []);

  // Determine whether any Source or Target Area falls within the Region of Brussels
  const hasBrusselsAreas = useMemo(
    () => hasAnyAreaInBrussels(sourceAreas, targetAreas),
    [sourceAreas, targetAreas]
  );

  // Find Metro stations falling within Source Areas and Target Areas
  const { sourceStations: sourceMetroStations, targetStations: targetMetroStations } = useMemo(
    () =>
      findBrusselsMetroStationsInAreas(
        brusselsMetroNetwork.stations,
        sourceAreas,
        targetAreas
      ),
    [brusselsMetroNetwork.stations, sourceAreas, targetAreas]
  );

  // Build static underground Metro evacuation corridors between Source stations and Target stations
  const metroCorridors = useMemo(
    () =>
      buildBrusselsMetroEvacuationCorridors(
        sourceAreas,
        targetAreas,
        brusselsMetroNetwork.lines,
        brusselsMetroNetwork.stations
      ),
    [
      sourceAreas,
      targetAreas,
      brusselsMetroNetwork.lines,
      brusselsMetroNetwork.stations,
    ]
  );

  const activeMetroEvacuationOptions = useMemo(() => {
    if (
      !hasBrusselsAreas ||
      !brusselsMetroConfig.useForEvacuation ||
      sourceMetroStations.length === 0 ||
      targetMetroStations.length === 0 ||
      metroCorridors.length === 0
    ) {
      return undefined;
    }
    return {
      enabled: true,
      corridors: metroCorridors,
      trainCount: brusselsMetroConfig.trainCount,
      trainCapacity: brusselsMetroConfig.trainCapacity,
    };
  }, [
    hasBrusselsAreas,
    brusselsMetroConfig.useForEvacuation,
    brusselsMetroConfig.trainCount,
    brusselsMetroConfig.trainCapacity,
    sourceMetroStations.length,
    targetMetroStations.length,
    metroCorridors,
  ]);

  const appendLog = useCallback(
    (level: LogEntry['level'], message: string, twinSec: number = 0) => {
      const mins = Math.floor(twinSec / 60);
      const secs = Math.floor(twinSec % 60);
      const twinFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

      setLogs((prev) => [
        ...prev,
        {
          id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: new Date().toLocaleTimeString(),
          twinTimeFormatted: twinFormatted,
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
    if (!isTwinning) {
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
      elapsedTwinSeconds > 0
    );
  }, [sourceAreas, clusters, pickupStates, elapsedTwinSeconds, isTwinning]);

  // Switch preset scenario (only when paused)
  const handleSelectPreset = (preset: PresetScenarioId) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before switching preset scenarios.');
      return;
    }

    setIsTwinning(false);
    setIsTwinInProgress(false);
    setElapsedTwinSeconds(0);
    setHasPendingTopologyChanges(false);
    setSelectedPreset(preset);
    setSelectedEntityId(null);
    setActiveDrawMode(null);
    setPendingDrawnPolygon(null);
    setPendingPlacedPoint(null);

    const data = preset !== 'custom' ? presetScenarios[preset] : undefined;
    if (data) {
      const freshSources = data.sourceAreas.map((s) => ({
        ...s,
        disabled: false,
      }));
      baselinePopulationsRef.current = Object.fromEntries(
        freshSources.map((s) => [s.id, s.population])
      );
      const freshTargets = data.targetAreas.map((t) => ({
        ...t,
        currentOccupancy: 0,
        disabled: false,
      }));
      const freshAvoids = data.avoidAreas.map((a) => ({
        ...a,
        disabled: false,
      }));
      const initialTwin = initializeTwinState(
        [],
        freshSources,
        freshTargets,
        data.vehicleFleets
      );

      setMapCenter(data.center);
      setMapZoom(data.zoom);
      setSourceAreas(freshSources);
      setTargetAreas(freshTargets);
      setAvoidAreas(freshAvoids);
      setVehicleFleets(data.vehicleFleets);
      setComputedRoutes([]);
      setClusters(initialTwin.clusters);
      setPickupStates(initialTwin.pickupStates);
      setVehicles(initialTwin.vehicles);
      setHeatmapPoints(initialTwin.heatmapPoints);
      setTelemetryStats(initialTwin.telemetryStats);

      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalRemainingAtSource(initialTwin.totalRemainingAtSource);
      setTotalWaitingAtPickups(0);

      appendLog(
        'INFO',
        `Loaded preset scenario: "${data.name}" (${freshSources.length} sources, ${freshTargets.length} shelters, ${freshAvoids.length} avoid areas, ${data.vehicleFleets.length} vehicle fleets).`
      );
    } else {
      baselinePopulationsRef.current = {};
      setSourceAreas([]);
      setTargetAreas([]);
      setAvoidAreas([]);
      setVehicleFleets([]);
      setComputedRoutes([]);
      setClusters([]);
      setPickupStates([]);
      setVehicles([]);
      setHeatmapPoints([]);
      setTelemetryStats(createInitialTelemetryStats([]));
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

  const handleStopComputingRoutes = useCallback(() => {
    if (routeComputeAbortRef.current) {
      routeComputeAbortRef.current.abort();
      routeComputeAbortRef.current = null;
    }
    setIsComputingRoutes(false);
    appendLog('WARN', 'Route calculation stopped by user.');
  }, [appendLog]);

  // Run OSRM + Obstacle Avoidance Route Computation & Establish Blue Square Pickups
  // Note: Only land routes over streets with the configured vehicleFleets are computed here;
  // Brussels Metro lines remain static and unaffected by avoidAreas.
  const handleComputeRoutes = useCallback(async () => {
    if (isTwinning || isTwinInProgress) {
      appendLog(
        'WARN',
        'Cannot compute evacuation routes while a twin is in progress. Wait until the twin finishes or reset the twin first.'
      );
      return;
    }

    const activeSources = sourceAreas.filter((s) => !s.disabled);
    const activeTargets = targetAreas.filter((t) => !t.disabled);
    if (activeSources.length === 0 || activeTargets.length === 0) {
      appendLog(
        'WARN',
        'Cannot compute routes: At least 1 active (enabled) Source Area and 1 active (enabled) Target Shelter are required.'
      );
      return;
    }

    if (routeComputeAbortRef.current) {
      routeComputeAbortRef.current.abort();
    }
    const abortController = new AbortController();
    routeComputeAbortRef.current = abortController;

    const isPausedMidSimulation =
      elapsedTwinSeconds > 0 && !activeSources.every((s) => s.population === 0) && vehicles.length > 0;

    setIsTwinning(false);
    if (!isPausedMidSimulation) {
      setIsTwinInProgress(false);
    }
    setIsComputingRoutes(true);

    // If computing routes after a completed twin (where active source populations reached 0), restore baseline populations
    const allZeroPop = activeSources.every((s) => s.population === 0);
    const effectiveSourceAreas = allZeroPop
      ? sourceAreas.map((s) => ({
          ...s,
          population: baselinePopulationsRef.current[s.id] ?? s.population,
        }))
      : sourceAreas;

    if (allZeroPop) {
      setSourceAreas(effectiveSourceAreas);
    }

    try {
      const result = await computeAllEvacuationRoutes(
        effectiveSourceAreas,
        targetAreas,
        avoidAreas,
        vehicleFleets,
        routingAlgorithm,
        abortController.signal
      );

      // If user clicked 'stop calculation', restore map without including the calculated routes
      if (abortController.signal.aborted) {
        return;
      }

      setComputedRoutes(result.routes);
      setLogs((prev) => [...prev, ...result.logs]);
      setHasPendingTopologyChanges(false);

      if (isPausedMidSimulation) {
        const directRoutesToClosestTarget: Record<
          string,
          { target: TargetArea; coordinates: [number, number][] }
        > = {};
        const rejoinRoutesToClosestEvacRoute: Record<
          string,
          { route: ComputedRoute; coordinates: [number, number][] }
        > = {};

        const streetVehicles = vehicles.filter((v) => v.vehicleType !== 'Metro' && !v.isMetro);
        for (const veh of streetVehicles) {
          if (abortController.signal.aborted) {
            return;
          }
          if (veh.currentOccupancy > 0) {
            directRoutesToClosestTarget[veh.id] = await computeDirectRouteToClosestTarget(
              veh.currentPosition,
              targetAreas,
              avoidAreas
            );
          }

          const fleet = vehicleFleets.find((f) => f.id === veh.fleetId);
          const isStillAtDepot =
            veh.progressMeters === 0 &&
            Boolean(fleet) &&
            Math.hypot(
              (veh.currentPosition[0] - fleet!.location[0]) * 111320,
              (veh.currentPosition[1] - fleet!.location[1]) * 71500
            ) <= 50;
          const origRoute = result.routes.find((r) => r.id === veh.assignedRouteId);
          const origSnap =
            origRoute && origRoute.coordinates && origRoute.coordinates.length >= 2
              ? findClosestPointOnPolyline(veh.currentPosition, origRoute.coordinates)
              : null;
          const isOnOrigEvacRoute =
            !isStillAtDepot &&
            origRoute !== undefined &&
            origSnap !== null &&
            origSnap.distanceMeters <= 40;

          if (!isStillAtDepot && !isOnOrigEvacRoute && result.routes.length > 0) {
            const rejoin = await computeRejoinPathToClosestRoute(
              veh.currentPosition,
              result.routes,
              avoidAreas,
              veh.currentOccupancy > 0 ? 'to_target' : 'to_pickup'
            );
            if (rejoin) {
              rejoinRoutesToClosestEvacRoute[veh.id] = rejoin;
            }
          }
        }

        if (abortController.signal.aborted) {
          return;
        }

        const currentTargetOccupancies: Record<string, number> = {};
        targetAreas.forEach((t) => {
          currentTargetOccupancies[t.id] = t.currentOccupancy;
        });

        const reconciled = reconcileTwinOnRestart(
          result.routes,
          effectiveSourceAreas,
          targetAreas,
          vehicleFleets,
          vehicles,
          currentTargetOccupancies,
          directRoutesToClosestTarget,
          telemetryStats,
          pickupStates,
          activeMetroEvacuationOptions,
          clusters,
          rejoinRoutesToClosestEvacRoute
        );

        setClusters(reconciled.clusters);
        setPickupStates(reconciled.pickupStates);
        setVehicles(reconciled.vehicles);
        setHeatmapPoints(reconciled.heatmapPoints);
        setTelemetryStats(reconciled.telemetryStats);
        setTotalEvacuated(reconciled.totalEvacuated);
        setTotalInTransit(reconciled.totalInTransit);
        setTotalRemainingAtSource(reconciled.totalRemainingAtSource);
        setTotalWaitingAtPickups(reconciled.totalWaitingAtPickups);

        reconciled.newLogs.forEach((msg) => appendLog('TWIN', msg, elapsedTwinSeconds));
      } else {
        // Initialize micro-twin state ready for playback at t = 0
        const initialTwinState = initializeTwinState(
          result.routes,
          effectiveSourceAreas,
          targetAreas,
          vehicleFleets,
          activeMetroEvacuationOptions
        );

        if (initialTwinState.newLogs.length > 0) {
          initialTwinState.newLogs.forEach((msg) => appendLog('ROUTING', msg, 0));
        }

        setClusters(initialTwinState.clusters);
        setPickupStates(initialTwinState.pickupStates);
        setVehicles(initialTwinState.vehicles);
        setHeatmapPoints(initialTwinState.heatmapPoints);
        setTelemetryStats(initialTwinState.telemetryStats);
        setElapsedTwinSeconds(0);

        setTotalEvacuated(0);
        setTotalInTransit(0);
        setTotalRemainingAtSource(initialTwinState.totalRemainingAtSource);
        setTotalWaitingAtPickups(0);
        setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        appendLog('WARN', `Route computation encountered an error: ${String(err)}`);
      }
    } finally {
      if (routeComputeAbortRef.current === abortController) {
        routeComputeAbortRef.current = null;
        setIsComputingRoutes(false);
      }
    }
  }, [
    sourceAreas,
    targetAreas,
    avoidAreas,
    vehicleFleets,
    routingAlgorithm,
    appendLog,
    isTwinning,
    isTwinInProgress,
    activeMetroEvacuationOptions,
    elapsedTwinSeconds,
    vehicles,
    telemetryStats,
    pickupStates,
    clusters,
  ]);

  // When paused at t=0 and scenario / Source/Target areas or Brussels Metro evacuation settings change,
  // refresh the initialized twin state so spatially uniform evacuee clusters,
  // metro pickups, drop-offs, and trains are immediately distributed and ready on the map.
  useEffect(() => {
    if (isTwinning || isTwinInProgress || elapsedTwinSeconds > 0) return;

    const freshState = initializeTwinState(
      computedRoutes,
      sourceAreas,
      targetAreas,
      vehicleFleets,
      activeMetroEvacuationOptions
    );
    setClusters(freshState.clusters);
    setPickupStates(freshState.pickupStates);
    setVehicles(freshState.vehicles);
    setHeatmapPoints(freshState.heatmapPoints);
    setTelemetryStats(freshState.telemetryStats);
    setTotalRemainingAtSource(freshState.totalRemainingAtSource);
  }, [
    activeMetroEvacuationOptions,
    sourceAreas,
    targetAreas,
    vehicleFleets,
    computedRoutes,
    isTwinning,
    isTwinInProgress,
    elapsedTwinSeconds,
  ]);

  // Run / Resume Twin (with automatic mid-twin route recomputation & vehicle diversion if topology changed)
  const handleRunTwin = async () => {
    const activeSources = sourceAreas.filter((s) => !s.disabled);
    if (activeSources.length === 0) {
      appendLog(
        'WARN',
        'Cannot run twin: No active Source Areas available! Add or enable at least one Source Area.'
      );
      return;
    }
    const activeTargets = targetAreas.filter((t) => !t.disabled);
    if (activeTargets.length === 0) {
      appendLog('WARN', 'Cannot run twin: No active Target Shelters available! Add or enable at least one Target Shelter.');
      return;
    }

    // If restarting after a previous twin finished (where active source populations reached 0), restore baseline populations first
    const isRestartingCompletedTwin =
      (totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0) ||
      activeSources.every((s) => s.population === 0);

    const effectiveSourceAreas = isRestartingCompletedTwin
      ? sourceAreas.map((s) => ({
          ...s,
          population: baselinePopulationsRef.current[s.id] ?? s.population,
        }))
      : sourceAreas;

    if (isRestartingCompletedTwin) {
      setSourceAreas(effectiveSourceAreas);
      setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));
      setElapsedTwinSeconds(0);
      setTotalEvacuated(0);
      setTotalInTransit(0);
      setTotalWaitingAtPickups(0);
    }

    const effectiveElapsedTwinSec = isRestartingCompletedTwin ? 0 : elapsedTwinSeconds;

    // Determine which active Source Areas still need street routes (those not covered by active Metro Corridors)
    const metroCoveredSourceIds = new Set(
      activeMetroEvacuationOptions?.enabled
        ? activeMetroEvacuationOptions.corridors.map((c) => c.sourceId)
        : []
    );
    const needsStreetRoutes =
      vehicleFleets.length > 0 &&
      effectiveSourceAreas.some((s) => !s.disabled && !metroCoveredSourceIds.has(s.id));

    // If topology/population/fleets were modified while paused (or routes/vehicles not yet initialized), recompute & initialize before resuming!
    if (
      hasPendingTopologyChanges ||
      isRestartingCompletedTwin ||
      (needsStreetRoutes && computedRoutes.length === 0) ||
      vehicles.length === 0
    ) {
      if (routeComputeAbortRef.current) {
        routeComputeAbortRef.current.abort();
      }
      const abortController = new AbortController();
      routeComputeAbortRef.current = abortController;
      setIsComputingRoutes(true);
      try {
        let nextStreetRoutes = computedRoutes;

        if (needsStreetRoutes && (hasPendingTopologyChanges || computedRoutes.length === 0)) {
          appendLog(
            'ROUTING',
            `Computing street evacuation routes (${routingAlgorithm}) for Source Areas served by street vehicle fleets...`,
            effectiveElapsedTwinSec
          );

          const routeResult = await computeAllEvacuationRoutes(
            effectiveSourceAreas,
            targetAreas,
            avoidAreas,
            vehicleFleets,
            routingAlgorithm,
            abortController.signal
          );

          if (abortController.signal.aborted) {
            return;
          }

          nextStreetRoutes = routeResult.routes;
          setComputedRoutes(routeResult.routes);
          setLogs((prev) => [...prev, ...routeResult.logs]);
        } else if (!needsStreetRoutes && computedRoutes.length > 0 && vehicleFleets.length === 0) {
          nextStreetRoutes = [];
          setComputedRoutes([]);
        }

        if (effectiveElapsedTwinSec > 0 && vehicles.length > 0) {
          // Compute direct routes from each loaded street vehicle's current position to the CLOSEST active Target Area
          // and compute rejoin paths to the closest evacuation route for any off-route street vehicle
          const directRoutesToClosestTarget: Record<
            string,
            { target: TargetArea; coordinates: [number, number][] }
          > = {};
          const rejoinRoutesToClosestEvacRoute: Record<
            string,
            { route: ComputedRoute; coordinates: [number, number][] }
          > = {};

          const streetVehicles = vehicles.filter((v) => v.vehicleType !== 'Metro' && !v.isMetro);
          for (const veh of streetVehicles) {
            if (abortController.signal.aborted) {
              return;
            }
            if (veh.currentOccupancy > 0) {
              directRoutesToClosestTarget[veh.id] = await computeDirectRouteToClosestTarget(
                veh.currentPosition,
                targetAreas,
                avoidAreas
              );
            }

            const fleet = vehicleFleets.find((f) => f.id === veh.fleetId);
            const isStillAtDepot =
              veh.progressMeters === 0 &&
              Boolean(fleet) &&
              Math.hypot(
                (veh.currentPosition[0] - fleet!.location[0]) * 111320,
                (veh.currentPosition[1] - fleet!.location[1]) * 71500
              ) <= 50;
            const origRoute = nextStreetRoutes.find((r) => r.id === veh.assignedRouteId);
            const origSnap =
              origRoute && origRoute.coordinates && origRoute.coordinates.length >= 2
                ? findClosestPointOnPolyline(veh.currentPosition, origRoute.coordinates)
                : null;
            const isOnOrigEvacRoute =
              !isStillAtDepot &&
              origRoute !== undefined &&
              origSnap !== null &&
              origSnap.distanceMeters <= 40;

            if (!isStillAtDepot && !isOnOrigEvacRoute && nextStreetRoutes.length > 0) {
              const rejoin = await computeRejoinPathToClosestRoute(
                veh.currentPosition,
                nextStreetRoutes,
                avoidAreas,
                veh.currentOccupancy > 0 ? 'to_target' : 'to_pickup'
              );
              if (rejoin) {
                rejoinRoutesToClosestEvacRoute[veh.id] = rejoin;
              }
            }
          }

          if (abortController.signal.aborted) {
            return;
          }

          const currentTargetOccupancies: Record<string, number> = {};
          targetAreas.forEach((t) => {
            currentTargetOccupancies[t.id] = t.currentOccupancy;
          });

          const reconciled = reconcileTwinOnRestart(
            nextStreetRoutes,
            effectiveSourceAreas,
            targetAreas,
            vehicleFleets,
            vehicles,
            currentTargetOccupancies,
            directRoutesToClosestTarget,
            telemetryStats,
            pickupStates,
            activeMetroEvacuationOptions,
            clusters,
            rejoinRoutesToClosestEvacRoute
          );

          setClusters(reconciled.clusters);
          setPickupStates(reconciled.pickupStates);
          setVehicles(reconciled.vehicles);
          setHeatmapPoints(reconciled.heatmapPoints);
          setTelemetryStats(reconciled.telemetryStats);
          setTotalEvacuated(reconciled.totalEvacuated);
          setTotalInTransit(reconciled.totalInTransit);
          setTotalRemainingAtSource(reconciled.totalRemainingAtSource);
          setTotalWaitingAtPickups(reconciled.totalWaitingAtPickups);

          reconciled.newLogs.forEach((msg) =>
            appendLog('TWIN', msg, effectiveElapsedTwinSec)
          );
        } else {
          // Fresh start at t = 0
          const initialTwinState = initializeTwinState(
            nextStreetRoutes,
            effectiveSourceAreas,
            targetAreas,
            vehicleFleets,
            activeMetroEvacuationOptions
          );
          setClusters(initialTwinState.clusters);
          setPickupStates(initialTwinState.pickupStates);
          setVehicles(initialTwinState.vehicles);
          setHeatmapPoints(initialTwinState.heatmapPoints);
          setTelemetryStats(initialTwinState.telemetryStats);
          setTotalEvacuated(0);
          setTotalInTransit(0);
          setTotalRemainingAtSource(initialTwinState.totalRemainingAtSource);
          setTotalWaitingAtPickups(0);

          initialTwinState.newLogs.forEach((msg) =>
            appendLog('TWIN', msg, 0)
          );
        }

        setHasPendingTopologyChanges(false);
      } catch (err) {
        if (!abortController.signal.aborted) {
          appendLog('WARN', `Failed to initialize routes on start: ${String(err)}`);
        }
        return;
      } finally {
        if (routeComputeAbortRef.current === abortController) {
          routeComputeAbortRef.current = null;
          setIsComputingRoutes(false);
        }
      }
    }

    setIsTwinReportOpen(false);
    setIsTwinInProgress(true);
    setIsTwinning(true);
    appendLog(
      'TWIN',
      `Twin running (${twinSpeed}x). Evacuees moving within source zones toward pickup locations${
        activeMetroEvacuationOptions
          ? ` (Brussels Metro Active: ${activeMetroEvacuationOptions.corridors.length} station corridor(s), ${activeMetroEvacuationOptions.trainCount} train(s) × ${activeMetroEvacuationOptions.trainCapacity} pax)`
          : ''
      }.`,
      effectiveElapsedTwinSec
    );
  };

  // Pause Twin and snapshot remaining people into sourceAreas
  const handleStopTwin = () => {
    setIsTwinning(false);

    // Sync each Source Area's population property to the exact remaining unboarded headcount
    const liveRemaining = getRemainingPopulationBySource(
      sourceAreas,
      clusters,
      pickupStates,
      elapsedTwinSeconds > 0
    );

    setSourceAreas((prev) =>
      prev.map((src) => ({
        ...src,
        population: liveRemaining[src.id] ?? src.population,
      }))
    );

    appendLog(
      'TWIN',
      'Twin paused. You can now modify Source/Target/Avoid areas, adjust population counts, disable Target Shelters, or add/remove vehicles.',
      elapsedTwinSeconds
    );
  };

  // Reset Twin back to t = 0
  const handleResetTwin = () => {
    setIsTwinning(false);
    setIsTwinInProgress(false);
    setElapsedTwinSeconds(0);
    setHasPendingTopologyChanges(false);

    const restoredSources = sourceAreas.map((s) => ({
      ...s,
      population: baselinePopulationsRef.current[s.id] ?? s.population,
    }));
    setSourceAreas(restoredSources);

    const freshState = initializeTwinState(
      computedRoutes,
      restoredSources,
      targetAreas,
      vehicleFleets,
      activeMetroEvacuationOptions
    );
    setClusters(freshState.clusters);
    setPickupStates(freshState.pickupStates);
    setVehicles(freshState.vehicles);
    setHeatmapPoints(freshState.heatmapPoints);
    setTelemetryStats(freshState.telemetryStats);

    setTotalEvacuated(0);
    setTotalInTransit(0);
    setTotalRemainingAtSource(freshState.totalRemainingAtSource);
    setTotalWaitingAtPickups(0);
    setTargetAreas((prev) => prev.map((t) => ({ ...t, currentOccupancy: 0 })));

    appendLog(
      'TWIN',
      'Twin reset to t=00:00. All evacuees returned to initial positions inside source zones.'
    );
  };

  // Keep latest twin state in ref for interval loop
  const twinStateRef = useRef({
    clusters,
    pickupStates,
    vehicles,
    targetOccupancies: {} as Record<string, number>,
    telemetryStats,
    elapsedTwinSeconds,
    sourceAreas,
    targetAreas,
    twinSpeed,
  });

  useEffect(() => {
    const occMap: Record<string, number> = {};
    targetAreas.forEach((t) => {
      occMap[t.id] = t.currentOccupancy;
    });

    twinStateRef.current = {
      clusters,
      pickupStates,
      vehicles,
      targetOccupancies: occMap,
      telemetryStats,
      elapsedTwinSeconds,
      sourceAreas,
      targetAreas,
      twinSpeed,
    };
  }, [
    clusters,
    pickupStates,
    vehicles,
    telemetryStats,
    elapsedTwinSeconds,
    sourceAreas,
    targetAreas,
    twinSpeed,
  ]);

  useEffect(() => {
    if (!isTwinning) return;

    const intervalMs = 100; // 10 ticks per second
    let lastTickMs = performance.now();

    const timer = setInterval(() => {
      const nowMs = performance.now();
      // Compute true wall-clock elapsed seconds (clamped to prevent huge jumps if tab was backgrounded)
      const wallDeltaSec = Math.min(0.5, Math.max(0.01, (nowMs - lastTickMs) / 1000));
      lastTickMs = nowMs;

      const state = twinStateRef.current;
      // 1x playback = 1 twin second per 1 real-time second
      const deltaTwinSec = wallDeltaSec * state.twinSpeed;
      const nextElapsed = state.elapsedTwinSeconds + deltaTwinSec;

      const stepResult = stepTwinState(
        {
          clusters: state.clusters,
          pickupStates: state.pickupStates,
          vehicles: state.vehicles,
          heatmapPoints: [],
          targetOccupancies: state.targetOccupancies,
          telemetryStats: state.telemetryStats,
          newLogs: [],
          totalEvacuated: 0,
          totalInTransit: 0,
          totalRemainingAtSource: 0,
          totalWaitingAtPickups: 0,
        },
        nextElapsed,
        deltaTwinSec,
        state.sourceAreas,
        state.targetAreas
      );

      setClusters(stepResult.clusters);
      setPickupStates(stepResult.pickupStates);
      setVehicles(stepResult.vehicles);
      setHeatmapPoints(stepResult.heatmapPoints);
      setTelemetryStats(stepResult.telemetryStats);
      setElapsedTwinSeconds(nextElapsed);

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
          appendLog('TWIN', msg, nextElapsed);
        });
      }

      // Auto-complete when source areas are empty and all vehicles have offloaded
      if (
        stepResult.totalRemainingAtSource === 0 &&
        stepResult.totalInTransit === 0 &&
        stepResult.totalEvacuated > 0
      ) {
        setIsTwinning(false);
        setIsTwinInProgress(false);
        setSourceAreas((prev) => prev.map((s) => (s.disabled ? s : { ...s, population: 0 })));
        appendLog(
          'TWIN',
          `Evacuation twin complete! All ${stepResult.totalEvacuated.toLocaleString()} evacuees transported from pickup locations to target shelters.`,
          nextElapsed
        );
      }
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isTwinning, appendLog]);

  // Entity CRUD Handlers (All strictly enforce pause state)
  const handleAddSourceArea = (src: Omit<SourceArea, 'id'>) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before adding a Source Area.');
      return;
    }
    const newSrc: SourceArea = { ...src, id: `src-${Date.now()}`, disabled: false };
    baselinePopulationsRef.current[newSrc.id] = newSrc.population;
    setSourceAreas((prev) => [...prev, newSrc]);
    setHasPendingTopologyChanges(true);
    setTotalRemainingAtSource((prev) => prev + newSrc.population);
    appendLog(
      'INFO',
      `Added Source Area "${newSrc.name}" (${newSrc.population.toLocaleString()} evacuees). Routes will recompute automatically when twin restarts.`,
      elapsedTwinSeconds
    );
  };

  const handleUpdateSourceArea = (updatedSrc: SourceArea) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before modifying a Source Area.');
      return;
    }
    if (!isTwinInProgress && elapsedTwinSeconds === 0) {
      baselinePopulationsRef.current[updatedSrc.id] = updatedSrc.population;
    } else {
      baselinePopulationsRef.current[updatedSrc.id] = Math.max(
        baselinePopulationsRef.current[updatedSrc.id] ?? 0,
        updatedSrc.population
      );
    }
    setSourceAreas((prev) => prev.map((s) => (s.id === updatedSrc.id ? updatedSrc : s)));
    setHasPendingTopologyChanges(true);

    // Recalculate total remaining across active sources
    const newTotalRem = sourceAreas
      .map((s) => (s.id === updatedSrc.id ? updatedSrc : s))
      .filter((s) => !s.disabled)
      .reduce((acc, s) => acc + s.population, 0);
    setTotalRemainingAtSource(newTotalRem);

    appendLog(
      'INFO',
      `Modified Source Area "${updatedSrc.name}" (Remaining people set to ${updatedSrc.population.toLocaleString()}). Routes will recompute on restart.`,
      elapsedTwinSeconds
    );
  };

  const handleToggleDisableSourceArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before disabling/enabling a Source Area.');
      return;
    }
    const src = sourceAreas.find((s) => s.id === id);
    if (!src) return;

    const nextDisabled = !src.disabled;
    const nextSources = sourceAreas.map((s) =>
      s.id === id ? { ...s, disabled: nextDisabled } : s
    );
    setSourceAreas(nextSources);
    setHasPendingTopologyChanges(true);

    // Update total remaining across active sources while paused
    const nextTotalRemaining = nextSources
      .filter((s) => !s.disabled)
      .reduce((acc, s) => acc + s.population, 0);
    setTotalRemainingAtSource(nextTotalRemaining);

    appendLog(
      nextDisabled ? 'WARN' : 'INFO',
      nextDisabled
        ? `Disabled Source Area "${src.name}" — excluded from evacuation routing and twin simulation.`
        : `Re-enabled Source Area "${src.name}" for evacuation routing and twin simulation.`,
      elapsedTwinSeconds
    );
  };

  const handleDeleteSourceArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before removing a Source Area.');
      return;
    }
    delete baselinePopulationsRef.current[id];
    const target = sourceAreas.find((s) => s.id === id);
    const nextSources = sourceAreas.filter((s) => s.id !== id);
    const nextRoutes = computedRoutes.filter((r) => r.sourceId !== id);
    const nextClusters = clusters.filter((c) => c.sourceId !== id);
    const nextPickups = pickupStates.filter((p) => p.sourceId !== id);
    const nextVehicles = vehicles.filter((v) => v.sourceId !== id);

    setSourceAreas(nextSources);
    setComputedRoutes(nextRoutes);
    setClusters(nextClusters);
    setPickupStates(nextPickups);
    setVehicles(nextVehicles);
    if (selectedEntityId === id) {
      setSelectedEntityId(null);
    }

    const occMap: Record<string, number> = {};
    targetAreas.forEach((t) => {
      occMap[t.id] = t.currentOccupancy;
    });

    setHeatmapPoints(
      generateHeatmapFromState(
        nextClusters,
        nextPickups,
        nextVehicles,
        targetAreas,
        occMap
      )
    );

    const nextTotalRemaining = nextSources
      .filter((s) => !s.disabled)
      .reduce((acc, s) => acc + s.population, 0);
    const nextWaitingInQueues = nextPickups.reduce((acc, p) => acc + p.waitingPopulation, 0);
    const nextBoarding = nextVehicles
      .filter((v) => v.status === 'waiting_for_80_pct')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);
    const nextInTransit = nextVehicles
      .filter((v) => v.status === 'to_target' || v.status === 'unloading')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);

    setTotalRemainingAtSource(nextTotalRemaining);
    setTotalWaitingAtPickups(nextWaitingInQueues + nextBoarding);
    setTotalInTransit(nextInTransit);

    if (elapsedTwinSeconds === 0) {
      setTelemetryStats(createInitialTelemetryStats(nextSources, nextClusters));
    }

    setHasPendingTopologyChanges(true);
    appendLog(
      'WARN',
      `Removed Source Area "${target?.name || id}" from twin configuration and map.`,
      elapsedTwinSeconds
    );
  };

  const handleAddTargetArea = (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before adding a Target Area.');
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
      elapsedTwinSeconds
    );
  };

  const handleUpdateTargetArea = (updatedTgt: TargetArea) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before modifying a Target Area.');
      return;
    }
    setTargetAreas((prev) => prev.map((t) => (t.id === updatedTgt.id ? updatedTgt : t)));
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Modified Target Shelter "${updatedTgt.name}". Routes will recompute on restart.`,
      elapsedTwinSeconds
    );
  };

  const handleToggleDisableTargetArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before disabling/enabling a Target Area.');
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
      elapsedTwinSeconds
    );
  };

  const handleDeleteTargetArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before removing a Target Area.');
      return;
    }
    const target = targetAreas.find((t) => t.id === id);
    const nextTargets = targetAreas.filter((t) => t.id !== id);
    const nextRoutes = computedRoutes.filter((r) => r.targetId !== id);
    const nextPickups = pickupStates.filter((p) => p.targetId !== id);
    const nextVehicles = vehicles.filter(
      (v) => !(v.targetId === id && (v.currentOccupancy === 0 || v.status === 'unloading'))
    );

    setTargetAreas(nextTargets);
    setComputedRoutes(nextRoutes);
    setPickupStates(nextPickups);
    setVehicles(nextVehicles);
    if (selectedEntityId === id) {
      setSelectedEntityId(null);
    }

    const occMap: Record<string, number> = {};
    nextTargets.forEach((t) => {
      occMap[t.id] = t.currentOccupancy;
    });

    setHeatmapPoints(
      generateHeatmapFromState(
        clusters,
        nextPickups,
        nextVehicles,
        nextTargets,
        occMap
      )
    );

    const nextTotalEvacuated = nextTargets.reduce((acc, t) => acc + t.currentOccupancy, 0);
    const nextWaitingInQueues = nextPickups.reduce((acc, p) => acc + p.waitingPopulation, 0);
    const nextBoarding = nextVehicles
      .filter((v) => v.status === 'waiting_for_80_pct')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);
    const nextInTransit = nextVehicles
      .filter((v) => v.status === 'to_target' || v.status === 'unloading')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);

    setTotalEvacuated(nextTotalEvacuated);
    setTotalWaitingAtPickups(nextWaitingInQueues + nextBoarding);
    setTotalInTransit(nextInTransit);

    setHasPendingTopologyChanges(true);
    appendLog(
      'WARN',
      `Removed Target Area "${target?.name || id}" from twin configuration and map.`,
      elapsedTwinSeconds
    );
  };

  const handleAddAvoidArea = (avoid: Omit<AvoidArea, 'id'>) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before adding an Avoid Area.');
      return;
    }
    const newAvoid: AvoidArea = { ...avoid, id: `avoid-${Date.now()}`, disabled: false };
    setAvoidAreas((prev) => [...prev, newAvoid]);
    setHasPendingTopologyChanges(true);
    appendLog(
      'WARN',
      `Defined Avoid Area "${newAvoid.name}". Routes will detour around it on restart.`,
      elapsedTwinSeconds
    );
  };

  const handleUpdateAvoidArea = (updatedAvoid: AvoidArea) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before modifying an Avoid Area.');
      return;
    }
    setAvoidAreas((prev) => prev.map((a) => (a.id === updatedAvoid.id ? updatedAvoid : a)));
    setHasPendingTopologyChanges(true);
    appendLog('INFO', `Modified Avoid Area "${updatedAvoid.name}".`, elapsedTwinSeconds);
  };

  const handleToggleDisableAvoidArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before disabling/enabling an Avoid Area.');
      return;
    }
    const avoid = avoidAreas.find((a) => a.id === id);
    if (!avoid) return;

    const nextDisabled = !avoid.disabled;
    setAvoidAreas((prev) =>
      prev.map((a) => (a.id === id ? { ...a, disabled: nextDisabled } : a))
    );
    setHasPendingTopologyChanges(true);

    appendLog(
      nextDisabled ? 'WARN' : 'INFO',
      nextDisabled
        ? `Disabled Avoid Area "${avoid.name}" — routes may now pass through this zone on recomputation.`
        : `Re-enabled Avoid Area "${avoid.name}" — strict routing exclusion active.`,
      elapsedTwinSeconds
    );
  };

  const handleDeleteAvoidArea = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before removing an Avoid Area.');
      return;
    }
    const target = avoidAreas.find((a) => a.id === id);
    setAvoidAreas((prev) => prev.filter((a) => a.id !== id));
    if (selectedEntityId === id) {
      setSelectedEntityId(null);
    }
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Removed Avoid Area "${target?.name || id}" from twin configuration and map.`,
      elapsedTwinSeconds
    );
  };

  const handleAddVehicleFleet = (fleet: Omit<VehicleFleet, 'id'>) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before adding a Vehicle Fleet.');
      return;
    }
    const newFleet: VehicleFleet = { ...fleet, id: `veh-${Date.now()}` };
    setVehicleFleets((prev) => [...prev, newFleet]);
    setHasPendingTopologyChanges(true);
    appendLog(
      'INFO',
      `Added Vehicle Fleet "${newFleet.name}" (${newFleet.count}x ${newFleet.type}, ${newFleet.capacityPerUnit} seats/unit, ${newFleet.transitSpeedKmh ?? 25} km/h transit speed, ${newFleet.loadUnloadTimePerPersonSeconds}s/person load/unload). Will be deployed on twin restart.`,
      elapsedTwinSeconds
    );
  };

  const handleUpdateVehicleFleet = (updatedFleet: VehicleFleet) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before modifying a Vehicle Fleet.');
      return;
    }
    const prevFleet = vehicleFleets.find((v) => v.id === updatedFleet.id);
    const topologyChanged =
      !prevFleet ||
      prevFleet.count !== updatedFleet.count ||
      prevFleet.location[0] !== updatedFleet.location[0] ||
      prevFleet.location[1] !== updatedFleet.location[1];

    const speedKmh = Math.max(1, updatedFleet.transitSpeedKmh ?? 25);
    const speedMps = (speedKmh * 1000) / 3600;

    setVehicleFleets((prev) =>
      prev.map((v) => (v.id === updatedFleet.id ? updatedFleet : v))
    );
    setVehicles((prev) =>
      prev.map((v) =>
        v.fleetId === updatedFleet.id
          ? {
              ...v,
              capacityPerUnit: updatedFleet.capacityPerUnit,
              maxCapacity: Math.max(
                v.currentOccupancy,
                v.unitCount * updatedFleet.capacityPerUnit
              ),
              loadUnloadTimePerPersonSeconds: updatedFleet.loadUnloadTimePerPersonSeconds,
              transitSpeedKmh: speedKmh,
              speedMps,
            }
          : v
      )
    );
    if (topologyChanged) {
      setHasPendingTopologyChanges(true);
    }
    appendLog(
      'INFO',
      `Modified Vehicle Fleet "${updatedFleet.name}" (${updatedFleet.count}x ${updatedFleet.type}, ${updatedFleet.capacityPerUnit} seats/unit, ${speedKmh} km/h transit speed, ${updatedFleet.loadUnloadTimePerPersonSeconds}s/person load/unload).`,
      elapsedTwinSeconds
    );
  };

  const handleDeleteVehicleFleet = (id: string) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before removing a Vehicle Fleet.');
      return;
    }
    const target = vehicleFleets.find((v) => v.id === id);
    setVehicleFleets((prev) => prev.filter((v) => v.id !== id));
    setHasPendingTopologyChanges(true);
    appendLog('WARN', `Removed Vehicle Fleet "${target?.name || id}".`, elapsedTwinSeconds);
  };

  // Drawing Handlers
  const handleStartDrawing = (type: 'source' | 'target' | 'avoid' | 'vehicle') => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before drawing or placing entities.');
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

  // Space Data: Google Earth Engine Sentinel-2 Optical RGB State & Handlers
  const computeSentinel2DateRange = (
    currentDateStr: string,
    period: Sentinel2AggregationPeriod
  ): [string, string] => {
    const parts = currentDateStr.split('-').map(Number);
    const endDate =
      parts.length === 3 && !parts.some(isNaN)
        ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
        : new Date();

    const startDate = new Date(endDate.getTime());

    switch (period) {
      case 'last week':
        startDate.setUTCDate(startDate.getUTCDate() - 7);
        break;
      case 'last 2 weeks':
        startDate.setUTCDate(startDate.getUTCDate() - 14);
        break;
      case 'last month':
        startDate.setUTCMonth(startDate.getUTCMonth() - 1);
        break;
      case 'last three months':
        startDate.setUTCMonth(startDate.getUTCMonth() - 3);
        break;
      case 'last six months':
        startDate.setUTCMonth(startDate.getUTCMonth() - 6);
        break;
      case 'last year':
        startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
        break;
    }

    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    return [fmt(startDate), fmt(endDate)];
  };

  const initialCurrentDate = new Date().toISOString().slice(0, 10);
  const initialDateRange = computeSentinel2DateRange(initialCurrentDate, 'last month');

  const [sentinel2Layer, setSentinel2Layer] = useState<Sentinel2LayerState>({
    active: false,
    visible: true,
    tileUrl: null,
    imageCount: 0,
    poi: null,
    currentDate: initialCurrentDate,
    aggregationPeriod: 'last month',
    visParams: {
      bands: ['B4', 'B3', 'B2'],
      min: 0,
      max: 3000,
      gamma: 1.4,
    },
    collection: 'COPERNICUS/S2_SR_HARMONIZED',
    dateRange: initialDateRange,
    opacity: 0.88,
  });
  const [isLoadingSentinel2, setIsLoadingSentinel2] = useState<boolean>(false);

  const [sentinel1Layer, setSentinel1Layer] = useState<Sentinel1LayerState>({
    active: false,
    visible: true,
    tileUrl: null,
    imageCount: 0,
    poi: null,
    visParams: {
      bands: ['VV', 'VH', 'VV/VH'],
      min: [-25, -30, 0],
      max: [0, -5, 1],
    },
    collection: 'COPERNICUS/S1_GRD',
    dateRange: initialDateRange,
    opacity: 0.88,
  });
  const [isLoadingSentinel1, setIsLoadingSentinel1] = useState<boolean>(false);

  const liveViewportPoiRef = useRef<[number, number]>(mapCenter);

  useEffect(() => {
    liveViewportPoiRef.current = mapCenter;
  }, [mapCenter]);

  const handleChangeSentinel2CurrentDate = (date: string) => {
    const newRange = computeSentinel2DateRange(date, sentinel2Layer.aggregationPeriod);
    setSentinel2Layer((prev) => ({
      ...prev,
      currentDate: date,
      dateRange: newRange,
    }));
    setSentinel1Layer((prev) => ({
      ...prev,
      dateRange: newRange,
    }));
  };

  const handleChangeSentinel2AggregationPeriod = (period: Sentinel2AggregationPeriod) => {
    const newRange = computeSentinel2DateRange(sentinel2Layer.currentDate, period);
    setSentinel2Layer((prev) => ({
      ...prev,
      aggregationPeriod: period,
      dateRange: newRange,
    }));
    setSentinel1Layer((prev) => ({
      ...prev,
      dateRange: newRange,
    }));
  };

  const handleFetchSentinel2Data = async () => {
    const poi = liveViewportPoiRef.current || mapCenter;
    const [startDate, endDate] = computeSentinel2DateRange(
      sentinel2Layer.currentDate,
      sentinel2Layer.aggregationPeriod
    );

    setIsLoadingSentinel2(true);
    appendLog(
      'INFO',
      `Space Data: Selected aggregation period "${sentinel2Layer.aggregationPeriod}" (current date: ${sentinel2Layer.currentDate}) -> Derived Sentinel-2 dates: ${startDate} to ${endDate}. Calling Google Earth Engine...`,
      elapsedTwinSeconds
    );

    try {
      const response = await fetch('/api/space-data/sentinel2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: poi[0],
          lng: poi[1],
          startDate,
          endDate,
        }),
      });
      const data = await response.json();

      if (data.ok && data.tileUrl) {
        const usedRange: [string, string] = data.dateRange || [startDate, endDate];
        setSentinel2Layer((prev) => ({
          ...prev,
          active: true,
          visible: true,
          tileUrl: data.tileUrl,
          imageCount: data.imageCount ?? 0,
          poi: data.poi || poi,
          visParams: data.visParams || prev.visParams,
          collection: data.collection || prev.collection,
          dateRange: usedRange,
        }));
        appendLog(
          'INFO',
          `Google Earth Engine: Rendered Sentinel-2 Optical RGB median composite for dates ${usedRange[0]} to ${usedRange[1]} (derived from "${sentinel2Layer.aggregationPeriod}", ${data.imageCount} scenes, RGB bands B4/B3/B2).`,
          elapsedTwinSeconds
        );
      } else {
        appendLog(
          'WARN',
          `Google Earth Engine Sentinel-2 query failed for dates ${startDate} to ${endDate}: ${data.error || 'Unknown server error'}`,
          elapsedTwinSeconds
        );
      }
    } catch (err) {
      appendLog(
        'WARN',
        `Failed to reach server-side Google Earth Engine endpoint: ${String(err)}`,
        elapsedTwinSeconds
      );
    } finally {
      setIsLoadingSentinel2(false);
    }
  };

  const handleFetchSentinel1Data = async () => {
    const poi = liveViewportPoiRef.current || mapCenter;
    const [startDate, endDate] = computeSentinel2DateRange(
      sentinel2Layer.currentDate,
      sentinel2Layer.aggregationPeriod
    );

    setIsLoadingSentinel1(true);
    appendLog(
      'INFO',
      `Space Data: Selected aggregation period "${sentinel2Layer.aggregationPeriod}" (current date: ${sentinel2Layer.currentDate}) -> Derived Sentinel-1 SAR dates: ${startDate} to ${endDate}. Calling Google Earth Engine (COPERNICUS/S1_GRD)...`,
      elapsedTwinSeconds
    );

    try {
      const response = await fetch('/api/space-data/sentinel1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: poi[0],
          lng: poi[1],
          startDate,
          endDate,
        }),
      });
      const data = await response.json();

      if (data.ok && data.tileUrl) {
        const usedRange: [string, string] = data.dateRange || [startDate, endDate];
        setSentinel1Layer((prev) => ({
          ...prev,
          active: true,
          visible: true,
          tileUrl: data.tileUrl,
          imageCount: data.imageCount ?? 0,
          poi: data.poi || poi,
          visParams: data.visParams || prev.visParams,
          collection: data.collection || prev.collection,
          dateRange: usedRange,
        }));
        appendLog(
          'INFO',
          `Google Earth Engine: Rendered Sentinel-1 SAR false-color composite (COPERNICUS/S1_GRD, bands VV, VH, VV/VH) for dates ${usedRange[0]} to ${usedRange[1]} (derived from "${sentinel2Layer.aggregationPeriod}", ${data.imageCount} scenes).`,
          elapsedTwinSeconds
        );
      } else {
        appendLog(
          'WARN',
          `Google Earth Engine Sentinel-1 SAR query failed for dates ${startDate} to ${endDate}: ${data.error || 'Unknown server error'}`,
          elapsedTwinSeconds
        );
      }
    } catch (err) {
      appendLog(
        'WARN',
        `Failed to reach server-side Google Earth Engine endpoint: ${String(err)}`,
        elapsedTwinSeconds
      );
    } finally {
      setIsLoadingSentinel1(false);
    }
  };

  const [glofasForecast, setGlofasForecast] = useState<GlofasForecastState>({
    active: false,
    cached: false,
    date: initialCurrentDate,
    center: null,
    radiusKm: 100,
    geotiffPath: null,
    clipMax: 80,
    overlays: [],
  });
  const [isLoadingGlofas, setIsLoadingGlofas] = useState<boolean>(false);

  // On application startup, delete every file from previous days in tmp_downloads
  useEffect(() => {
    fetch('/api/cems-glofas/cleanup')
      .then((r) => r.json())
      .then((res) => {
        if (res?.deletedFiles?.length > 0) {
          appendLog(
            'INFO',
            `CEMS GloFAS Startup Cleanup: Deleted ${res.deletedFiles.length} file(s) from previous days in tmp_downloads (${res.deletedFiles.join(', ')}).`,
            0
          );
        }
      })
      .catch(() => {
        // Non-fatal if running static build without dev server middleware
      });
  }, []);

  const handleFetchGlofasForecast = async () => {
    const poi = liveViewportPoiRef.current || mapCenter;
    const targetDate = sentinel2Layer.currentDate;

    setIsLoadingGlofas(true);
    appendLog(
      'INFO',
      `CEMS Early Warning River Discharge Prediction: Requesting 24h, 48h, and 72h forecasts for date ${targetDate} (100 km radius around [${poi[0].toFixed(4)}, ${poi[1].toFixed(4)}]) via scripts/download_glofas.py...`,
      elapsedTwinSeconds
    );

    try {
      const response = await fetch('/api/cems-glofas/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: poi[0],
          lng: poi[1],
          date: targetDate,
          radius: 100000,
        }),
      });
      const data = await response.json();

      if (data.ok && Array.isArray(data.overlays)) {
        const mappedOverlays: GlofasForecastOverlay[] = data.overlays.map(
          (ov: Omit<GlofasForecastOverlay, 'visible' | 'opacity'>) => ({
            ...ov,
            visible: true,
            opacity: 0.85,
          })
        );

        setGlofasForecast({
          active: true,
          cached: Boolean(data.cached),
          date: data.date || targetDate,
          center: data.center || poi,
          radiusKm: data.radiusKm || 100,
          geotiffPath: data.geotiffPath || 'tmp_downloads/',
          clipMax: data.clipMax ?? 80,
          overlays: mappedOverlays,
        });

        if (data.deletedFiles?.length > 0) {
          appendLog(
            'INFO',
            `CEMS GloFAS Cleanup: Deleted ${data.deletedFiles.length} file(s) from previous days in tmp_downloads.`,
            elapsedTwinSeconds
          );
        }

        appendLog(
          'INFO',
          `CEMS Early Warning River Discharge Prediction: ${
            data.cached
              ? `Reused existing GeoTIFF for today (${data.geotiffPath}) to spare download time.`
              : `Downloaded GRIB2 & converted to 3-band GeoTIFF (${data.geotiffPath}).`
          } Added 3 map overlays (24h, 48h, 72h forecasts: pixels < 10 m³/s fully transparent, pixels > 10 m³/s clipped at 80 with White -> Red color map and controlled by transparency sliders).`,
          elapsedTwinSeconds
        );
      } else {
        appendLog(
          'WARN',
          `CEMS GloFAS forecast download failed: ${data.error || 'Unknown error'}`,
          elapsedTwinSeconds
        );
      }
    } catch (err) {
      appendLog(
        'WARN',
        `Failed to execute CEMS GloFAS forecast endpoint: ${String(err)}`,
        elapsedTwinSeconds
      );
    } finally {
      setIsLoadingGlofas(false);
    }
  };

  const handleToggleGlofasOverlayVisibility = (band: number) => {
    setGlofasForecast((prev) => ({
      ...prev,
      overlays: prev.overlays.map((ov) =>
        ov.band === band ? { ...ov, visible: !ov.visible } : ov
      ),
    }));
  };

  const handleChangeGlofasOverlayOpacity = (band: number, opacity: number) => {
    setGlofasForecast((prev) => ({
      ...prev,
      overlays: prev.overlays.map((ov) => (ov.band === band ? { ...ov, opacity } : ov)),
    }));
  };

  const handleToggleSentinel2Visibility = () => {
    setSentinel2Layer((prev) => ({ ...prev, visible: !prev.visible }));
  };

  const handleChangeSentinel2Opacity = (opacity: number) => {
    setSentinel2Layer((prev) => ({ ...prev, opacity }));
  };

  const handleToggleSentinel1Visibility = () => {
    setSentinel1Layer((prev) => ({ ...prev, visible: !prev.visible }));
  };

  const handleChangeSentinel1Opacity = (opacity: number) => {
    setSentinel1Layer((prev) => ({ ...prev, opacity }));
  };

  // Brussels Metro Handlers
  const handleToggleBrusselsMetroNetworkOverlay = () => {
    setBrusselsMetroConfig((prev) => {
      const next = !prev.showNetworkOverlay;
      appendLog(
        'INFO',
        next
          ? `Brussels Metro Network overlay enabled on map (${brusselsMetroNetwork.lines.filter((l) => l.variant === 1).length} lines, ${brusselsMetroNetwork.stations.length} stations).`
          : 'Brussels Metro Network overlay hidden on map.',
        elapsedTwinSeconds
      );
      return { ...prev, showNetworkOverlay: next };
    });
  };

  const handleToggleUseBrusselsMetroForEvacuation = (checked: boolean) => {
    if (isTwinning) {
      appendLog('WARN', 'Pause twin before toggling Brussels Metro evacuation.');
      return;
    }
    setBrusselsMetroConfig((prev) => ({ ...prev, useForEvacuation: checked }));
    if (elapsedTwinSeconds > 0) {
      setHasPendingTopologyChanges(true);
    }
    appendLog(
      'INFO',
      checked
        ? `Brussels Metro Evacuation enabled: ${brusselsMetroConfig.trainCount} train(s) × ${brusselsMetroConfig.trainCapacity} pax across ${metroCorridors.length} underground corridor(s) (${metroCorridors.map((c) => `${c.sourceStation.name_fr} → ${c.targetStation.name_fr}`).join(', ')}).`
        : 'Brussels Metro Evacuation disabled.',
      elapsedTwinSeconds
    );
  };

  const handleChangeBrusselsMetroTrainCount = (count: number) => {
    if (isTwinning) return;
    const validCount = Math.max(1, Math.round(count));
    setBrusselsMetroConfig((prev) => ({ ...prev, trainCount: validCount }));
    if (elapsedTwinSeconds > 0) {
      setHasPendingTopologyChanges(true);
    }
  };

  const handleChangeBrusselsMetroTrainCapacity = (capacity: number) => {
    if (isTwinning) return;
    const validCap = Math.max(1, Math.round(capacity));
    setBrusselsMetroConfig((prev) => ({ ...prev, trainCapacity: validCap }));
    if (elapsedTwinSeconds > 0) {
      setHasPendingTopologyChanges(true);
    }
  };

  return (
    <div className="cockpit-grid-layout">
      {/* 1. LEFT SIDE PANEL (25% Width x 100% Height, Collapsible) */}
      <LeftControlPanel
        isCollapsed={isLeftPanelCollapsed}
        onToggleCollapse={() => setIsLeftPanelCollapsed((prev) => !prev)}
        presetScenarios={Object.values(presetScenarios)}
        selectedPreset={selectedPreset}
        onSelectPreset={handleSelectPreset}
        showLabels={showLabels}
        onToggleShowLabels={() => setShowLabels((prev) => !prev)}
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        avoidAreas={avoidAreas}
        vehicleFleets={vehicleFleets}
        remainingBySource={remainingBySource}
        onAddSourceArea={handleAddSourceArea}
        onUpdateSourceArea={handleUpdateSourceArea}
        onToggleDisableSourceArea={handleToggleDisableSourceArea}
        onDeleteSourceArea={handleDeleteSourceArea}
        onAddTargetArea={handleAddTargetArea}
        onUpdateTargetArea={handleUpdateTargetArea}
        onToggleDisableTargetArea={handleToggleDisableTargetArea}
        onDeleteTargetArea={handleDeleteTargetArea}
        onAddAvoidArea={handleAddAvoidArea}
        onUpdateAvoidArea={handleUpdateAvoidArea}
        onToggleDisableAvoidArea={handleToggleDisableAvoidArea}
        onDeleteAvoidArea={handleDeleteAvoidArea}
        onAddVehicleFleet={handleAddVehicleFleet}
        onUpdateVehicleFleet={handleUpdateVehicleFleet}
        onDeleteVehicleFleet={handleDeleteVehicleFleet}
        routingAlgorithm={routingAlgorithm}
        onChangeRoutingAlgorithm={setRoutingAlgorithm}
        onComputeRoutes={handleComputeRoutes}
        onStopComputingRoutes={handleStopComputingRoutes}
        isComputingRoutes={isComputingRoutes}
        hasComputedRoutes={computedRoutes.length > 0}
        onRunTwin={handleRunTwin}
        onStopTwin={handleStopTwin}
        onResetTwin={handleResetTwin}
        onOpenTwinReport={() => {
          if (!isTwinning) {
            setIsTwinReportOpen(true);
          }
        }}
        isTwinning={isTwinning}
        isTwinInProgress={isTwinInProgress}
        twinSpeed={twinSpeed}
        onChangeTwinSpeed={setTwinSpeed}
        activeDrawMode={activeDrawMode}
        onStartDrawing={handleStartDrawing}
        pendingDrawnPolygon={pendingDrawnPolygon}
        pendingPlacedPoint={pendingPlacedPoint}
        onClearPendingGeometry={handleClearPendingGeometry}
        selectedEntityId={selectedEntityId}
        onSelectEntity={setSelectedEntityId}
        sentinel2Layer={sentinel2Layer}
        isLoadingSentinel2={isLoadingSentinel2}
        onFetchSentinel2Data={handleFetchSentinel2Data}
        onChangeSentinel2CurrentDate={handleChangeSentinel2CurrentDate}
        onChangeSentinel2AggregationPeriod={handleChangeSentinel2AggregationPeriod}
        onToggleSentinel2Visibility={handleToggleSentinel2Visibility}
        onChangeSentinel2Opacity={handleChangeSentinel2Opacity}
        sentinel1Layer={sentinel1Layer}
        isLoadingSentinel1={isLoadingSentinel1}
        onFetchSentinel1Data={handleFetchSentinel1Data}
        onToggleSentinel1Visibility={handleToggleSentinel1Visibility}
        onChangeSentinel1Opacity={handleChangeSentinel1Opacity}
        glofasForecast={glofasForecast}
        isLoadingGlofas={isLoadingGlofas}
        onFetchGlofasForecast={handleFetchGlofasForecast}
        onToggleGlofasOverlayVisibility={handleToggleGlofasOverlayVisibility}
        onChangeGlofasOverlayOpacity={handleChangeGlofasOverlayOpacity}
        hasBrusselsAreas={hasBrusselsAreas}
        brusselsMetroConfig={brusselsMetroConfig}
        sourceMetroStations={sourceMetroStations}
        targetMetroStations={targetMetroStations}
        metroCorridors={metroCorridors}
        onToggleBrusselsMetroNetworkOverlay={handleToggleBrusselsMetroNetworkOverlay}
        onToggleUseBrusselsMetroForEvacuation={handleToggleUseBrusselsMetroForEvacuation}
        onChangeBrusselsMetroTrainCount={handleChangeBrusselsMetroTrainCount}
        onChangeBrusselsMetroTrainCapacity={handleChangeBrusselsMetroTrainCapacity}
      />

      {/* 2. CENTER AREA COLUMN (Dynamic Flex Width) -> TOP MAP (Flex Height) + BOTTOM LOGS (Collapsible) */}
      <main className="cockpit-center-column">
        <div className="cockpit-map-area" id="center-osm-map-panel">
          <EvacuationMap
            center={mapCenter}
            zoom={mapZoom}
            showLabels={showLabels}
            sourceAreas={sourceAreas}
            targetAreas={targetAreas}
            avoidAreas={avoidAreas}
            vehicleFleets={vehicleFleets}
            computedRoutes={computedRoutes}
            pickupStates={pickupStates}
            vehicles={vehicles}
            clusters={clusters}
            heatmapPoints={heatmapPoints}
            isTwinning={isTwinning}
            isComputingRoutes={isComputingRoutes}
            onStopComputingRoutes={handleStopComputingRoutes}
            activeDrawMode={activeDrawMode}
            onUpdateDrawMode={setActiveDrawMode}
            onFinishDrawingPolygon={handleFinishDrawingPolygon}
            onFinishPlacingVehiclePoint={handleFinishPlacingVehiclePoint}
            selectedEntityId={selectedEntityId}
            onSelectEntity={setSelectedEntityId}
            sentinel2Layer={sentinel2Layer}
            sentinel1Layer={sentinel1Layer}
            glofasForecast={glofasForecast}
            onMapViewportChange={(c) => {
              liveViewportPoiRef.current = c;
            }}
            showBrusselsMetroNetwork={hasBrusselsAreas && brusselsMetroConfig.showNetworkOverlay}
            brusselsMetroLines={brusselsMetroNetwork.lines}
            brusselsMetroStations={brusselsMetroNetwork.stations}
            activeMetroCorridors={activeMetroEvacuationOptions ? metroCorridors : []}
          />
        </div>

        <BottomLogPanel
          logs={logs}
          onClearLogs={() => setLogs([])}
          isCollapsed={isBottomPanelCollapsed}
          onToggleCollapse={() => setIsBottomPanelCollapsed((prev) => !prev)}
        />
      </main>

      {/* 3. RIGHT SIDE PANEL (25% Width x 100% Height, Collapsible) */}
      <RightTelemetryPanel
        isCollapsed={isRightPanelCollapsed}
        onToggleCollapse={() => setIsRightPanelCollapsed((prev) => !prev)}
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        vehicleFleets={vehicleFleets}
        computedRoutes={computedRoutes}
        pickupStates={pickupStates}
        elapsedTwinSeconds={elapsedTwinSeconds}
        totalEvacuated={totalEvacuated}
        totalInTransit={totalInTransit}
        totalRemainingAtSource={totalRemainingAtSource}
        totalWaitingAtPickups={totalWaitingAtPickups}
        isTwinning={isTwinning}
      />

      {/* Centered Twin Report Modal (enabled only when twin is paused) */}
      <TwinReportModal
        isOpen={isTwinReportOpen && !isTwinning}
        onClose={() => setIsTwinReportOpen(false)}
        scenarioName={
          selectedPreset === 'custom'
            ? 'Custom Scenario'
            : presetScenarios[selectedPreset]?.name ?? selectedPreset
        }
        elapsedTwinSeconds={elapsedTwinSeconds}
        twinSpeed={twinSpeed}
        sourceAreas={sourceAreas}
        targetAreas={targetAreas}
        avoidAreas={avoidAreas}
        vehicleFleets={vehicleFleets}
        computedRoutes={computedRoutes}
        clusters={clusters}
        pickupStates={pickupStates}
        vehicles={vehicles}
        telemetryStats={telemetryStats}
        totalEvacuated={totalEvacuated}
        totalInTransit={totalInTransit}
        totalRemainingAtSource={totalRemainingAtSource}
        totalWaitingAtPickups={totalWaitingAtPickups}
      />
    </div>
  );
}

export default App;
