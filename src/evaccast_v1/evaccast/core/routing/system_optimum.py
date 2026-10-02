"""SystemOptimumRoutePlanner: finds a capacity-respecting flow assignment
for `demand` vehicles/evacuees between a source and target node set, using
real per-edge road capacity (evaccast.core.capacity) instead of
RoutePlanner's flat capacity=1-per-edge edge-disjoint assumption.

Scope, stated plainly: this solves a SINGLE min-cost-flow problem using
free-flow edge costs (evaccast.core.capacity's free_flow_time) - it
respects hard capacity limits, but doesn't adjust cost for congestion. That
is NOT true system-optimum flow in the technical sense (which needs
marginal cost, d/dx[x*c(x)], on a congestion-dependent curve). A real
marginal-cost extension - iteratively re-weighting edges by a finite-
difference marginal cost and re-solving - is a concrete, nameable follow-up,
not attempted here. (evaccast.core.equilibrium already implements exactly
that kind of congestion-aware assignment via Frank-Wolfe, but is a separate,
independently-developed piece - not touched or reused by this module.)
"""

import networkx as nx

from evaccast.core import capacity as capacity_module

from .base import BaseRoutePlanner
from .compressor import GraphCompressor, collapse_to_digraph

# The scaled-integer edge attributes nx.capacity_scaling/network_simplex
# actually solve over - kept distinct from capacity_attr/weight_attr (real
# veh/hr and seconds) so the evac-time estimate can read the originals back
# after solving.
_SOLVER_CAPACITY_ATTR = "_flow_capacity"
_SOLVER_WEIGHT_ATTR = "_flow_weight"


def _region_capacity_fn(compressor, all_node_ids, regions, default):
    """A GraphCompressor.build() source/target_region_capacity callable
    from `regions` - a list of (node_ids, quantity) pairs, e.g.
    evaccast.core.selection.SelectionState.applied_regions() with each
    criterion's .population/.capacity swapped in for `quantity` (None
    where unset).

    A criterion's own node_ids are "one physical site" (see
    applied_regions()' docstring), but GraphCompressor.contiguous_regions()
    only looks at edges AMONG the selected nodes themselves - if a site's
    own nodes happen to split into two clusters with no direct edge
    between them (the connecting road passes through an intersection just
    outside the drawn circle/polygon), build() creates TWO representatives
    for that one site. Naively giving each fragment the site's full
    quantity would double-count it (silently letting a demand-vs-capacity
    comparison the user made by hand - e.g. "125 demand against a 100
    capacity site" - pass when it shouldn't, because one 100-capacity site
    fragmented into two representatives each treated as if it alone had
    the full 100). So this mirrors build()'s own
    `compressor.contiguous_regions(all_node_ids)` call up front, works out
    how many of those discovered components EACH criterion actually
    touches, and divides that criterion's quantity evenly across only
    those - so summed back up over every fragment, a site's total
    contribution is still exactly its own stated quantity, never a
    multiple of it. `default` substitutes for any individual unset (None)
    quantity - so a caller that leaves a site's population/capacity unset
    gets exactly the old flat behavior for that site alone - and for a
    discovered component none of `regions` touches at all (shouldn't
    happen when `regions` was built from the same node ids passed to
    GraphCompressor.build())."""
    components = [frozenset(component) for component in compressor.contiguous_regions(all_node_ids)]
    contributions = {component: [] for component in components}
    for node_ids, quantity in regions:
        node_ids = set(node_ids)
        touched = [component for component in components if component & node_ids]
        for component, share in zip(touched, _split_evenly(default if quantity is None else quantity, len(touched))):
            contributions[component].append(share)
    capacity_by_component = {
        component: sum(shares) if shares else default for component, shares in contributions.items()
    }

    def fn(component):
        return capacity_by_component[frozenset(component)]

    return fn


def _expand_super_edges(supergraph, assignment):
    """`assignment` with each muster-to-muster super-edge replaced by the
    real road edges its stored `path` follows - so a hierarchical plan's
    RouteAssignment.edges are real graph edges, same as a flat plan's (see
    RouteAssignment's own docstring)."""
    edges = []
    for u, v in assignment.edges:
        path = supergraph.edges[u, v].get("path") or [u, v]
        edges.extend(zip(path[:-1], path[1:]))
    return type(assignment)(
        edges=edges, flow=assignment.flow, evac_time_estimate=assignment.evac_time_estimate,
        overflow=assignment.overflow,
    )


