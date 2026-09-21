import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  SimulationTelemetryStats,
  PopulationBehaviorType,
  BehaviorCounts,
} from '../types/evacuation';
import {
  formatMMSS,
  createZeroBehaviorCounts,
  computeBehaviorCountsFromSources,
} from '../services/simulationEngine';
import {
  FileBarChart2,
  X,
  Users,
  Clock,
  MapPin,
  Bus,
  Building2,
  ShieldAlert,
  Download,
  CheckCircle2,
  Activity,
  TrendingUp,
} from 'lucide-react';

interface SimulationReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  scenarioName: string;
  elapsedSimSeconds: number;
  simSpeed: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  clusters: SourceInternalCluster[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  telemetryStats: SimulationTelemetryStats;
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  totalWaitingAtPickups: number;
}

const BEHAVIOR_LABELS: Record<
  PopulationBehaviorType,
  { title: string; subtitle: string; color: string; badgeBg: string }
> = {
  obedient: {
    title: 'Obedient',
    subtitle: 'Direct to Closest Pickup Location',
    color: '#38bdf8',
    badgeBg: 'rgba(56, 189, 248, 0.16)',
  },
  autonomous: {
    title: 'Autonomous',
    subtitle: 'Perimeter Boundary Exploration',
    color: '#fbbf24',
    badgeBg: 'rgba(251, 191, 36, 0.16)',
  },
  random: {
    title: 'Random',
    subtitle: '2D Brownian Motion Diffusion',
    color: '#f472b6',
    badgeBg: 'rgba(244, 114, 182, 0.16)',
  },
};

