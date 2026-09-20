import React, { useState } from 'react';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  PresetScenarioId,
  ActiveDrawMode,
  VehicleType,
  Sentinel2LayerState,
  Sentinel1LayerState,
  Sentinel2AggregationPeriod,
  GlofasForecastState,
} from '../types/evacuation';
import {
  Route,
  Play,
  Pause,
  RotateCcw,
  Plus,
  Pencil,
  Trash2,
  Users,
  ShieldAlert,
  Building2,
  Bus,
  Check,
  X,
  MapPin,
  Ban,
  CheckCircle2,
  Lock,
  Satellite,
  Eye,
  EyeOff,
} from 'lucide-react';

interface LeftControlPanelProps {
  selectedPreset: PresetScenarioId;
  onSelectPreset: (preset: PresetScenarioId) => void;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
  remainingBySource: Record<string, number>;
  onAddSourceArea: (src: Omit<SourceArea, 'id'>) => void;
  onUpdateSourceArea: (src: SourceArea) => void;
  onDeleteSourceArea: (id: string) => void;
  onAddTargetArea: (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => void;
  onUpdateTargetArea: (tgt: TargetArea) => void;
  onToggleDisableTargetArea: (id: string) => void;
  onAddNoGoArea: (nogo: Omit<NoGoArea, 'id'>) => void;
  onUpdateNoGoArea: (nogo: NoGoArea) => void;
  onDeleteNoGoArea: (id: string) => void;
  onAddVehicleFleet: (fleet: Omit<VehicleFleet, 'id'>) => void;
  onUpdateVehicleFleet: (fleet: VehicleFleet) => void;
  onDeleteVehicleFleet: (id: string) => void;
  onComputeRoutes: () => void;
  isComputingRoutes: boolean;
  hasComputedRoutes: boolean;
  onRunSimulation: () => void;
  onStopSimulation: () => void;
  onResetSimulation: () => void;
  isSimulating: boolean;
  simSpeed: number;
  onChangeSimSpeed: (speed: number) => void;
  activeDrawMode: ActiveDrawMode;
  onStartDrawing: (type: 'source' | 'target' | 'nogo' | 'vehicle') => void;
  pendingDrawnPolygon: [number, number][] | null;
  pendingPlacedPoint: [number, number] | null;
  onClearPendingGeometry: () => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
  sentinel2Layer: Sentinel2LayerState;
  isLoadingSentinel2: boolean;
  onFetchSentinel2Data: () => void;
  onChangeSentinel2CurrentDate: (date: string) => void;
  onChangeSentinel2AggregationPeriod: (period: Sentinel2AggregationPeriod) => void;
  onToggleSentinel2Visibility: () => void;
  onChangeSentinel2Opacity: (opacity: number) => void;
  sentinel1Layer: Sentinel1LayerState;
  isLoadingSentinel1: boolean;
  onFetchSentinel1Data: () => void;
  onToggleSentinel1Visibility: () => void;
  onChangeSentinel1Opacity: (opacity: number) => void;
  glofasForecast: GlofasForecastState;
  isLoadingGlofas: boolean;
  onFetchGlofasForecast: () => void;
  onToggleGlofasOverlayVisibility: (band: number) => void;
  onChangeGlofasOverlayOpacity: (band: number, opacity: number) => void;
}

export const LeftControlPanel: React.FC<LeftControlPanelProps> = ({
  selectedPreset,
  onSelectPreset,
  sourceAreas,
  targetAreas,
  noGoAreas,
  vehicleFleets,
  remainingBySource,
  onAddSourceArea,
  onUpdateSourceArea,
  onDeleteSourceArea,
  onAddTargetArea,
  onUpdateTargetArea,
  onToggleDisableTargetArea,
  onAddNoGoArea,
  onUpdateNoGoArea,
  onDeleteNoGoArea,
  onAddVehicleFleet,
  onUpdateVehicleFleet,
  onDeleteVehicleFleet,
  onComputeRoutes,
  isComputingRoutes,
  hasComputedRoutes,
  onRunSimulation,
  onStopSimulation,
  onResetSimulation,
  isSimulating,
  simSpeed,
  onChangeSimSpeed,
  activeDrawMode,
  onStartDrawing,
  pendingDrawnPolygon,
  pendingPlacedPoint,
  onClearPendingGeometry,
  selectedEntityId,
  onSelectEntity,
  sentinel2Layer,
  isLoadingSentinel2,
  onFetchSentinel2Data,
  onChangeSentinel2CurrentDate,
  onChangeSentinel2AggregationPeriod,
  onToggleSentinel2Visibility,
  onChangeSentinel2Opacity,
  sentinel1Layer,
  isLoadingSentinel1,
  onFetchSentinel1Data,
  onToggleSentinel1Visibility,
  onChangeSentinel1Opacity,
  glofasForecast,
  isLoadingGlofas,
  onFetchGlofasForecast,
  onToggleGlofasOverlayVisibility,
  onChangeGlofasOverlayOpacity,
}) => {
  const [activeTab, setActiveTab] = useState<'sources' | 'targets' | 'nogos' | 'vehicles'>('sources');

  // Editing state for inline modal/form
  const [editingSourceId, setEditingSourceId] = useState<string | null>(null);
  const [editingTargetId, setEditingTargetId] = useState<string | null>(null);
  const [editingNoGoId, setEditingNoGoId] = useState<string | null>(null);
  const [editingVehicleId, setEditingVehicleId] = useState<string | null>(null);

  // Form states for creating or editing entities
  const [srcForm, setSrcForm] = useState({
    name: '',
    population: 1000,
    obedient: 70,
    autonomous: 20,
    random: 10,
  });

  const [tgtForm, setTgtForm] = useState({
    name: '',
    capacity: 25000,
  });

  const [nogoForm, setNogoForm] = useState({
    name: '',
  });

  const [vehForm, setVehForm] = useState({
    name: '',
    type: 'Bus' as VehicleType,
    count: 25,
    capacityPerUnit: 50,
  });

  // Trigger creation modal when polygon drawing or point placement finishes
  const isCreatingNewEntity = Boolean(pendingDrawnPolygon || pendingPlacedPoint);

  const handleSaveNewEntity = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSimulating) return;
    if (pendingDrawnPolygon && activeDrawMode?.type === 'source') {
      onAddSourceArea({
        name: srcForm.name || `Evacuation Zone #${sourceAreas.length + 1}`,
        population: Math.max(0, Number(srcForm.population) || 0),
        polygon: pendingDrawnPolygon,
        behavior: {
          obedient: Number(srcForm.obedient),
          autonomous: Number(srcForm.autonomous),
          random: Number(srcForm.random),
        },
      });
    } else if (pendingDrawnPolygon && activeDrawMode?.type === 'target') {
      onAddTargetArea({
        name: tgtForm.name || `Shelter Zone #${targetAreas.length + 1}`,
        capacity: Number(tgtForm.capacity) || 10000,
        polygon: pendingDrawnPolygon,
        disabled: false,
      });
    } else if (pendingDrawnPolygon && activeDrawMode?.type === 'nogo') {
      onAddNoGoArea({
        name: nogoForm.name || `Hazard Area #${noGoAreas.length + 1}`,
        polygon: pendingDrawnPolygon,
      });
    } else if (pendingPlacedPoint && activeDrawMode?.type === 'vehicle') {
      onAddVehicleFleet({
        name: vehForm.name || `${vehForm.type} Fleet #${vehicleFleets.length + 1}`,
        type: vehForm.type,
        count: Number(vehForm.count) || 10,
        capacityPerUnit: Number(vehForm.capacityPerUnit) || 50,
        location: pendingPlacedPoint,
      });
    }
    onClearPendingGeometry();
  };

  // Start editing an existing Source Area (only when paused)
  const startEditSource = (src: SourceArea, currentRemaining: number) => {
    if (isSimulating) return;
    setEditingSourceId(src.id);
    setSrcForm({
      name: src.name,
      population: currentRemaining,
      obedient: src.behavior.obedient,
      autonomous: src.behavior.autonomous,
      random: src.behavior.random,
    });
  };

  const saveEditSource = (src: SourceArea) => {
    if (isSimulating) return;
    onUpdateSourceArea({
      ...src,
      name: srcForm.name,
      population: Math.max(0, Number(srcForm.population)),
      behavior: {
        obedient: Number(srcForm.obedient),
        autonomous: Number(srcForm.autonomous),
        random: Number(srcForm.random),
      },
    });
    setEditingSourceId(null);
  };

  // Start editing an existing Target Area (only when paused)
  const startEditTarget = (tgt: TargetArea) => {
    if (isSimulating) return;
    setEditingTargetId(tgt.id);
    setTgtForm({
      name: tgt.name,
      capacity: tgt.capacity,
    });
  };

  const saveEditTarget = (tgt: TargetArea) => {
    if (isSimulating) return;
    onUpdateTargetArea({
      ...tgt,
      name: tgtForm.name,
      capacity: Number(tgtForm.capacity),
    });
    setEditingTargetId(null);
  };

  // Start editing an existing No-Go Area (only when paused)
  const startEditNoGo = (nogo: NoGoArea) => {
    if (isSimulating) return;
    setEditingNoGoId(nogo.id);
    setNogoForm({ name: nogo.name });
  };

  const saveEditNoGo = (nogo: NoGoArea) => {
    if (isSimulating) return;
    onUpdateNoGoArea({
      ...nogo,
      name: nogoForm.name,
    });
    setEditingNoGoId(null);
  };

  // Start editing an existing Vehicle Fleet (only when paused)
  const startEditVehicle = (veh: VehicleFleet) => {
    if (isSimulating) return;
    setEditingVehicleId(veh.id);
    setVehForm({
      name: veh.name,
      type: veh.type,
      count: veh.count,
      capacityPerUnit: veh.capacityPerUnit,
    });
  };

  const saveEditVehicle = (veh: VehicleFleet) => {
    if (isSimulating) return;
    onUpdateVehicleFleet({
      ...veh,
      name: vehForm.name,
      type: vehForm.type,
      count: Number(vehForm.count),
      capacityPerUnit: Number(vehForm.capacityPerUnit),
    });
    setEditingVehicleId(null);
  };

  return (
    <aside className="cockpit-left-panel" id="left-parameters-panel">
      {/* Application Brand Header */}
      <header className="panel-brand-header">
        <div className="brand-title-row">
          <div className="brand-badge">EVAC-OPS</div>
          <h1 className="app-main-title">Evacuation Command</h1>
        </div>
        <p className="brand-subtitle">OSM Tactical Routing & Crowd Simulation</p>
      </header>

      {/* Preset Scenario Selector */}
      <section className="panel-section scenario-selector-section">
        <label htmlFor="preset-scenario-select" className="section-label">
          PRESET SCENARIO
        </label>
        <select
          id="preset-scenario-select"
          className="tactical-select"
          value={selectedPreset}
          disabled={isSimulating}
          onChange={(e) => onSelectPreset(e.target.value as PresetScenarioId)}
        >
          <option value="brussels">Brussels — Capital Region Evacuation</option>
          <option value="paris">Paris — Seine Bridges Closure Scenario</option>
          <option value="custom">Custom / Blank Scenario</option>
        </select>
      </section>

      {/* Primary Action & Simulation Execution Controls */}
      <section className="panel-section execution-controls-section">
        <div className="section-label">EXECUTION & SIMULATION</div>

        <button
          id="btn-compute-routes"
          type="button"
          className="btn-primary-action compute-btn"
          onClick={onComputeRoutes}
          disabled={isComputingRoutes || isSimulating || sourceAreas.length === 0 || targetAreas.length === 0}
        >
          <Route size={16} />
          <span>
            {isComputingRoutes ? 'Computing OSRM Routes...' : 'Compute evacuation routes'}
          </span>
        </button>

        <div className="sim-buttons-grid">
          <button
            id="btn-run-simulation"
            type="button"
            className={`btn-sim-action run-btn ${isSimulating ? 'active-running' : ''}`}
            onClick={onRunSimulation}
            disabled={(!hasComputedRoutes && !isSimulating) || isComputingRoutes}
            title={!hasComputedRoutes ? 'Compute evacuation routes first' : 'Run / Resume simulation'}
          >
            <Play size={15} />
            <span>Run simulation</span>
          </button>

          <button
            id="btn-stop-simulation"
            type="button"
            className="btn-sim-action stop-btn"
            onClick={onStopSimulation}
            disabled={!isSimulating}
          >
            <Pause size={15} />
            <span>Pause simulation</span>
          </button>

          <button
            id="btn-reset-simulation"
            type="button"
            className="btn-sim-action reset-btn"
            onClick={onResetSimulation}
          >
            <RotateCcw size={15} />
            <span>Reset simulation</span>
          </button>
        </div>

        <div className="sim-speed-bar">
          <span className="speed-label">Playback Speed:</span>
          <div className="speed-pills">
            {[1, 2, 5, 10].map((spd) => (
              <button
                key={spd}
                type="button"
                className={`speed-pill ${simSpeed === spd ? 'active' : ''}`}
                onClick={() => onChangeSimSpeed(spd)}
              >
                {spd}x
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Pause Requirement Notice Banner when Simulation is Active */}
      {isSimulating && (
        <div
          style={{
            margin: '0 14px 8px 14px',
            padding: '8px 10px',
            borderRadius: '6px',
            background: 'rgba(245, 158, 11, 0.14)',
            border: '1px solid rgba(245, 158, 11, 0.45)',
            color: '#fbbf24',
            fontSize: '0.74rem',
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            lineHeight: 1.35,
          }}
        >
          <Lock size={14} style={{ flexShrink: 0 }} />
          <span>
            <strong>Editing Locked:</strong> Pause simulation first to add, modify, disable, or delete areas and vehicles.
          </span>
        </div>
      )}

      {/* Modal Form when finishing Map Polygon Drawing or Point Placement */}
      {isCreatingNewEntity && (
        <section className="new-entity-modal-card">
          <div className="modal-card-header">
            <span>
              Configure New{' '}
              {activeDrawMode?.type === 'source'
                ? 'Source Evacuation Area'
                : activeDrawMode?.type === 'target'
                ? 'Target Shelter Area'
                : activeDrawMode?.type === 'nogo'
                ? 'No-Go Hazard Area'
                : 'Vehicle Fleet Depot'}
            </span>
            <button type="button" onClick={onClearPendingGeometry} className="btn-icon-only">
              <X size={15} />
            </button>
          </div>
          <form onSubmit={handleSaveNewEntity} className="entity-form">
            {activeDrawMode?.type === 'source' && (
              <>
                <div className="form-group">
                  <label>Zone Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Central Station"
                    value={srcForm.name}
                    onChange={(e) => setSrcForm({ ...srcForm, name: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Population to Evacuate</label>
                  <input
                    type="number"
                    min={0}
                    max={500000}
                    required
                    value={srcForm.population}
                    onChange={(e) => setSrcForm({ ...srcForm, population: Number(e.target.value) })}
                  />
                </div>
                <div className="form-group">
                  <label>Behavioral Split (Obedient / Autonomous / Random %)</label>
                  <div className="behavior-inputs-row">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={srcForm.obedient}
                      onChange={(e) => {
                        const ob = Number(e.target.value);
                        const rem = Math.max(0, 100 - ob);
                        setSrcForm({
                          ...srcForm,
                          obedient: ob,
                          autonomous: Math.round(rem * 0.65),
                          random: rem - Math.round(rem * 0.65),
                        });
                      }}
                      title="Obedient %"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={srcForm.autonomous}
                      onChange={(e) => {
                        const au = Number(e.target.value);
                        const rd = Math.max(0, 100 - srcForm.obedient - au);
                        setSrcForm({ ...srcForm, autonomous: au, random: rd });
                      }}
                      title="Autonomous %"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={srcForm.random}
                      readOnly
                      title="Random %"
                    />
                  </div>
                </div>
              </>
            )}

            {activeDrawMode?.type === 'target' && (
              <>
                <div className="form-group">
                  <label>Target Shelter Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Olympic Stadium"
                    value={tgtForm.name}
                    onChange={(e) => setTgtForm({ ...tgtForm, name: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Shelter Capacity (People)</label>
                  <input
                    type="number"
                    min={100}
                    max={1000000}
                    required
                    value={tgtForm.capacity}
                    onChange={(e) => setTgtForm({ ...tgtForm, capacity: Number(e.target.value) })}
                  />
                </div>
              </>
            )}

            {activeDrawMode?.type === 'nogo' && (
              <div className="form-group">
                <label>No-Go Hazard Zone Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g., Collapsed Bridge Sector"
                  value={nogoForm.name}
                  onChange={(e) => setNogoForm({ ...nogoForm, name: e.target.value })}
                />
              </div>
            )}

            {activeDrawMode?.type === 'vehicle' && (
              <>
                <div className="form-group">
                  <label>Fleet / Depot Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g., Transit Bus Depot North"
                    value={vehForm.name}
                    onChange={(e) => setVehForm({ ...vehForm, name: e.target.value })}
                  />
                </div>
                <div className="form-row-2">
                  <div className="form-group">
                    <label>Vehicle Type</label>
                    <select
                      value={vehForm.type}
                      onChange={(e) =>
                        setVehForm({
                          ...vehForm,
                          type: e.target.value as VehicleType,
                          capacityPerUnit: e.target.value === 'Bus' ? 50 : 4,
                        })
                      }
                    >
                      <option value="Bus">Bus (50 cap)</option>
                      <option value="Private Car">Private Car (4 cap)</option>
                      <option value="Shuttle">Shuttle (15 cap)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Unit Count</label>
                    <input
                      type="number"
                      min={1}
                      max={2000}
                      value={vehForm.count}
                      onChange={(e) => setVehForm({ ...vehForm, count: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label>Capacity per Vehicle</label>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={vehForm.capacityPerUnit}
                    onChange={(e) =>
                      setVehForm({ ...vehForm, capacityPerUnit: Number(e.target.value) })
                    }
                  />
                </div>
              </>
            )}

            <div className="form-actions-row">
              <button type="submit" className="btn-save-entity">
                <Check size={14} />
                <span>Save Entity</span>
              </button>
              <button
                type="button"
                className="btn-cancel-entity"
                onClick={onClearPendingGeometry}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Entity Category Navigation Tabs */}
      <nav className="entity-tabs-nav">
        <button
          type="button"
          className={`entity-tab-btn ${activeTab === 'sources' ? 'active' : ''}`}
          onClick={() => setActiveTab('sources')}
        >
          <Users size={14} />
          <span>Sources ({sourceAreas.length})</span>
        </button>
        <button
          type="button"
          className={`entity-tab-btn ${activeTab === 'targets' ? 'active' : ''}`}
          onClick={() => setActiveTab('targets')}
        >
          <Building2 size={14} />
          <span>Targets ({targetAreas.length})</span>
        </button>
        <button
          type="button"
          className={`entity-tab-btn ${activeTab === 'nogos' ? 'active' : ''}`}
          onClick={() => setActiveTab('nogos')}
        >
          <ShieldAlert size={14} />
          <span>No-Go ({noGoAreas.length})</span>
        </button>
        <button
          type="button"
          className={`entity-tab-btn ${activeTab === 'vehicles' ? 'active' : ''}`}
          onClick={() => setActiveTab('vehicles')}
        >
          <Bus size={14} />
          <span>Vehicles ({vehicleFleets.length})</span>
        </button>
      </nav>

      {/* Scrollable Entity List Container */}
      <div className="entity-list-scroll-area">
        {/* TAB 1: SOURCE AREAS */}
        {activeTab === 'sources' && (
          <div className="entity-tab-content">
            <div className="tab-header-action">
              <span className="tab-desc">Evacuation Zones (Polygons)</span>
              <button
                type="button"
                className="btn-add-entity source-add"
                disabled={isSimulating}
                title={isSimulating ? 'Pause simulation to add a Source Area' : 'Draw new Source Area on map'}
                onClick={() => {
                  setSrcForm({
                    name: `Source Zone #${sourceAreas.length + 1}`,
                    population: 1200,
                    obedient: 70,
                    autonomous: 20,
                    random: 10,
                  });
                  onStartDrawing('source');
                }}
              >
                <Plus size={14} />
                <span>Add Source Area</span>
              </button>
            </div>

            {sourceAreas.map((src) => {
              const isEditing = editingSourceId === src.id;
              const isSelected = selectedEntityId === src.id;
              const remainingPeople = remainingBySource[src.id] ?? src.population;
              const canDeleteSource = !isSimulating && remainingPeople === 0;

              return (
                <div
                  key={src.id}
                  className={`entity-item-card source-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectEntity(src.id)}
                >
                  {isEditing ? (
                    <div className="inline-edit-form" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={srcForm.name}
                        onChange={(e) => setSrcForm({ ...srcForm, name: e.target.value })}
                        placeholder="Zone Name"
                      />
                      <div className="edit-row">
                        <label>People in Area:</label>
                        <input
                          type="number"
                          min={0}
                          value={srcForm.population}
                          onChange={(e) =>
                            setSrcForm({ ...srcForm, population: Math.max(0, Number(e.target.value)) })
                          }
                        />
                      </div>
                      <div className="edit-row">
                        <label>Ob/Au/Rd %:</label>
                        <div className="mini-3-inputs">
                          <input
                            type="number"
                            value={srcForm.obedient}
                            onChange={(e) =>
                              setSrcForm({ ...srcForm, obedient: Number(e.target.value) })
                            }
                          />
                          <input
                            type="number"
                            value={srcForm.autonomous}
                            onChange={(e) =>
                              setSrcForm({ ...srcForm, autonomous: Number(e.target.value) })
                            }
                          />
                          <input
                            type="number"
                            value={srcForm.random}
                            onChange={(e) =>
                              setSrcForm({ ...srcForm, random: Number(e.target.value) })
                            }
                          />
                        </div>
                      </div>
                      <div className="inline-edit-actions">
                        <button
                          type="button"
                          className="btn-inline-save"
                          onClick={() => saveEditSource(src)}
                        >
                          <Check size={13} /> Save
                        </button>
                        <button
                          type="button"
                          className="btn-inline-cancel"
                          onClick={() => setEditingSourceId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="entity-card-top">
                        <div className="entity-title-group">
                          <span className="entity-dot source-dot" />
                          <span className="entity-name">{src.name}</span>
                        </div>
                        <div className="entity-actions">
                          <button
                            type="button"
                            className="btn-entity-icon"
                            disabled={isSimulating}
                            title={
                              isSimulating
                                ? 'Pause simulation to modify Source Area or people count'
                                : 'Modify Source Area & People Count'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditSource(src, remainingPeople);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon delete"
                            disabled={!canDeleteSource}
                            style={{
                              opacity: canDeleteSource ? 1 : 0.35,
                              cursor: canDeleteSource ? 'pointer' : 'not-allowed',
                            }}
                            title={
                              isSimulating
                                ? 'Pause simulation to modify or delete areas'
                                : remainingPeople > 0
                                ? `Cannot remove Source Area while ${remainingPeople.toLocaleString()} people remain inside`
                                : 'Delete Source Area (0 people remaining)'
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              if (canDeleteSource) {
                                onDeleteSourceArea(src.id);
                              }
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="entity-card-metrics">
                        <span className="metric-pill">
                          Remaining: <strong>{remainingPeople.toLocaleString()}</strong> people
                        </span>
                        <span className="metric-pill behavior-pill">
                          Ob {src.behavior.obedient}% · Au {src.behavior.autonomous}% · Rd{' '}
                          {src.behavior.random}%
                        </span>
                      </div>
                      {remainingPeople > 0 && !isSimulating && (
                        <div
                          style={{
                            marginTop: '4px',
                            fontSize: '0.68rem',
                            color: '#94a3b8',
                          }}
                        >
                          🔒 Deletion disabled while people remain inside (click ✏️ to edit count)
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 2: TARGET AREAS */}
        {activeTab === 'targets' && (
          <div className="entity-tab-content">
            <div className="tab-header-action">
              <span className="tab-desc">Safe Shelters (Cannot be removed; can be disabled)</span>
              <button
                type="button"
                className="btn-add-entity target-add"
                disabled={isSimulating}
                title={isSimulating ? 'Pause simulation to add a Target Area' : 'Draw new Target Area on map'}
                onClick={() => {
                  setTgtForm({
                    name: `Shelter Zone #${targetAreas.length + 1}`,
                    capacity: 25000,
                  });
                  onStartDrawing('target');
                }}
              >
                <Plus size={14} />
                <span>Add Target Area</span>
              </button>
            </div>

            {targetAreas.map((tgt) => {
              const isEditing = editingTargetId === tgt.id;
              const isSelected = selectedEntityId === tgt.id;
              const isDisabled = Boolean(tgt.disabled);

              return (
                <div
                  key={tgt.id}
                  className={`entity-item-card target-card ${isSelected ? 'selected' : ''}`}
                  style={{
                    opacity: isDisabled ? 0.72 : 1,
                    borderColor: isDisabled ? '#64748b' : undefined,
                  }}
                  onClick={() => onSelectEntity(tgt.id)}
                >
                  {isEditing ? (
                    <div className="inline-edit-form" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={tgtForm.name}
                        onChange={(e) => setTgtForm({ ...tgtForm, name: e.target.value })}
                        placeholder="Shelter Name"
                      />
                      <div className="edit-row">
                        <label>Capacity:</label>
                        <input
                          type="number"
                          value={tgtForm.capacity}
                          onChange={(e) =>
                            setTgtForm({ ...tgtForm, capacity: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="inline-edit-actions">
                        <button
                          type="button"
                          className="btn-inline-save"
                          onClick={() => saveEditTarget(tgt)}
                        >
                          <Check size={13} /> Save
                        </button>
                        <button
                          type="button"
                          className="btn-inline-cancel"
                          onClick={() => setEditingTargetId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="entity-card-top">
                        <div className="entity-title-group">
                          <span
                            className="entity-dot target-dot"
                            style={{ background: isDisabled ? '#64748b' : undefined }}
                          />
                          <span className="entity-name">
                            {tgt.name}
                            {isDisabled && (
                              <span
                                style={{
                                  marginLeft: '6px',
                                  fontSize: '0.68rem',
                                  color: '#f87171',
                                  fontWeight: 700,
                                }}
                              >
                                [DISABLED]
                              </span>
                            )}
                          </span>
                        </div>
                        <div className="entity-actions">
                          <button
                            type="button"
                            className="btn-entity-icon"
                            disabled={isSimulating}
                            title={isSimulating ? 'Pause simulation to modify Target Area' : 'Modify Target Shelter'}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditTarget(tgt);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon"
                            disabled={isSimulating}
                            title={
                              isSimulating
                                ? 'Pause simulation to disable/enable Target Area'
                                : isDisabled
                                ? 'Enable Target Area to receive evacuees'
                                : 'Disable Target Area (will receive no more people)'
                            }
                            style={{
                              padding: '3px 7px',
                              borderRadius: '4px',
                              fontSize: '0.7rem',
                              fontWeight: 600,
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              background: isDisabled
                                ? 'rgba(16, 185, 129, 0.18)'
                                : 'rgba(239, 68, 68, 0.16)',
                              color: isDisabled ? '#34d399' : '#f87171',
                              border: isDisabled
                                ? '1px solid rgba(16, 185, 129, 0.4)'
                                : '1px solid rgba(239, 68, 68, 0.4)',
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              onToggleDisableTargetArea(tgt.id);
                            }}
                          >
                            {isDisabled ? (
                              <>
                                <CheckCircle2 size={12} /> Enable
                              </>
                            ) : (
                              <>
                                <Ban size={12} /> Disable
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="entity-card-metrics">
                        <span className="metric-pill">
                          Capacity: <strong>{tgt.capacity.toLocaleString()}</strong> people
                        </span>
                        <span className="metric-pill">
                          Occupied: <strong>{tgt.currentOccupancy.toLocaleString()}</strong>
                        </span>
                        {isDisabled && (
                          <span className="metric-pill hazard-pill">
                            🚫 Receives No More People
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 3: NO-GO AREAS */}
        {activeTab === 'nogos' && (
          <div className="entity-tab-content">
            <div className="tab-header-action">
              <span className="tab-desc">Blocked / Hazard Zones</span>
              <button
                type="button"
                className="btn-add-entity nogo-add"
                disabled={isSimulating}
                title={isSimulating ? 'Pause simulation to add a No-Go Area' : 'Draw new No-Go Area on map'}
                onClick={() => {
                  setNogoForm({
                    name: `Hazard Sector #${noGoAreas.length + 1}`,
                  });
                  onStartDrawing('nogo');
                }}
              >
                <Plus size={14} />
                <span>Add No-Go Area</span>
              </button>
            </div>

            {noGoAreas.map((nogo) => {
              const isEditing = editingNoGoId === nogo.id;
              const isSelected = selectedEntityId === nogo.id;

              return (
                <div
                  key={nogo.id}
                  className={`entity-item-card nogo-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectEntity(nogo.id)}
                >
                  {isEditing ? (
                    <div className="inline-edit-form" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={nogoForm.name}
                        onChange={(e) => setNogoForm({ name: e.target.value })}
                      />
                      <div className="inline-edit-actions">
                        <button
                          type="button"
                          className="btn-inline-save"
                          onClick={() => saveEditNoGo(nogo)}
                        >
                          <Check size={13} /> Save
                        </button>
                        <button
                          type="button"
                          className="btn-inline-cancel"
                          onClick={() => setEditingNoGoId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="entity-card-top">
                        <div className="entity-title-group">
                          <span className="entity-dot nogo-dot" />
                          <span className="entity-name">{nogo.name}</span>
                        </div>
                        <div className="entity-actions">
                          <button
                            type="button"
                            className="btn-entity-icon"
                            disabled={isSimulating}
                            title={isSimulating ? 'Pause simulation to modify No-Go Area' : 'Modify No-Go Area'}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditNoGo(nogo);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon delete"
                            disabled={isSimulating}
                            title={isSimulating ? 'Pause simulation to delete No-Go Area' : 'Delete No-Go Area'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteNoGoArea(nogo.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="entity-card-metrics">
                        <span className="metric-pill hazard-pill">
                          ⛔ Strict Routing Exclusion Active
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 4: VEHICLE FLEETS */}
        {activeTab === 'vehicles' && (
          <div className="entity-tab-content">
            <div className="tab-header-action">
              <span className="tab-desc">Evacuation Transport Fleets</span>
              <button
                type="button"
                className="btn-add-entity vehicle-add"
                disabled={isSimulating}
                title={isSimulating ? 'Pause simulation to add a Vehicle Fleet' : 'Place new Vehicle Fleet on map'}
                onClick={() => {
                  setVehForm({
                    name: `Bus Fleet #${vehicleFleets.length + 1}`,
                    type: 'Bus',
                    count: 50,
                    capacityPerUnit: 50,
                  });
                  onStartDrawing('vehicle');
                }}
              >
                <MapPin size={14} />
                <span>Add Vehicle Fleet</span>
              </button>
            </div>

            {vehicleFleets.map((veh) => {
              const isEditing = editingVehicleId === veh.id;
              const isSelected = selectedEntityId === veh.id;
              const totalCap = veh.count * veh.capacityPerUnit;

              return (
                <div
                  key={veh.id}
                  className={`entity-item-card vehicle-card ${isSelected ? 'selected' : ''}`}
                  onClick={() => onSelectEntity(veh.id)}
                >
                  {isEditing ? (
                    <div className="inline-edit-form" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="text"
                        value={vehForm.name}
                        onChange={(e) => setVehForm({ ...vehForm, name: e.target.value })}
                      />
                      <div className="edit-row">
                        <label>Count:</label>
                        <input
                          type="number"
                          value={vehForm.count}
                          onChange={(e) =>
                            setVehForm({ ...vehForm, count: Number(e.target.value) })
                          }
                        />
                        <label>Cap/Unit:</label>
                        <input
                          type="number"
                          value={vehForm.capacityPerUnit}
                          onChange={(e) =>
                            setVehForm({ ...vehForm, capacityPerUnit: Number(e.target.value) })
                          }
                        />
                      </div>
                      <div className="inline-edit-actions">
                        <button
                          type="button"
                          className="btn-inline-save"
                          onClick={() => saveEditVehicle(veh)}
                        >
                          <Check size={13} /> Save
                        </button>
                        <button
                          type="button"
                          className="btn-inline-cancel"
                          onClick={() => setEditingVehicleId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="entity-card-top">
                        <div className="entity-title-group">
                          <span className="entity-dot vehicle-dot" />
                          <span className="entity-name">{veh.name}</span>
                        </div>
                        <div className="entity-actions">
                          <button
                            type="button"
                            className="btn-entity-icon"
                            disabled={isSimulating}
                            title={isSimulating ? 'Pause simulation to modify Vehicle Fleet' : 'Modify Vehicle Fleet'}
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditVehicle(veh);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon delete"
                            disabled={isSimulating}
                            title={isSimulating ? 'Pause simulation to delete Vehicle Fleet' : 'Delete Vehicle Fleet'}
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteVehicleFleet(veh.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="entity-card-metrics">
                        <span className="metric-pill">
                          <strong>{veh.count}</strong> × {veh.type} ({veh.capacityPerUnit} seats)
                        </span>
                        <span className="metric-pill">
                          Total Cap: <strong>{totalCap.toLocaleString()}</strong>
                        </span>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Space Data Section (Placed below all other sections on the left panel) */}
      <section className="panel-section space-data-section">
        <div className="section-label">SPACE DATA</div>

        {/* Text box at the top of the Space Data panel with the current date */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '8px',
            fontSize: '0.74rem',
            color: '#cbd5e1',
          }}
        >
          <label htmlFor="space-data-current-date" style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>
            Current Date:
          </label>
          <input
            id="space-data-current-date"
            type="text"
            value={sentinel2Layer.currentDate}
            onChange={(e) => onChangeSentinel2CurrentDate(e.target.value)}
            style={{
              flex: 1,
              padding: '4px 8px',
              borderRadius: '5px',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              background: 'rgba(15, 23, 42, 0.85)',
              color: '#f8fafc',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              textAlign: 'center',
            }}
          />
        </div>

        {/* Aggregation period dropdown selector */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '8px',
            marginBottom: '8px',
            fontSize: '0.74rem',
            color: '#cbd5e1',
          }}
        >
          <label
            htmlFor="space-data-aggregation-period"
            style={{ fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            aggregation period:
          </label>
          <select
            id="space-data-aggregation-period"
            className="tactical-select"
            value={sentinel2Layer.aggregationPeriod}
            onChange={(e) =>
              onChangeSentinel2AggregationPeriod(e.target.value as Sentinel2AggregationPeriod)
            }
            style={{
              flex: 1,
              padding: '4px 6px',
              fontSize: '0.74rem',
            }}
          >
            <option value="last week">last week</option>
            <option value="last 2 weeks">last 2 weeks</option>
            <option value="last month">last month</option>
            <option value="last three months">last three months</option>
            <option value="last six months">last six months</option>
            <option value="last year">last year</option>
          </select>
        </div>

        {/* Smaller Sentinel 2 Optical Data button */}
        <button
          id="btn-sentinel2-optical-data"
          type="button"
          className="btn-primary-action"
          style={{
            padding: '6px 10px',
            fontSize: '0.76rem',
            minHeight: '30px',
            background: sentinel2Layer.active && sentinel2Layer.visible
              ? 'linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%)'
              : 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            border: sentinel2Layer.active && sentinel2Layer.visible
              ? '1px solid #38bdf8'
              : '1px solid rgba(56, 189, 248, 0.35)',
            color: '#f8fafc',
          }}
          onClick={onFetchSentinel2Data}
          disabled={isLoadingSentinel2}
        >
          <Satellite size={14} style={{ color: '#38bdf8' }} />
          <span>
            {isLoadingSentinel2
              ? 'Calling Google Earth Engine...'
              : 'Sentinel 2 Optical Data'}
          </span>
        </button>

        {/* Sentinel 1 SAR Data button below Sentinel 2 */}
        <button
          id="btn-sentinel1-sar-data"
          type="button"
          className="btn-primary-action"
          style={{
            marginTop: '6px',
            padding: '6px 10px',
            fontSize: '0.76rem',
            minHeight: '30px',
            background: sentinel1Layer.active && sentinel1Layer.visible
              ? 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)'
              : 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
            border: sentinel1Layer.active && sentinel1Layer.visible
              ? '1px solid #a78bfa'
              : '1px solid rgba(167, 139, 250, 0.35)',
            color: '#f8fafc',
          }}
          onClick={onFetchSentinel1Data}
          disabled={isLoadingSentinel1}
        >
          <Satellite size={14} style={{ color: '#a78bfa' }} />
          <span>
            {isLoadingSentinel1
              ? 'Calling Google Earth Engine...'
              : 'Sentinel 1 SAR Data'}
          </span>
        </button>

        {sentinel2Layer.active && (
          <div
            style={{
              marginTop: '8px',
              padding: '7px 9px',
              borderRadius: '6px',
              background: 'rgba(15, 23, 42, 0.72)',
              border: '1px solid rgba(56, 189, 248, 0.28)',
              fontSize: '0.71rem',
              color: '#cbd5e1',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '5px',
              }}
            >
              <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                COPERNICUS/S2_SR_HARMONIZED
              </span>
              <button
                type="button"
                onClick={onToggleSentinel2Visibility}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  background: sentinel2Layer.visible
                    ? 'rgba(14, 165, 233, 0.2)'
                    : 'rgba(51, 65, 85, 0.5)',
                  color: sentinel2Layer.visible ? '#7dd3fc' : '#94a3b8',
                  fontSize: '0.66rem',
                  cursor: 'pointer',
                }}
              >
                {sentinel2Layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                <span>{sentinel2Layer.visible ? 'Visible' : 'Hidden'}</span>
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '0.68rem' }}>
              <div>
                <strong>Dates:</strong> {sentinel2Layer.dateRange[0]} &rarr; {sentinel2Layer.dateRange[1]}
              </div>
              <div>
                <strong>Composite:</strong> Median ({sentinel2Layer.imageCount} scenes, B4/B3/B2 RGB)
              </div>
            </div>

            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.66rem',
              }}
            >
              <span>Opacity:</span>
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.05}
                value={sentinel2Layer.opacity}
                onChange={(e) => onChangeSentinel2Opacity(Number(e.target.value))}
                style={{ flex: 1, accentColor: '#38bdf8', cursor: 'pointer' }}
              />
              <span style={{ minWidth: '28px', textAlign: 'right' }}>
                {Math.round(sentinel2Layer.opacity * 100)}%
              </span>
            </div>
          </div>
        )}

        {sentinel1Layer.active && (
          <div
            style={{
              marginTop: '8px',
              padding: '7px 9px',
              borderRadius: '6px',
              background: 'rgba(15, 23, 42, 0.72)',
              border: '1px solid rgba(167, 139, 250, 0.3)',
              fontSize: '0.71rem',
              color: '#cbd5e1',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '5px',
              }}
            >
              <span style={{ color: '#a78bfa', fontWeight: 600 }}>
                COPERNICUS/S1_GRD
              </span>
              <button
                type="button"
                onClick={onToggleSentinel1Visibility}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  background: sentinel1Layer.visible
                    ? 'rgba(139, 92, 246, 0.22)'
                    : 'rgba(51, 65, 85, 0.5)',
                  color: sentinel1Layer.visible ? '#c4b5fd' : '#94a3b8',
                  fontSize: '0.66rem',
                  cursor: 'pointer',
                }}
              >
                {sentinel1Layer.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                <span>{sentinel1Layer.visible ? 'Visible' : 'Hidden'}</span>
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '0.68rem' }}>
              <div>
                <strong>Dates:</strong> {sentinel1Layer.dateRange[0]} &rarr; {sentinel1Layer.dateRange[1]}
              </div>
              <div>
                <strong>Composite:</strong> False Color ({sentinel1Layer.imageCount} scenes, VV / VH / VV&divide;VH)
              </div>
            </div>

            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.66rem',
              }}
            >
              <span>Opacity:</span>
              <input
                type="range"
                min={0.15}
                max={1}
                step={0.05}
                value={sentinel1Layer.opacity}
                onChange={(e) => onChangeSentinel1Opacity(Number(e.target.value))}
                style={{ flex: 1, accentColor: '#a78bfa', cursor: 'pointer' }}
              />
              <span style={{ minWidth: '28px', textAlign: 'right' }}>
                {Math.round(sentinel1Layer.opacity * 100)}%
              </span>
            </div>
          </div>
        )}

        {/* CEMS Early Warning River Discharge Prediction Section under Space Data */}
        <div
          id="cems-glofas-section"
          style={{
            marginTop: '12px',
            paddingTop: '10px',
            borderTop: '1px solid rgba(148, 163, 184, 0.25)',
          }}
        >
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              color: '#fca5a5',
              marginBottom: '6px',
              letterSpacing: '0.02em',
            }}
          >
            CEMS Early Warning River Discharge Prediction
          </div>

          <button
            id="btn-cems-glofas-forecast"
            type="button"
            className="btn-primary-action"
            style={{
              padding: '6px 10px',
              fontSize: '0.75rem',
              minHeight: '30px',
              background: glofasForecast.active
                ? 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)'
                : 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)',
              border: glofasForecast.active
                ? '1px solid #f87171'
                : '1px solid rgba(248, 113, 113, 0.4)',
              color: '#f8fafc',
            }}
            onClick={onFetchGlofasForecast}
            disabled={isLoadingGlofas}
          >
            <Satellite size={14} style={{ color: '#f87171' }} />
            <span>
              {isLoadingGlofas
                ? 'Downloading CEMS GloFAS Forecast...'
                : 'Load 24h / 48h / 72h River Discharge (100 km)'}
            </span>
          </button>

          {glofasForecast.active && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 9px',
                borderRadius: '6px',
                background: 'rgba(15, 23, 42, 0.78)',
                border: '1px solid rgba(248, 113, 113, 0.35)',
                fontSize: '0.7rem',
                color: '#cbd5e1',
              }}
            >
              <div style={{ marginBottom: '6px', fontSize: '0.67rem', color: '#e2e8f0' }}>
                <div>
                  <strong>Date:</strong> {glofasForecast.date} &bull;{' '}
                  <strong>Radius:</strong> {glofasForecast.radiusKm} km
                </div>
                <div>
                  <strong>Storage:</strong>{' '}
                  <code style={{ fontSize: '0.63rem', color: '#fca5a5' }}>
                    {glofasForecast.geotiffPath || 'tmp_downloads/'}
                  </code>{' '}
                  ({glofasForecast.cached ? 'Cached today' : 'Downloaded today'})
                </div>
              </div>

              {/* Red Scale Color Map Legend: White (0) -> Red (80), Clipped at 80 */}
              <div
                style={{
                  marginBottom: '8px',
                  padding: '6px 8px',
                  borderRadius: '5px',
                  background: 'rgba(30, 41, 59, 0.75)',
                  border: '1px solid rgba(248, 113, 113, 0.25)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.65rem',
                    fontWeight: 600,
                    color: '#fecaca',
                    marginBottom: '4px',
                  }}
                >
                  <span>Color Map: White (0) &rarr; Red (80)</span>
                  <span>Clipped &le; 80 m&sup3;/s</span>
                </div>
                <div
                  style={{
                    height: '10px',
                    width: '100%',
                    borderRadius: '3px',
                    background:
                      'linear-gradient(to right, #ffffff 0%, #fecaca 25%, #f87171 50%, #ef4444 75%, #ff0000 100%)',
                    border: '1px solid rgba(255,255,255,0.35)',
                  }}
                />
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: '3px',
                    fontSize: '0.62rem',
                    fontFamily: 'monospace',
                    color: '#cbd5e1',
                  }}
                >
                  <span>0</span>
                  <span>20</span>
                  <span>40</span>
                  <span>60</span>
                  <span>80</span>
                </div>
              </div>

              {/* Three Overlays: 24h, 48h, 72h Forecast */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {glofasForecast.overlays.map((ov) => (
                  <div
                    key={ov.band}
                    style={{
                      padding: '5px 7px',
                      borderRadius: '5px',
                      background: 'rgba(15, 23, 42, 0.85)',
                      border: ov.visible
                        ? '1px solid rgba(248, 113, 113, 0.45)'
                        : '1px solid rgba(100, 116, 139, 0.3)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '3px',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#fca5a5', fontSize: '0.68rem' }}>
                        Band {ov.band}: {ov.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => onToggleGlofasOverlayVisibility(ov.band)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          border: '1px solid rgba(148, 163, 184, 0.3)',
                          background: ov.visible
                            ? 'rgba(239, 68, 68, 0.25)'
                            : 'rgba(51, 65, 85, 0.5)',
                          color: ov.visible ? '#fecaca' : '#94a3b8',
                          fontSize: '0.64rem',
                          cursor: 'pointer',
                        }}
                      >
                        {ov.visible ? <Eye size={11} /> : <EyeOff size={11} />}
                        <span>{ov.visible ? 'Visible' : 'Hidden'}</span>
                      </button>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '0.63rem',
                      }}
                    >
                      <span>Opacity:</span>
                      <input
                        type="range"
                        min={0.15}
                        max={1}
                        step={0.05}
                        value={ov.opacity}
                        onChange={(e) =>
                          onChangeGlofasOverlayOpacity(ov.band, Number(e.target.value))
                        }
                        style={{ flex: 1, accentColor: '#ef4444', cursor: 'pointer' }}
                      />
                      <span style={{ minWidth: '28px', textAlign: 'right' }}>
                        {Math.round(ov.opacity * 100)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </aside>
  );
};
