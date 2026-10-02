import React, { useState } from 'react';
import {
  SourceArea,
  TargetArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
} from '../types/evacuation';
import {
  Activity,
  Clock,
  CheckCircle2,
  Navigation,
  Users,
  Building2,
  Bus,
  EyeOff,
  BarChart3,
  MapPin,
  ChevronLeft,
  PanelRightClose,
  PanelRightOpen,
} from 'lucide-react';

interface RightTelemetryPanelProps {
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  pickupStates: PickupLocationState[];
  elapsedTwinSeconds: number;
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  totalWaitingAtPickups: number;
  isTwinning: boolean;
}

export const RightTelemetryPanel: React.FC<RightTelemetryPanelProps> = ({
  isCollapsed = false,
  onToggleCollapse,
  sourceAreas,
  targetAreas,
  vehicleFleets,
  computedRoutes,
  pickupStates,
  elapsedTwinSeconds,
  totalEvacuated,
  totalInTransit,
  totalRemainingAtSource,
  totalWaitingAtPickups,
  isTwinning,
}) => {
  const [minimalMode, setMinimalMode] = useState<boolean>(false);

  const activeSourceAreas = sourceAreas.filter((s) => !s.disabled);

  const accountedTotalPopulation =
    totalEvacuated + totalInTransit + totalRemainingAtSource;
  const totalPopulation =
    accountedTotalPopulation > 0
      ? accountedTotalPopulation
      : activeSourceAreas.reduce((acc, s) => acc + s.population, 0);

  const isCompletelyEvacuated =
    totalPopulation > 0 &&
    totalRemainingAtSource === 0 &&
    totalInTransit === 0 &&
    totalEvacuated > 0;

  const progressPercent =
    totalPopulation === 0
      ? 0
      : isCompletelyEvacuated
      ? 100
      : Math.min(99, Math.floor((totalEvacuated / totalPopulation) * 100));

  const formatTwinTime = (sec: number) => {
    const totalSec = Math.max(0, Math.floor(sec));
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const remSec = totalSec % 60;
    if (days > 0) {
      return `${days}d ${hours}h ${mins}m ${remSec}s`;
    }
    if (hours > 0) {
      return `${hours}h ${mins}m ${remSec}s`;
    }
    return `${mins}m ${remSec}s`;
  };

  const totalCompliant = activeSourceAreas.reduce(
    (acc, s) => acc + Math.round((s.population * s.behavior.compliant) / 100),
    0
  );
  const totalSelfDirected = activeSourceAreas.reduce(
    (acc, s) => acc + Math.round((s.population * s.behavior['self-directed']) / 100),
    0
  );
  const totalDisoriented = Math.max(0, totalPopulation - totalCompliant - totalSelfDirected);

  const totalFleetVehicles = vehicleFleets.reduce((acc, f) => acc + f.count, 0);
  const totalFleetCapacity = vehicleFleets.reduce(
    (acc, f) => acc + f.count * f.capacityPerUnit,
    0
  );

  const wanderingInZones = Math.max(0, totalRemainingAtSource - totalWaitingAtPickups);

  if (isCollapsed) {
    return (
      <aside
        className="cockpit-right-panel collapsed"
        id="right-telemetry-panel"
        title="Click to expand Right Situational Telemetry Panel"
      >
        <button
          type="button"
          id="btn-toggle-right-panel"
          className="panel-rail-expand-btn"
          onClick={onToggleCollapse}
          title="Expand Right Situational Telemetry Panel"
        >
          <ChevronLeft size={13} />
          <PanelRightOpen size={15} />
        </button>
        <div
          className="panel-rail-vertical-label"
          onClick={onToggleCollapse}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onToggleCollapse?.();
          }}
        >
          <span className="rail-kpi-pill">{progressPercent}%</span>
          <span>SITUATIONAL TELEMETRY</span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="cockpit-right-panel" id="right-telemetry-panel">
      <header className="right-panel-header">
        <div className="right-title-row">
          <Activity size={16} className="telemetry-icon" />
          <h2 className="right-panel-title">Situational Telemetry</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button
            type="button"
            className="btn-toggle-minimal"
            onClick={() => setMinimalMode(!minimalMode)}
            title="Toggle Telemetry vs Scoping Blank View"
          >
            {minimalMode ? <BarChart3 size={14} /> : <EyeOff size={14} />}
            <span>{minimalMode ? 'Show KPIs' : 'Blank View'}</span>
          </button>
          {onToggleCollapse && (
            <button
              type="button"
              id="btn-toggle-right-panel"
              className="btn-collapse-panel"
              onClick={onToggleCollapse}
              title="Collapse Right Situational Telemetry Panel"
            >
              <span>Collapse</span>
              <PanelRightClose size={14} />
            </button>
          )}
        </div>
      </header>

      {minimalMode ? (
        <div className="scoping-blank-placeholder">
          <div className="placeholder-box">
            <h3>Right Side Panel (25% Width)</h3>
            <p>
              Reserved for future scoping modules. Click <strong>"Show KPIs"</strong> above to view live evacuation telemetry and shelter occupancy metrics.
            </p>
          </div>
        </div>
      ) : (
        <div className="telemetry-scroll-content">
          {/* Twin Clock & Status Banner */}
          <div className={`twin-status-banner ${isTwinning ? 'running' : ''}`}>
            <div className="clock-display">
              <Clock size={18} />
              <div className="clock-text">
                <span className="clock-label">ELAPSED EVACUATION TIME</span>
                <span className="clock-digits">{formatTwinTime(elapsedTwinSeconds)}</span>
              </div>
            </div>
            <div className={`twin-badge ${isTwinning ? 'active' : ''}`}>
              {isTwinning ? 'LIVE ANIMATION' : elapsedTwinSeconds > 0 ? 'PAUSED' : 'STANDBY'}
            </div>
          </div>

          {/* Evacuation Progress Summary Card */}
          <section className="telemetry-card">
            <div className="telemetry-card-header">
              <span>OVERALL EVACUATION PROGRESS</span>
              <span className="progress-pct-highlight">{progressPercent}%</span>
            </div>

            <div className="master-progress-track">
              <div
                className="master-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <div className="kpi-stat-grid">
              <div className="kpi-stat-box safe">
                <div className="kpi-stat-label">
                  <CheckCircle2 size={13} />
                  <span>Safe at Shelter</span>
                </div>
                <div className="kpi-stat-value">{totalEvacuated.toLocaleString()}</div>
              </div>

              <div className="kpi-stat-box transit">
                <div className="kpi-stat-label">
                  <Navigation size={13} />
                  <span>On Vehicles</span>
                </div>
                <div className="kpi-stat-value">{totalInTransit.toLocaleString()}</div>
              </div>

              <div className="kpi-stat-box waiting">
                <div className="kpi-stat-label">
                  <Users size={13} />
                  <span>In Source Area</span>
                </div>
                <div className="kpi-stat-value">{totalRemainingAtSource.toLocaleString()}</div>
              </div>
            </div>

            {/* Sub-breakdown of Source Area population */}
            <div className="source-sub-breakdown">
              <div className="sub-breakdown-item">
                <span className="sub-dot hotspot" />
                <span>Waiting at Pickup Squares:</span>
                <strong>{totalWaitingAtPickups.toLocaleString()}</strong>
              </div>
              <div className="sub-breakdown-item">
                <span className="sub-dot wandering" />
                <span>Moving Inside Source Zones:</span>
                <strong>{wanderingInZones.toLocaleString()}</strong>
              </div>
            </div>
          </section>

          {/* Blue Square & Metro Station Pickup Locations Live Queue & Boarding Status */}
          {pickupStates.length > 0 && (
            <section className="telemetry-card">
              <div className="telemetry-card-header">
                <div className="header-with-icon">
                  <MapPin size={14} style={{ color: '#3b82f6' }} />
                  <span>PICKUP &amp; METRO STATIONS (LIVE QUEUE)</span>
                </div>
              </div>

              <div className="pickup-queues-list">
                {pickupStates.map((p, i) => (
                  <div key={p.id} className="pickup-queue-item">
                    <div className="pickup-queue-top">
                      <span className="pickup-queue-name">
                        {p.isMetro ? `🚇 #${i + 1} ${p.label}` : `🟦 #${i + 1} ${p.label}`}
                      </span>
                      <span className="pickup-queue-count">
                        Queue: <strong>{p.waitingPopulation}</strong>
                      </span>
                    </div>
                    {p.boardingVehicleInfo ? (
                      <div className="pickup-boarding-status active">
                        {p.isMetro ? '🚇' : '🚌'} {p.boardingVehicleInfo}
                      </div>
                    ) : (
                      <div className="pickup-boarding-status">
                        Boarded: {p.totalBoardedCount.toLocaleString()} &bull; Dropped off
                        {p.isMetro && p.metroTargetStationName
                          ? ` at ${p.metroTargetStationName}`
                          : ''}
                        : {p.evacuatedCount.toLocaleString()} evacuees
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Target Shelter Occupancy Meters */}
          <section className="telemetry-card">
            <div className="telemetry-card-header">
              <div className="header-with-icon">
                <Building2 size={14} />
                <span>TARGET SHELTER OCCUPANCY</span>
              </div>
            </div>

            <div className="shelter-meters-list">
              {targetAreas.map((tgt) => {
                const pct = Math.min(
                  100,
                  Math.round((tgt.currentOccupancy / Math.max(1, tgt.capacity)) * 100)
                );
                return (
                  <div key={tgt.id} className="shelter-meter-item">
                    <div className="shelter-meter-top">
                      <span className="shelter-name">{tgt.name}</span>
                      <span className="shelter-numbers">
                        <strong>{tgt.currentOccupancy.toLocaleString()}</strong> /{' '}
                        {tgt.capacity.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                    <div className="shelter-bar-track">
                      <div
                        className={`shelter-bar-fill ${pct > 85 ? 'high' : ''}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Population Behavioral Profile Breakdown */}
          <section className="telemetry-card">
            <div className="telemetry-card-header">
              <div className="header-with-icon">
                <Users size={14} />
                <span>INTERNAL ZONE BEHAVIOR MODEL</span>
              </div>
            </div>

            <div className="behavior-breakdown-list">
              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot compliant" />
                  <div>
                    <div className="behavior-title">Compliant Population</div>
                    <div className="behavior-desc">Go immediately to closest pickup point</div>
                  </div>
                </div>
                <span className="behavior-count">{totalCompliant.toLocaleString()}</span>
              </div>

              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot self-directed" />
                  <div>
                    <div className="behavior-title">Self-Directed Population</div>
                    <div className="behavior-desc">Random zig-zag to closest pickup (with brief reversals)</div>
                  </div>
                </div>
                <span className="behavior-count">{totalSelfDirected.toLocaleString()}</span>
              </div>

              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot disoriented" />
                  <div>
                    <div className="behavior-title">Disoriented Population</div>
                    <div className="behavior-desc">Wander randomly with pickup-seeking drift (135m capture)</div>
                  </div>
                </div>
                <span className="behavior-count">{totalDisoriented.toLocaleString()}</span>
              </div>
            </div>
          </section>

          {/* Evacuation Fleet Summary */}
          <section className="telemetry-card">
            <div className="telemetry-card-header">
              <div className="header-with-icon">
                <Bus size={14} />
                <span>AUTHORITY TRANSPORT FLEETS</span>
              </div>
            </div>
            <div className="fleet-summary-grid">
              <div className="fleet-stat">
                <span className="fleet-stat-num">{totalFleetVehicles}</span>
                <span className="fleet-stat-lbl">Total Units</span>
              </div>
              <div className="fleet-stat">
                <span className="fleet-stat-num">{totalFleetCapacity.toLocaleString()}</span>
                <span className="fleet-stat-lbl">Seat Capacity</span>
              </div>
              <div className="fleet-stat">
                <span className="fleet-stat-num">{computedRoutes.length}</span>
                <span className="fleet-stat-lbl">Pickup Squares</span>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
};
