from __future__ import annotations

import hashlib
import json
import math
import pickle
import sys
from pathlib import Path
from typing import Any

import osmnx as ox
from shapely.geometry import LineString, MultiLineString, Point, Polygon

# Ensure src/evaccast_v1 is importable
REPO_ROOT = Path(__file__).resolve().parent.parent
EVACCAST_V1_ROOT = REPO_ROOT / "src" / "evaccast_v1"
if str(EVACCAST_V1_ROOT) not in sys.path:
    sys.path.insert(0, str(EVACCAST_V1_ROOT))

try:
    import geojson_pydantic  # noqa: F401
except ModuleNotFoundError:
    import types

    _geojson_stub = types.ModuleType("geojson_pydantic")
    _geojson_stub.FeatureCollection = dict  # type: ignore[attr-defined]
    sys.modules["geojson_pydantic"] = _geojson_stub

from evaccast.api.v1.routing import route_between_areas  # noqa: E402

# Cache simplified NetworkX graphs from ox.graph_from_point on disk in ox.settings.cache_folder
# and memoize nodes-only GeoDataFrame extraction across repeated nodes_within() calls on the same graph.
_orig_graph_from_point = ox.graph_from_point
_orig_graph_to_gdfs = ox.graph_to_gdfs
_nodes_gdf_memo: dict[int, Any] = {}


def _cached_graph_from_point(
    center_point: tuple[float, float],
    dist: float = 1000,
    dist_type: str = "bbox",
    network_type: str = "all",
    **kwargs: Any,
) -> Any:
    cache_dir = Path(ox.settings.cache_folder)
    cache_dir.mkdir(parents=True, exist_ok=True)
    key_str = (
        f"{float(center_point[0]):.6f}_{float(center_point[1]):.6f}_"
        f"{float(dist):.1f}_{dist_type}_{network_type}"
    )
    digest = hashlib.sha1(key_str.encode("utf-8")).hexdigest()
    pkl_path = cache_dir / f"nx_graph_{digest}.pkl"
    if pkl_path.is_file():
        try:
            with open(pkl_path, "rb") as f:
                return pickle.load(f)
        except Exception:  # noqa: BLE001
            pass

    graph = _orig_graph_from_point(
        center_point,
        dist=dist,
        dist_type=dist_type,
        network_type=network_type,
        **kwargs,
    )
    try:
        with open(pkl_path, "wb") as f:
            pickle.dump(graph, f, protocol=pickle.HIGHEST_PROTOCOL)
    except Exception:  # noqa: BLE001
        pass
    return graph


def _memoized_graph_to_gdfs(
    graph: Any,
    nodes: bool = True,
    edges: bool = True,
    **kwargs: Any,
) -> Any:
    if nodes and not edges and not kwargs:
        gid = id(graph)
        cached = _nodes_gdf_memo.get(gid)
        if cached is not None and len(cached) == len(graph):
            return cached
        res = _orig_graph_to_gdfs(graph, nodes=True, edges=False)
        _nodes_gdf_memo[gid] = res
        return res
    return _orig_graph_to_gdfs(graph, nodes=nodes, edges=edges, **kwargs)


ox.graph_from_point = _cached_graph_from_point
ox.graph_to_gdfs = _memoized_graph_to_gdfs


def _latlng_ring_to_polygon(latlng_points: list[list[float]]) -> Polygon:
    """Convert a list of [lat, lng] coordinates into an EPSG:4326 Shapely Polygon (lon, lat)."""
    coords = [(float(pt[1]), float(pt[0])) for pt in latlng_points]
    if len(coords) >= 3 and coords[0] != coords[-1]:
        coords.append(coords[0])
    poly = Polygon(coords)
    if not poly.is_valid:
        poly = poly.buffer(0)
    return poly