def _split_evenly(quantity, parts):
    """`quantity` split into `parts` near-equal shares that are whole
    numbers whenever `quantity` is, and always sum back to exactly
    `quantity` - the solver rounds every connector capacity to an int, so
    a naive quantity/parts (e.g. 125 -> 62.5 + 62.5, which round to
    62 + 62 = 124) would make an exactly-balanced plan infeasible."""
    if parts <= 0:
        return []
    if quantity == float("inf"):
        return [quantity] * parts
    whole = int(quantity)
    base, remainder = divmod(whole, parts)
    shares = [base + (1 if i < remainder else 0) for i in range(parts)]
    shares[0] += quantity - whole  # any fractional part, kept whole-sum-exact
    return shares


def max_flow_between(graph, source_node_ids, target_node_ids, capacity_attr="capacity", annotate_capacity=True):
    """The network's own maximum sustainable throughput (vehicles/hour)
    between the source and target node sets, using each real edge's actual
    road capacity (evaccast.core.capacity) - a theoretical upper bound no
    routing plan (RoutePlanner, SystemOptimumRoutePlanner, ...) can beat,
    by max-flow/min-cut duality: population P's minimum possible
    evacuation time is P / max_flow_between(...), regardless of how well
    any particular plan actually routes it.

    Independent of any specific population/demand - unlike
    SystemOptimumRoutePlanner.plan() (whose connector-edge capacity is
    sized to a specific `demand`, since it's solving "route exactly this
    much flow"), this gives the source/target regions' own connector
    edges effectively unbounded capacity, so only real edges' own
    capacity can ever bottleneck the result. 0.0 if the target isn't
    reachable from the source at all."""
    compressor = GraphCompressor(graph)
    compressed = compressor.build(source_node_ids, target_node_ids, connector_weight=0, connector_capacity=float("inf"))
    if annotate_capacity:
        capacity_module.annotate_graph_capacity(
            compressed, capacity_attr=capacity_attr, free_flow_time_attr="free_flow_time"
        )
    collapsed = collapse_to_digraph(compressed, capacity_attr=capacity_attr, weight_attr="free_flow_time")
    if GraphCompressor.SUPER_SOURCE not in collapsed or GraphCompressor.SUPER_TARGET not in collapsed:
        return 0.0
    try:
        cut_value, _partition = nx.minimum_cut(
            collapsed, GraphCompressor.SUPER_SOURCE, GraphCompressor.SUPER_TARGET, capacity=capacity_attr
        )
    except nx.NetworkXUnbounded:
        return float("inf")
    except nx.NetworkXError:  # SUPER_SOURCE/SUPER_TARGET disconnected
        return 0.0
    return cut_value


