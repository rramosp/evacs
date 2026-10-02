"""Node selection: build up a set of *filters* on a GraphData's nodes, where
a node is selected if it satisfies EVERY filter (AND across filters), and a
filter itself is satisfied if the node matches ANY ONE of that filter's
*criteria* (OR within a filter) - e.g. one filter could read "elevation >=
60m OR within 200m of this point".

This module is the Bokeh-agnostic engine behind the elevation-map app's
Source/Target tabs: evaccast.bokeh_app.selection_panel wraps a SelectionState
with widgets (Tabs/Slider/Select/Button) and event handlers; a future
polygon-area-based API endpoint (see draft api.pdf) would build SelectionState
filters directly from request data instead, then call the same
applied_node_ids() this module already provides.

A criterion's "kind" is "elevation" or "distance" (to a picked point); its
"op" is ">=", "<=", or "=". "=" is given a small fixed tolerance
(ELEVATION_EQ_TOLERANCE / a fraction of the graph's own extent for distance)
since elevations and distances are continuous floats that would almost never
exactly match otherwise.
"""

from dataclasses import dataclass, field, replace

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union

from .geometry import CIRCLE_QUAD_SEGS, alpha_shape_geometry, map_bounds_polygon, mercator_scale, point_buffer_radius

KIND_ELEVATION = "elevation"
KIND_DISTANCE = "distance"
KINDS = (KIND_ELEVATION, KIND_DISTANCE)
OPS = (">=", "<=", "=")

ELEVATION_EQ_TOLERANCE = 1.0  # meters
DISTANCE_EQ_TOLERANCE_FRACTION = 0.02  # fraction of the graph's own distance_max


@dataclass
class Criterion:
    id: int
    kind: str = KIND_ELEVATION
    op: str = ">="
    value: float = 0.0
    # (x, y) in the graph's EPSG:3857 display CRS, "distance" only - while
    # a distance criterion's `value` is in ground meters (see
    # evaccast.core.geometry.mercator_scale()).
    point: tuple | None = None
    # A criterion is also the natural "one physical site" granularity (see
    # SelectionState.applied_regions()' docstring): a Source filter's OR'd
    # criteria are its distinct source sites, a Target filter's are its
    # distinct target sites. Only one of these two is ever meaningful for a
    # given criterion depending on which SelectionState (Source vs Target)
    # it lives in - both are carried on the same dataclass rather than
    # split into subclasses so scenario JSON/UI code doesn't need to know
    # which mode built a given Criterion. None means "not specified" -
    # evaccast.core.routing.system_optimum treats an unset source
    # population as 0 (no flow demanded from that site) and an unset
    # target capacity as unconstrained (matching the flat, pre-existing
    # behavior for a region nothing has said anything about).
    population: float | None = None  # Source: how many evacuees are at this site right now
    capacity: float | None = None  # Target: the most evacuees this site can absorb

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "op": self.op,
            "value": self.value,
            "point": self.point,
            "population": self.population,
            "capacity": self.capacity,
        }

    @classmethod
    def from_dict(cls, data):
        point = data.get("point")
        return cls(
            id=data["id"],
            kind=data["kind"],
            op=data["op"],
            value=data["value"],
            point=tuple(point) if point is not None else None,
            population=data.get("population"),
            capacity=data.get("capacity"),
        )


@dataclass
class Filter:
    id: int
    criteria: list = field(default_factory=list)
    registered: bool = False

    def to_dict(self):
        return {
            "id": self.id,
            "criteria": [c.to_dict() for c in self.criteria],
            "registered": self.registered,
        }

    @classmethod
    def from_dict(cls, data):
        criteria = [Criterion.from_dict(c) for c in data["criteria"]]
        if not criteria:  # an empty OR would silently mean "matches nothing"
            raise ValueError(f"filter {data.get('id')!r} has no criteria")
        return cls(id=data["id"], criteria=criteria, registered=bool(data.get("registered")))