def _extract_ordered_lonlat_coords(
    geom: LineString | MultiLineString,
) -> list[tuple[float, float]]:
    """Extract a continuous sequence of (lon, lat) coordinates from a LineString or MultiLineString."""
    if isinstance(geom, LineString):
        return [(float(x), float(y)) for x, y in geom.coords]

    if isinstance(geom, MultiLineString):
        coords: list[tuple[float, float]] = []
        for part in geom.geoms:
            part_coords = [(float(x), float(y)) for x, y in part.coords]
            if not part_coords:
                continue
            if not coords:
                coords.extend(part_coords)
            else:
                prev_end = coords[-1]
                if (
                    abs(prev_end[0] - part_coords[0][0]) < 1e-8
                    and abs(prev_end[1] - part_coords[0][1]) < 1e-8
                ):
                    coords.extend(part_coords[1:])
                else:
                    coords.extend(part_coords)
        return coords

    raise TypeError(f"Unsupported path geometry type: {type(geom)!r}")


def _match_point_to_area(pt: Point, areas: list[dict[str, Any]]) -> tuple[int, float]:
    """Identify which area polygon `pt` falls upon (or is closest to within tolerance).

    Returns (best_index, distance_deg). Distance is 0.0 when `pt` is inside or on the boundary.
    """
    best_idx = 0
    best_dist = float("inf")
    for idx, area in enumerate(areas):
        shape = area["shape"]
        if shape.covers(pt) or shape.intersects(pt):
            return idx, 0.0
        dist = float(shape.distance(pt))
        if dist < best_dist:
            best_dist = dist
            best_idx = idx
    return best_idx, best_dist


def _haversine_distance_meters(coords_latlng: list[list[float]]) -> float:
    """Compute total geodesic length in meters along a [[lat, lng], ...] polyline."""
    total_m = 0.0
    earth_radius_m = 6371000.0
    for i in range(1, len(coords_latlng)):
        lat1, lon1 = math.radians(coords_latlng[i - 1][0]), math.radians(coords_latlng[i - 1][1])
        lat2, lon2 = math.radians(coords_latlng[i][0]), math.radians(coords_latlng[i][1])
        dlat = lat2 - lat1
        dlon = lon2 - lon1
        a = (
            math.sin(dlat / 2.0) ** 2
            + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2.0) ** 2
        )
        c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
        total_m += earth_radius_m * c
    return total_m


