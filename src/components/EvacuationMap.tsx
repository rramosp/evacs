import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  SimulationCohort,
  HeatmapPoint,
  ActiveDrawMode,
} from '../types/evacuation';
import { getPolygonCentroid } from '../services/routingEngine';
import { Layers, Check, X, Compass, Eye, EyeOff } from 'lucide-react';

interface EvacuationMapProps {
  center: [number, number];
  zoom: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  cohorts: SimulationCohort[];
  heatmapPoints: HeatmapPoint[];
  isSimulating: boolean;
  activeDrawMode: ActiveDrawMode;
  onUpdateDrawMode: (mode: ActiveDrawMode) => void;
  onFinishDrawingPolygon: (points: [number, number][]) => void;
  onFinishPlacingVehiclePoint: (point: [number, number]) => void;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
}

export const EvacuationMap: React.FC<EvacuationMapProps> = ({
  center,
  zoom,
  sourceAreas,
  targetAreas,
  noGoAreas,
  vehicleFleets,
  computedRoutes,
  cohorts,
  heatmapPoints,
  isSimulating,
  activeDrawMode,
  onUpdateDrawMode,
  onFinishDrawingPolygon,
  onFinishPlacingVehiclePoint,
  selectedEntityId,
  onSelectEntity,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  // Layer groups
  const polygonsLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const routesLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const vehiclesLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const drawPreviewLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const heatmapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Map visual toggles
  const [mapTheme, setMapTheme] = useState<'dark' | 'standard'>('dark');
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);
  const [showRoutes, setShowRoutes] = useState<boolean>(true);
  const [showZones, setShowZones] = useState<boolean>(true);

  // Keep latest activeDrawMode in a ref for Leaflet click handler
  const activeDrawModeRef = useRef<ActiveDrawMode>(activeDrawMode);
  useEffect(() => {
    activeDrawModeRef.current = activeDrawMode;
  }, [activeDrawMode]);

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center,
      zoom,
      zoomControl: false,
      attributionControl: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const tileUrl =
      mapTheme === 'dark'
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    tileLayerRef.current = tileLayer;
    polygonsLayerGroupRef.current = L.layerGroup().addTo(map);
    routesLayerGroupRef.current = L.layerGroup().addTo(map);
    vehiclesLayerGroupRef.current = L.layerGroup().addTo(map);
    drawPreviewLayerGroupRef.current = L.layerGroup().addTo(map);

    // Map click listener for drawing polygons or placing vehicle depots
    map.on('click', (e: L.LeafletMouseEvent) => {
      const currentMode = activeDrawModeRef.current;
      if (!currentMode) return;

      const clickedPt: [number, number] = [
        Number(e.latlng.lat.toFixed(5)),
        Number(e.latlng.lng.toFixed(5)),
      ];

      if (
        currentMode.type === 'source' ||
        currentMode.type === 'target' ||
        currentMode.type === 'nogo'
      ) {
        onUpdateDrawMode({
          ...currentMode,
          points: [...currentMode.points, clickedPt],
        });
      } else if (currentMode.type === 'vehicle') {
        onFinishPlacingVehiclePoint(clickedPt);
      }
    });

    // Repaint heatmap canvas on map move or zoom
    const handleMapMove = () => {
      renderHeatmapCanvas();
    };
    map.on('move', handleMapMove);
    map.on('zoom', handleMapMove);
    map.on('resize', handleMapMove);

    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Switch tile theme
  useEffect(() => {
    if (!tileLayerRef.current) return;
    const tileUrl =
      mapTheme === 'dark'
        ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
    tileLayerRef.current.setUrl(tileUrl);
  }, [mapTheme]);

  // Fly to new center/zoom when preset changes
  const prevCenterRef = useRef<[number, number]>(center);
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    if (
      prevCenterRef.current[0] !== center[0] ||
      prevCenterRef.current[1] !== center[1]
    ) {
      mapInstanceRef.current.flyTo(center, zoom, { duration: 1.1 });
      prevCenterRef.current = center;
    }
  }, [center, zoom]);

  // Render Source, Target, No-Go Polygons & Vehicle Staging Depots
  useEffect(() => {
    const group = polygonsLayerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (!showZones) return;

    // 1. Source Areas (Amber / Orange)
    sourceAreas.forEach((src) => {
      const isSelected = selectedEntityId === src.id;
      const poly = L.polygon(src.polygon, {
        color: isSelected ? '#fbbf24' : '#f59e0b',
        weight: isSelected ? 3 : 2,
        fillColor: '#f59e0b',
        fillOpacity: isSelected ? 0.38 : 0.24,
        dashArray: isSelected ? undefined : '4, 4',
      });

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectEntity(src.id);
      });

      const centroid = getPolygonCentroid(src.polygon);
      const labelHtml = `
        <div class="map-zone-badge map-zone-source ${isSelected ? 'selected' : ''}">
          <div class="zone-badge-title">SOURCE: ${src.name}</div>
          <div class="zone-badge-sub">${src.population.toLocaleString()} evacuees</div>
          <div class="zone-badge-split">
            <span>Ob: ${src.behavior.obedient}%</span>
            <span>Au: ${src.behavior.autonomous}%</span>
            <span>Rd: ${src.behavior.random}%</span>
          </div>
        </div>
      `;

      const marker = L.marker(centroid, {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: labelHtml,
          iconSize: [160, 54],
          iconAnchor: [80, 27],
        }),
      });
      marker.on('click', () => onSelectEntity(src.id));

      poly.addTo(group);
      marker.addTo(group);
    });

    // 2. Target Areas (Emerald Green)
    targetAreas.forEach((tgt) => {
      const isSelected = selectedEntityId === tgt.id;
      const poly = L.polygon(tgt.polygon, {
        color: isSelected ? '#34d399' : '#10b981',
        weight: isSelected ? 3 : 2,
        fillColor: '#10b981',
        fillOpacity: isSelected ? 0.36 : 0.22,
      });

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectEntity(tgt.id);
      });

      const centroid = getPolygonCentroid(tgt.polygon);
      const occPercent = Math.min(
        100,
        Math.round((tgt.currentOccupancy / Math.max(1, tgt.capacity)) * 100)
      );
      const labelHtml = `
        <div class="map-zone-badge map-zone-target ${isSelected ? 'selected' : ''}">
          <div class="zone-badge-title">SHELTER: ${tgt.name}</div>
          <div class="zone-badge-sub">${tgt.currentOccupancy.toLocaleString()} / ${tgt.capacity.toLocaleString()} (${occPercent}%)</div>
          <div class="zone-progress-track">
            <div class="zone-progress-fill" style="width: ${occPercent}%"></div>
          </div>
        </div>
      `;

      const marker = L.marker(centroid, {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: labelHtml,
          iconSize: [175, 52],
          iconAnchor: [87, 26],
        }),
      });
      marker.on('click', () => onSelectEntity(tgt.id));

      poly.addTo(group);
      marker.addTo(group);
    });

    // 3. No-Go Areas (Crimson Red Hazard)
    noGoAreas.forEach((nogo) => {
      const isSelected = selectedEntityId === nogo.id;
      const poly = L.polygon(nogo.polygon, {
        color: isSelected ? '#f87171' : '#ef4444',
        weight: isSelected ? 3 : 2,
        fillColor: '#ef4444',
        fillOpacity: isSelected ? 0.45 : 0.32,
        dashArray: '6, 6',
      });

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectEntity(nogo.id);
      });

      const centroid = getPolygonCentroid(nogo.polygon);
      const labelHtml = `
        <div class="map-zone-badge map-zone-nogo ${isSelected ? 'selected' : ''}">
          <div class="zone-badge-title">⛔ NO-GO ZONE</div>
          <div class="zone-badge-sub">${nogo.name}</div>
        </div>
      `;

      const marker = L.marker(centroid, {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: labelHtml,
          iconSize: [150, 40],
          iconAnchor: [75, 20],
        }),
      });
      marker.on('click', () => onSelectEntity(nogo.id));

      poly.addTo(group);
      marker.addTo(group);
    });

    // 4. Vehicle Fleet Staging Depots
    vehicleFleets.forEach((fleet) => {
      const isSelected = selectedEntityId === fleet.id;
      const totalCap = fleet.count * fleet.capacityPerUnit;
      const iconHtml = `
        <div class="map-depot-pin ${isSelected ? 'selected' : ''}">
          <div class="depot-pin-icon">${fleet.type === 'Bus' ? '🚌' : '🚓'}</div>
          <div class="depot-pin-info">
            <span class="depot-name">${fleet.name}</span>
            <span class="depot-meta">${fleet.count} units (${totalCap} cap)</span>
          </div>
        </div>
      `;

      const marker = L.marker(fleet.location, {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: iconHtml,
          iconSize: [160, 36],
          iconAnchor: [80, 18],
        }),
      });

      marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectEntity(fleet.id);
      });

      marker.addTo(group);
    });
  }, [
    sourceAreas,
    targetAreas,
    noGoAreas,
    vehicleFleets,
    selectedEntityId,
    showZones,
  ]);

  // Render Computed Evacuation Routes
  useEffect(() => {
    const group = routesLayerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (!showRoutes || computedRoutes.length === 0) return;

    computedRoutes.forEach((route) => {
      let color = '#38bdf8'; // Obedient primary cyan-blue
      let weight = 4;
      let dashArray: string | undefined = undefined;
      let opacity = 0.88;

      if (route.behaviorType === 'autonomous') {
        color = '#fbbf24'; // Amber alternate corridor
        weight = 3.5;
        dashArray = '8, 6';
      } else if (route.behaviorType === 'random') {
        color = '#fb7185'; // Rose/coral random path
        weight = 2.5;
        dashArray = '3, 6';
        opacity = 0.75;
      } else if (route.behaviorType === 'vehicle_dispatch') {
        color = '#a855f7'; // Purple/Indigo vehicle fleet corridor
        weight = 3;
        dashArray = '10, 5';
        opacity = 0.82;
      }

      // Outer casing for high contrast
      L.polyline(route.coordinates, {
        color: '#090d16',
        weight: weight + 3,
        opacity: 0.65,
      }).addTo(group);

      const polyline = L.polyline(route.coordinates, {
        color,
        weight,
        opacity,
        dashArray,
      });

      const distKm = (route.distanceMeters / 1000).toFixed(2);
      const durationMin = Math.ceil(route.estimatedDurationSeconds / 60);
      polyline.bindTooltip(
        `<div class="route-tooltip">
          <strong>${route.behaviorType.toUpperCase()} CORRIDOR</strong><br/>
          ${route.sourceName} &rarr; ${route.targetName}<br/>
          Distance: <b>${distKm} km</b> | Est. Time: <b>~${durationMin} min</b><br/>
          Assigned Evacuees: <b>${route.assignedPopulation.toLocaleString()}</b>
          ${route.isDetour ? '<br/><span style="color:#f87171">⚠️ Obstacle Detour Active</span>' : ''}
        </div>`,
        { sticky: true }
      );

      polyline.addTo(group);
    });
  }, [computedRoutes, showRoutes]);

  // Render active simulation moving vehicle markers
  useEffect(() => {
    const group = vehiclesLayerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (!isSimulating) return;

    cohorts
      .filter((c) => c.status === 'en_route' && c.isVehicle)
      .forEach((veh) => {
        const html = `
          <div class="sim-vehicle-marker">
            <span class="sim-veh-icon">${veh.vehicleType === 'Bus' ? '🚌' : '🚓'}</span>
            <span class="sim-veh-badge">${veh.populationCount}</span>
          </div>
        `;
        const marker = L.marker(veh.currentPosition, {
          icon: L.divIcon({
            className: 'custom-div-icon',
            html,
            iconSize: [52, 26],
            iconAnchor: [26, 13],
          }),
        });
        marker.addTo(group);
      });
  }, [cohorts, isSimulating]);

  // Render drawing preview polygon/markers
  useEffect(() => {
    const group = drawPreviewLayerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (!activeDrawMode) return;

    if (
      activeDrawMode.type === 'source' ||
      activeDrawMode.type === 'target' ||
      activeDrawMode.type === 'nogo'
    ) {
      const pts = activeDrawMode.points;
      const color =
        activeDrawMode.type === 'source'
          ? '#f59e0b'
          : activeDrawMode.type === 'target'
          ? '#10b981'
          : '#ef4444';

      pts.forEach((pt, idx) => {
        L.circleMarker(pt, {
          radius: 5,
          color: '#ffffff',
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .bindTooltip(`Vertex #${idx + 1}`, { permanent: false })
          .addTo(group);
      });

      if (pts.length >= 2) {
        L.polygon(pts, {
          color,
          weight: 2.5,
          fillColor: color,
          fillOpacity: 0.28,
          dashArray: '5, 5',
        }).addTo(group);
      }
    }
  }, [activeDrawMode]);

  // Heatmap HTML5 Canvas rendering function
  const renderHeatmapCanvas = () => {
    const canvas = heatmapCanvasRef.current;
    const map = mapInstanceRef.current;
    if (!canvas || !map) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = map.getSize();
    if (canvas.width !== size.x || canvas.height !== size.y) {
      canvas.width = size.x;
      canvas.height = size.y;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!showHeatmap || heatmapPoints.length === 0) return;

    // Scale radius dynamically with zoom level so density looks realistic across zoom levels
    const currentZoom = map.getZoom();
    const baseRadius = Math.max(18, Math.min(58, Math.pow(1.32, currentZoom - 10) * 16));

    heatmapPoints.forEach((pt) => {
      const containerPt = map.latLngToContainerPoint([pt.lat, pt.lng]);

      // Skip offscreen points
      if (
        containerPt.x < -baseRadius ||
        containerPt.y < -baseRadius ||
        containerPt.x > canvas.width + baseRadius ||
        containerPt.y > canvas.height + baseRadius
      ) {
        return;
      }

      const grad = ctx.createRadialGradient(
        containerPt.x,
        containerPt.y,
        baseRadius * 0.1,
        containerPt.x,
        containerPt.y,
        baseRadius
      );

      const alpha = Math.min(0.82, Math.max(0.18, pt.intensity * 0.78));

      if (pt.behavior === 'random') {
        grad.addColorStop(0, `rgba(244, 63, 94, ${alpha})`);
        grad.addColorStop(0.45, `rgba(251, 146, 60, ${alpha * 0.65})`);
        grad.addColorStop(1, 'rgba(251, 146, 60, 0)');
      } else if (pt.behavior === 'autonomous') {
        grad.addColorStop(0, `rgba(250, 204, 21, ${alpha})`);
        grad.addColorStop(0.5, `rgba(52, 211, 153, ${alpha * 0.6})`);
        grad.addColorStop(1, 'rgba(52, 211, 153, 0)');
      } else {
        // Thermal spectrum: Hot Red/Yellow core -> Emerald/Cyan outer aura
        grad.addColorStop(0, `rgba(239, 68, 68, ${alpha})`);
        grad.addColorStop(0.35, `rgba(245, 158, 11, ${alpha * 0.8})`);
        grad.addColorStop(0.7, `rgba(6, 182, 212, ${alpha * 0.45})`);
        grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(containerPt.x, containerPt.y, baseRadius, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  // Trigger heatmap repaint whenever heatmapPoints or showHeatmap changes
  useEffect(() => {
    renderHeatmapCanvas();
  }, [heatmapPoints, showHeatmap]);

  return (
    <div className="map-viewport-wrapper">
      {/* Leaflet DOM Container */}
      <div ref={mapContainerRef} className="leaflet-map-container" />

      {/* Synchronized HTML5 Heatmap Overlay Canvas */}
      <canvas
        ref={heatmapCanvasRef}
        className="heatmap-overlay-canvas"
        style={{ pointerEvents: 'none' }}
      />

      {/* Top-Left Floating Map Layer Controls */}
      <div className="map-floating-toolbar">
        <button
          type="button"
          className={`map-tool-btn ${mapTheme === 'dark' ? 'active' : ''}`}
          onClick={() => setMapTheme(mapTheme === 'dark' ? 'standard' : 'dark')}
          title="Toggle Tactical Dark / Standard OSM Tiles"
        >
          <Compass size={15} />
          <span>{mapTheme === 'dark' ? 'Tactical OSM' : 'Standard OSM'}</span>
        </button>

        <button
          type="button"
          className={`map-tool-btn ${showZones ? 'active' : ''}`}
          onClick={() => setShowZones(!showZones)}
          title="Toggle Zones & Depots"
        >
          <Layers size={15} />
          <span>Zones</span>
        </button>

        <button
          type="button"
          className={`map-tool-btn ${showRoutes ? 'active' : ''}`}
          onClick={() => setShowRoutes(!showRoutes)}
          title="Toggle Computed Routes"
        >
          {showRoutes ? <Eye size={15} /> : <EyeOff size={15} />}
          <span>Routes ({computedRoutes.length})</span>
        </button>

        <button
          type="button"
          className={`map-tool-btn ${showHeatmap ? 'active' : ''}`}
          onClick={() => setShowHeatmap(!showHeatmap)}
          title="Toggle Evacuee Density Heatmap"
        >
          <span className="heatmap-dot-indicator" />
          <span>Heatmap Overlay</span>
        </button>
      </div>

      {/* Interactive Map Legend */}
      <div className="map-legend-box">
        <div className="legend-title">TACTICAL OVERLAY LEGEND</div>
        <div className="legend-grid">
          <div className="legend-item">
            <span className="legend-swatch source-swatch" />
            <span>Source Area</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch target-swatch" />
            <span>Target Shelter</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch nogo-swatch" />
            <span>No-Go Hazard</span>
          </div>
          <div className="legend-item">
            <span className="legend-line obedient-line" />
            <span>Obedient Route</span>
          </div>
          <div className="legend-item">
            <span className="legend-line autonomous-line" />
            <span>Autonomous Detour</span>
          </div>
          <div className="legend-item">
            <span className="legend-line random-line" />
            <span>Random Path</span>
          </div>
        </div>
      </div>

      {/* Floating Drawing Mode Banner */}
      {activeDrawMode && (
        <div className="map-drawing-banner">
          <div className="drawing-banner-text">
            {activeDrawMode.type === 'vehicle' ? (
              <>
                <strong>Placing Vehicle Fleet Depot:</strong> Click anywhere on the map to set the staging coordinates.
              </>
            ) : (
              <>
                <strong>
                  Drawing{' '}
                  {activeDrawMode.type === 'source'
                    ? 'Source Evacuation Area'
                    : activeDrawMode.type === 'target'
                    ? 'Target Shelter Area'
                    : 'No-Go Hazard Zone'}
                  :
                </strong>{' '}
                Click on the map to add polygon vertices ({activeDrawMode.points.length} placed, min 3 required).
              </>
            )}
          </div>
          <div className="drawing-banner-actions">
            {activeDrawMode.type !== 'vehicle' && (
              <button
                type="button"
                className="btn-banner-confirm"
                disabled={activeDrawMode.points.length < 3}
                onClick={() => onFinishDrawingPolygon(activeDrawMode.points)}
              >
                <Check size={15} />
                <span>Complete Polygon ({activeDrawMode.points.length} pts)</span>
              </button>
            )}
            <button
              type="button"
              className="btn-banner-cancel"
              onClick={() => onUpdateDrawMode(null)}
            >
              <X size={15} />
              <span>Cancel</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