# --- pure mask/geometry functions, given a GraphData ------------------------


def feature_values(graph_data, criterion):
    """The continuous value this criterion is thresholding, one per node in
    `graph_data`: elevation directly, or distance to the criterion's picked
    point. Returns None if a distance criterion has no point picked yet."""
    if criterion.kind == KIND_ELEVATION:
        return graph_data.elevation
    if criterion.point is None:
        return None
    point_x, point_y = criterion.point
    # Ground meters, not raw EPSG:3857 units - see mercator_scale().
    return np.hypot(graph_data.x - point_x, graph_data.y - point_y) / mercator_scale(point_y)


def feature_mask(values, op, value, tolerance):
    """Boolean array of which nodes satisfy `values <op> value`."""
    if op == ">=":
        return values >= value
    if op == "<=":
        return values <= value
    return np.abs(values - value) <= tolerance


def criterion_tolerance(graph_data, criterion):
    if criterion.kind == KIND_ELEVATION:
        return ELEVATION_EQ_TOLERANCE
    return DISTANCE_EQ_TOLERANCE_FRACTION * graph_data.distance_max


def criterion_mask(graph_data, criterion):
    """Boolean array of which nodes satisfy this single criterion, or
    all-False if it's an incomplete distance criterion (no point picked
    yet)."""
    values = feature_values(graph_data, criterion)
    if values is None:
        return np.zeros(len(graph_data), dtype=bool)
    return feature_mask(values, criterion.op, criterion.value, criterion_tolerance(graph_data, criterion))


def filter_mask(graph_data, filt):
    """Boolean array of which nodes satisfy this filter: the OR (union) of
    all its criteria - a node needs to match only one to pass the filter."""
    mask = np.zeros(len(graph_data), dtype=bool)
    for criterion in filt.criteria:
        mask |= criterion_mask(graph_data, criterion)
    return mask


def criterion_geometry(graph_data, criterion):
    """The on-map geometry a single criterion selects:

    - 'distance': the exact shapely shape - a filled disk (<=), an annulus
      (=, using its tolerance band as the ring width), or the complement of
      a disk clipped to the graph's extent (>=). Distance is inherently
      spatial, so this draws exactly what it means.
    - 'elevation': elevation has no 2D shape of its own, so this instead
      traces an alpha shape (see evaccast.core.geometry.alpha_shape_geometry)
      around the x/y positions of whichever nodes currently satisfy it -
      unlike a convex hull it won't bridge over gaps the selection doesn't
      actually cover.

    Returns None for a 'distance' criterion with no point picked yet, or a
    criterion that currently matches zero nodes.
    """
    if criterion.kind == KIND_DISTANCE:
        if criterion.point is None:
            return None
        bounds = map_bounds_polygon(graph_data.x, graph_data.y)
        if bounds is None:
            return None
        center = Point(criterion.point)
        # criterion.value/tolerance are ground meters; the geometry is drawn
        # in EPSG:3857, so scale radii up by mercator_scale() to match.
        scale = float(mercator_scale(criterion.point[1]))
        value = criterion.value * scale
        if criterion.op == "<=":
            return center.buffer(value, quad_segs=CIRCLE_QUAD_SEGS).intersection(bounds)
        if criterion.op == ">=":
            return bounds.difference(center.buffer(value, quad_segs=CIRCLE_QUAD_SEGS))
        # "=": an annulus straddling `value`, `criterion_tolerance()` wide on
        # each side (mirrors the tolerance criterion_mask() itself uses).
        tolerance = criterion_tolerance(graph_data, criterion) * scale
        outer = center.buffer(value + tolerance, quad_segs=CIRCLE_QUAD_SEGS)
        inner_radius = value - tolerance
        ring = (
            outer.difference(center.buffer(inner_radius, quad_segs=CIRCLE_QUAD_SEGS))
            if inner_radius > 0
            else outer
        )
        return ring.intersection(bounds)

    mask = criterion_mask(graph_data, criterion)
    radius = point_buffer_radius(graph_data.x, graph_data.y)
    return alpha_shape_geometry(graph_data.x[mask], graph_data.y[mask], radius)


