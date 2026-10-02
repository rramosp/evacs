"""Evacuation planning: route a population from source regions to target
regions over a road graph with SystemOptimumRoutePlanner, within a time
horizon, and report the result - or, if it can't be done, say why.

This is the one planning code path every front end shares: the HTTP API
(evaccast.api.v1.routing adapts request shapes onto it), the Bokeh Route
Plan tab, and the scripts. It takes node-id regions, so it works on any
graph whatever its CRS (the API's unprojected EPSG:4326 graphs, the UI's
EPSG:3857 ones); nodes_within()/nearest_nodes() turn EPSG:4326 lon/lat
geometry into those node ids.

A "region" throughout is a (node_ids, quantity) pair: a source region's
quantity is its population (None = 0, nobody to move), a target region's
its capacity (None = unconstrained). Population and vehicles are treated
1:1 - vehicle occupancy isn't modelled yet.
"""

import json
import math
from dataclasses import dataclass, field
from functools import cached_property

import geopandas as gpd
import networkx as nx
import numpy as np
import osmnx as ox
from geojson_pydantic import FeatureCollection
from shapely.geometry import MultiLineString

from . import capacity
from .routing import GraphCompressor, SystemOptimumRoutePlanner
from .routing.system_optimum import max_flow_between

GEOGRAPHIC_CRS = "EPSG:4326"


class InfeasibleEvacuationError(ValueError):
    """The full demand can't reach targets within the time horizon (and
    allow_unsheltered was False). The message names the bottleneck(s) -
    see _explain_infeasibility(). A ValueError, so the HTTP API's handler
    surfaces it as a 422."""


@dataclass
class EvacuationTimeBound:
    """evacuation_time_lower_bound()'s result. `sources`/`targets` are
    (index, amount, veh/hr rate) triples: each populated source's
    population and max outflow to all targets; each target that MUST take
    in `amount` > 0 (the other targets can't hold the rest) and its max
    inflow from all sources."""

    hours: float | None
    network_rate: float
    total_target_capacity: float | None
    sources: list
    targets: list


@dataclass
class RouteComputation:
    """plan_evacuation()'s result.

    - assignments: the planner's RouteAssignments (real edges, flow,
      evac_time_estimate) - excluding the unsheltered overflow, which is
      summed into `unsheltered` instead.
    - max_flow_veh_per_hr: the network's max throughput from all sources
      to all targets - an upper bound no plan can beat.
    - min_evac_time_hours: evacuation_time_lower_bound()'s `hours` - the
      slowest of several max-flow lower bounds; None if no horizon could
      ever move everyone.
    - demand / time_horizon_hours / unsheltered: what was asked for, the
      window it had, and how much of it couldn't reach a target in that
      window (only ever > 0 with allow_unsheltered=True).
    - graph: the exact graph solved over, for plotting/inspection.
    - routes: the assignments as a GeoJSON FeatureCollection in EPSG:4326
      (one feature per real edge, with "source"/"sink"/"route_index"/
      "flow"/"evac_time_estimate" properties) - built on first access.
    - vehicle_paths: one EPSG:4326 MultiLineString per vehicle (e.g. bus),
      for visualization/simulation - built on first access. Each
      assignment's path (one part per road edge, in travel order; the
      first coordinate is where it leaves its source region) is repeated
      ceil(flow / occupancy) times, `occupancy` being the vehicle
      occupancy of the source region the path starts in - so the last
      vehicle on a path may be under-full, and paths overlap freely. A
      path from a region with no occupancy set appears once. Purely a
      presentation of `assignments`: the solve itself is in people.
    """

    assignments: list
    max_flow_veh_per_hr: float
    min_evac_time_hours: float | None
    graph: object = None
    demand: float = 0.0
    time_horizon_hours: float = 1.0
    unsheltered: float = 0.0
    # Source node id -> that node's region's vehicle occupancy (None =
    # unset), for vehicle_paths - see plan_evacuation().
    source_occupancy_by_node: dict = field(default_factory=dict, repr=False)

    @property
    def sheltered(self) -> float:
        return self.demand - self.unsheltered

    @cached_property
    def routes(self) -> FeatureCollection:
        return FeatureCollection(type="FeatureCollection", features=route_features(self.graph, self.assignments))

    @cached_property
    def vehicle_paths(self) -> list[MultiLineString]:
        paths = []
        for assignment in self.assignments:
            if not assignment.edges:
                continue
            path = path_geometry(self.graph, assignment)
            occupancy = self.source_occupancy_by_node.get(assignment.edges[0][0])
            copies = math.ceil(assignment.flow / occupancy) if occupancy else 1
            paths.extend([path] * copies)
        return paths


