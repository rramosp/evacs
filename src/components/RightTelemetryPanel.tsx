import React, { useState } from 'react';
import {
  SourceArea,
  TargetArea,
  VehicleFleet,
  ComputedRoute,
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
} from 'lucide-react';

interface RightTelemetryPanelProps {
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  elapsedSimSeconds: number;
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  isSimulating: boolean;
}

export const RightTelemetryPanel: React.FC<RightTelemetryPanelProps> = ({
  sourceAreas,
  targetAreas,
  vehicleFleets,
  computedRoutes,
  elapsedSimSeconds,
  totalEvacuated,
  totalInTransit,
  totalRemainingAtSource,
  isSimulating,
}) => {
  const [minimalMode, setMinimalMode] = useState<boolean>(false);

  const totalPopulation = sourceAreas.reduce((acc, s) => acc + s.population, 0);
  const progressPercent =
    totalPopulation > 0 ? Math.min(100, Math.round((totalEvacuated / totalPopulation) * 100)) : 0;

  const formatSimTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const remSec = Math.floor(sec % 60);
    return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
  };

  // Behavioral headcount totals across all source areas
  const totalObedient = sourceAreas.reduce(
    (acc, s) => acc + Math.round((s.population * s.behavior.obedient) / 100),
    0
  );
  const totalAutonomous = sourceAreas.reduce(
    (acc, s) => acc + Math.round((s.population * s.behavior.autonomous) / 100),
    0
  );
  const totalRandom = Math.max(0, totalPopulation - totalObedient - totalAutonomous);

  const totalFleetVehicles = vehicleFleets.reduce((acc, f) => acc + f.count, 0);
  const totalFleetCapacity = vehicleFleets.reduce(
    (acc, f) => acc + f.count * f.capacityPerUnit,
    0
  );

  return (
    <aside className="cockpit-right-panel" id="right-telemetry-panel">
      <header className="right-panel-header">
        <div className="right-title-row">
          <Activity size={16} className="telemetry-icon" />
          <h2 className="right-panel-title">Situational Telemetry</h2>
        </div>
        <button
          type="button"
          className="btn-toggle-minimal"
          onClick={() => setMinimalMode(!minimalMode)}
          title="Toggle Telemetry vs Scoping Blank View"
        >
          {minimalMode ? <BarChart3 size={14} /> : <EyeOff size={14} />}
          <span>{minimalMode ? 'Show KPIs' : 'Blank View'}</span>
        </button>
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
          {/* Simulation Clock & Status Banner */}
          <div className={`sim-status-banner ${isSimulating ? 'running' : ''}`}>
            <div className="clock-display">
              <Clock size={18} />
              <div className="clock-text">
                <span className="clock-label">ELAPSED EVACUATION TIME</span>
                <span className="clock-digits">{formatSimTime(elapsedSimSeconds)}</span>
              </div>
            </div>
            <div className={`sim-badge ${isSimulating ? 'active' : ''}`}>
              {isSimulating ? 'LIVE ANIMATION' : elapsedSimSeconds > 0 ? 'PAUSED' : 'STANDBY'}
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
                  <span>In Transit</span>
                </div>
                <div className="kpi-stat-value">{totalInTransit.toLocaleString()}</div>
              </div>

              <div className="kpi-stat-box waiting">
                <div className="kpi-stat-label">
                  <Users size={13} />
                  <span>At Source</span>
                </div>
                <div className="kpi-stat-value">{totalRemainingAtSource.toLocaleString()}</div>
              </div>
            </div>
          </section>

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
                <span>POPULATION BEHAVIOR MODEL</span>
              </div>
            </div>

            <div className="behavior-breakdown-list">
              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot obedient" />
                  <div>
                    <div className="behavior-title">Obedient Evacuees</div>
                    <div className="behavior-desc">Follow official optimal routes strictly</div>
                  </div>
                </div>
                <span className="behavior-count">{totalObedient.toLocaleString()}</span>
              </div>

              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot autonomous" />
                  <div>
                    <div className="behavior-title">Autonomous Evacuees</div>
                    <div className="behavior-desc">Detour dynamically around congestion</div>
                  </div>
                </div>
                <span className="behavior-count">{totalAutonomous.toLocaleString()}</span>
              </div>

              <div className="behavior-row">
                <div className="behavior-row-info">
                  <span className="behavior-dot random" />
                  <div>
                    <div className="behavior-title">Random Evacuees</div>
                    <div className="behavior-desc">Non-compliant / random exit selection</div>
                  </div>
                </div>
                <span className="behavior-count">{totalRandom.toLocaleString()}</span>
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
                <span className="fleet-stat-lbl">Active Corridors</span>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
};