export const SimulationReportModal: React.FC<SimulationReportModalProps> = ({
  isOpen,
  onClose,
  scenarioName,
  elapsedSimSeconds,
  simSpeed,
  sourceAreas,
  targetAreas,
  noGoAreas,
  vehicleFleets,
  computedRoutes,
  clusters,
  pickupStates,
  vehicles,
  telemetryStats,
  totalEvacuated,
  totalInTransit,
}) => {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const behaviors: PopulationBehaviorType[] = ['obedient', 'autonomous', 'random'];

  // 1. Compute live population by behavior in each state
  const movingInZoneByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  clusters
    .filter((c) => c.status === 'moving_in_zone' && c.headcount > 0)
    .forEach((c) => {
      movingInZoneByBehavior[c.behavior] += c.headcount;
    });

  const waitingInQueueByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  pickupStates.forEach((p) => {
    if (p.waitingByBehavior) {
      waitingInQueueByBehavior.obedient += p.waitingByBehavior.obedient || 0;
      waitingInQueueByBehavior.autonomous += p.waitingByBehavior.autonomous || 0;
      waitingInQueueByBehavior.random += p.waitingByBehavior.random || 0;
    }
  });

  const boardingInVehiclesByBehavior: BehaviorCounts = createZeroBehaviorCounts();
  const inTransitByBehavior: BehaviorCounts = createZeroBehaviorCounts();

  vehicles.forEach((v) => {
    const occ = v.occupancyByBehavior || createZeroBehaviorCounts();
    if (v.status === 'waiting_for_80_pct' && v.currentOccupancy > 0) {
      boardingInVehiclesByBehavior.obedient += occ.obedient || 0;
      boardingInVehiclesByBehavior.autonomous += occ.autonomous || 0;
      boardingInVehiclesByBehavior.random += occ.random || 0;
    } else if (v.status === 'to_target' && v.currentOccupancy > 0) {
      inTransitByBehavior.obedient += occ.obedient || 0;
      inTransitByBehavior.autonomous += occ.autonomous || 0;
      inTransitByBehavior.random += occ.random || 0;
    }
  });

  // If clusters haven't been initialized yet, derive directly from sourceAreas
  const hasActiveSimulationEntities =
    clusters.length > 0 || totalEvacuated > 0 || totalInTransit > 0;
  const fallbackSourceByBehavior = computeBehaviorCountsFromSources(sourceAreas);

  const waitingAtPickupsByBehavior: BehaviorCounts = {
    obedient: waitingInQueueByBehavior.obedient + boardingInVehiclesByBehavior.obedient,
    autonomous: waitingInQueueByBehavior.autonomous + boardingInVehiclesByBehavior.autonomous,
    random: waitingInQueueByBehavior.random + boardingInVehiclesByBehavior.random,
  };

  const notEvacuatedByBehavior: BehaviorCounts = hasActiveSimulationEntities
    ? {
        obedient:
          movingInZoneByBehavior.obedient +
          waitingAtPickupsByBehavior.obedient +
          inTransitByBehavior.obedient,
        autonomous:
          movingInZoneByBehavior.autonomous +
          waitingAtPickupsByBehavior.autonomous +
          inTransitByBehavior.autonomous,
        random:
          movingInZoneByBehavior.random +
          waitingAtPickupsByBehavior.random +
          inTransitByBehavior.random,
      }
    : fallbackSourceByBehavior;

  const evacuatedByBehavior: BehaviorCounts = telemetryStats?.evacuatedByBehavior || {
    obedient: 0,
    autonomous: 0,
    random: 0,
  };

  const initialByBehavior: BehaviorCounts = {
    obedient: evacuatedByBehavior.obedient + notEvacuatedByBehavior.obedient,
    autonomous: evacuatedByBehavior.autonomous + notEvacuatedByBehavior.autonomous,
    random: evacuatedByBehavior.random + notEvacuatedByBehavior.random,
  };

  const totalNotEvacuated =
    notEvacuatedByBehavior.obedient +
    notEvacuatedByBehavior.autonomous +
    notEvacuatedByBehavior.random;
  const totalInitialPopulation = totalEvacuated + totalNotEvacuated;
  const overallEvacuatedPct =
    totalInitialPopulation > 0 ? (totalEvacuated / totalInitialPopulation) * 100 : 0;
  const overallNotEvacuatedPct =
    totalInitialPopulation > 0 ? (totalNotEvacuated / totalInitialPopulation) * 100 : 0;

  // 2. Mean evacuation time per person (overall and per behavior)
  // Average route transit time as baseline reference when 0 people of a behavior have reached shelter yet
  const avgRouteDurationSec =
    computedRoutes.length > 0
      ? computedRoutes.reduce((acc, r) => acc + r.estimatedDurationSeconds, 0) /
        computedRoutes.length
      : 240;

  const estWalkTimeByBehavior: Record<PopulationBehaviorType, number> = {
    obedient: 115,
    autonomous: 245,
    random: 340,
  };

  const getBehaviorMeanEvacTime = (
    b: PopulationBehaviorType
  ): {
    meanEvacSec: number | null;
    estimatedEvacSec: number;
    meanPickupSec: number | null;
    evacuatedCount: number;
    pickupArrivedCount: number;
  } => {
    const evacCount = evacuatedByBehavior[b] || 0;
    const evacPersonSec = telemetryStats?.evacuatedPersonSecondsByBehavior?.[b] || 0;
    const pickupCount = telemetryStats?.pickupArrivedByBehavior?.[b] || 0;
    const pickupPersonSec = telemetryStats?.pickupArrivalPersonSecondsByBehavior?.[b] || 0;

    const meanEvacSec = evacCount > 0 ? evacPersonSec / evacCount : null;
    const meanPickupSec = pickupCount > 0 ? pickupPersonSec / pickupCount : null;
    const estimatedEvacSec =
      (meanPickupSec !== null ? meanPickupSec : estWalkTimeByBehavior[b]) +
      avgRouteDurationSec +
      90;

    return {
      meanEvacSec,
      estimatedEvacSec,
      meanPickupSec,
      evacuatedCount: evacCount,
      pickupArrivedCount: pickupCount,
    };
  };

  const behaviorTimeStats = {
    obedient: getBehaviorMeanEvacTime('obedient'),
    autonomous: getBehaviorMeanEvacTime('autonomous'),
    random: getBehaviorMeanEvacTime('random'),
  };

  const totalEvacPersonSeconds =
    (telemetryStats?.evacuatedPersonSecondsByBehavior?.obedient || 0) +
    (telemetryStats?.evacuatedPersonSecondsByBehavior?.autonomous || 0) +
    (telemetryStats?.evacuatedPersonSecondsByBehavior?.random || 0);

  const totalEvacTrackedCount =
    evacuatedByBehavior.obedient +
    evacuatedByBehavior.autonomous +
    evacuatedByBehavior.random;

  const overallMeanEvacTimeSec =
    totalEvacTrackedCount > 0 ? totalEvacPersonSeconds / totalEvacTrackedCount : null;

  const totalPickupArrivedCount =
    (telemetryStats?.pickupArrivedByBehavior?.obedient || 0) +
    (telemetryStats?.pickupArrivedByBehavior?.autonomous || 0) +
    (telemetryStats?.pickupArrivedByBehavior?.random || 0);

  const totalPickupPersonSeconds =
    (telemetryStats?.pickupArrivalPersonSecondsByBehavior?.obedient || 0) +
    (telemetryStats?.pickupArrivalPersonSecondsByBehavior?.autonomous || 0) +
    (telemetryStats?.pickupArrivalPersonSecondsByBehavior?.random || 0);

  const overallMeanPickupTimeSec =
    totalPickupArrivedCount > 0 ? totalPickupPersonSeconds / totalPickupArrivedCount : null;

  // 3. Pickup Location metrics & Mean Vehicle Wait Time at each Pickup Location
  const pickupReportRows = pickupStates.map((p) => {
    const activeWaitingVehicles = vehicles.filter(
      (v) =>
        v.assignedPickupId === p.id &&
        v.status === 'waiting_for_80_pct' &&
        v.waitingAtPickupSeconds > 0
    );
    const activeBoardingOccupancy = vehicles
      .filter((v) => v.assignedPickupId === p.id && v.status === 'waiting_for_80_pct')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);
    const inTransitFromPickup = vehicles
      .filter((v) => v.assignedPickupId === p.id && v.status === 'to_target')
      .reduce((acc, v) => acc + v.currentOccupancy, 0);

    const completedDepartures = p.completedDeparturesCount || 0;
    const completedWaitSec = p.totalCompletedVehicleWaitSeconds || 0;
    const activeWaitSecSum = activeWaitingVehicles.reduce(
      (acc, v) => acc + v.waitingAtPickupSeconds,
      0
    );
    const totalWaitObservations = completedDepartures + activeWaitingVehicles.length;

    const meanWaitSeconds =
      totalWaitObservations > 0
        ? (completedWaitSec + activeWaitSecSum) / totalWaitObservations
        : null;

    const avgDepartureLoadPct =
      completedDepartures > 0
        ? ((p.totalDepartureOccupancyRatioSum || 0) / completedDepartures) * 100
        : null;

    return {
      pickup: p,
      evacuatedToShelter: p.evacuatedCount || 0,
      totalBoardedAtPickup: p.totalBoardedCount || 0,
      inTransitFromPickup,
      currentlyWaitingTotal: p.waitingPopulation + activeBoardingOccupancy,
      completedDepartures,
      activeWaitingVehicleCount: activeWaitingVehicles.length,
      meanWaitSeconds,
      maxWaitSeconds: p.maxVehicleWaitSeconds || 0,
      avgDepartureLoadPct,
    };
  });

  // Overall mean vehicle wait time across all pickup locations
  const globalWaitNumer = pickupReportRows.reduce((acc, row) => {
    const obs = row.completedDepartures + row.activeWaitingVehicleCount;
    return acc + (row.meanWaitSeconds !== null ? row.meanWaitSeconds * obs : 0);
  }, 0);
  const globalWaitDenom = pickupReportRows.reduce(
    (acc, row) => acc + row.completedDepartures + row.activeWaitingVehicleCount,
    0
  );
  const overallMeanVehicleWaitSec =
    globalWaitDenom > 0 ? globalWaitNumer / globalWaitDenom : null;

  // 4. Additional Valuable Operational Metrics
  const elapsedMinutes = elapsedSimSeconds / 60;
  const evacuationRatePerMin =
    elapsedMinutes > 0 ? totalEvacuated / elapsedMinutes : 0;
  const totalBoardedAllPickups = pickupStates.reduce(
    (acc, p) => acc + (p.totalBoardedCount || 0),
    0
  );
  const boardingRatePerMin =
    elapsedMinutes > 0 ? totalBoardedAllPickups / elapsedMinutes : 0;

  const estimatedRemainingMinutes =
    evacuationRatePerMin > 0
      ? totalNotEvacuated / evacuationRatePerMin
      : boardingRatePerMin > 0
      ? totalNotEvacuated / boardingRatePerMin
      : null;

  const activeTargetShelters = targetAreas.filter((t) => !t.disabled);
  const totalShelterCapacity = activeTargetShelters.reduce((acc, t) => acc + t.capacity, 0);
  const shelterCapacityUtilizationPct =
    totalShelterCapacity > 0 ? (totalEvacuated / totalShelterCapacity) * 100 : 0;

  const detourRoutesCount = computedRoutes.filter((r) => r.isDetour).length;

  // Export handlers (JSON & CSV)
  const handleDownloadJsonReport = () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      scenarioName,
      elapsedSimulationSeconds: Math.round(elapsedSimSeconds),
      elapsedSimulationFormatted: formatMMSS(elapsedSimSeconds),
      playbackSpeedMultiplier: simSpeed,
      summary: {
        totalInitialPopulation,
        peopleEvacuatedToShelter: totalEvacuated,
        peopleStillNotEvacuated: totalNotEvacuated,
        evacuationCompletionPercent: Number(overallEvacuatedPct.toFixed(2)),
        meanEvacuationTimeSeconds:
          overallMeanEvacTimeSec !== null ? Number(overallMeanEvacTimeSec.toFixed(1)) : null,
        meanEvacuationTimeFormatted:
          overallMeanEvacTimeSec !== null ? formatMMSS(overallMeanEvacTimeSec) : null,
        meanPickupArrivalTimeSeconds:
          overallMeanPickupTimeSec !== null ? Number(overallMeanPickupTimeSec.toFixed(1)) : null,
        meanVehicleWaitTimeSeconds:
          overallMeanVehicleWaitSec !== null ? Number(overallMeanVehicleWaitSec.toFixed(1)) : null,
        meanVehicleWaitTimeFormatted:
          overallMeanVehicleWaitSec !== null ? formatMMSS(overallMeanVehicleWaitSec) : null,
        evacuationThroughputPerMinute: Number(evacuationRatePerMin.toFixed(2)),
        totalCompletedVehicleTrips: telemetryStats?.totalCompletedVehicleTrips || 0,
      },
      populationBehaviorBreakdown: behaviors.map((b) => ({
        behavior: b,
        initialPopulation: initialByBehavior[b],
        evacuatedToShelter: evacuatedByBehavior[b],
        stillNotEvacuated: notEvacuatedByBehavior[b],
        stillNotEvacuatedDetail: {
          movingInSourceZone: hasActiveSimulationEntities
            ? movingInZoneByBehavior[b]
            : fallbackSourceByBehavior[b],
          waitingAtPickupLocation: waitingAtPickupsByBehavior[b],
          inTransitOnVehicles: inTransitByBehavior[b],
        },
        meanEvacuationTimeSeconds:
          behaviorTimeStats[b].meanEvacSec !== null
            ? Number(behaviorTimeStats[b].meanEvacSec!.toFixed(1))
            : null,
        meanEvacuationTimeFormatted:
          behaviorTimeStats[b].meanEvacSec !== null
            ? formatMMSS(behaviorTimeStats[b].meanEvacSec!)
            : null,
        meanPickupArrivalTimeSeconds:
          behaviorTimeStats[b].meanPickupSec !== null
            ? Number(behaviorTimeStats[b].meanPickupSec!.toFixed(1))
            : null,
      })),
      pickupLocationsReport: pickupReportRows.map((row) => ({
        pickupId: row.pickup.id,
        pickupLabel: row.pickup.label,
        sourceName: row.pickup.sourceName,
        targetName: row.pickup.targetName,
        coordinates: row.pickup.location,
        peopleBoardedAtPickup: row.totalBoardedAtPickup,
        peopleEvacuatedToShelterFromPickup: row.evacuatedToShelter,
        peopleInTransitFromPickup: row.inTransitFromPickup,
        peopleCurrentlyWaitingAtPickup: row.currentlyWaitingTotal,
        completedVehicleDepartures: row.completedDepartures,
        meanVehicleWaitTimeSeconds:
          row.meanWaitSeconds !== null ? Number(row.meanWaitSeconds.toFixed(1)) : null,
        meanVehicleWaitTimeFormatted:
          row.meanWaitSeconds !== null ? formatMMSS(row.meanWaitSeconds) : null,
        maxVehicleWaitTimeSeconds: Number(row.maxWaitSeconds.toFixed(1)),
      })),
      targetShelters: targetAreas.map((t) => ({
        id: t.id,
        name: t.name,
        status: t.disabled ? 'disabled' : 'active',
        evacueesArrived: t.currentOccupancy,
        capacity: t.capacity,
        utilizationPercent:
          t.capacity > 0 ? Number(((t.currentOccupancy / t.capacity) * 100).toFixed(1)) : 0,
      })),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `evac-sim-report-${Math.round(elapsedSimSeconds)}s.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return createPortal(
    <div
      id="simulation-report-modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        backgroundColor: 'rgba(4, 9, 18, 0.78)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      <div
        id="simulation-report-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="simulation-report-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1060px, 95vw)',
          maxHeight: '90vh',
          backgroundColor: 'hsl(222, 30%, 11%)',
          border: '1px solid rgba(56, 189, 248, 0.45)',
          borderRadius: '12px',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.8)',
          color: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Modal Top Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '16px 22px',
            background:
              'linear-gradient(90deg, rgba(15, 23, 42, 0.98) 0%, rgba(30, 41, 59, 0.95) 100%)',
            borderBottom: '1px solid rgba(56, 189, 248, 0.28)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: '8px',
                background: 'rgba(56, 189, 248, 0.16)',
                border: '1px solid rgba(56, 189, 248, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#38bdf8',
              }}
            >
              <FileBarChart2 size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2
                  id="simulation-report-modal-title"
                  style={{
                    margin: 0,
                    fontSize: '1.05rem',
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    color: '#f8fafc',
                  }}
                >
                  SIMULATION REPORT — TACTICAL EVACUATION ANALYTICS
                </h2>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    background:
                      totalNotEvacuated === 0 && totalEvacuated > 0
                        ? 'rgba(16, 185, 129, 0.2)'
                        : 'rgba(245, 158, 11, 0.2)',
                    color:
                      totalNotEvacuated === 0 && totalEvacuated > 0 ? '#34d399' : '#fbbf24',
                    border:
                      totalNotEvacuated === 0 && totalEvacuated > 0
                        ? '1px solid rgba(16, 185, 129, 0.45)'
                        : '1px solid rgba(245, 158, 11, 0.45)',
                  }}
                >
                  {totalNotEvacuated === 0 && totalEvacuated > 0
                    ? 'COMPLETED (100%)'
                    : elapsedSimSeconds > 0
                    ? `PAUSED AT T+${formatMMSS(elapsedSimSeconds)}`
                    : 'INITIAL SNAPSHOT (T+00:00)'}
                </span>
              </div>
              <p
                style={{
                  margin: '3px 0 0 0',
                  fontSize: '0.76rem',
                  color: '#94a3b8',
                }}
              >
                Scenario: <strong style={{ color: '#e2e8f0' }}>{scenarioName}</strong> &bull;
                Simulation Clock:{' '}
                <strong style={{ color: '#38bdf8', fontFamily: 'monospace' }}>
                  {formatMMSS(elapsedSimSeconds)} ({Math.round(elapsedSimSeconds)}s)
                </strong>{' '}
                &bull; Speed: <strong>{simSpeed}x</strong>
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              id="btn-export-simulation-report-json"
              type="button"
              onClick={handleDownloadJsonReport}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '7px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(56, 189, 248, 0.4)',
                background: 'rgba(14, 165, 233, 0.14)',
                color: '#7dd3fc',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              title="Download full simulation report as JSON"
            >
              <Download size={14} />
              <span>Export JSON</span>
            </button>
            <button
              id="btn-close-simulation-report"
              type="button"
              onClick={onClose}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '7px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(148, 163, 184, 0.35)',
                background: 'rgba(51, 65, 85, 0.6)',
                color: '#f8fafc',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <X size={15} />
              <span>Close</span>
            </button>
          </div>
        </header>

        {/* Scrollable Report Body */}
        <div
          style={{
            padding: '18px 22px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '18px',
          }}
        >
          {/* 1. Primary Executive Summary Cards */}
          <section aria-label="Executive Summary Metrics">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap: '12px',
              }}
            >
              {/* Card 1: Evacuated to Shelter */}
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(16, 185, 129, 0.4)',
                  borderRadius: '8px',
                  padding: '12px 14px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    marginBottom: '6px',
                  }}
                >
                  <span>Evacuated to Shelter</span>
                  <CheckCircle2 size={15} style={{ color: '#10b981' }} />
                </div>
                <div
                  id="report-metric-evacuated-count"
                  style={{
                    fontSize: '1.55rem',
                    fontWeight: 800,
                    color: '#34d399',
                    fontFamily: 'monospace',
                  }}
                >
                  {totalEvacuated.toLocaleString()}
                  <span
                    style={{
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      color: '#94a3b8',
                      marginLeft: '8px',
                    }}
                  >
                    ({overallEvacuatedPct.toFixed(1)}%)
                  </span>
                </div>
                <div style={{ fontSize: '0.72rem', color: '#cbd5e1', marginTop: '4px' }}>
                  Out of <strong>{totalInitialPopulation.toLocaleString()}</strong> total initial
                  population across {sourceAreas.length} source zones
                </div>
              </div>

              {/* Card 2: Still Not Evacuated */}
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(245, 158, 11, 0.4)',
                  borderRadius: '8px',
                  padding: '12px 14px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    marginBottom: '6px',
                  }}
                >
                  <span>Still Not Evacuated</span>
                  <Users size={15} style={{ color: '#fbbf24' }} />
                </div>
                <div
                  id="report-metric-not-evacuated-count"
                  style={{
                    fontSize: '1.55rem',
                    fontWeight: 800,
                    color: '#fbbf24',
                    fontFamily: 'monospace',
                  }}
                >
                  {totalNotEvacuated.toLocaleString()}
                  <span
                    style={{
                      fontSize: '0.82rem',
                      fontWeight: 600,
                      color: '#94a3b8',
                      marginLeft: '8px',
                    }}
                  >
                    ({overallNotEvacuatedPct.toFixed(1)}%)
                  </span>
                </div>
                <div style={{ fontSize: '0.71rem', color: '#cbd5e1', marginTop: '4px' }}>
                  Ob: <strong>{notEvacuatedByBehavior.obedient.toLocaleString()}</strong> &bull; Au:{' '}
                  <strong>{notEvacuatedByBehavior.autonomous.toLocaleString()}</strong> &bull; Rd:{' '}
                  <strong>{notEvacuatedByBehavior.random.toLocaleString()}</strong>
                </div>
              </div>

              {/* Card 3: Mean Evacuation Time per Person */}
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(56, 189, 248, 0.4)',
                  borderRadius: '8px',
                  padding: '12px 14px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    marginBottom: '6px',
                  }}
                >
                  <span>Mean Evacuation Time / Person</span>
                  <Clock size={15} style={{ color: '#38bdf8' }} />
                </div>
                <div
                  id="report-metric-mean-evac-time"
                  style={{
                    fontSize: '1.5rem',
                    fontWeight: 800,
                    color: '#38bdf8',
                    fontFamily: 'monospace',
                  }}
                >
                  {overallMeanEvacTimeSec !== null
                    ? `${formatMMSS(overallMeanEvacTimeSec)} (${Math.round(overallMeanEvacTimeSec)}s)`
                    : `~${formatMMSS(avgRouteDurationSec + 180)} (Est.)`}
                </div>
                <div style={{ fontSize: '0.71rem', color: '#cbd5e1', marginTop: '4px' }}>
                  {overallMeanPickupTimeSec !== null
                    ? `Mean pickup assembly time: ${formatMMSS(overallMeanPickupTimeSec)} (${Math.round(overallMeanPickupTimeSec)}s)`
                    : 'Awaiting first shelter offload completion'}
                </div>
              </div>

              {/* Card 4: Mean Vehicle Wait Time at Pickups */}
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.85)',
                  border: '1px solid rgba(167, 139, 250, 0.4)',
                  borderRadius: '8px',
                  padding: '12px 14px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    marginBottom: '6px',
                  }}
                >
                  <span>Mean Vehicle Wait at Pickups</span>
                  <Bus size={15} style={{ color: '#a78bfa' }} />
                </div>
                <div
                  id="report-metric-mean-vehicle-wait"
                  style={{
                    fontSize: '1.5rem',
                    fontWeight: 800,
                    color: '#c4b5fd',
                    fontFamily: 'monospace',
                  }}
                >
                  {overallMeanVehicleWaitSec !== null
                    ? `${formatMMSS(overallMeanVehicleWaitSec)} (${Math.round(overallMeanVehicleWaitSec)}s)`
                    : '00:00 (No waits yet)'}
                </div>
                <div style={{ fontSize: '0.71rem', color: '#cbd5e1', marginTop: '4px' }}>
                  Across <strong>{globalWaitDenom}</strong> vehicle boarding dispatches (Max 10:00
                  cap)
                </div>
              </div>
            </div>
          </section>

          {/* 2. Population Behaviour Breakdown Table (Obedient, Autonomous, Random) */}
          <section
            style={{
              background: 'rgba(15, 23, 42, 0.78)',
              border: '1px solid rgba(148, 163, 184, 0.25)',
              borderRadius: '10px',
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Users size={16} style={{ color: '#38bdf8' }} />
                <h3
                  style={{
                    margin: 0,
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: '#e2e8f0',
                  }}
                >
                  Population Behaviour Breakdown (Still Not Evacuated &amp; Mean Evacuation Time)
                </h3>
              </div>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                Detailed by Behavioural Profile: Obedient, Autonomous, and Random
              </span>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table
                id="report-behavior-table"
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.76rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid rgba(148, 163, 184, 0.28)',
                      color: '#94a3b8',
                      fontSize: '0.7rem',
                      textTransform: 'uppercase',
                    }}
                  >
                    <th style={{ padding: '8px 10px' }}>Population Behaviour</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>Initial Pop.</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Evacuated to Shelter
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Still Not Evacuated
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Moving in Zone / Pickup Queue / In Transit
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Mean Time to Pickup
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Mean Evacuation Time / Person
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {behaviors.map((b) => {
                    const meta = BEHAVIOR_LABELS[b];
                    const initPop = initialByBehavior[b];
                    const evacPop = evacuatedByBehavior[b];
                    const notEvacPop = notEvacuatedByBehavior[b];
                    const movingPop = hasActiveSimulationEntities
                      ? movingInZoneByBehavior[b]
                      : fallbackSourceByBehavior[b];
                    const waitingPop = waitingAtPickupsByBehavior[b];
                    const transitPop = inTransitByBehavior[b];
                    const tStats = behaviorTimeStats[b];
                    const evacPct = initPop > 0 ? (evacPop / initPop) * 100 : 0;
                    const notEvacPct = initPop > 0 ? (notEvacPop / initPop) * 100 : 0;

                    return (
                      <tr
                        key={b}
                        style={{
                          borderBottom: '1px solid rgba(51, 65, 85, 0.55)',
                        }}
                      >
                        <td style={{ padding: '9px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span
                              style={{
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                backgroundColor: meta.color,
                                display: 'inline-block',
                                flexShrink: 0,
                              }}
                            />
                            <div>
                              <div style={{ fontWeight: 700, color: meta.color }}>
                                {meta.title}
                              </div>
                              <div style={{ fontSize: '0.67rem', color: '#94a3b8' }}>
                                {meta.subtitle}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            fontWeight: 600,
                          }}
                        >
                          {initPop.toLocaleString()}
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            color: '#34d399',
                            fontWeight: 700,
                          }}
                        >
                          {evacPop.toLocaleString()}{' '}
                          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 400 }}>
                            ({evacPct.toFixed(1)}%)
                          </span>
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            color: '#fbbf24',
                            fontWeight: 700,
                          }}
                        >
                          {notEvacPop.toLocaleString()}{' '}
                          <span style={{ fontSize: '0.68rem', color: '#94a3b8', fontWeight: 400 }}>
                            ({notEvacPct.toFixed(1)}%)
                          </span>
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            fontSize: '0.71rem',
                            color: '#cbd5e1',
                          }}
                        >
                          <span title="Moving inside Source Zone">
                            Zone: <strong>{movingPop.toLocaleString()}</strong>
                          </span>{' '}
                          |{' '}
                          <span title="Waiting or Boarding at Pickup Location">
                            Pickup: <strong>{waitingPop.toLocaleString()}</strong>
                          </span>{' '}
                          |{' '}
                          <span title="In Transit on Vehicles to Target Shelter">
                            Transit: <strong>{transitPop.toLocaleString()}</strong>
                          </span>
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            color: '#cbd5e1',
                          }}
                        >
                          {tStats.meanPickupSec !== null
                            ? `${formatMMSS(tStats.meanPickupSec)} (${Math.round(tStats.meanPickupSec)}s)`
                            : `~${formatMMSS(estWalkTimeByBehavior[b])} (Est.)`}
                        </td>
                        <td
                          style={{
                            padding: '9px 10px',
                            textAlign: 'right',
                            fontFamily: 'monospace',
                            fontWeight: 700,
                            color: tStats.meanEvacSec !== null ? '#38bdf8' : '#94a3b8',
                          }}
                        >
                          {tStats.meanEvacSec !== null
                            ? `${formatMMSS(tStats.meanEvacSec)} (${Math.round(tStats.meanEvacSec)}s)`
                            : `~${formatMMSS(tStats.estimatedEvacSec)} (Est. / 0 arrived)`}
                        </td>
                      </tr>
                    );
                  })}
                  {/* Total Summary Row */}
                  <tr
                    style={{
                      background: 'rgba(30, 41, 59, 0.7)',
                      fontWeight: 700,
                      borderTop: '1px solid rgba(148, 163, 184, 0.35)',
                    }}
                  >
                    <td style={{ padding: '9px 10px', color: '#f8fafc' }}>
                      TOTAL / OVERALL POPULATION
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                      }}
                    >
                      {totalInitialPopulation.toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        color: '#34d399',
                      }}
                    >
                      {totalEvacuated.toLocaleString()} ({overallEvacuatedPct.toFixed(1)}%)
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        color: '#fbbf24',
                      }}
                    >
                      {totalNotEvacuated.toLocaleString()} ({overallNotEvacuatedPct.toFixed(1)}%)
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        fontSize: '0.71rem',
                        color: '#e2e8f0',
                      }}
                    >
                      Zone:{' '}
                      {(hasActiveSimulationEntities
                        ? movingInZoneByBehavior.obedient +
                          movingInZoneByBehavior.autonomous +
                          movingInZoneByBehavior.random
                        : totalInitialPopulation
                      ).toLocaleString()}{' '}
                      | Pickup:{' '}
                      {(
                        waitingAtPickupsByBehavior.obedient +
                        waitingAtPickupsByBehavior.autonomous +
                        waitingAtPickupsByBehavior.random
                      ).toLocaleString()}{' '}
                      | Transit: {totalInTransit.toLocaleString()}
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        color: '#e2e8f0',
                      }}
                    >
                      {overallMeanPickupTimeSec !== null
                        ? `${formatMMSS(overallMeanPickupTimeSec)} (${Math.round(overallMeanPickupTimeSec)}s)`
                        : '—'}
                    </td>
                    <td
                      style={{
                        padding: '9px 10px',
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        color: '#38bdf8',
                      }}
                    >
                      {overallMeanEvacTimeSec !== null
                        ? `${formatMMSS(overallMeanEvacTimeSec)} (${Math.round(overallMeanEvacTimeSec)}s)`
                        : `~${formatMMSS(avgRouteDurationSec + 180)} (Est.)`}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 3. Pickup Locations Table (People Evacuated & Mean Vehicle Wait Time per Pickup Location) */}
          <section
            style={{
              background: 'rgba(15, 23, 42, 0.78)',
              border: '1px solid rgba(148, 163, 184, 0.25)',
              borderRadius: '10px',
              padding: '14px 16px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <MapPin size={16} style={{ color: '#60a5fa' }} />
                <h3
                  style={{
                    margin: 0,
                    fontSize: '0.86rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: '#e2e8f0',
                  }}
                >
                  Pickup Locations Performance &amp; Mean Vehicle Wait Times
                </h3>
              </div>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                {pickupReportRows.length} Blue Square Assembly &amp; Boarding Points
              </span>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table
                id="report-pickup-locations-table"
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: '0.75rem',
                  textAlign: 'left',
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid rgba(148, 163, 184, 0.28)',
                      color: '#94a3b8',
                      fontSize: '0.69rem',
                      textTransform: 'uppercase',
                    }}
                  >
                    <th style={{ padding: '8px 10px' }}>Pickup Location</th>
                    <th style={{ padding: '8px 10px' }}>Source &rarr; Target Corridor</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Evacuated at Pickup (Boarded)
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Delivered to Shelter
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Waiting at Pickup Now
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Vehicle Departures
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Mean Vehicle Wait Time
                    </th>
                    <th style={{ padding: '8px 10px', textAlign: 'right' }}>
                      Max Wait / Avg Load
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pickupReportRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        style={{
                          padding: '14px',
                          textAlign: 'center',
                          color: '#94a3b8',
                        }}
                      >
                        No pickup locations established yet. Compute routes first.
                      </td>
                    </tr>
                  ) : (
                    pickupReportRows.map((row) => {
                      const bb = row.pickup.boardedByBehavior || createZeroBehaviorCounts();
                      return (
                        <tr
                          key={row.pickup.id}
                          style={{
                            borderBottom: '1px solid rgba(51, 65, 85, 0.55)',
                          }}
                        >
                          <td style={{ padding: '9px 10px' }}>
                            <div style={{ fontWeight: 700, color: '#60a5fa' }}>
                              {row.pickup.label}
                            </div>
                            <div
                              style={{
                                fontSize: '0.67rem',
                                color: '#94a3b8',
                                fontFamily: 'monospace',
                              }}
                            >
                              [{row.pickup.location[0].toFixed(4)},{' '}
                              {row.pickup.location[1].toFixed(4)}]
                            </div>
                          </td>
                          <td style={{ padding: '9px 10px', color: '#e2e8f0' }}>
                            <div>{row.pickup.sourceName}</div>
                            <div style={{ fontSize: '0.68rem', color: '#34d399' }}>
                              &rarr; {row.pickup.targetName}
                            </div>
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            <div style={{ fontWeight: 700, color: '#38bdf8' }}>
                              {row.totalBoardedAtPickup.toLocaleString()} pax
                            </div>
                            <div style={{ fontSize: '0.66rem', color: '#94a3b8' }}>
                              Ob:{bb.obedient} Au:{bb.autonomous} Rd:{bb.random}
                            </div>
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            <span style={{ fontWeight: 700, color: '#34d399' }}>
                              {row.evacuatedToShelter.toLocaleString()}
                            </span>
                            {row.inTransitFromPickup > 0 && (
                              <div style={{ fontSize: '0.66rem', color: '#fbbf24' }}>
                                +{row.inTransitFromPickup.toLocaleString()} en route
                              </div>
                            )}
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                              color: row.currentlyWaitingTotal > 0 ? '#fbbf24' : '#94a3b8',
                              fontWeight: 600,
                            }}
                          >
                            {row.currentlyWaitingTotal.toLocaleString()}
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                              color: '#e2e8f0',
                            }}
                          >
                            <strong>{row.completedDepartures}</strong> departed
                            {row.activeWaitingVehicleCount > 0 && (
                              <div style={{ fontSize: '0.66rem', color: '#a78bfa' }}>
                                ({row.activeWaitingVehicleCount} boarding now)
                              </div>
                            )}
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              color: row.meanWaitSeconds !== null ? '#c4b5fd' : '#94a3b8',
                            }}
                          >
                            {row.meanWaitSeconds !== null
                              ? `${formatMMSS(row.meanWaitSeconds)} (${Math.round(row.meanWaitSeconds)}s)`
                              : '00:00 (0s)'}
                          </td>
                          <td
                            style={{
                              padding: '9px 10px',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                              fontSize: '0.71rem',
                              color: '#cbd5e1',
                            }}
                          >
                            <div>
                              Max: <strong>{formatMMSS(row.maxWaitSeconds)}</strong>
                            </div>
                            <div style={{ fontSize: '0.67rem', color: '#94a3b8' }}>
                              Load:{' '}
                              {row.avgDepartureLoadPct !== null
                                ? `${row.avgDepartureLoadPct.toFixed(0)}%`
                                : '—'}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* 4. Additional Valuable Metrics: Target Shelters, Source Zones & Operational Logistics */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
              gap: '14px',
            }}
          >
            {/* Target Shelters Capacity Utilization */}
            <section
              style={{
                background: 'rgba(15, 23, 42, 0.78)',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                borderRadius: '10px',
                padding: '14px 16px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Building2 size={15} style={{ color: '#34d399' }} />
                  <h3
                    style={{
                      margin: 0,
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: '#e2e8f0',
                    }}
                  >
                    Target Shelters Occupancy &amp; Headroom
                  </h3>
                </div>
                <span style={{ fontSize: '0.71rem', color: '#34d399', fontWeight: 600 }}>
                  Overall Utilization: {shelterCapacityUtilizationPct.toFixed(1)}%
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
                {targetAreas.map((t) => {
                  const incoming = vehicles
                    .filter((v) => v.targetId === t.id && v.status === 'to_target')
                    .reduce((acc, v) => acc + v.currentOccupancy, 0);
                  const utilPct =
                    t.capacity > 0 ? Math.min(100, (t.currentOccupancy / t.capacity) * 100) : 0;
                  const headroom = Math.max(0, t.capacity - t.currentOccupancy);

                  return (
                    <div
                      key={t.id}
                      style={{
                        padding: '8px 10px',
                        borderRadius: '6px',
                        background: 'rgba(30, 41, 59, 0.55)',
                        border: '1px solid rgba(71, 85, 105, 0.4)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: '0.75rem',
                          marginBottom: '5px',
                        }}
                      >
                        <div>
                          <strong style={{ color: t.disabled ? '#94a3b8' : '#f8fafc' }}>
                            {t.name}
                          </strong>{' '}
                          {t.disabled && (
                            <span
                              style={{
                                fontSize: '0.65rem',
                                color: '#f87171',
                                marginLeft: '6px',
                              }}
                            >
                              [DISABLED]
                            </span>
                          )}
                        </div>
                        <div style={{ fontFamily: 'monospace', fontSize: '0.73rem' }}>
                          <strong style={{ color: '#34d399' }}>
                            {t.currentOccupancy.toLocaleString()}
                          </strong>{' '}
                          / {t.capacity.toLocaleString()} ({utilPct.toFixed(1)}%)
                        </div>
                      </div>
                      <div
                        style={{
                          height: '6px',
                          borderRadius: '999px',
                          background: 'rgba(15, 23, 42, 0.9)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${utilPct}%`,
                            height: '100%',
                            background:
                              utilPct > 90
                                ? '#ef4444'
                                : utilPct > 70
                                ? '#f59e0b'
                                : '#10b981',
                          }}
                        />
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          fontSize: '0.67rem',
                          color: '#94a3b8',
                          marginTop: '4px',
                        }}
                      >
                        <span>Remaining Capacity Headroom: {headroom.toLocaleString()} pax</span>
                        <span>Incoming En Route: +{incoming.toLocaleString()} pax</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Operational Velocity, Fleet Logistics & Hazard Avoidance Summary */}
            <section
              style={{
                background: 'rgba(15, 23, 42, 0.78)',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                borderRadius: '10px',
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '10px',
                  }}
                >
                  <TrendingUp size={15} style={{ color: '#38bdf8' }} />
                  <h3
                    style={{
                      margin: 0,
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: '#e2e8f0',
                    }}
                  >
                    Operational Throughput &amp; Logistics Telemetry
                  </h3>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: '8px',
                    fontSize: '0.74rem',
                  }}
                >
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'rgba(30, 41, 59, 0.55)',
                    }}
                  >
                    <div style={{ color: '#94a3b8', fontSize: '0.68rem' }}>
                      Shelter Delivery Rate
                    </div>
                    <div
                      style={{
                        fontSize: '0.96rem',
                        fontWeight: 700,
                        color: '#38bdf8',
                        fontFamily: 'monospace',
                        marginTop: '2px',
                      }}
                    >
                      {evacuationRatePerMin.toFixed(1)} pax / min
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'rgba(30, 41, 59, 0.55)',
                    }}
                  >
                    <div style={{ color: '#94a3b8', fontSize: '0.68rem' }}>
                      Pickup Boarding Rate
                    </div>
                    <div
                      style={{
                        fontSize: '0.96rem',
                        fontWeight: 700,
                        color: '#60a5fa',
                        fontFamily: 'monospace',
                        marginTop: '2px',
                      }}
                    >
                      {boardingRatePerMin.toFixed(1)} pax / min
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'rgba(30, 41, 59, 0.55)',
                    }}
                  >
                    <div style={{ color: '#94a3b8', fontSize: '0.68rem' }}>
                      Estimated Time to 100% Clearance
                    </div>
                    <div
                      style={{
                        fontSize: '0.96rem',
                        fontWeight: 700,
                        color: '#fbbf24',
                        fontFamily: 'monospace',
                        marginTop: '2px',
                      }}
                    >
                      {totalNotEvacuated === 0
                        ? '00:00 (Cleared)'
                        : estimatedRemainingMinutes !== null
                        ? `~${formatMMSS(estimatedRemainingMinutes * 60)} remaining`
                        : 'Pending flow rate'}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: '6px',
                      background: 'rgba(30, 41, 59, 0.55)',
                    }}
                  >
                    <div style={{ color: '#94a3b8', fontSize: '0.68rem' }}>
                      Completed Shelter Convoys
                    </div>
                    <div
                      style={{
                        fontSize: '0.96rem',
                        fontWeight: 700,
                        color: '#34d399',
                        fontFamily: 'monospace',
                        marginTop: '2px',
                      }}
                    >
                      {telemetryStats?.totalCompletedVehicleTrips || 0} trips (
                      {vehicleFleets.length} fleets)
                    </div>
                  </div>
                </div>
              </div>

              {/* Corridor & No-Go Zone Avoidance Summary */}
              <div
                style={{
                  padding: '9px 11px',
                  borderRadius: '6px',
                  background: 'rgba(239, 68, 68, 0.09)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  fontSize: '0.72rem',
                  color: '#e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <ShieldAlert size={16} style={{ color: '#f87171', flexShrink: 0 }} />
                  <span>
                    <strong>No-Go Hazard Avoidance:</strong> {noGoAreas.length} active No-Go zones
                    enforced; <strong>{detourRoutesCount}</strong> of {computedRoutes.length}{' '}
                    corridors dynamically detoured with zero polygon intersection.
                  </span>
                </div>
                <Activity size={15} style={{ color: '#38bdf8', flexShrink: 0 }} />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