def plan_evacuation(
    graph, source_regions, target_regions, time_horizon_hours=1.0, allow_unsheltered=False,
    algorithm="capacity_scaling", source_label="source region", target_label="target region",
    speed_override_kph=None, source_vehicle_occupancy=None,
) -> RouteComputation:
    """Route every source region's population to the target regions over
    `graph`, respecting real road capacity (veh/hr x time_horizon_hours
    per edge) and each target's capacity.

    `source_regions`/`target_regions`: lists of (node_ids, quantity) - see
    the module docstring. `source_label`/`target_label` name regions in
    error messages (e.g. "source point" for the point-based API).

    `speed_override_kph`: plan as if every road had this one free-flow
    speed (a debugging aid), ignoring OSM "maxspeed" tags and class
    defaults. Only travel times - so route choice and evac_time_estimate -
    change; capacity, feasibility and min_evac_time_hours don't depend on
    speed. Solved over a copy, so `graph` itself is left untouched.

    `source_vehicle_occupancy`: optional, one entry per source region (None
    = unset) - only used to size RouteComputation.vehicle_paths, never
    the solve.

    Raises ValueError for a non-positive horizon, no population at all, a
    populated source region with no nodes, or no non-empty target region;
    InfeasibleEvacuationError if the demand doesn't fit and
    allow_unsheltered is False. Empty regions with nothing to supply/absorb
    are ignored.
    """
    if time_horizon_hours <= 0:
        raise ValueError("time_horizon_hours must be > 0")
    if speed_override_kph is not None:
        if speed_override_kph <= 0:
            raise ValueError("speed_override_kph must be > 0")
        graph = graph.copy()
        capacity.annotate_graph_capacity(graph, speed_override_kph=speed_override_kph)
    source_regions = [(list(node_ids), population or 0) for node_ids, population in source_regions]
    occupancies = list(source_vehicle_occupancy) if source_vehicle_occupancy is not None else [None] * len(source_regions)
    if len(occupancies) != len(source_regions):
        raise ValueError("source_vehicle_occupancy must have exactly one entry per source region")
    # First region listing a node wins, if regions overlap/touch.
    source_occupancy_by_node = {}
    for (node_ids, _population), occupancy in zip(source_regions, occupancies):
        for node in node_ids:
            source_occupancy_by_node.setdefault(node, occupancy)
    for index, (node_ids, population) in enumerate(source_regions):
        if population > 0 and not node_ids:
            raise ValueError(f"{source_label} {index} (population {population:,.0f}) contains no graph node")
    # An empty region with nothing to supply/absorb can't matter - drop it
    # rather than hand the compressor an empty node set.
    source_regions = [(ids, population) for ids, population in source_regions if ids]
    target_regions = [(list(node_ids), capacity) for node_ids, capacity in target_regions if node_ids]
    demand = sum(population for _ids, population in source_regions)
    if demand <= 0:
        raise ValueError(f"at least one {source_label} must have a population > 0")
    if not target_regions:
        raise ValueError(f"no {target_label} contains a graph node")

    source_node_ids = _union(source_regions)
    target_node_ids = _union(target_regions)
    planner = SystemOptimumRoutePlanner(GraphCompressor(graph), time_horizon_hours=time_horizon_hours)
    try:
        assignments = planner.plan(
            source_node_ids, target_node_ids, demand, algorithm=algorithm,
            source_regions=source_regions, target_regions=target_regions, allow_unsheltered=allow_unsheltered,
        )
    except nx.NetworkXUnfeasible as exc:
        raise InfeasibleEvacuationError(_explain_infeasibility(
            graph, demand, source_regions, target_regions, time_horizon_hours, source_label, target_label,
        )) from exc

    bound = evacuation_time_lower_bound(graph, source_regions, target_regions, demand)
    return RouteComputation(
        # The overflow assignment (if any) always comes last, so the real
        # routes keep indices 0..n-1.
        assignments=[a for a in assignments if not a.overflow],
        max_flow_veh_per_hr=bound.network_rate,
        min_evac_time_hours=bound.hours,
        graph=graph,
        demand=demand,
        time_horizon_hours=time_horizon_hours,
        unsheltered=sum(a.flow for a in assignments if a.overflow),
        source_occupancy_by_node=source_occupancy_by_node,
    )


