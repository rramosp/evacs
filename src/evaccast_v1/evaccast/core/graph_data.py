"""The GraphData/ElevationGraphData containers the Bokeh UI and node
selection (evaccast.core.selection) work over, and the fetch-and-shape
functions that build them. Network access itself lives in
evaccast.core.network.

Every GraphData's coordinates (x/y, edge_xs/edge_ys) are EPSG:3857 - the
CRS the Bokeh basemap tiles use - but every *distance* derived from them
(distance_max, distance criteria) is in true ground meters, corrected for
Web Mercator's scale distortion via evaccast.core.geometry.mercator_scale().
"""

from dataclasses import dataclass, field

import numpy as np
import osmnx as ox
from shapely.geometry import Point

from .geometry import mercator_scale
from .network import (
    DEFAULT_BUFFER_M,
    NETWORK_TYPE,
    add_node_elevations,
    fetch_graph_around,
    fetch_place_graph,
    remove_geometry_from_graph,
)

DISPLAY_CRS = "EPSG:3857"


def point_loc(point):
    """A raw source/sink point entry's plain (lat, lon) pair - either the
    pair itself, or the "loc" key of the richer per-site dict shape (see
    evaccast.api.v1.demo_http.SourcePoint/SinkPoint)."""
    return point["loc"] if isinstance(point, dict) else point


def _graph_to_result(graph):
    """Plain dict (GraphData.from_fetch_result()'s shape) for `graph`,
    which must already carry each node's "elevation" attribute and already
    be in its final projected CRS - the shared tail of
    _add_elevations_and_build_result() below, and of
    rebuild_result_with_obstacle()'s no-network re-derivation after
    pruning/restoring nodes locally (e.g. toggling an obstacle group)."""
    # Convert the graph into two GeoDataFrames (one row per node, one row
    # per edge) - an easy shape to pull plain x/y/elevation lists out of.
    nodes, edges = ox.graph_to_gdfs(graph)

    elevations = nodes["elevation"].to_numpy(dtype=float)
    # A handful of nodes can come back with no elevation data (provider gaps
    # right at the coordinate); drop those rather than plotting/routing
    # through a NaN.
    valid = ~np.isnan(elevations)
    nodes = nodes[valid]
    elevations = elevations[valid]

    # Each edge geometry is a shapely LineString; `.coords` gives its
    # (x, y) points in order. Split those into separate x-lists and y-lists,
    # the shape Bokeh's multi_line glyph expects.
    edge_lines = [list(geom.coords) for geom in edges.geometry]
    edge_xs = [[pt[0] for pt in line] for line in edge_lines]
    edge_ys = [[pt[1] for pt in line] for line in edge_lines]

    return {
        "node_x": nodes["x"].tolist(),
        "node_y": nodes["y"].tolist(),
        "node_elevation": elevations.tolist(),
        "node_ids": nodes.index.tolist(),
        # The full graph (every node, including ones dropped above for
        # having no elevation data - they're still real, traversable
        # intersections) - kept for routing (GraphCompressor walks the real
        # road graph, not just the elevation-tagged subset).
        "graph": graph,
        "edge_xs": edge_xs,
        "edge_ys": edge_ys,
        "n_nodes": len(nodes),
    }


def _add_elevations_and_build_result(graph):
    """Shared tail of fetch_place_data()/fetch_point_region_data(): look up
    each node's elevation, reproject to DISPLAY_CRS, and convert to the
    plain dict shape GraphData.from_fetch_result() expects."""
    graph = add_node_elevations(graph)
    graph = ox.projection.project_graph(graph, to_crs=DISPLAY_CRS)
    return _graph_to_result(graph)


def rebuild_result_with_obstacle(graph, obstacle_geometry=None):
    """A plain result dict (GraphData.from_fetch_result()'s shape) for
    `graph` - which must already be elevation-annotated and in its final
    projected CRS, e.g. an already-loaded ElevationGraphData.graph - with
    any node/edge intersecting `obstacle_geometry` pruned first (see
    remove_geometry_from_graph()), or left as-is if `obstacle_geometry` is
    None. No network calls, so it's safe to call every time an obstacle
    group's enabled checkbox is toggled."""
    if obstacle_geometry is not None:
        graph = remove_geometry_from_graph(graph, obstacle_geometry)
    return _graph_to_result(graph)


def fetch_place_data(place, network_type=NETWORK_TYPE):
    """Download the network and its elevations for `place`. Slow - run
    off whatever thread needs to stay responsive. Returns a plain dict; use
    GraphData.from_fetch_result() to turn it into a GraphData."""
    return _add_elevations_and_build_result(fetch_place_graph(place, network_type=network_type))


