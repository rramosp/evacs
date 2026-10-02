"""Per-edge road capacity (vehicles/hour) and free-flow travel time from raw
OSMnx/OSM tags (`highway`, `lanes`, `maxspeed`), for use by
evaccast.core.routing.system_optimum's capacity-respecting flow solve.

`highway`/`lanes`/`maxspeed` can each be a scalar OR a list on a real OSMnx
edge - OSMnx merges tags across simplified/parallel ways, and a single OSM
way can itself carry a semicolon-delimited multi-value tag. `maxspeed` is
frequently missing outright, and `lanes` is often missing on minor roads.
Every function here is defensive about both: it always resolves to *some*
number, falling back to a highway-class-keyed default table rather than
raising, since a routing solver needs a value for every edge, however rough.

This module never reads NODE data (OSM also uses "highway" as a point-
feature tag - "traffic_signals", "stop", "crossing", etc. - which would
otherwise leak into the lookup as unknown classes; harmless given the
fallback bucket, but worth keeping straight).

The capacity table below is HCM-*ish* - a reasonable planning-level
approximation of the Highway Capacity Manual's per-lane saturation flow
rates, scaled down by road class - not a calibrated HCM analysis. Treat the
numbers as tunable defaults, not ground truth.
"""

import re
from dataclasses import dataclass

MPH_TO_KPH = 1.60934


@dataclass(frozen=True)
class HighwayClassDefaults:
    lanes: int  # default lanes *in one direction* if the "lanes" tag is unusable
    capacity_per_lane_veh_per_hr: float
    free_flow_speed_kph: float


HIGHWAY_CLASS_DEFAULTS = {
    "motorway": HighwayClassDefaults(2, 2200, 110),
    "motorway_link": HighwayClassDefaults(1, 1500, 60),
    "trunk": HighwayClassDefaults(2, 2000, 90),
    "trunk_link": HighwayClassDefaults(1, 1500, 50),
    "primary": HighwayClassDefaults(1, 1800, 70),
    "primary_link": HighwayClassDefaults(1, 1500, 50),
    "secondary": HighwayClassDefaults(1, 1700, 60),
    "secondary_link": HighwayClassDefaults(1, 1400, 40),
    "tertiary": HighwayClassDefaults(1, 1400, 50),
    "tertiary_link": HighwayClassDefaults(1, 1200, 40),
    "unclassified": HighwayClassDefaults(1, 1200, 40),
    "residential": HighwayClassDefaults(1, 1000, 30),
    "living_street": HighwayClassDefaults(1, 600, 15),
    "service": HighwayClassDefaults(1, 600, 15),
    "road": HighwayClassDefaults(1, 1000, 30),  # OSM's own "unknown class" tag
}
# Anything not in the table above (an unrecognized class, or junk data)
# falls back to this bucket, so resolving a class never raises.
DEFAULT_HIGHWAY_CLASS = "unclassified"

_MAXSPEED_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(mph|km/h|kmh)?\s*$", re.IGNORECASE)


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def resolve_highway_class(highway_tag):
    """The most conservative (lowest-capacity) of `highway_tag`'s known
    values - a scalar or a list - or DEFAULT_HIGHWAY_CLASS if none are
    recognized."""
    known = [v for v in _as_list(highway_tag) if v in HIGHWAY_CLASS_DEFAULTS]
    if not known:
        return DEFAULT_HIGHWAY_CLASS
    return min(known, key=lambda cls: HIGHWAY_CLASS_DEFAULTS[cls].capacity_per_lane_veh_per_hr)