def filter_geometry(graph_data, filt):
    """The on-map geometry a filter selects - the union of its criteria's
    geometries (mirroring filter_mask()'s OR). None if no criterion
    currently has a representable geometry (e.g. every 'distance to point'
    criterion is still missing its point, or the filter has no criteria) -
    a criterion that simply matches zero nodes right now just drops out of
    the union rather than blanking the whole filter."""
    geoms = [
        g for g in (criterion_geometry(graph_data, c) for c in filt.criteria) if g is not None and not g.is_empty
    ]
    if not geoms:
        return None
    return unary_union(geoms)


# --- SelectionState: the stateful filter list for one Source/Target/etc. ---


class SelectionState:
    """One mode's (Source, Target, ...) filter list: filters combine with
    AND, each filter's criteria combine with OR (see module docstring).
    Holds only the filter data itself - no notion of which filter/criterion
    a UI happens to be editing right now (that's evaccast.bokeh_app.
    selection_panel's job)."""

    def __init__(self):
        self.filters = []
        self._next_filter_id = 0
        self._next_criterion_id = 0

    # -- building filters/criteria ------------------------------------------

    def new_criterion(self, graph_data, kind=KIND_ELEVATION):
        if kind == KIND_ELEVATION:
            value = (graph_data.elevation_min + graph_data.elevation_max) / 2
        else:
            value = graph_data.distance_max / 2
        criterion = Criterion(id=self._next_criterion_id, kind=kind, op=">=", value=value)
        self._next_criterion_id += 1
        return criterion

    def add_filter(self, criteria):
        """Append a new filter with the given criteria (unregistered) and
        return it."""
        filt = Filter(id=self._next_filter_id, criteria=list(criteria))
        self._next_filter_id += 1
        # Criteria built outside new_criterion()/clone_criteria() (e.g. a
        # point import numbering its own) must not collide with later ones.
        self._next_criterion_id = max([self._next_criterion_id, *(c.id + 1 for c in filt.criteria)])
        self.filters.append(filt)
        return filt

    def clone_criteria(self, filter_id):
        """Fresh copies (new ids, not yet attached to any filter) of an
        existing filter's criteria - the building block for a "Copy filter"
        action, which should create a new unregistered filter rather than
        mutate the source one."""
        source = self.find_filter(filter_id)
        new_criteria = []
        for c in source.criteria:
            # replace(), not a field-by-field copy, so every per-site field
            # (point, population, capacity, ...) comes along.
            new_criteria.append(replace(c, id=self._next_criterion_id))
            self._next_criterion_id += 1
        return new_criteria

    def add_criterion(self, filter_id, graph_data, kind=KIND_ELEVATION):
        filt = self.find_filter(filter_id)
        criterion = self.new_criterion(graph_data, kind=kind)
        filt.criteria.append(criterion)
        filt.registered = False
        return criterion

    def remove_filter(self, filter_id):
        self.filters = [f for f in self.filters if f.id != filter_id]

    def remove_criterion(self, filter_id, criterion_id):
        """Remove a criterion, unless it's the filter's last one - an empty
        OR would silently mean "matches nothing"; removing the whole filter
        is the way to get rid of the last one."""
        filt = self.find_filter(filter_id)
        if len(filt.criteria) <= 1:
            raise ValueError("cannot remove a filter's last criterion; remove the filter instead")
        filt.criteria = [c for c in filt.criteria if c.id != criterion_id]
        filt.registered = False

    def find_filter(self, filter_id):
        return next(f for f in self.filters if f.id == filter_id)

    def find_criterion(self, filter_id, criterion_id):
        filt = self.find_filter(filter_id)
        return next(c for c in filt.criteria if c.id == criterion_id)

    def apply_filter(self, filter_id):
        """Mark a filter as registered (contributing to applied_mask()), or
        raise ValueError if any of its distance criteria is still missing a
        point."""
        filt = self.find_filter(filter_id)
        if any(c.kind == KIND_DISTANCE and c.point is None for c in filt.criteria):
            raise ValueError("every 'distance to point' criterion needs a point before applying")
        filt.registered = True

    # -- reading the current selection ---------------------------------------

    def registered_filters(self):
        return [f for f in self.filters if f.registered]

    def applied_mask(self, graph_data):
        """Boolean array over `graph_data`'s nodes: which ones satisfy every
        *applied* (registered) filter. All-False if nothing's applied yet."""
        registered = self.registered_filters()
        if not registered:
            return np.zeros(len(graph_data), dtype=bool)
        mask = np.ones(len(graph_data), dtype=bool)
        for filt in registered:
            mask &= filter_mask(graph_data, filt)
        return mask

    def applied_node_ids(self, graph_data):
        """The real OSMnx node ids behind applied_mask() - what a routing
        planner should treat as this mode's source/target node set."""
        return graph_data.node_ids[self.applied_mask(graph_data)].tolist()

    def applied_regions(self, graph_data):
        """One (node_ids, criterion) pair per criterion belonging to an
        *applied* filter - the per-site breakdown of applied_node_ids(),
        since each OR'd criterion within a filter is one physical site (one
        drawn circle/polygon), while applied_node_ids() only gives the flat
        union. `node_ids` is that criterion's own contribution: the nodes
        it selects that ALSO satisfy every other applied filter (filters
        AND together - see module docstring), so the UNION of every
        returned `node_ids` equals applied_node_ids() - though with more
        than one registered filter, each filter's own criteria already
        union up to that same full set on their own (every filter must
        agree for a node to be in applied_mask() at all), so summing
        `node_ids` across filters (rather than unioning) double-counts.
        `criterion` carries
        whichever of .population/.capacity a caller cares about (Source vs
        Target - see Criterion's own docstring). Empty list if nothing's
        applied yet."""
        registered = self.registered_filters()
        if not registered:
            return []
        regions = []
        for filt in registered:
            other_mask = np.ones(len(graph_data), dtype=bool)
            for other in registered:
                if other is not filt:
                    other_mask &= filter_mask(graph_data, other)
            for criterion in filt.criteria:
                mask = criterion_mask(graph_data, criterion) & other_mask
                regions.append((graph_data.node_ids[mask].tolist(), criterion))
        return regions

    def intersection_geometry(self, graph_data):
        """The AND (intersection) of every applied filter's own geometry -
        None if nothing's applied yet."""
        registered = self.registered_filters()
        if not registered:
            return None
        intersection = filter_geometry(graph_data, registered[0]) or Polygon()
        for filt in registered[1:]:
            intersection = intersection.intersection(filter_geometry(graph_data, filt) or Polygon())
        return intersection

    # -- scenario export/import ----------------------------------------------

    def to_dict(self):
        """This mode's filters, in a plain/JSON-safe shape (a criterion's
        "point" is a 2-tuple, which json.dumps writes as a 2-element
        array)."""
        return {"filters": [f.to_dict() for f in self.filters]}

    @classmethod
    def from_dict(cls, data):
        """The inverse of to_dict(): a fresh SelectionState with
        `data["filters"]` (tolerating a missing/empty key). Raises
        ValueError/KeyError/TypeError if `data` isn't shaped like a filters
        list at all - callers should catch that and report it rather than
        leaving a half-applied scenario on screen."""
        state = cls()
        state.filters = [Filter.from_dict(f) for f in data.get("filters", [])]
        state._next_filter_id = max((f.id for f in state.filters), default=-1) + 1
        state._next_criterion_id = max((c.id for f in state.filters for c in f.criteria), default=-1) + 1
        return state
