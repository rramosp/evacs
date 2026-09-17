import React, { useState } from 'react';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  PresetScenarioId,
  ActiveDrawMode,
  VehicleType,
} from '../types/evacuation';
import {
  Route,
  Play,
  Square,
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
} from 'lucide-react';

interface LeftControlPanelProps {
  selectedPreset: PresetScenarioId;
  onSelectPreset: (preset: PresetScenarioId) => void;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
  onAddSourceArea: (src: Omit<SourceArea, 'id'>) => void;
  onUpdateSourceArea: (src: SourceArea) => void;
  onDeleteSourceArea: (id: string) => void;
  onAddTargetArea: (tgt: Omit<TargetArea, 'id' | 'currentOccupancy'>) => void;
  onUpdateTargetArea: (tgt: TargetArea) => void;
  onDeleteTargetArea: (id: string) => void;
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
}

export const LeftControlPanel: React.FC<LeftControlPanelProps> = ({
  selectedPreset,
  onSelectPreset,
  sourceAreas,
  targetAreas,
  noGoAreas,
  vehicleFleets,
  onAddSourceArea,
  onUpdateSourceArea,
  onDeleteSourceArea,
  onAddTargetArea,
  onUpdateTargetArea,
  onDeleteTargetArea,
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
    if (pendingDrawnPolygon && activeDrawMode?.type === 'source') {
      onAddSourceArea({
        name: srcForm.name || `Evacuation Zone #${sourceAreas.length + 1}`,
        population: Number(srcForm.population) || 500,
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

  // Start editing an existing Source Area
  const startEditSource = (src: SourceArea) => {
    setEditingSourceId(src.id);
    setSrcForm({
      name: src.name,
      population: src.population,
      obedient: src.behavior.obedient,
      autonomous: src.behavior.autonomous,
      random: src.behavior.random,
    });
  };

  const saveEditSource = (src: SourceArea) => {
    onUpdateSourceArea({
      ...src,
      name: srcForm.name,
      population: Number(srcForm.population),
      behavior: {
        obedient: Number(srcForm.obedient),
        autonomous: Number(srcForm.autonomous),
        random: Number(srcForm.random),
      },
    });
    setEditingSourceId(null);
  };

  // Start editing an existing Target Area
  const startEditTarget = (tgt: TargetArea) => {
    setEditingTargetId(tgt.id);
    setTgtForm({
      name: tgt.name,
      capacity: tgt.capacity,
    });
  };

  const saveEditTarget = (tgt: TargetArea) => {
    onUpdateTargetArea({
      ...tgt,
      name: tgtForm.name,
      capacity: Number(tgtForm.capacity),
    });
    setEditingTargetId(null);
  };

  // Start editing an existing No-Go Area
  const startEditNoGo = (nogo: NoGoArea) => {
    setEditingNoGoId(nogo.id);
    setNogoForm({ name: nogo.name });
  };

  const saveEditNoGo = (nogo: NoGoArea) => {
    onUpdateNoGoArea({
      ...nogo,
      name: nogoForm.name,
    });
    setEditingNoGoId(null);
  };

  // Start editing an existing Vehicle Fleet
  const startEditVehicle = (veh: VehicleFleet) => {
    setEditingVehicleId(veh.id);
    setVehForm({
      name: veh.name,
      type: veh.type,
      count: veh.count,
      capacityPerUnit: veh.capacityPerUnit,
    });
  };

  const saveEditVehicle = (veh: VehicleFleet) => {
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
          disabled={isComputingRoutes || sourceAreas.length === 0 || targetAreas.length === 0}
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
            disabled={!hasComputedRoutes && !isSimulating}
            title={!hasComputedRoutes ? 'Compute evacuation routes first' : 'Run animated simulation'}
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
            <Square size={15} />
            <span>Stop simulation</span>
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
                    min={10}
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
                        <label>Pop:</label>
                        <input
                          type="number"
                          value={srcForm.population}
                          onChange={(e) =>
                            setSrcForm({ ...srcForm, population: Number(e.target.value) })
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
                            title="Modify Source Area"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditSource(src);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon delete"
                            title="Delete Source Area"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteSourceArea(src.id);
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                      <div className="entity-card-metrics">
                        <span className="metric-pill">
                          <strong>{src.population.toLocaleString()}</strong> people
                        </span>
                        <span className="metric-pill behavior-pill">
                          Ob {src.behavior.obedient}% · Au {src.behavior.autonomous}% · Rd{' '}
                          {src.behavior.random}%
                        </span>
                      </div>
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
              <span className="tab-desc">Safe Shelters (Polygons)</span>
              <button
                type="button"
                className="btn-add-entity target-add"
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

              return (
                <div
                  key={tgt.id}
                  className={`entity-item-card target-card ${isSelected ? 'selected' : ''}`}
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
                          <span className="entity-dot target-dot" />
                          <span className="entity-name">{tgt.name}</span>
                        </div>
                        <div className="entity-actions">
                          <button
                            type="button"
                            className="btn-entity-icon"
                            title="Modify Target Shelter"
                            onClick={(e) => {
                              e.stopPropagation();
                              startEditTarget(tgt);
                            }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="btn-entity-icon delete"
                            title="Delete Target Shelter"
                            onClick={(e) => {
                              e.stopPropagation();
                              onDeleteTargetArea(tgt.id);
                            }}
                          >
                            <Trash2 size={13} />
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
                            title="Modify No-Go Area"
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
                            title="Delete No-Go Area"
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
                            title="Modify Vehicle Fleet"
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
                            title="Delete Vehicle Fleet"
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
    </aside>
  );
};
