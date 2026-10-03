#!/usr/bin/env python3
"""
Loads all preset evacuation scenarios from data/scenarios/*.pkl.
Each .pkl file contains a dictionary with:
  - 'name': str
  - 'source_areas': list of dicts ('name', 'population', 'population-distribution', 'shape', ...)
  - 'target_areas': list of dicts ('name', 'capacity', 'shape', ...)
  - 'red_areas': list of dicts ('name', 'shape', ...)
  - 'vehicle_fleets': list of dicts ('name', 'count', 'capacity_per_unit', 'load_unload_secs_per_person', 'speed', 'lat', 'lon', ...)
All geometric objects ('shape') are Shapely geometries (Polygon, MultiPolygon, LineString, MultiLineString) in (lon, lat) WGS84.
Outputs JSON in EPSG:4326 ([lat, lng]) order for the frontend.
"""

import glob
import json
import os
import pickle
import sys
from shapely.geometry import Polygon


def extract_polygons_lat_lng(geom, line_buffer_deg=0.00025):
    """
    Convert a Shapely geometry (Polygon, MultiPolygon, LineString, MultiLineString)
    with (lon, lat) coordinates into a list of (polygon_coords_lat_lng, area_weight) tuples.
    """
    if geom is None or geom.is_empty:
        return []

    gtype = geom.geom_type

    if gtype == "LineString":
        coords = list(geom.coords)
        if len(coords) >= 4 and coords[0] == coords[-1]:
            poly = Polygon(coords)
            if poly.is_valid and poly.area > 0:
                return extract_polygons_lat_lng(poly, line_buffer_deg)
        buffered = geom.buffer(line_buffer_deg, cap_style=2, join_style=2)
        return extract_polygons_lat_lng(buffered, line_buffer_deg)

    if gtype == "MultiLineString":
        buffered = geom.buffer(line_buffer_deg, cap_style=2, join_style=2)
        return extract_polygons_lat_lng(buffered, line_buffer_deg)

    if gtype == "Polygon":
        coords = list(geom.exterior.coords)
        if len(coords) > 3 and coords[0] == coords[-1]:
            coords = coords[:-1]
        ring = [[float(lat), float(lon)] for lon, lat in coords]
        if len(ring) < 3:
            return []
        return [(ring, max(float(geom.area), 1e-12))]

    if gtype == "MultiPolygon":
        parts = []
        for sub in geom.geoms:
            parts.extend(extract_polygons_lat_lng(sub, line_buffer_deg))
        return parts

    if hasattr(geom, "geoms"):
        parts = []
        for sub in geom.geoms:
            parts.extend(extract_polygons_lat_lng(sub, line_buffer_deg))
        return parts

    return []


def normalize_behavior(dist_raw):
    """Normalize behavioral distribution dictionary to compliant / self-directed / disoriented summing to 100."""
    if not isinstance(dist_raw, dict):
        return {"compliant": 70, "self-directed": 20, "disoriented": 10}

    compliant = dist_raw.get("compliant", dist_raw.get("obedient", 70))
    self_directed = dist_raw.get(
        "self-directed",
        dist_raw.get("self_directed", dist_raw.get("autonomous", 20)),
    )
    disoriented = dist_raw.get("disoriented", dist_raw.get("random", 10))

    c = int(round(float(compliant)))
    s = int(round(float(self_directed)))
    d = int(round(float(disoriented)))
    total = c + s + d
    if total <= 0:
        return {"compliant": 70, "self-directed": 20, "disoriented": 10}
    if total != 100:
        c = int(round((c / total) * 100))
        s = int(round((s / total) * 100))
        d = 100 - c - s
    return {"compliant": c, "self-directed": s, "disoriented": d}


def normalize_vehicle_type(raw_type):
    if not raw_type:
        return "Bus"
    t = str(raw_type).strip()
    if t in ("Bus", "Private Car", "Shuttle", "Metro"):
        return t
    tl = t.lower()
    if "shuttle" in tl:
        return "Shuttle"
    if "car" in tl or "private" in tl:
        return "Private Car"
    if "metro" in tl or "train" in tl:
        return "Metro"
    return "Bus"


def compute_center_and_zoom(lats, lons):
    if not lats or not lons:
        return [50.8466, 4.3528], 12
    min_lat, max_lat = min(lats), max(lats)
    min_lon, max_lon = min(lons), max(lons)
    center = [round((min_lat + max_lat) / 2.0, 6), round((min_lon + max_lon) / 2.0, 6)]
    span = max(max_lat - min_lat, max_lon - min_lon)
    if span > 0.6:
        zoom = 10
    elif span > 0.3:
        zoom = 11
    elif span > 0.12:
        zoom = 12
    elif span > 0.05:
        zoom = 13
    else:
        zoom = 14
    return center, zoom