class SystemOptimumRoutePlanner(BaseRoutePlanner):
    """Wraps a GraphCompressor and solves a min-cost flow of `demand` units
    from the source node set to the target node set, respecting each real
    edge's actual road capacity. `hierarchy` (optional - see
    evaccast.core.routing.hierarchy) routes over a pre-built muster-point
    supergraph instead of the flat GraphCompressor-compressed graph; this
    planner never builds a hierarchy itself, it only consumes one."""

    ROUTE_ALGORITHMS = {"capacity_scaling": nx.capacity_scaling, "network_simplex": nx.network_simplex}
    # nx.max_flow_min_cost is deliberately not offered here: its (G, s, t)
    # signature has no node-demand support and isn't solver-registry-
    # compatible with the others.

    def __init__(
        self, compressor, weight_attr="free_flow_time", scale=1000, capacity_attr="capacity",
        time_horizon_hours=1.0, annotate_capacity=True,
    ):
        super().__init__(compressor, weight_attr=weight_attr, scale=scale)
        self.capacity_attr = capacity_attr
        self.time_horizon_hours = time_horizon_hours
        # Whether _prepare() should call evaccast.core.capacity itself for
        # any real edge missing capacity_attr/weight_attr. Non-destructive
        # either way (see annotate_graph_capacity) - set False only if a
        # caller has already annotated the graph with a different capacity
        # source and wants this planner to use exactly that.
        self.annotate_capacity = annotate_capacity

    def plan(
        self, source_node_ids, target_node_ids, demand, algorithm="capacity_scaling", hierarchy=None,
        source_regions=None, target_regions=None, allow_unsheltered=False,
    ):
        """A capacity-respecting flow assignment for `demand` vehicles/
        evacuees from the source node set to the target node set. Returns a
        list of RouteAssignment (see base.py), each with .evac_time_estimate
        populated. Raises nx.NetworkXUnfeasible if `demand` can't be routed
        within the available capacity - UNLESS `allow_unsheltered` is True
        (ignored when `hierarchy` is given), in which case any demand the
        network genuinely can't get to a real target - not enough target
        capacity, not enough road capacity, or both - comes back as a
        trailing RouteAssignment(edges=[], flow=<unsheltered count>,
        overflow=True) instead of raising, so a caller can report "N people
        unsheltered, plan requires staggering/more capacity" rather than a
        bare failure. See evaccast.core.routing.compressor.GraphCompressor.
        SLACK for the mechanism (a deliberately, punitively expensive
        SUPER_SOURCE->SUPER_TARGET bypass the solver only ever uses once
        every real path is already saturated).

        `source_regions`/`target_regions` (optional, ignored when
        `hierarchy` is given - see _prepare()): a list of
        (node_ids, quantity) pairs, e.g.
        evaccast.core.selection.SelectionState.applied_regions() with each
        criterion's .population/.capacity as `quantity`, giving each
        source/target region its OWN connector capacity instead of the one
        flat `demand` every region gets by default. This is what makes
        `demand` a real per-region constraint rather than an
        undifferentiated pool any single region could supply/absorb all
        of - see the module docstring's own scope note and
        evaccast.core.routing.compressor.GraphCompressor.build()'s
        `source_region_capacity`/`target_region_capacity`. `demand` should
        still be the sum of the source quantities - the connector edges
        leaving SUPER_SOURCE only add up to that much regardless, so a
        smaller `demand` just leaves some source capacity unused, and a
        larger one is infeasible before a single unit can move."""
        solver = self._resolve_solver(algorithm)
        if demand <= 0:
            return []
        graph = self._prepare(
            source_node_ids, target_node_ids, demand, hierarchy, source_regions, target_regions, allow_unsheltered,
        )
        _, flow_dict = solver(graph, capacity=_SOLVER_CAPACITY_ATTR, weight=_SOLVER_WEIGHT_ATTR)
        slack_nodes = {GraphCompressor.SLACK} if allow_unsheltered and hierarchy is None else frozenset()
        assignments = self._decompose(graph, flow_dict, slack_nodes=slack_nodes)
        assignments = [self._with_evac_time(graph, assignment) for assignment in assignments]
        if hierarchy is not None:
            assignments = [_expand_super_edges(graph, assignment) for assignment in assignments]
        return assignments

    def _prepare(
        self, source_node_ids, target_node_ids, demand, hierarchy, source_regions=None, target_regions=None,
        allow_unsheltered=False,
    ):
        # Solver-ready integers go under distinct keys (see the module
        # constants), deliberately NOT overwriting capacity_attr/
        # "free_flow_time" - _with_evac_time() below needs the original,
        # unscaled values after solving.
        if hierarchy is None:
            source_capacity_fn = (
                _region_capacity_fn(self.compressor, source_node_ids, source_regions, demand)
                if source_regions is not None else None
            )
            target_capacity_fn = (
                _region_capacity_fn(self.compressor, target_node_ids, target_regions, demand)
                if target_regions is not None else None
            )
            graph = self.compressor.build(
                source_node_ids, target_node_ids, connector_weight=0, connector_capacity=demand,
                source_region_capacity=source_capacity_fn, target_region_capacity=target_capacity_fn,
                slack_capacity=demand if allow_unsheltered else None,
            )
            if self.annotate_capacity:
                capacity_module.annotate_graph_capacity(
                    graph, capacity_attr=self.capacity_attr, free_flow_time_attr="free_flow_time"
                )
            edges = (
                graph.edges(keys=True, data=True)
                if graph.is_multigraph()
                else ((u, v, None, d) for u, v, d in graph.edges(data=True))
            )
            # Two passes: real edges first, so `total_real_weight` (an
            # upper bound on any real S->T path's own total cost) is known
            # before SLACK's own weight - punitively larger than that bound
            # - is set below. Order doesn't matter for correctness (each
            # edge's weight only depends on its own data), just for having
            # the bound ready in time.
            synthetic_edges = []
            total_real_weight = 0
            for u, v, _key, data in edges:
                if graph.nodes[u].get("synthetic") or graph.nodes[v].get("synthetic"):
                    synthetic_edges.append((u, v, data))
                    continue
                capacity_per_hr = data.get(self.capacity_attr, 1.0)
                # Floored to 1, not 0, so a genuinely thin edge doesn't make
                # the whole demand infeasible on a rounding fluke.
                data[_SOLVER_CAPACITY_ATTR] = max(1, round(capacity_per_hr * self.time_horizon_hours))
                data[_SOLVER_WEIGHT_ATTR] = self._scaled_weight(data)
                total_real_weight += data[_SOLVER_WEIGHT_ATTR]
            for u, v, data in synthetic_edges:
                if GraphCompressor.SLACK in (u, v):
                    # Strictly worse than ANY real S->T path (whose total
                    # cost can't exceed the sum of every real edge's own
                    # weight) - a solver will only ever push flow through
                    # here once no real, capacity-respecting path has any
                    # room left.
                    data[_SOLVER_CAPACITY_ATTR] = int(round(data.get("capacity", demand)))
                    data[_SOLVER_WEIGHT_ATTR] = total_real_weight + 1
                    continue
                # GraphCompressor's own connector edges: capacity is
                # already in demand units (compressor.build() above set
                # it to `demand`, or a per-region population/capacity,
                # directly), no unit conversion needed.
                data[_SOLVER_CAPACITY_ATTR] = int(round(data.get("capacity", demand)))
                data[_SOLVER_WEIGHT_ATTR] = 0
        else:
            # HierarchicalSupergraph.graph is always a plain DiGraph - no
            # parallel edges to iterate over.
            graph = hierarchy.graph.copy()
            for u, v, data in graph.edges(data=True):
                if graph.nodes[u].get("synthetic") or graph.nodes[v].get("synthetic"):
                    # SUPER_SOURCE/SUPER_TARGET's own edges to top-level
                    # musters: build_supergraph() gives these
                    # capacity=float("inf") (effectively unbounded) - cap to
                    # `demand`, as much as could ever be needed.
                    data[_SOLVER_CAPACITY_ATTR] = int(demand)
                    data[_SOLVER_WEIGHT_ATTR] = 0
                    continue
                # A real muster/choke super-edge: its capacity came from a
                # max-flow/min-cut over real edges' veh/hr capacity (see
                # HierarchicalDecomposer.super_edge_capacity) - convert to
                # vehicles-over-the-horizon the same way a real edge is.
                data[_SOLVER_CAPACITY_ATTR] = max(1, round(data.get("capacity", 1.0) * self.time_horizon_hours))
                data[_SOLVER_WEIGHT_ATTR] = self._scaled_weight(data, attr="weight")
                # A super-edge's weight IS its shortest path's total
                # free-flow time (see HierarchicalDecomposer.
                # super_edge_capacity) - exposed under the name
                # _with_evac_time() reads, so hierarchical plans don't
                # report a 0s travel time.
                data["free_flow_time"] = data.get("weight", 0.0)

        graph.nodes[GraphCompressor.SUPER_SOURCE]["demand"] = -int(demand)
        graph.nodes[GraphCompressor.SUPER_TARGET]["demand"] = int(demand)
        return graph

    def _with_evac_time(self, graph, assignment):
        """Evac-time estimate: free-flow time plus a simple deterministic
        delay term on any edge this assignment saturates
        (flow >= capacity over the time horizon) - NOT a real queueing
        model (an M/M/1-style or BPR-integral delay would be more
        realistic; deferred). For a MultiDiGraph, the specific parallel
        edge a route's flow used isn't tracked by node sequence alone -
        the highest-capacity parallel edge between each (u, v) is used as
        the representative, matching how a real driver would prefer it.

        Note: since capacity is a HARD constraint in the min-cost-flow
        solve above (the solver simply can't push more flow through an
        edge than its capacity, and raises nx.NetworkXUnfeasible if `demand`
        doesn't fit at all), `delay` is always 0 for a solve that succeeds -
        no single edge's flow can ever exceed its own capacity within one
        plan() call. The term is still computed explicitly (rather than
        dropped) so a genuine congestion model - or a caller stacking
        several plan() calls against a shared capacity budget - has an
        obvious place to plug in.

        An `overflow` assignment (see RouteAssignment's own docstring)
        isn't a real path at all - there's no travel time to estimate, so
        this returns it unchanged (evac_time_estimate stays None) rather
        than looping over its always-empty `edges` and reporting a
        misleadingly literal 0.0.
        """
        if assignment.overflow:
            return assignment
        total = 0.0
        for u, v in assignment.edges:
            data = self._representative_edge_data(graph, u, v)
            free_flow_time = data.get("free_flow_time", 0.0)
            edge_capacity = data.get(self.capacity_attr, 1.0) * self.time_horizon_hours
            delay = max(assignment.flow - edge_capacity, 0.0) / edge_capacity * free_flow_time
            total += free_flow_time + delay
        return type(assignment)(
            edges=assignment.edges, flow=assignment.flow, evac_time_estimate=total, overflow=assignment.overflow,
        )

    def _representative_edge_data(self, graph, u, v):
        if graph.is_multigraph():
            parallel = graph.get_edge_data(u, v)
            return max(parallel.values(), key=lambda d: d.get(_SOLVER_CAPACITY_ATTR, 0))
        return graph.get_edge_data(u, v)