def evacuation_time_lower_bound(graph, source_regions, target_regions, demand=None) -> EvacuationTimeBound:
    """The slowest of several independent max-flow/min-cut lower bounds on
    how long moving `demand` (default: the sources' total population) must
    take - so their max is a lower bound too:

    - the whole network: demand / max flow (all sources -> all targets);
    - each source region: its population / its own max outflow - a small
      site with one thin exit road can't empty faster than that however
      much capacity the rest of the network has;
    - each target region that must absorb at least
      demand - (sum of every other target's capacity): that much / its own
      max inflow. Only binds when target capacity is tight; skipped for a
      target if any other target is unconstrained (None).

    `hours` is None when no horizon could ever suffice: the network moves
    nothing, a populated source reaches no target, a target that must
    absorb flow is unreachable, or total target capacity < demand. Still
    only a lower bound - sources competing for the same shared road can
    need longer."""
    if demand is None:
        demand = sum(population or 0 for _ids, population in source_regions)
    source_node_ids = _union(source_regions)
    target_node_ids = _union(target_regions)
    network_rate = max_flow_between(graph, source_node_ids, target_node_ids)

    sources = [
        (index, population, max_flow_between(graph, node_ids, target_node_ids))
        for index, (node_ids, population) in enumerate(source_regions)
        if population
    ]

    capacities = [capacity for _ids, capacity in target_regions]
    total_target_capacity = sum(capacities) if all(c is not None for c in capacities) else None
    targets = []
    for index, (node_ids, capacity) in enumerate(target_regions):
        others = capacities[:index] + capacities[index + 1:]
        if any(c is None for c in others):
            continue
        must_absorb = min(demand - sum(others), demand if capacity is None else capacity)
        if must_absorb > 0:
            targets.append((index, must_absorb, max_flow_between(graph, source_node_ids, node_ids)))

    hours = None
    infeasible = (
        network_rate <= 0
        or (total_target_capacity is not None and total_target_capacity < demand)
        or any(rate <= 0 for _i, _amount, rate in sources + targets)
    )
    if not infeasible and demand > 0:
        hours = max([demand / network_rate] + [amount / rate for _i, amount, rate in sources + targets])
    return EvacuationTimeBound(hours, network_rate, total_target_capacity, sources, targets)


def nodes_within(graph, shape):
    """Node ids of every `graph` node inside/on `shape` (an EPSG:4326
    shapely geometry), whatever `graph`'s own CRS."""
    nodes_gdf = ox.graph_to_gdfs(graph, edges=False)
    shape = _to_crs([shape], nodes_gdf.crs)[0]
    return nodes_gdf.index[nodes_gdf.intersects(shape)].tolist()


def nearest_nodes(graph, points):
    """The id of the `graph` node nearest each of `points` (EPSG:4326
    shapely Points), whatever `graph`'s own CRS."""
    points = _to_crs(points, graph.graph.get("crs", GEOGRAPHIC_CRS))
    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return np.atleast_1d(ox.distance.nearest_nodes(graph, X=xs, Y=ys)).tolist()


def route_features(graph, assignments):
    """GeoJSON features (EPSG:4326) for `assignments`: one per real edge,
    with that edge's own geometry and OSM tags plus "source"/"sink"/
    "route_index" (position in `assignments`)/"flow"/"evac_time_estimate"."""
    features = []
    for route_index, assignment in enumerate(assignments):
        if not assignment.edges:
            continue
        node_sequence = [assignment.edges[0][0], *(v for _u, v in assignment.edges)]
        route_gdf = ox.routing.route_to_gdf(graph, node_sequence, weight="length")
        if route_gdf.crs is not None and not route_gdf.crs.equals(GEOGRAPHIC_CRS):
            route_gdf = route_gdf.to_crs(GEOGRAPHIC_CRS)
        route_gdf["source"] = node_sequence[0]
        route_gdf["sink"] = node_sequence[-1]
        route_gdf["route_index"] = route_index
        route_gdf["flow"] = assignment.flow
        route_gdf["evac_time_estimate"] = assignment.evac_time_estimate
        features.extend(json.loads(route_gdf.to_json())["features"])
    return features


