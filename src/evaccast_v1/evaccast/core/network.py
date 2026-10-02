"""Fetching road networks (Overpass via osmnx, elevations via Open Topo
Data) and handling avoid-area geometry - the part of the app that talks to
the network, so it's slow and should run off any thread that needs to stay
responsive.

Coordinate convention: every geometry passed in or returned here is a
shapely geometry in EPSG:4326 (x = lon, y = lat - GeoJSON's own order)
unless a function says otherwise, and every graph fetch_graph_around()/
fetch_place_graph() return is unprojected EPSG:4326 too. Callers holding
(lat, lon) pairs (e.g. the HTTP API's `loc`) convert once at their own
boundary.
"""

import io
import json
import os
import tempfile
import threading
from pathlib import Path

import geopandas as gpd
import osmnx as ox
import pyogrio
import shapely
from shapely.geometry import Point

NETWORK_TYPE = "drive"  # osmnx also supports "walk", "bike", "all", etc.
DEFAULT_BUFFER_M = 1000.0

# OSMnx's own elevation helper is built around the Google Maps Elevation API,
# which needs a paid API key. Open Topo Data implements the same request/
# response format for free, so we point osmnx at it instead.
ELEVATION_URL_TEMPLATE = "https://api.opentopodata.org/v1/aster30m?locations={locations}"

ox.settings.log_console = False
# Pin osmnx's HTTP response cache next to the repo, not wherever the
# process happened to be launched from.
ox.settings.cache_folder = Path(__file__).resolve().parent.parent.parent.parent / "cache"

# ox.settings is process-global; this serializes the elevation-URL swap in
# add_node_elevations() so two concurrent fetches can't interleave it.
_elevation_settings_lock = threading.Lock()


def bounding_circle(geometries):
    """(center, radius_m) of a circle covering every vertex of
    `geometries` (EPSG:4326 shapely geometries - points, polygons, or a
    mix): `center` is the vertices' mean lon/lat as a Point, `radius_m`
    the great-circle distance from it to the farthest vertex."""
    coords = shapely.get_coordinates(list(geometries))
    if len(coords) == 0:
        raise ValueError("bounding_circle() needs at least one geometry with coordinates")
    center_lon, center_lat = coords.mean(axis=0)
    radius = max(ox.distance.great_circle(center_lat, center_lon, lat, lon) for lon, lat in coords)
    return Point(center_lon, center_lat), float(radius)


def fetch_graph_around(geometries, buffer_m=DEFAULT_BUFFER_M, network_type=NETWORK_TYPE, avoid=None):
    """The road network covering `geometries` (EPSG:4326 shapely points
    and/or polygons) plus `buffer_m` meters beyond their bounding_circle(),
    as an unprojected EPSG:4326 MultiDiGraph - with every node/edge
    intersecting `avoid` (an EPSG:4326 geometry, or None) pruned out.
    Slow: one Overpass download (cached on disk by osmnx)."""
    center, radius = bounding_circle(geometries)
    graph = ox.graph_from_point((center.y, center.x), dist=radius + buffer_m, network_type=network_type)
    if avoid is not None and not avoid.is_empty:
        graph = remove_geometry_from_graph(graph, avoid)
    return graph


def fetch_place_graph(place, network_type=NETWORK_TYPE):
    """The road network for a geocodable place name (Nominatim +
    Overpass), unprojected EPSG:4326. Slow."""
    return ox.graph_from_place(place, network_type=network_type)


def add_node_elevations(graph):
    """`graph` with an "elevation" attribute on every node, looked up from
    Open Topo Data (via osmnx's Google-compatible elevation helper). Slow
    (batched HTTP requests); `graph` must be unprojected EPSG:4326."""
    with _elevation_settings_lock:
        original_url_template = ox.settings.elevation_url_template
        ox.settings.elevation_url_template = ELEVATION_URL_TEMPLATE
        try:
            return ox.elevation.add_node_elevations_google(graph, batch_size=100, pause=1)
        finally:
            ox.settings.elevation_url_template = original_url_template


def read_avoid_geojson(avoid_geojson: str | dict) -> gpd.GeoDataFrame:
    """Parse `avoid_geojson` - a GeoJSON string or already-parsed dict -
    into a GeoDataFrame. Falls back to a temp file when pyogrio refuses to
    read the string from memory (it can reject valid GeoJSON it reads fine
    from disk)."""
    if isinstance(avoid_geojson, dict):
        avoid_geojson = json.dumps(avoid_geojson)
    try:
        return gpd.read_file(io.StringIO(avoid_geojson))
    except pyogrio.errors.DataSourceError:
        fd, path = tempfile.mkstemp(suffix=".geojson", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf8") as tmp:
                tmp.write(avoid_geojson)
            return gpd.read_file(f"GEOJSON:{path}")
        finally:
            os.remove(path)


def avoid_geometry(avoid_geojson: str | dict, crs="EPSG:4326"):
    """`avoid_geojson`'s features unioned into one shapely geometry,
    reprojected to `crs` (EPSG:4326 by default - the convention everything
    in this module uses; pass a graph's own CRS to prune a projected
    graph). A GeoJSON with no CRS is taken as EPSG:4326, per the spec."""
    gdf = read_avoid_geojson(avoid_geojson)
    if gdf.crs is None:
        gdf = gdf.set_crs("EPSG:4326")
    return gdf.to_crs(crs).union_all()


def remove_geometry_from_graph(graph, avoid_poly):
    """A copy of `graph` with any node inside `avoid_poly` and any edge
    intersecting it removed - `avoid_poly` must already be in `graph`'s own
    CRS. A copy, so a caller can keep the unpruned original (e.g. to toggle
    an obstacle without re-fetching)."""
    graph = graph.copy()
    nodes, edges = ox.graph_to_gdfs(graph)
    graph.remove_nodes_from(nodes[nodes.geometry.within(avoid_poly)].index)
    graph.remove_edges_from(edges[edges.geometry.intersects(avoid_poly)].index)
    return graph