def fetch_point_region_data(sources, sinks, dist_buffer=DEFAULT_BUFFER_M, network_type=NETWORK_TYPE):
    """Download the network and its elevations around a routing request's
    source/sink points ((lat, lon) pairs or per-site dicts - see
    point_loc()), for callers with points but no place name. Slow.
    Returns a plain dict shaped like fetch_place_data()'s."""
    points = [Point(lon, lat) for lat, lon in (point_loc(p) for p in list(sources) + list(sinks))]
    graph = fetch_graph_around(points, buffer_m=dist_buffer, network_type=network_type)
    return _add_elevations_and_build_result(graph)


@dataclass
class GraphData:
    """The currently loaded graph's node coordinates, as plain numpy
    arrays, plus a few derived bounds used to size filter sliders/validate
    criteria. Every selection function in evaccast.core.selection (which
    nodes pass a given distance criterion) reads from this.

    `node_ids` is aligned 1:1 with `x`/`y` (the real OSMnx node id behind
    each entry) - SelectionState.applied_node_ids() uses it to turn a
    boolean filter mask into node ids for GraphCompressor.

    `graph` is the underlying networkx MultiDiGraph itself, kept around for
    routing use.

    x/y are DISPLAY_CRS (EPSG:3857) coordinates; `distance_max` (the
    extent's diagonal) is in ground meters. See ElevationGraphData below
    for the per-node elevation the Bokeh app's elevation criterion needs.
    """

    x: np.ndarray = field(default_factory=lambda: np.array([]))
    y: np.ndarray = field(default_factory=lambda: np.array([]))
    node_ids: np.ndarray = field(default_factory=lambda: np.array([]))
    graph: object = None
    edge_xs: list = field(default_factory=list)
    edge_ys: list = field(default_factory=list)
    distance_max: float = 1.0

    @classmethod
    def from_fetch_result(cls, result):
        """Build a GraphData from a result dict shaped like
        fetch_place_data()'s return value (node_x/node_y/node_ids/graph/
        edge_xs/edge_ys). `cls` is honored (not hardcoded to GraphData), so
        ElevationGraphData.from_fetch_result() below can call this via
        super() and get an ElevationGraphData back, not a plain GraphData."""
        node_x = result["node_x"]
        node_y = result["node_y"]
        data = cls(
            x=np.array(node_x),
            y=np.array(node_y),
            node_ids=np.array(result["node_ids"]),
            graph=result["graph"],
            edge_xs=result["edge_xs"],
            edge_ys=result["edge_ys"],
        )
        if node_x:
            width = max(node_x) - min(node_x)
            height = max(node_y) - min(node_y)
            center_y = (max(node_y) + min(node_y)) / 2
            data.distance_max = float(np.hypot(width, height) / mercator_scale(center_y)) or 1.0
        return data

    @classmethod
    def load(cls, place, network_type=NETWORK_TYPE):
        """Fetch and build a GraphData for `place` in one call. Slow - see
        fetch_place_data()'s docstring. Note this still fetches elevations
        under the hood (fetch_place_data() always does) even when called as
        plain GraphData.load() - it's just discarded; call
        ElevationGraphData.load() instead to keep it."""
        return cls.from_fetch_result(fetch_place_data(place, network_type=network_type))

    def __len__(self):
        return len(self.x)


@dataclass
class ElevationGraphData(GraphData):
    """A GraphData that also carries per-node elevation - what the
    elevation-map Bokeh app's Source/Target "elevation" filter criterion
    (evaccast.core.selection.KIND_ELEVATION) and node coloring need. Built
    via fetch_place_data()'s Open Topo Data lookup (see .load(), inherited
    from GraphData - cls-polymorphic, so it builds an ElevationGraphData
    here rather than needing its own override)."""

    elevation: np.ndarray = field(default_factory=lambda: np.array([]))
    elevation_min: float = 0.0
    elevation_max: float = 1.0

    @classmethod
    def from_fetch_result(cls, result):
        data = super().from_fetch_result(result)
        node_elevation = result["node_elevation"]
        data.elevation = np.array(node_elevation)
        if node_elevation:
            data.elevation_min = min(node_elevation)
            data.elevation_max = max(node_elevation)
        return data

    @classmethod
    def from_points(cls, sources, sinks, dist_buffer=1000.0, network_type=NETWORK_TYPE):
        """Fetch and build an ElevationGraphData around a set of (lat, lon)
        source/sink points instead of a place name - see
        fetch_point_region_data()'s docstring. Slow (network calls); used by
        the Bokeh UI's request-import path (evaccast.bokeh_app.scenario_io),
        which has points but no place to geocode."""
        return cls.from_fetch_result(
            fetch_point_region_data(sources, sinks, dist_buffer=dist_buffer, network_type=network_type)
        )
