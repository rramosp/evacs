"""RoutePlanner: finds up to `n_routes` distinct routes between a source and
target node set, via minimum-cost flow over a GraphCompressor-built
compressed graph. Every real road edge gets capacity=1, which makes the
min-cost flow edge-disjoint - no two returned routes reuse the same
physical edge - and edge-disjoint routes on a fixed planar embedding like
a street network can't cross as curves (they can only touch at a shared
node). A two-way street modeled as a pair of opposite directed edges can
still carry one route each way at once, though, since each direction is
its own capacity-1 edge - if a stricter "this physical street segment
carries at most one route, in either direction" guarantee is ever needed,
that means routing both directions through one shared capacity-1
mid-edge instead, which needs a bit more graph surgery than this does.
"""

import networkx as nx

from .base import BaseRoutePlanner
from .compressor import GraphCompressor


class RoutePlanner(BaseRoutePlanner):
    """Wraps a GraphCompressor and finds edge-disjoint routes over it.

    ROUTE_ALGORITHMS is the set of solvers a caller (e.g. the Bokeh Route
    Plan tab's "algorithm" dropdown, or the FastAPI demo's `algorithm`
    field) may choose from. All of them are demand-based, meaning plan() raises
    nx.NetworkXUnfeasible rather than silently returning fewer than
    `n_routes` routes when that many edge-disjoint routes don't exist.
    """

    ROUTE_ALGORITHMS = {"capacity_scaling": nx.capacity_scaling, "network_simplex": nx.network_simplex}

    def plan(self, source_node_ids, target_node_ids, n_routes, algorithm="capacity_scaling"):
        """Up to `n_routes` edge-disjoint routes from the source node set
        to the target node set. Returns a list of routes, each a list of
        (u, v) node-id-pair edges over the real road graph, in travel
        order - no synthetic nodes, ready to look up each edge's own
        geometry for plotting."""
        solver = self._resolve_solver(algorithm)
        if n_routes <= 0:
            return []
        graph = self._prepare(source_node_ids, target_node_ids, n_routes)
        _, flow_dict = solver(graph)
        assignments = self._decompose(graph, flow_dict)
        # Every real edge has capacity=1, so almost every assignment's flow
        # is exactly 1 already. The one exception: a node selected by both
        # Source's and Target's filters produces a path made entirely of
        # connector edges (no real edge at all, capacity=n_routes) - the
        # shared decomposition's bottleneck rule collapses that into ONE
        # RouteAssignment(edges=[], flow=n_routes) rather than n_routes
        # separate ones. Explode it back out so plan()'s return shape (and
        # count) stays exactly what it's always been: a bare list of routes.
        routes = []
        for assignment in assignments:
            routes.extend([assignment.edges] * int(assignment.flow))
        return routes

    def _prepare(self, source_node_ids, target_node_ids, n_routes):
        """The compressed graph, made solvable: every real edge gets
        capacity=1 (for edge-disjointness) and an integer weight (see
        __init__); GraphCompressor's connector edges are left at
        weight=0, but given capacity=n_routes rather than its own
        conservative default of 1, since a single region should be free
        to supply/receive any number of the routes up to the whole
        budget, not just one. SUPER_SOURCE/SUPER_TARGET get a hard
        supply/demand of `n_routes` each, which is what makes the solver
        fail loudly (nx.NetworkXUnfeasible) instead of quietly returning
        fewer routes than asked for."""
        graph = self.compressor.build(
            source_node_ids, target_node_ids, connector_weight=0, connector_capacity=n_routes
        )
        edges = (
            graph.edges(keys=True, data=True) if graph.is_multigraph() else ((u, v, None, d) for u, v, d in graph.edges(data=True))
        )
        for u, v, _key, data in edges:
            if graph.nodes[u].get("synthetic") or graph.nodes[v].get("synthetic"):
                continue
            data["capacity"] = 1
            data["weight"] = self._scaled_weight(data)
        graph.nodes[GraphCompressor.SUPER_SOURCE]["demand"] = -n_routes
        graph.nodes[GraphCompressor.SUPER_TARGET]["demand"] = n_routes
        return graph