def run_evaccast_routing(payload: dict[str, Any]) -> dict[str, Any]:
    """Run evaccast.api.v1.routing.route_between_areas on the provided scenario payload."""
    raw_sources = payload.get("sourceAreas", [])
    raw_targets = [t for t in payload.get("targetAreas", []) if not t.get("disabled", False)]
    raw_reds = payload.get("redAreas", payload.get("avoidAreas", []))

    if not raw_sources:
        return {"ok": False, "error": "At least one Source Area is required."}
    if not raw_targets:
        return {"ok": False, "error": "At least one active Target Area is required."}

    # Construct source_areas with exact keys:
    # 'name', 'shape', 'population', 'population_distribution', 'vehicle_occupancy'
    source_areas: list[dict[str, Any]] = []
    source_meta: list[dict[str, Any]] = []
    for src in raw_sources:
        shape = _latlng_ring_to_polygon(src["polygon"])
        population = int(round(float(src.get("population", 0))))
        pop_dist = dict(src.get("behavior", {}))
        source_areas.append(
            {
                "name": str(src["name"]),
                "shape": shape,
                "population": population,
                "population_distribution": pop_dist,
                "vehicle_occupancy": None,
            }
        )
        source_meta.append(
            {
                "id": str(src["id"]),
                "name": str(src["name"]),
                "population": population,
                "shape": shape,
            }
        )

    # Construct target_areas with exact keys:
    # 'name', 'shape', 'capacity', 'vehicle_occupancy'
    target_areas: list[dict[str, Any]] = []
    target_meta: list[dict[str, Any]] = []
    for tgt in raw_targets:
        shape = _latlng_ring_to_polygon(tgt["polygon"])
        capacity = int(round(float(tgt.get("capacity", 0))))
        target_areas.append(
            {
                "name": str(tgt["name"]),
                "shape": shape,
                "capacity": capacity,
                "vehicle_occupancy": None,
            }
        )
        target_meta.append(
            {
                "id": str(tgt["id"]),
                "name": str(tgt["name"]),
                "capacity": capacity,
                "shape": shape,
            }
        )

    # Construct red_areas as in cell 5 of notebooks/test-evaccast-pickle-scenario.ipynb:
    # red_areas = [a['shape'] for a in ...]
    red_dicts: list[dict[str, Any]] = []
    for rd in raw_reds:
        rd_name = str(rd.get("name", ""))
        rings = (
            rd["polygons"]
            if isinstance(rd.get("polygons"), list) and len(rd["polygons"]) > 0
            else ([rd["polygon"]] if rd.get("polygon") else [])
        )
        for ring in rings:
            if isinstance(ring, list) and len(ring) >= 3:
                red_dicts.append(
                    {
                        "name": rd_name,
                        "shape": _latlng_ring_to_polygon(ring),
                    }
                )
    red_areas = [a["shape"] for a in red_dicts]

    computation = route_between_areas(
        source_areas,
        target_areas,
        red_areas=red_areas,
        time_horizon_hours=96,
        speed_override_kph=25,
    )

    vehicle_paths = computation.vehicle_paths

    paths_out: list[dict[str, Any]] = []
    for idx, geom in enumerate(vehicle_paths):
        coords_lonlat = _extract_ordered_lonlat_coords(geom)
        if len(coords_lonlat) < 2:
            continue

        start_pt = Point(coords_lonlat[0])
        end_pt = Point(coords_lonlat[-1])

        # Identify which source_area and target_area each end of the path falls upon
        src_idx_fwd, src_dist_fwd = _match_point_to_area(start_pt, source_meta)
        tgt_idx_fwd, tgt_dist_fwd = _match_point_to_area(end_pt, target_meta)

        src_idx_rev, src_dist_rev = _match_point_to_area(end_pt, source_meta)
        tgt_idx_rev, tgt_dist_rev = _match_point_to_area(start_pt, target_meta)

        if src_dist_rev + tgt_dist_rev < src_dist_fwd + tgt_dist_fwd:
            # Path is oriented from target_area to source_area; reverse so it goes pickup -> drop-off
            coords_lonlat = list(reversed(coords_lonlat))
            src_idx = src_idx_rev
            tgt_idx = tgt_idx_rev
        else:
            src_idx = src_idx_fwd
            tgt_idx = tgt_idx_fwd

        coords_latlng = [[round(lat, 6), round(lon, 6)] for lon, lat in coords_lonlat]
        pickup_location = coords_latlng[0]
        dropoff_location = coords_latlng[-1]
        distance_meters = round(_haversine_distance_meters(coords_latlng))
        # At 25 km/h (6.9444 m/s)
        duration_seconds = round(distance_meters / (25.0 / 3.6))

        matched_source = source_meta[src_idx]
        matched_target = target_meta[tgt_idx]

        paths_out.append(
            {
                "pathIndex": idx,
                "sourceId": matched_source["id"],
                "sourceName": matched_source["name"],
                "targetId": matched_target["id"],
                "targetName": matched_target["name"],
                "pickupLocation": pickup_location,
                "dropOffLocation": dropoff_location,
                "coordinates": coords_latlng,
                "distanceMeters": distance_meters,
                "estimatedDurationSeconds": duration_seconds,
            }
        )

    return {
        "ok": True,
        "paths": paths_out,
        "maxFlowVehPerHr": computation.max_flow_veh_per_hr,
        "minEvacTimeHours": computation.min_evac_time_hours,
        "demand": computation.demand,
        "sheltered": computation.sheltered,
    }


def main() -> int:
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            print(json.dumps({"ok": False, "error": "Empty request payload on stdin."}))
            return 1
        payload = json.loads(raw_input)
        result = run_evaccast_routing(payload)
        print(json.dumps(result))
        return 0 if result.get("ok") else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