def load_scenario_pkl(filepath):
    stem = os.path.splitext(os.path.basename(filepath))[0]
    with open(filepath, "rb") as f:
        raw = pickle.load(f)

    scenario_name = str(raw.get("name") or stem)
    all_lats = []
    all_lons = []

    # 1. Source Areas
    source_areas = []
    for idx, item in enumerate(raw.get("source_areas") or []):
        base_name = str(item.get("name") or f"source_{idx:02d}")
        total_pop = max(0, int(round(float(item.get("population") or 0))))
        behavior = normalize_behavior(
            item.get("population-distribution")
            or item.get("population_distribution")
            or item.get("behavior")
        )
        parts = extract_polygons_lat_lng(item.get("shape"))
        if not parts:
            continue
        total_weight = sum(w for _, w in parts) or 1.0
        remaining_pop = total_pop
        for p_idx, (ring, weight) in enumerate(parts):
            for lat, lon in ring:
                all_lats.append(lat)
                all_lons.append(lon)
            if len(parts) == 1:
                part_pop = total_pop
                part_name = base_name
                part_id = f"{stem}-src-{idx}"
            else:
                if p_idx == len(parts) - 1:
                    part_pop = max(0, remaining_pop)
                else:
                    part_pop = int(round(total_pop * (weight / total_weight)))
                    remaining_pop -= part_pop
                part_name = f"{base_name} ({p_idx + 1})"
                part_id = f"{stem}-src-{idx}-{p_idx}"

            source_areas.append(
                {
                    "id": part_id,
                    "name": part_name,
                    "polygon": ring,
                    "population": part_pop,
                    "behavior": behavior,
                }
            )

    # 2. Target Areas
    target_areas = []
    for idx, item in enumerate(raw.get("target_areas") or []):
        base_name = str(item.get("name") or f"target_{idx:02d}")
        total_cap = max(0, int(round(float(item.get("capacity") or 0))))
        occ_raw = item.get("vehicle_occupancy")
        initial_occ = int(round(float(occ_raw))) if isinstance(occ_raw, (int, float)) else 0
        parts = extract_polygons_lat_lng(item.get("shape"))
        if not parts:
            continue
        total_weight = sum(w for _, w in parts) or 1.0
        remaining_cap = total_cap
        for p_idx, (ring, weight) in enumerate(parts):
            for lat, lon in ring:
                all_lats.append(lat)
                all_lons.append(lon)
            if len(parts) == 1:
                part_cap = total_cap
                part_name = base_name
                part_id = f"{stem}-tgt-{idx}"
            else:
                if p_idx == len(parts) - 1:
                    part_cap = max(0, remaining_cap)
                else:
                    part_cap = int(round(total_cap * (weight / total_weight)))
                    remaining_cap -= part_cap
                part_name = f"{base_name} ({p_idx + 1})"
                part_id = f"{stem}-tgt-{idx}-{p_idx}"

            target_areas.append(
                {
                    "id": part_id,
                    "name": part_name,
                    "polygon": ring,
                    "capacity": part_cap,
                    "currentOccupancy": initial_occ if p_idx == 0 else 0,
                    "disabled": bool(item.get("disabled", False)),
                }
            )

    # 3. Red Areas
    red_areas = []
    raw_reds = raw.get("red_areas") if "red_areas" in raw else raw.get("avoid_areas")
    for idx, item in enumerate(raw_reds or []):
        base_name = str(item.get("name") or f"red_{idx:02d}")
        parts = extract_polygons_lat_lng(item.get("shape"))
        if not parts:
            continue
        for p_idx, (ring, _) in enumerate(parts):
            for lat, lon in ring:
                all_lats.append(lat)
                all_lons.append(lon)
            part_name = base_name if len(parts) == 1 else f"{base_name} ({p_idx + 1})"
            part_id = f"{stem}-red-{idx}" if len(parts) == 1 else f"{stem}-red-{idx}-{p_idx}"
            red_areas.append(
                {
                    "id": part_id,
                    "name": part_name,
                    "polygon": ring,
                }
            )

    # 4. Vehicle Fleets
    vehicle_fleets = []
    for idx, item in enumerate(raw.get("vehicle_fleets") or []):
        name = str(item.get("name") or f"fleet_{idx:02d}")
        vtype = normalize_vehicle_type(item.get("type"))
        count = max(1, int(round(float(item.get("count") or 1))))
        cap = max(1, int(round(float(item.get("capacity_per_unit") or item.get("capacityPerUnit") or 40))))
        load_secs = float(
            item.get("load_unload_secs_per_person")
            if item.get("load_unload_secs_per_person") is not None
            else item.get("loadUnloadTimePerPersonSeconds", 2)
        )
        speed_kmh = float(
            item.get("speed")
            if item.get("speed") is not None
            else item.get("transitSpeedKmh", 25)
        )
        if "lat" in item and ("lon" in item or "lng" in item):
            lat = round(float(item["lat"]), 6)
            lon = round(float(item.get("lon", item.get("lng"))), 6)
        elif "shape" in item and item["shape"] is not None:
            pt = item["shape"].centroid
            lat = round(float(pt.y), 6)
            lon = round(float(pt.x), 6)
        else:
            continue

        all_lats.append(lat)
        all_lons.append(lon)

        vehicle_fleets.append(
            {
                "id": f"{stem}-veh-{idx}",
                "name": name,
                "type": vtype,
                "location": [lat, lon],
                "count": count,
                "capacityPerUnit": cap,
                "loadUnloadTimePerPersonSeconds": load_secs,
                "transitSpeedKmh": speed_kmh,
            }
        )

    center, zoom = compute_center_and_zoom(all_lats, all_lons)

    return {
        "id": stem,
        "name": scenario_name,
        "fileName": os.path.basename(filepath),
        "center": center,
        "zoom": zoom,
        "sourceAreas": source_areas,
        "targetAreas": target_areas,
        "redAreas": red_areas,
        "vehicleFleets": vehicle_fleets,
    }


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    scenarios_dir = os.path.join(repo_root, "data", "scenarios")

    if not os.path.isdir(scenarios_dir):
        print(json.dumps({"ok": True, "scenarios": []}))
        return

    pkl_files = sorted(glob.glob(os.path.join(scenarios_dir, "*.pkl")))
    scenarios = []
    errors = []

    for filepath in pkl_files:
        try:
            scenarios.append(load_scenario_pkl(filepath))
        except Exception as exc:
            errors.append({"file": os.path.basename(filepath), "error": str(exc)})

    print(
        json.dumps(
            {
                "ok": True,
                "scenarios": scenarios,
                "errors": errors,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
