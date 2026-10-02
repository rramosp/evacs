"""A JSON-safe snapshot of a routing scenario: the place plus Source's and
Target's node-selection filters (see evaccast.core.selection) - i.e.
everything that isn't derivable from the loaded graph itself. Used by the
Bokeh UI's "Export scenario"/"Import scenario" buttons
(evaccast.bokeh_app.scenario_io) for this module's own filter-based shape.

That same "Import scenario" file input also accepts a second, unrelated
shape: a plain routing request (evaccast.api.v1.demo_http.RouteRequest) -
"sources"/"sinks" point lists plus an "avoid_geojson" obstacle group,
instead of filter trees. is_point_request()/source_target_states_from_points()
below turn that shape into the same SelectionState pair this module's own
apply_scenario() produces, so Source/Target work identically either way;
scenario_io.py sniffs which shape it got and calls whichever path applies.
Obstacle handling for that shape lives in evaccast.bokeh_app (there's no
SelectionState-based equivalent for it - see that package's "Obstacles" tab).
"""

import geopandas as gpd
import numpy as np
from shapely.geometry import Point

from .geometry import mercator_scale
from .graph_data import point_loc
from .selection import KIND_DISTANCE, Criterion, SelectionState

SCENARIO_VERSION = 1

# A point-request source/sink is a single lat/lon point, not a region - this
# is the radius (in ground meters) of the small
# disk stood in for it, matching evaccast.api.v1.routing.route_between_points'
# treatment of each side as "one combined region" small enough to still read
# as a point on screen. This is only a FLOOR, not a guarantee: a fixed radius
# can legitimately contain zero real graph nodes (a city block is often
# 50-150m across, and the picked point is rarely exactly on an intersection)
# - see source_target_states_from_points()'s `graph_data` argument, which
# grows a point's own radius past this floor when needed so its disk always
# reaches at least its nearest real node.
POINT_REGION_RADIUS = 25.0
# Extra padding (meters) added past a point's nearest-node distance, so that
# node lands just inside the disk rather than exactly on its boundary.
POINT_REGION_MARGIN = 5.0


def export_scenario(place, source_state, target_state):
    return {
        "version": SCENARIO_VERSION,
        "place": place,
        "source": source_state.to_dict(),
        "target": target_state.to_dict(),
    }


def apply_scenario(scenario):
    """(source_state, target_state) built from an exported scenario dict.
    Raises KeyError/TypeError/ValueError if `scenario` isn't shaped like one
    - callers should catch that and report it rather than leaving a
    half-applied scenario on screen."""
    source_state = SelectionState.from_dict(scenario.get("source", {}))
    target_state = SelectionState.from_dict(scenario.get("target", {}))
    return source_state, target_state


def is_point_request(data):
    """True if `data` looks like a routing request (sources/sinks point
    lists, see evaccast.api.v1.demo_http.RouteRequest) rather than this
    module's own filter-based scenario shape ("source"/"target" filter
    trees) - the two ways evaccast.bokeh_app.scenario_io's single "Import
    scenario" file input can be shaped."""
    return isinstance(data, dict) and "sources" in data and "sinks" in data


def _project_points(points):
    """(lat, lon) pairs -> (x, y) pairs in EPSG:3857 - the CRS
    Criterion.point/criterion_geometry() (evaccast.core.selection) expect,
    matching what the loaded graph's own node coordinates are projected
    into (see evaccast.core.graph_data's fetch_point_region_data()). Each
    entry in `points` may be a plain (lat, lon) pair or the richer
    per-site shape (see evaccast.core.graph_data.point_loc())."""
    locs = [point_loc(p) for p in points]
    projected = gpd.GeoSeries([Point(lon, lat) for lat, lon in locs], crs="EPSG:4326").to_crs("EPSG:3857")
    return [(geom.x, geom.y) for geom in projected]


def nearest_node_distance(point, graph_data):
    """The ground distance (meters) from `point` (an (x, y) pair in
    graph_data's EPSG:3857 display CRS) to the nearest real node in
    `graph_data` - None if it has no nodes."""
    if len(graph_data) == 0:
        return None
    raw = np.hypot(graph_data.x - point[0], graph_data.y - point[1]).min()
    return float(raw / mercator_scale(point[1]))


def _state_from_points(points, radius, graph_data=None, quantity_attr=None):
    """A SelectionState with a single applied filter - one OR'd "distance
    to point" criterion per point in `points`, each a disk at least
    `radius` meters wide - so intersection_geometry() shows the union of
    all of them as one combined region (matching
    route_between_points()'s treatment of a request's sources/sinks). An
    empty SelectionState (no filter at all, rather than a degenerate
    empty-criteria one - see Filter.from_dict's own docstring on why that
    would silently mean "matches nothing") if `points` is empty.

    Each entry in `points` may be a plain (lat, lon) pair, or the richer
    per-site shape (see evaccast.core.graph_data.point_loc() and
    evaccast.api.v1.demo_http.SourcePoint/SinkPoint) - a dict with a "loc"
    key plus an optional "population"/"capacity". `quantity_attr` ("population"
    or "capacity", matching evaccast.core.selection.Criterion's own two
    quantity fields) says which of those two keys, if present on a dict
    point, to carry over onto that point's own Criterion - None (a plain
    (lat, lon) point, or `quantity_attr` itself None) leaves both unset.

    `graph_data`, when given, grows a point's own disk past `radius`
    when needed so it always reaches that point's nearest real node
    (plus POINT_REGION_MARGIN) - `radius` alone is only a floor, not a
    guarantee (see POINT_REGION_RADIUS's own docstring): a routing request
    would otherwise silently end up with an unusable, empty node set
    whenever the picked point happens to be farther than `radius` from
    anything real."""
    state = SelectionState()
    if not points:
        return state
    criteria = []
    for i, (raw, projected) in enumerate(zip(points, _project_points(points))):
        value = radius
        nearest = nearest_node_distance(projected, graph_data) if graph_data is not None else None
        if nearest is not None:
            value = max(radius, nearest + POINT_REGION_MARGIN)
        quantity_kwargs = {}
        if quantity_attr is not None and isinstance(raw, dict):
            quantity_kwargs[quantity_attr] = raw.get(quantity_attr)
        criteria.append(Criterion(id=i, kind=KIND_DISTANCE, op="<=", value=value, point=projected, **quantity_kwargs))
    filt = state.add_filter(criteria)
    state.apply_filter(filt.id)
    return state


def source_target_states_from_points(sources, sinks, radius=POINT_REGION_RADIUS, graph_data=None):
    """(source_state, target_state) built from a routing request's
    sources/sinks point lists - the point-request equivalent of
    apply_scenario(). Pass the just-fetched `graph_data` (see
    evaccast.core.graph_data.fetch_point_region_data()) so each point's
    disk is guaranteed to reach a real node - see _state_from_points(),
    which also documents the richer per-site (dict) point shape this
    carries a "population" (sources)/"capacity" (sinks) over from, if
    present."""
    return (
        _state_from_points(sources, radius, graph_data, quantity_attr="population"),
        _state_from_points(sinks, radius, graph_data, quantity_attr="capacity"),
    )
