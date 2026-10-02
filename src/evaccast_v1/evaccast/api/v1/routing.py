"""The HTTP API's request shapes adapted onto evaccast.core.planning: fetch
the road network around the request, turn its points/areas into node-id
regions, and plan. All the planning itself - capacity, time horizon,
lower bounds, infeasibility explanations - lives in core, shared with the
Bokeh UI and the scripts.

Coordinates: point requests carry (lat, lon) pairs (the documented HTTP
contract - see demo_http.SourcePoint); they're converted to EPSG:4326
shapely Points here, once, which is what everything in core takes.
Area requests are shapely geometries in EPSG:4326 already.
"""

from shapely.geometry import Point
from shapely.ops import unary_union

from evaccast.core.network import DEFAULT_BUFFER_M, NETWORK_TYPE, avoid_geometry, fetch_graph_around
from evaccast.core.planning import (  # noqa: F401 - re-exported for API callers
    InfeasibleEvacuationError,
    RouteComputation,
    nearest_nodes,
    nodes_within,
    plan_evacuation,
)


def regions_from(node_ids, quantities):
    """[(node_ids, quantity), ...] pairs - one single-node region per
    point - for plan_evacuation()'s source/target regions."""
    return [([node_id], quantity) for node_id, quantity in zip(node_ids, quantities)]


def route_between_points(
    sources: list[tuple[float, float]],
    sinks: list[tuple[float, float]],
    source_populations: list[float | None] | None = None,
    sink_capacities: list[float | None] | None = None,
    avoid_geojson: str | dict | None = None,
    dist_buffer: float = DEFAULT_BUFFER_M,
    network_type: str = NETWORK_TYPE,
    algorithm: str = "capacity_scaling",
    time_horizon_hours: float = 1.0,
    allow_unsheltered: bool = False,
    speed_override_kph: float | None = None,
) -> RouteComputation:
    """Plan an evacuation between (lat, lon) source and sink points: each
    point is snapped to its nearest graph node and treated as its own
    region - a source must supply exactly its population (None = 0), a
    sink absorbs at most its capacity (None = unconstrained).

    `avoid_geojson`: areas to prune from the network (GeoJSON string or
    dict), or None. `dist_buffer`: meters of network fetched beyond the
    points. `time_horizon_hours`/`allow_unsheltered`/`algorithm`/
    `speed_override_kph` (e.g. 25 to give every road 25 km/h, for
    debugging): see evaccast.core.planning.plan_evacuation().

    Raises ValueError for malformed input (checked before any download)
    and InfeasibleEvacuationError if the demand doesn't fit.
    """
    source_populations = list(source_populations) if source_populations is not None else [None] * len(sources)
    sink_capacities = list(sink_capacities) if sink_capacities is not None else [None] * len(sinks)
    if len(source_populations) != len(sources):
        raise ValueError("source_populations must have exactly one entry per source point")
    if len(sink_capacities) != len(sinks):
        raise ValueError("sink_capacities must have exactly one entry per sink point")
    _check_before_fetch(source_populations, time_horizon_hours, speed_override_kph, "source")

    source_points = [Point(lon, lat) for lat, lon in sources]
    sink_points = [Point(lon, lat) for lat, lon in sinks]
    avoid = avoid_geometry(avoid_geojson) if avoid_geojson is not None else None
    graph = fetch_graph_around(source_points + sink_points, buffer_m=dist_buffer, network_type=network_type, avoid=avoid)

    return plan_evacuation(
        graph,
        regions_from(nearest_nodes(graph, source_points), source_populations),
        regions_from(nearest_nodes(graph, sink_points), sink_capacities),
        time_horizon_hours=time_horizon_hours, allow_unsheltered=allow_unsheltered, algorithm=algorithm,
        source_label="source point", target_label="sink point", speed_override_kph=speed_override_kph,
    )


def route_between_areas(
    source_areas: list[dict],
    target_areas: list[dict],
    avoid_areas: list | None = None,
    dist_buffer: float = DEFAULT_BUFFER_M,
    network_type: str = NETWORK_TYPE,
    algorithm: str = "capacity_scaling",
    time_horizon_hours: float = 1.0,
    allow_unsheltered: bool = False,
    speed_override_kph: float | None = None,
) -> RouteComputation:
    """The polygon-area sibling of route_between_points(): each area is
    every graph node inside its shape (no nearest-node fallback - draw an
    area wider, or raise `dist_buffer`, if one comes up empty).

    `source_areas`: dicts {"shape": EPSG:4326 shapely (Multi)Polygon,
    "population": int | None, "vehicle_occupancy": int | None - only
    sizes RouteComputation.vehicle_paths (people per vehicle), not the
    solve}.
    `target_areas`: the same with "capacity". `avoid_areas`: EPSG:4326
    geometries pruned from the network (unioned), or None.
    `speed_override_kph`: give every road this one free-flow speed (e.g.
    25, for debugging) - see route_between_points().

    Raises ValueError for malformed input or an area containing no graph
    node, and InfeasibleEvacuationError if the demand doesn't fit.
    """
    _check_before_fetch(
        [a.get("population") for a in source_areas], time_horizon_hours, speed_override_kph, "source area",
    )

    shapes = [a["shape"] for a in source_areas] + [a["shape"] for a in target_areas]
    avoid = unary_union(avoid_areas) if avoid_areas else None
    graph = fetch_graph_around(shapes, buffer_m=dist_buffer, network_type=network_type, avoid=avoid)

    # Each area as the (node_ids, quantity) region plan_evacuation() takes.
    source_regions = [(nodes_within(graph, a["shape"]), a.get("population")) for a in source_areas]
    target_regions = [(nodes_within(graph, a["shape"]), a.get("capacity")) for a in target_areas]
    _require_every_area_has_a_node(source_areas, source_regions, "source")
    _require_every_area_has_a_node(target_areas, target_regions, "target")

    return plan_evacuation(
        graph, source_regions, target_regions,
        time_horizon_hours=time_horizon_hours, allow_unsheltered=allow_unsheltered, algorithm=algorithm,
        source_label="source area", target_label="target area", speed_override_kph=speed_override_kph,
        source_vehicle_occupancy=[a.get("vehicle_occupancy") for a in source_areas],
    )


def _check_before_fetch(populations, time_horizon_hours, speed_override_kph, label):
    """The input checks plan_evacuation() would make anyway, done before
    the slow network download instead of after it."""
    if time_horizon_hours <= 0:
        raise ValueError("time_horizon_hours must be > 0")
    if speed_override_kph is not None and speed_override_kph <= 0:
        raise ValueError("speed_override_kph must be > 0")
    if sum(p or 0 for p in populations) <= 0:
        raise ValueError(f"at least one {label} must have a population > 0")


def _require_every_area_has_a_node(areas, regions, label):
    for area, (node_ids, _quantity) in zip(areas, regions):
        if not node_ids:
            raise ValueError(f"a {label} area contains no real graph node: {area['shape'].bounds}")