def resolve_lanes(edge_data, highway_class):
    """Lanes carried by this one directed edge. OSM's "lanes" tag counts
    both directions of a two-way street, so a parsed value is halved
    (floored, minimum 1) unless the edge is tagged "oneway". Falls back to
    the highway class's default (already a one-direction count) if "lanes"
    is missing, a list with nothing parseable, or non-positive.

    Deferred: OSM's more precise "lanes:forward"/"lanes:backward" tags
    aren't used here - matching them correctly to this edge's actual (u, v)
    direction needs reasoning about OSMnx's post-simplification edge
    bookkeeping, left as follow-up.
    """
    parsed = []
    for value in _as_list(edge_data.get("lanes")):
        try:
            parsed.append(int(float(value)))
        except (TypeError, ValueError):
            continue
    if not parsed or min(parsed) <= 0:
        return HIGHWAY_CLASS_DEFAULTS[highway_class].lanes
    lanes = min(parsed)
    if not edge_data.get("oneway"):
        lanes = max(1, lanes // 2)
    return lanes


def resolve_free_flow_speed_kph(edge_data, highway_class):
    """The most conservative (lowest) parsed "maxspeed" value, in km/h - a
    bare number with no unit suffix is treated as km/h (OSM's documented
    convention; "mph" must be spelled out). Falls back to the highway
    class's default speed if "maxspeed" is missing or nothing in it
    parses."""
    parsed = []
    for value in _as_list(edge_data.get("maxspeed")):
        match = _MAXSPEED_RE.match(str(value))
        if not match:
            continue
        speed, unit = float(match.group(1)), (match.group(2) or "").lower()
        parsed.append(speed * MPH_TO_KPH if unit == "mph" else speed)
    if not parsed:
        return HIGHWAY_CLASS_DEFAULTS[highway_class].free_flow_speed_kph
    return min(parsed)


def edge_capacity_veh_per_hr(edge_data):
    """Vehicles/hour this one directed edge can carry, from its "highway"
    and "lanes" tags."""
    highway_class = resolve_highway_class(edge_data.get("highway"))
    lanes = resolve_lanes(edge_data, highway_class)
    return lanes * HIGHWAY_CLASS_DEFAULTS[highway_class].capacity_per_lane_veh_per_hr


def edge_free_flow_time_s(edge_data, speed_override_kph=None):
    """Free-flow travel time (seconds) from "length" (meters - already
    present on every OSMnx edge) and the resolved free-flow speed - or
    `speed_override_kph` instead, if given (e.g. a uniform speed for
    debugging, ignoring every edge's own "maxspeed"/class default)."""
    if speed_override_kph is None:
        highway_class = resolve_highway_class(edge_data.get("highway"))
        speed_override_kph = resolve_free_flow_speed_kph(edge_data, highway_class)
    speed_kph = max(speed_override_kph, 1.0)
    length_m = edge_data.get("length", 1.0)
    return length_m / (speed_kph / 3.6)


def annotate_graph_capacity(
    graph, capacity_attr="capacity", free_flow_time_attr="free_flow_time", speed_override_kph=None,
):
    """Set `capacity_attr` (veh/hr) and `free_flow_time_attr` (seconds) on
    every real edge of `graph`, in place. Non-destructive: only fills in an
    attribute that isn't already present, so this is safe to call more than
    once, or on a graph a caller has already partially annotated. Skips any
    edge touching a `synthetic=True` node (GraphCompressor's SUPER_SOURCE/
    SUPER_TARGET/region-representative connector edges) - those carry their
    own deliberately-chosen capacity/weight, not a road's.

    `speed_override_kph`: if given, every edge's free-flow time is
    (re)computed at that one speed - overwriting any existing value, since
    an explicit override should win. Capacity doesn't depend on speed here,
    so it's unaffected either way.
    """
    edges = (
        graph.edges(keys=True, data=True)
        if graph.is_multigraph()
        else ((u, v, None, d) for u, v, d in graph.edges(data=True))
    )
    for u, v, _key, data in edges:
        if graph.nodes[u].get("synthetic") or graph.nodes[v].get("synthetic"):
            continue
        if capacity_attr not in data:
            data[capacity_attr] = edge_capacity_veh_per_hr(data)
        if free_flow_time_attr not in data or speed_override_kph is not None:
            data[free_flow_time_attr] = edge_free_flow_time_s(data, speed_override_kph)