def path_geometry(graph, assignment):
    """`assignment`'s real edges as one EPSG:4326 MultiLineString, one
    part per road edge in travel order (each edge's own geometry, e.g.
    curved streets, not a straight line between intersections)."""
    node_sequence = [assignment.edges[0][0], *(v for _u, v in assignment.edges)]
    route_gdf = ox.routing.route_to_gdf(graph, node_sequence, weight="length")
    if route_gdf.crs is not None and not route_gdf.crs.equals(GEOGRAPHIC_CRS):
        route_gdf = route_gdf.to_crs(GEOGRAPHIC_CRS)
    return MultiLineString(list(route_gdf.geometry))


def _union(regions):
    """Every node id across `regions`, deduplicated, first-seen order."""
    return list(dict.fromkeys(n for node_ids, _quantity in regions for n in node_ids))


def _to_crs(geometries, crs):
    """`geometries` (EPSG:4326) reprojected to `crs` - a no-op when `crs`
    is EPSG:4326 already."""
    series = gpd.GeoSeries(list(geometries), crs=GEOGRAPHIC_CRS)
    if crs is None or series.crs.equals(crs):
        return list(series)
    return list(series.to_crs(crs))


def _explain_infeasibility(
    graph, demand, source_regions, target_regions, time_horizon_hours, source_label, target_label,
):
    """A human-readable reason `demand` can't be routed within
    `time_horizon_hours`: (1) total target capacity vs demand, (2) each
    source's max outflow vs its population, (3) each capacity-constrained
    target's max inflow vs what it must absorb, (4) failing those, the
    whole network's max flow vs demand. These are necessary conditions
    only - if none trips, sources are competing for shared capacity, and
    the message says so. When a longer horizon would help, it says how
    long it needs to be at minimum."""
    horizon = f"{time_horizon_hours:g}h"
    reasons = []
    bound = evacuation_time_lower_bound(graph, source_regions, target_regions, demand)

    if bound.total_target_capacity is not None and bound.total_target_capacity < demand:
        reasons.append(f"total {target_label} capacity is {bound.total_target_capacity:,.0f}, less than the demand")

    for index, population, rate in bound.sources:
        if rate <= 0:
            reasons.append(f"{source_label} {index} can't reach any target at all")
        elif rate * time_horizon_hours < population:
            reasons.append(
                f"{source_label} {index} (population {population:,.0f}) can only move "
                f"{rate * time_horizon_hours:,.0f} to any target in {horizon} ({rate:,.0f} veh/hr max outflow)"
            )
    for index, must_absorb, rate in bound.targets:
        if rate <= 0:
            reasons.append(f"{target_label} {index} can't be reached from any source at all")
        elif rate * time_horizon_hours < must_absorb:
            reasons.append(
                f"{target_label} {index} must take in at least {must_absorb:,.0f} (the other targets can't "
                f"hold the rest) but can only receive {rate * time_horizon_hours:,.0f} in {horizon} "
                f"({rate:,.0f} veh/hr max inflow)"
            )
    if not reasons and bound.network_rate * time_horizon_hours < demand:
        reasons.append(
            f"the network as a whole can only move {bound.network_rate * time_horizon_hours:,.0f} in {horizon}"
        )
    if not reasons:
        reasons.append(
            "no single source/target is the bottleneck on its own - sources are competing for shared "
            "roads or target capacity"
        )

    message = f"Can't move all {demand:,.0f} evacuees to targets within {horizon}: " + "; ".join(reasons) + "."
    hints = ["pass allow_unsheltered=True to route what fits and report the rest"]
    if bound.hours is not None and bound.hours > time_horizon_hours:
        hints.insert(0, f"raise time_horizon_hours to at least {bound.hours:.2f}h")
    elif bound.hours is not None:
        hints.insert(0, "raise time_horizon_hours")
    return message + " Try: " + ", or ".join(hints) + "."
