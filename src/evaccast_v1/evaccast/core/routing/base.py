"""BaseRoutePlanner: the machinery shared by every routing algorithm built on
top of GraphCompressor - resolving a named solver, and decomposing a solved
min-cost-flow's flow_dict into individual source->target paths. Concrete
planners (RoutePlanner, SystemOptimumRoutePlanner) differ only in how they
build the compressed graph's per-edge capacity/weight and what "how much
flow to push" means (a route budget vs. a demand volume) - see their own
modules.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar

from .compressor import GraphCompressor


@dataclass(frozen=True)
class RouteAssignment:
    """One source->target path and how much flow it carries.

    `edges`: (u, v) node-id pairs over the REAL road graph, in travel order,
    synthetic nodes stripped - ready to look up each edge's own geometry for
    plotting, same shape a route always had.

    `flow`: how many units of flow this path carries. For RoutePlanner
    (edge-disjoint routes, every real edge capacity=1) this is always 1.
    For SystemOptimumRoutePlanner it's a vehicle/evacuee count, and one
    RouteAssignment can represent many vehicles sharing one path.

    `evac_time_estimate`: seconds, populated only by SystemOptimumRoutePlanner
    (see its module for the formula) - None for the plain edge-disjoint
    planner, which has no capacity/speed model to estimate travel time from.

    `overflow`: True if this "assignment" isn't a real route at all, but
    flow SystemOptimumRoutePlanner routed through its SLACK bypass instead
    (see evaccast.core.routing.compressor.GraphCompressor.SLACK and
    SystemOptimumRoutePlanner.plan()'s `allow_unsheltered`) - `flow`
    evacuees/vehicles that couldn't reach any real, capacity-respecting
    target given the network and demand as specified. `edges` is always
    `[]` for one of these (SLACK, like SUPER_SOURCE/SUPER_TARGET, is
    synthetic - see _decompose()) and `evac_time_estimate` is always None
    (there's no real path to estimate a travel time over). Always False
    for RoutePlanner, which never builds a SLACK node.
    """

    edges: list
    flow: float
    evac_time_estimate: float | None = None
    overflow: bool = False


class BaseRoutePlanner(ABC):
    """Wraps a GraphCompressor. Subclasses must set their own ROUTE_ALGORITHMS
    (a name -> networkx min-cost-flow solver mapping, each returning
    `(flow_value, flow_dict)`) and implement plan() - the *shape* of plan()'s
    arguments/return value is deliberately left up to the subclass (a route
    budget vs. a demand volume are genuinely different requests), but every
    subclass should still raise nx.NetworkXUnfeasible (which the underlying
    solvers already do) rather than silently returning less than asked for.
    """

    ROUTE_ALGORITHMS: ClassVar[dict] = {}

    def __init__(self, compressor, weight_attr="length", scale=1000):
        self.compressor = compressor
        self.weight_attr = weight_attr
        # networkx's demand-based min-cost-flow solvers require integer
        # edge weights; `scale` converts a real-valued weight_attr (e.g.
        # "length" in meters, or "free_flow_time" in seconds) into one by
        # multiplying then rounding, so a little rounding error is the only
        # cost of using it - fine for routing, not for surveying.
        self.scale = scale

    @abstractmethod
    def plan(self, source_node_ids, target_node_ids, *args, **kwargs):
        """Solve and return the routes/assignments for this algorithm."""

    def _resolve_solver(self, algorithm):
        try:
            return self.ROUTE_ALGORITHMS[algorithm]
        except KeyError:
            raise ValueError(
                f"Unknown routing algorithm {algorithm!r}; choose one of {sorted(self.ROUTE_ALGORITHMS)}"
            ) from None

    def _scaled_weight(self, data, attr=None):
        return int(round(data.get(attr or self.weight_attr, 1) * self.scale))

    def _flatten_flow_dict(self, graph, flow_dict):
        """{u: {v: total_positive_flow}} - for a multigraph, networkx's
        flow_dict nests one level deeper (flow_dict[u][v] is itself
        {key: flow_on_that_parallel_edge}, since a route only records which
        NODES it passed through, not which parallel edge between them
        carried it); that's flattened into a single u->v total here."""
        residual = {}
        for u, neighbors in flow_dict.items():
            residual[u] = {}
            for v, flow in neighbors.items():
                total = sum(f for f in flow.values() if f > 0) if graph.is_multigraph() else flow
                if total > 0:
                    residual[u][v] = total
        return residual

    def _decompose(self, graph, flow_dict, slack_nodes=frozenset()):
        """Turn a solved flow_dict into a list of RouteAssignments: repeatedly
        walk SUPER_SOURCE -> SUPER_TARGET along positive-residual edges, then
        subtract the MINIMUM residual capacity along the whole path (not a
        flat 1 unit) before repeating - the standard flow-decomposition-into-
        paths algorithm. When every real edge has capacity=1 (RoutePlanner's
        edge-disjoint case), every path's bottleneck is exactly 1, so this
        reduces to walking one route at a time, same as before.

        Guards against two things a min-cost solver's optimal (but not
        necessarily unique) solution could in principle include, even though
        today's single edge-disjoint algorithm provably can't trigger them
        (every real edge has positive weight, so a solver would never pick a
        pointless loop) - a future solver over tied-cost parallel super-edges
        (e.g. a hierarchical muster-point supergraph) isn't guaranteed the
        same:

        - A positive-residual CYCLE reachable from SUPER_SOURCE without ever
          reaching SUPER_TARGET: detected by revisiting a node mid-walk: the
          cycle's bottleneck flow is purged (no route emitted) and the walk
          restarts from SUPER_SOURCE.
        - Non-termination: bounded by an iteration cap (total initial flow
          out of SUPER_SOURCE, plus one purge per graph node as slack) -
          exceeding it raises RuntimeError, since that means flow_dict
          doesn't actually satisfy conservation (a solver contract
          violation, not a normal runtime state).

        `slack_nodes` (e.g. {GraphCompressor.SLACK} - see
        SystemOptimumRoutePlanner's `allow_unsheltered`): any decomposed
        path passing through one of these gets RouteAssignment.overflow=
        True instead of False. Empty by default, so a caller that never
        builds a SLACK node (RoutePlanner; SystemOptimumRoutePlanner with
        `allow_unsheltered=False`) sees no behavior change at all.
        """
        residual = self._flatten_flow_dict(graph, flow_dict)
        source, target = GraphCompressor.SUPER_SOURCE, GraphCompressor.SUPER_TARGET

        total_flow = sum(residual.get(source, {}).values())
        max_iterations = total_flow + len(graph) + 1

        assignments = []
        iterations = 0
        while residual.get(source):
            iterations += 1
            if iterations > max_iterations:
                raise RuntimeError(
                    "flow decomposition did not terminate - flow_dict doesn't satisfy conservation"
                )

            node, nodes, visited = source, [source], {source}
            cycle = None
            while node != target:
                successors = residual.get(node)
                if not successors:
                    raise RuntimeError(
                        f"flow decomposition stuck at {node!r}: no positive-residual successor and "
                        "not SUPER_TARGET - flow_dict doesn't satisfy conservation"
                    )
                nxt = next(iter(successors))
                if nxt in visited:
                    cycle = nodes[nodes.index(nxt):] + [nxt]
                    break
                nodes.append(nxt)
                visited.add(nxt)
                node = nxt

            path = cycle if cycle is not None else nodes
            amount = min(residual[u][v] for u, v in zip(path[:-1], path[1:]))
            for u, v in zip(path[:-1], path[1:]):
                residual[u][v] -= amount
                if residual[u][v] == 0:
                    del residual[u][v]

            if cycle is not None:
                continue  # purged, no route to emit - restart from SUPER_SOURCE

            # Every synthetic node on a valid S->T path is a leading
            # SUPER_SOURCE/representative or trailing representative/
            # SUPER_TARGET run - GraphCompressor never wires a
            # representative to anything but its own region's boundary
            # nodes and SUPER_SOURCE/SUPER_TARGET, so synthetic nodes
            # can't appear in the middle EXCEPT for a SLACK node (entirely
            # synthetic on both sides by construction - see `slack_nodes`
            # above) - dropping every synthetic node (not just a leading/
            # trailing run) leaves a contiguous run of real, adjacent graph
            # nodes either way, and correctly empties out to edges=[] for
            # an all-synthetic SUPER_SOURCE->SLACK->SUPER_TARGET path.
            real_nodes = [n for n in nodes if not graph.nodes[n].get("synthetic")]
            edges = list(zip(real_nodes[:-1], real_nodes[1:]))
            overflow = bool(slack_nodes.intersection(nodes))
            assignments.append(RouteAssignment(edges=edges, flow=amount, overflow=overflow))
        return assignments
