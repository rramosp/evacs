#!/usr/bin/env python3
"""
Reads data/brussels_metro_lines.parquet and data/brussels_metro_stations.parquet
using GeoPandas and outputs their geographic definitions as JSON in EPSG:4326 ([lat, lng]).
"""

import json
import os
import sys
import geopandas as gpd


def main():
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    lines_path = os.path.join(repo_root, "data", "brussels_metro_lines.parquet")
    stations_path = os.path.join(repo_root, "data", "brussels_metro_stations.parquet")

    if not os.path.exists(lines_path):
        print(json.dumps({"ok": False, "error": f"Missing file: {lines_path}"}))
        sys.exit(1)
    if not os.path.exists(stations_path):
        print(json.dumps({"ok": False, "error": f"Missing file: {stations_path}"}))
        sys.exit(1)

    gdf_lines = gpd.read_parquet(lines_path)
    if gdf_lines.crs and gdf_lines.crs.to_epsg() != 4326:
        gdf_lines = gdf_lines.to_crs(epsg=4326)

    gdf_stations = gpd.read_parquet(stations_path)
    if gdf_stations.crs and gdf_stations.crs.to_epsg() != 4326:
        gdf_stations = gdf_stations.to_crs(epsg=4326)

    lines_out = []
    for idx, row in gdf_lines.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        segments = []
        if geom.geom_type == "LineString":
            segments.append([[round(float(pt[1]), 6), round(float(pt[0]), 6)] for pt in geom.coords])
        elif geom.geom_type == "MultiLineString":
            for part in geom.geoms:
                segments.append([[round(float(pt[1]), 6), round(float(pt[0]), 6)] for pt in part.coords])

        primary_coords = segments[0] if segments else []
        lines_out.append(
            {
                "id": str(row.get("id", f"stib_lines.{idx}")),
                "line": str(row.get("line", "")),
                "mode": str(row.get("mode", "Metro")),
                "variant": int(row.get("variant", 1)),
                "color": str(row.get("color", "#0066A3")),
                "coordinates": primary_coords,
                "segments": segments,
            }
        )

    stations_out = []
    for idx, row in gdf_stations.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            continue
        pt = geom.centroid if geom.geom_type != "Point" else geom
        lat = round(float(pt.y), 6)
        lng = round(float(pt.x), 6)
        line_str = str(row.get("line", ""))
        lines_list = [x.strip() for x in line_str.strip("{}").split(",") if x.strip()]
        name_fr = str(row.get("name_fr", f"Station {idx}"))
        name_nl = str(row.get("name_nl", name_fr))
        stop_id = str(row.get("stop_id", str(idx)))

        stations_out.append(
            {
                "id": f"bxl-metro-st-{idx}",
                "name_fr": name_fr,
                "name_nl": name_nl,
                "stop_id": stop_id,
                "line": line_str,
                "lines": lines_list,
                "position": [lat, lng],
            }
        )

    print(
        json.dumps(
            {
                "ok": True,
                "sourceFiles": {
                    "lines": "data/brussels_metro_lines.parquet",
                    "stations": "data/brussels_metro_stations.parquet",
                },
                "lines": lines_out,
                "stations": stations_out,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
