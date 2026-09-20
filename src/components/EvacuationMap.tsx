import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  SourceArea,
  TargetArea,
  NoGoArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  ActiveVehicleUnit,
  SourceInternalCluster,
  HeatmapPoint,
  ActiveDrawMode,
} from '../types/evacuation';
import { getPolygonCentroid } from '../services/routingEngine';
import { formatMMSS } from '../services/simulationEngine';
import { Layers, Check, X, Compass, Eye, EyeOff } from 'lucide-react';

type OsmLayerStyle = 'standard' | 'hot' | 'cyclosm';

const OSM_TILE_PROVIDERS: Record<
  OsmLayerStyle,
  { label: string; url: string; attribution: string }
> = {
  standard: {
    label: 'Standard OSM',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  hot: {
    label: 'Humanitarian OSM',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hotosm.org/" target="_blank">Humanitarian OpenStreetMap Team</a>',
  },
  cyclosm: {
    label: 'CyclOSM',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://github.com/cyclosm/cyclosm-cartocss-style/releases">CyclOSM</a>',
  },
};

interface EvacuationMapProps {
  center: [number, number];
  zoom: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  noGoAreas: NoGoArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  clusters: SourceInternalCluster[];
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
  pickupStates,
  vehicles,
  clusters,
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
  const pickupSquaresLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const vehiclesLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const drawPreviewLayerGroupRef = useRef<L.LayerGroup | null>(null);
  const heatmapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Map visual toggles — default is official Standard OpenStreetMap (no API key required)
  const [osmStyle, setOsmStyle] = useState<OsmLayerStyle>('standard');
  const [showHeatmap, setShowHeatmap] = useState<boolean>(true);
  const [showRoutes, setShowRoutes] = useState<boolean>(true);
  const [showZones, setShowZones] = useState<boolean>(true);

  const cycleOsmStyle = () => {
    setOsmStyle((prev) =>
      prev === 'standard' ? 'hot' : prev === 'hot' ? 'cyclosm' : 'standard'
    );
  };

  const activeDrawModeRef = useRef<ActiveDrawMode>(activeDrawMode);
  useEffect(() => {
    activeDrawModeRef.current = activeDrawMode;
  }, [activeDrawMode]);

  // Initialize Leaflet Map once with official OpenStreetMap tiles (zero API key)
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center,
      zoom,
      zoomControl: false,
      attributionControl: true,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const provider = OSM_TILE_PROVIDERS[osmStyle];
    const tileLayer = L.tileLayer(provider.url, {
      maxZoom: 19,
      attribution: provider.attribution,
    }).addTo(map);

    tileLayerRef.current = tileLayer;
    polygonsLayerGroupRef.current = L.layerGroup().addTo(map);
    routesLayerGroupRef.current = L.layerGroup().addTo(map);
    pickupSquaresLayerGroupRef.current = L.layerGroup().addTo(map);
    vehiclesLayerGroupRef.current = L.layerGroup().addTo(map);
    drawPreviewLayerGroupRef.current = L.layerGroup().addTo(map);

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

  // Switch between public zero-API-key OpenStreetMap tile layers
  useEffect(() => {
    if (!tileLayerRef.current) return;
    const provider = OSM_TILE_PROVIDERS[osmStyle];
    tileLayerRef.current.setUrl(provider.url);
  }, [osmStyle]);

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
        fillOpacity: isSelected ? 0.28 : 0.16,
        dashArray: isSelected ? undefined : '4, 4',
      });

      poly.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectEntity(src.id);
      });

      const centroid = getPolygonCentroid(src.polygon);

      // Compute live remaining headcount in this source area
      const movingInThisSrc = clusters
        .filter((c) => c.sourceId === src.id && c.status === 'moving_in_zone')
        .reduce((acc, c) => acc + c.headcount, 0);
      const waitingInThisSrc = pickupStates
        .filter((p) => p.sourceId === src.id)
        .reduce((acc, p) => acc + p.waitingPopulation, 0);
      const boardingInThisSrc = vehicles
        .filter((v) => v.sourceId === src.id && v.status === 'waiting_for_80_pct')
        .reduce((acc, v) => acc + v.currentOccupancy, 0);

      const currentRemaining =
        clusters.length > 0
          ? movingInThisSrc + waitingInThisSrc + boardingInThisSrc
          : src.population;

      const labelHtml = `
        <div class="map-zone-badge map-zone-source ${isSelected ? 'selected' : ''}">
          <div class="zone-badge-title">SOURCE: ${src.name}</div>
          <div class="zone-badge-sub">
            <strong>${currentRemaining.toLocaleString()}</strong> / ${src.population.toLocaleString()} in zone
          </div>
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
          iconSize: [170, 56],
          iconAnchor: [85, 28],
        }),
      });
      marker.on('click', () => onSelectEntity(src.id));

      poly.addTo(group);
      marker.addTo(group);
    });

    // 2. Target Areas (Emerald Green when Active, Slate Gray when Disabled)
    targetAreas.forEach((tgt) => {
      const isSelected = selectedEntityId === tgt.id;
      const isDisabled = Boolean(tgt.disabled);
      const poly = L.polygon(tgt.polygon, {
        color: isDisabled ? '#94a3b8' : isSelected ? '#34d399' : '#10b981',
        weight: isSelected ? 3 : 2,
        fillColor: isDisabled ? '#64748b' : '#10b981',
        fillOpacity: isDisabled ? 0.16 : isSelected ? 0.36 : 0.22,
        dashArray: isDisabled ? '5, 5' : undefined,
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
        <div class="map-zone-badge map-zone-target ${isSelected ? 'selected' : ''}" style="${
        isDisabled ? 'border-color: #64748b; background: rgba(15, 23, 42, 0.92);' : ''
      }">
          <div class="zone-badge-title">
            SHELTER: ${tgt.name} ${
        isDisabled ? '<span style="color:#f87171">[DISABLED]</span>' : ''
      }
          </div>
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
          iconSize: [185, 52],
          iconAnchor: [92, 26],
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
    clusters,
    pickupStates,
    vehicles,
  ]);

  // Render Computed Evacuation Routes
  useEffect(() => {
    const routesGroup = routesLayerGroupRef.current;
    if (!routesGroup) return;
    routesGroup.clearLayers();

    if (!showRoutes || computedRoutes.length === 0) return;

    computedRoutes.forEach((route) => {
      const color = route.behaviorType === 'obedient' ? '#0284c7' : '#d97706';
      const weight = 4;

      // Outer casing for main evacuation route
      L.polyline(route.coordinates, {
        color: '#090d16',
        weight: weight + 3,
        opacity: 0.72,
      }).addTo(routesGroup);

      const polyline = L.polyline(route.coordinates, {
        color,
        weight,
        opacity: 0.92,
      });

      const distKm = (route.distanceMeters / 1000).toFixed(2);
      polyline.bindTooltip(
        `<div class="route-tooltip">
          <strong>EVACUATION CORRIDOR</strong><br/>
          ${route.pickupLabel} &rarr; ${route.targetName}<br/>
          Distance: <b>${distKm} km</b>
          ${route.isDetour ? '<br/><span style="color:#f87171">⚠️ Obstacle Detour Active</span>' : ''}
        </div>`,
        { sticky: true }
      );

      polyline.addTo(routesGroup);
    });
  }, [computedRoutes, showRoutes]);

  // Render Blue Square Pickup Locations with Live Queue & Boarding Badges
  useEffect(() => {
    const pickupGroup = pickupSquaresLayerGroupRef.current;
    if (!pickupGroup) return;
    pickupGroup.clearLayers();

    if (!showRoutes || computedRoutes.length === 0) return;

    computedRoutes.forEach((route, idx) => {
      if (!route.pickupLocation) return;

      const pState = pickupStates.find((p) => p.routeId === route.id);
      const waitingCount = pState ? pState.waitingPopulation : 0;

      // Also check if a vehicle is currently boarding at this pickup point
      const boardingVeh = vehicles.find(
        (v) => v.assignedRouteId === route.id && v.status === 'waiting_for_80_pct'
      );

      const boardingPct = boardingVeh
        ? Math.round((boardingVeh.currentOccupancy / Math.max(1, boardingVeh.maxCapacity)) * 100)
        : 0;
      const waitFormatted = boardingVeh ? formatMMSS(boardingVeh.waitingAtPickupSeconds) : "00:00";

      const squareHtml = `
        <div class="pickup-square-wrapper">
          ${
            waitingCount > 0 || boardingVeh
              ? `<div class="pickup-live-queue-pill ${waitingCount > 100 ? 'hot' : ''}">
                  <span>⏳ ${waitingCount} waiting</span>
                  ${
                    boardingVeh
                      ? `<span class="boarding-sub-pill">🚌 ${boardingVeh.currentOccupancy}/${boardingVeh.maxCapacity} (${boardingPct}%) · ⏱️ ${waitFormatted}/10:00</span>`
                      : ''
                  }
                </div>`
              : ''
          }
          <div class="map-pickup-square-marker" title="${route.pickupLabel}">
            <span class="pickup-square-inner">${idx + 1}</span>
          </div>
        </div>
      `;

      const pickupMarker = L.marker(route.pickupLocation, {
        icon: L.divIcon({
          className: 'custom-div-icon',
          html: squareHtml,
          iconSize: [140, 48],
          iconAnchor: [70, 38],
        }),
        zIndexOffset: 950,
      });

      pickupMarker.bindTooltip(
        `<div class="route-tooltip">
          <strong style="color:#60a5fa">🟦 BLUE SQUARE PICKUP #${idx + 1}</strong><br/>
          <b>${route.pickupLabel}</b><br/>
          Destination: <b>${route.targetName}</b><br/>
          Waiting in Queue: <b>${waitingCount.toLocaleString()} evacuees</b><br/>
          ${
            boardingVeh
              ? `Active Vehicle Boarding: <b>${boardingVeh.currentOccupancy}/${boardingVeh.maxCapacity} seats (${boardingPct}%)</b><br/>Wait Timer: <b>${waitFormatted} / 10:00 min</b> (departs at 80% or 10:00 with &ge;1 passenger)<br/>`
              : 'Vehicle Status: <b>En route to pickup</b><br/>'
          }
          Coordinates: <code>[${route.pickupLocation[0]}, ${route.pickupLocation[1]}]</code>
        </div>`,
        { direction: 'top', offset: [0, -16] }
      );

      pickupMarker.addTo(pickupGroup);
    });
  }, [computedRoutes, pickupStates, vehicles, showRoutes]);

  // Render Active Moving Vehicle Markers AND Internal Source Crowd Clusters
  useEffect(() => {
    const group = vehiclesLayerGroupRef.current;
    if (!group) return;
    group.clearLayers();

    if (!isSimulating && clusters.length === 0) return;

    // 1. Render micro-dots for crowd clusters moving inside Source Areas
    clusters
      .filter((c) => c.status === 'moving_in_zone' && c.headcount > 0)
      .forEach((c) => {
        const dotColor =
          c.behavior === 'obedient'
            ? '#0284c7'
            : c.behavior === 'autonomous'
            ? '#d97706'
            : '#e11d48';

        L.circleMarker(c.position, {
          radius: 4,
          color: '#090d16',
          weight: 1.2,
          fillColor: dotColor,
          fillOpacity: 0.92,
        })
          .bindTooltip(
            `<b>${c.behavior.toUpperCase()} Cluster</b> (${c.headcount} evacuees)<br/>Moving toward Blue Square pickup`,
            { direction: 'top' }
          )
          .addTo(group);
      });

    // 2. Render active vehicles (en route to pickup, waiting for 80% occupancy, or en route to shelter)
    vehicles
      .filter((v) => v.status !== 'completed')
      .forEach((veh) => {
        const occPct = Math.round(
          (veh.currentOccupancy / Math.max(1, veh.maxCapacity)) * 100
        );
        const statusClass =
          veh.status === 'waiting_for_80_pct'
            ? 'boarding-wait'
            : veh.status === 'to_target'
            ? 'evac-enroute'
            : 'approach-empty';

        const html = `
          <div class="sim-vehicle-marker ${statusClass}">
            <span class="sim-veh-icon">${veh.vehicleType === 'Bus' ? '🚌' : '🚓'}</span>
            <span class="sim-veh-badge">
              ${
                veh.status === 'waiting_for_80_pct'
                  ? `${occPct}%`
                  : veh.currentOccupancy > 0
                  ? `${veh.currentOccupancy}`
                  : '0'
              }
            </span>
          </div>
        `;

        const marker = L.marker(veh.currentPosition, {
          icon: L.divIcon({
            className: 'custom-div-icon',
            html,
            iconSize: [58, 26],
            iconAnchor: [29, 13],
          }),
          zIndexOffset: 920,
        });

        marker.bindTooltip(
          `<div class="route-tooltip">
            <strong>${veh.fleetName}</strong> (${veh.unitCount}x ${veh.vehicleType})<br/>
            Status: <b>${
              veh.status === 'waiting_for_80_pct'
                ? `Boarding at Pickup (${occPct}% | Wait ${formatMMSS(veh.waitingAtPickupSeconds)}/10:00)`
                : veh.status === 'to_target'
                ? `En Route to ${veh.targetName}`
                : 'Approaching Blue Square Pickup Point'
            }</b><br/>
            Occupancy: <b>${veh.currentOccupancy} / ${veh.maxCapacity} evacuees (${occPct}%)</b>
          </div>`,
          { direction: 'top' }
        );

        marker.addTo(group);
      });
  }, [vehicles, clusters, isSimulating]);

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

    const currentZoom = map.getZoom();
    const baseRadius = Math.max(20, Math.min(64, Math.pow(1.32, currentZoom - 10) * 18));

    heatmapPoints.forEach((pt) => {
      const containerPt = map.latLngToContainerPoint([pt.lat, pt.lng]);

      if (
        containerPt.x < -baseRadius ||
        containerPt.y < -baseRadius ||
        containerPt.x > canvas.width + baseRadius ||
        containerPt.y > canvas.height + baseRadius
      ) {
        return;
      }

      const radius =
        pt.behavior === 'pickup_hotspot' ? baseRadius * 1.28 : baseRadius * 0.88;

      const grad = ctx.createRadialGradient(
        containerPt.x,
        containerPt.y,
        radius * 0.08,
        containerPt.x,
        containerPt.y,
        radius
      );

      const alpha = Math.min(0.88, Math.max(0.15, pt.intensity * 0.85));

      if (pt.behavior === 'pickup_hotspot') {
        // Intense glowing thermal hotspot around Blue Square Pickup Locations!
        grad.addColorStop(0, `rgba(255, 30, 30, ${Math.min(0.95, alpha * 1.15)})`);
        grad.addColorStop(0.32, `rgba(249, 115, 22, ${alpha})`);
        grad.addColorStop(0.65, `rgba(250, 204, 21, ${alpha * 0.65})`);
        grad.addColorStop(1, 'rgba(250, 204, 21, 0)');
      } else if (pt.behavior === 'random') {
        grad.addColorStop(0, `rgba(244, 63, 94, ${alpha * 0.8})`);
        grad.addColorStop(0.5, `rgba(251, 146, 60, ${alpha * 0.55})`);
        grad.addColorStop(1, 'rgba(251, 146, 60, 0)');
      } else if (pt.behavior === 'autonomous') {
        grad.addColorStop(0, `rgba(250, 204, 21, ${alpha * 0.8})`);
        grad.addColorStop(0.5, `rgba(52, 211, 153, ${alpha * 0.55})`);
        grad.addColorStop(1, 'rgba(52, 211, 153, 0)');
      } else {
        grad.addColorStop(0, `rgba(245, 158, 11, ${alpha * 0.75})`);
        grad.addColorStop(0.5, `rgba(6, 182, 212, ${alpha * 0.5})`);
        grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
      }

      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(containerPt.x, containerPt.y, radius, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  useEffect(() => {
    renderHeatmapCanvas();
  }, [heatmapPoints, showHeatmap]);

  return (
    <div className="map-viewport-wrapper">
      <div ref={mapContainerRef} className="leaflet-map-container" />

      <canvas
        ref={heatmapCanvasRef}
        className="heatmap-overlay-canvas"
        style={{ pointerEvents: 'none' }}
      />

      {/* Top-Left Floating Map Layer Controls */}
      <div className="map-floating-toolbar">
        <button
          type="button"
          className="map-tool-btn active"
          onClick={cycleOsmStyle}
          title="Switch between free OpenStreetMap layers (no API key required)"
        >
          <Compass size={15} />
          <span>{OSM_TILE_PROVIDERS[osmStyle].label}</span>
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
          title="Toggle Computed Routes & Pickup Squares"
        >
          {showRoutes ? <Eye size={15} /> : <EyeOff size={15} />}
          <span>Routes & Pickups ({computedRoutes.length})</span>
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
            <span className="legend-swatch pickup-square-swatch" />
            <span>Route Pickup Point</span>
          </div>
          <div className="legend-item">
            <span className="legend-line obedient-line" />
            <span>Evac Corridor</span>
          </div>
          <div className="legend-item">
            <span className="legend-swatch hotspot-swatch" />
            <span>Pickup Queue Heat</span>
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
