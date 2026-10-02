"""Route-planning graph compression.

Most of the routing planners built on top of this app will operate not on
the full OSMnx road graph, but on a *compressed* version of it built by
GraphCompressor.build():

- A super source `s` and a super target `t`.
- One *representative* node per contiguous region of the source/target
  node sets (see evaccast.core.selection.SelectionState.applied_node_ids() -
  the nodes currently passing every applied filter). A representative isn't a
  real intersection - it's a routing convenience standing in for "you're
  already somewhere in this region" - see contiguous_regions() below for
  how a "region" is decided.
- Each representative connects onward only to that region's *boundary*
  nodes - the nodes that actually touch the rest of the road network -
  see boundary_nodes() below for why the interior nodes don't also need a
  direct connection.
- Everything else - the road network's own nodes and edges - passes
  through into the compressed graph unchanged.

This lets a planner run a single s -> t shortest-path/max-flow/min-cost-
flow/etc. over the compressed graph, instead of every planner having to
separately reason about "nearest point in a whole region of acceptable
start/end nodes" itself.
"""

import networkx as nx


def collapse_to_digraph(graph, capacity_attr="capacity", weight_attr="free_flow_time", nodes=None):
    """A simple DiGraph over `graph` (or the subgraph induced by `nodes`,
    if given), with parallel real edges summed into one `capacity_attr`
    value (physically additive - e.g. divided-carriageway segments) and
    reduced to the minimum `weight_attr` (the fastest of the parallel
    options). nx.minimum_cut/maximum_flow reject MultiDiGraph outright -
    this collapse is required, not optional, before calling them."""
    sub = graph if nodes is None else graph.subgraph(set(nodes))
    collapsed = nx.DiGraph()
    collapsed.add_nodes_from(sub.nodes())
    edge_iter = (
        sub.edges(data=True, keys=True) if graph.is_multigraph() else ((u, v, None, d) for u, v, d in sub.edges(data=True))
    )
    for u, v, _key, data in edge_iter:
        capacity = data.get(capacity_attr, 1.0)
        weight = data.get(weight_attr, 1.0)
        if collapsed.has_edge(u, v):
            collapsed[u][v]["capacity"] += capacity
            collapsed[u][v]["weight"] = min(collapsed[u][v]["weight"], weight)
        else:
            collapsed.add_edge(u, v, capacity=capacity, weight=weight)
    return collapsed


class GraphCompressor:
    """Wraps a road graph (anything networkx-shaped - a plain Graph or
    DiGraph, or a MultiDiGraph like what OSMnx returns) and builds
    compressed s/t routing graphs from it. Stateless beyond the wrapped
    graph itself, so one instance can be reused across different source/
    target node sets as the user edits filters.
    """

    SUPER_SOURCE = "s"
    SUPER_TARGET = "t"
    # A bypass node build() can optionally wire directly SUPER_SOURCE ->
    # SLACK -> SUPER_TARGET (see `slack_capacity`) - not a real place, and
    # not tied to any particular source/target region, unlike every other
    # node build() adds. Its purpose is the opposite of every other
    # connector: those exist to be cheap enough that a solver never avoids
    # a real region needlessly, while SLACK exists to be expensive enough
    # (see evaccast.core.routing.system_optimum's `allow_unsheltered`) that
    # a solver only ever routes flow through it once every real, capacity-
    # respecting path is already exhausted.
    SLACK = "slack"

    def __init__(self, graph):
        self.graph = graph

    def contiguous_regions(self, node_ids):
        """The connected components of `node_ids` within self.graph - the
        maximal subsets that are mutually reachable using only edges
        between nodes also in `node_ids`. Undirected, even if self.graph
        is directed: two adjacent nodes count as the same region
        regardless of which way the road between them runs, since a
        region is a physically contiguous area, not a set of nodes
        reachable from one another by directed travel. A node with no
        neighbors in `node_ids` forms its own single-node region; a node
        id not present in self.graph is silently ignored (matching
        nx.Graph.subgraph's own behavior). Returns a list of sets.
        """
        undirected = self.graph.to_undirected(as_view=True) if self.graph.is_directed() else self.graph
        subgraph = undirected.subgraph(node_ids)
        return [set(component) for component in nx.connected_components(subgraph)]

    def boundary_nodes(self, region):
        """The nodes of `region` that have at least one edge (in either
        direction) to a node outside it - i.e. where the region can
        actually be entered/exited onto the rest of the road network.
        Connecting a region's representative to only these (rather than
        to every node in the region) is enough for full reachability: the
        region's own interior edges are kept as-is in the compressed
        graph, so every other node in the region is already reachable
        from any one of its boundary nodes.

        Falls back to the whole region if it turns out to have no
        external edges at all (e.g. `region` is an entire connected
        component of self.graph, not just of some smaller selected node
        set) - otherwise its representative would end up with nothing to
        connect to and the whole region would be unreachable.
        """
        region = set(region)
        boundary = {node for node in region if self._neighbors(node) - region}
        return boundary or region

    def _neighbors(self, node):
        if self.graph.is_directed():
            return set(self.graph.successors(node)) | set(self.graph.predecessors(node))
        return set(self.graph.neighbors(node))

    def build(
        self, source_node_ids, target_node_ids, connector_weight=0, connector_capacity: float = 1,
        source_region_capacity=None, target_region_capacity=None, slack_capacity=None,
    ):
        """A copy of self.graph plus:

        - SUPER_SOURCE, connected to one representative node per
          contiguous region of `source_node_ids`, which connects onward
          to that region's boundary nodes.
        - SUPER_TARGET, symmetrically, from each contiguous region of
          `target_node_ids`.
        - SLACK, wired SUPER_SOURCE -> SLACK -> SUPER_TARGET, ONLY when
          `slack_capacity` is given (None - the default - omits SLACK
          entirely, unchanged from before this parameter existed). Both
          edges get `capacity=slack_capacity` and `weight=connector_weight`
          - the same placeholder weight every connector edge gets here;
          giving SLACK a real (large) weight is left to the caller, since
          it's a solver-facing concern, not a graph-structure one - see
          evaccast.core.routing.system_optimum's `allow_unsheltered`.

        Every added edge carries `weight=connector_weight` (0 by default -
        being somewhere in the region costs nothing extra to leave/enter
        from) and a `capacity`: `connector_capacity` (1 by default, a safe
        minimum for a demand-based flow solver, which - unlike a plain
        max-flow one - generally can't handle an infinite capacity at
        all), UNLESS `source_region_capacity`/`target_region_capacity` is
        given - an optional `region(set) -> float` callable, called once
        per contiguous region, that overrides `connector_capacity` for
        that region's own connector edges. This is how a caller ties a
        region's connector capacity to something real (e.g. the actual
        population/site-capacity behind it - see
        evaccast.core.routing.system_optimum's per-region demand/capacity
        enforcement) instead of one flat value shared by every region;
        callers that don't need per-region capacities (RoutePlanner,
        max_flow_between) can ignore both and keep using
        `connector_capacity` alone. That means the same compressed graph
        works for a shortest-path planner (reads `weight`) or a max-flow/
        min-cost-flow one (reads `capacity`/`weight`) without extra setup
        - see the module docstring.

        Every synthetic node this adds (SUPER_SOURCE/SUPER_TARGET and
        every representative) is tagged `synthetic=True`, so a caller can
        always tell a real road-graph node from a routing bookkeeping one
        - see RoutePlanner below for why that matters.

        Representative node ids are plain strings ("source-region-0",
        "target-region-1", ...), which can't collide with OSMnx's integer
        node ids; SUPER_SOURCE/SUPER_TARGET are the class attributes
        above. Both add_edge calls below create their endpoint nodes
        automatically, except when a node set is completely empty (no
        regions at all) - the explicit add_node calls make sure
        SUPER_SOURCE/SUPER_TARGET still end up in the graph (correctly
        tagged) even then.
        """
        compressed = self.graph.copy()
        compressed.add_node(self.SUPER_SOURCE, synthetic=True)
        compressed.add_node(self.SUPER_TARGET, synthetic=True)

        for i, region in enumerate(self.contiguous_regions(source_node_ids)):
            representative = f"source-region-{i}"
            capacity = source_region_capacity(region) if source_region_capacity else connector_capacity
            compressed.add_node(representative, synthetic=True)
            compressed.add_edge(self.SUPER_SOURCE, representative, weight=connector_weight, capacity=capacity)
            for node in self.boundary_nodes(region):
                compressed.add_edge(representative, node, weight=connector_weight, capacity=capacity)

        for i, region in enumerate(self.contiguous_regions(target_node_ids)):
            representative = f"target-region-{i}"
            capacity = target_region_capacity(region) if target_region_capacity else connector_capacity
            compressed.add_node(representative, synthetic=True)
            compressed.add_edge(representative, self.SUPER_TARGET, weight=connector_weight, capacity=capacity)
            for node in self.boundary_nodes(region):
                compressed.add_edge(node, representative, weight=connector_weight, capacity=capacity)

        if slack_capacity is not None:
            compressed.add_node(self.SLACK, synthetic=True)
            compressed.add_edge(self.SUPER_SOURCE, self.SLACK, weight=connector_weight, capacity=slack_capacity)
            compressed.add_edge(self.SLACK, self.SUPER_TARGET, weight=connector_weight, capacity=slack_capacity)

        return compressed
