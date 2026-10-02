"""Hierarchical muster-point decomposition (BeSafer Use Case Overview,
section I.VI.B): instead of routing directly between every node of a large
user-drawn source/target region, pick a handful of well-connected exit
points ("muster points") per region, estimate how much flow can move
between each pair via max-flow/min-cut, and recursively split off any
"choke point" bottleneck found along the way - producing a much smaller
supergraph a flow solver (evaccast.core.routing.system_optimum) can solve
over instead of the full city graph.

HierarchicalDecomposer wraps a GraphCompressor (composition, not
inheritance - same pattern RoutePlanner already uses) to reuse
contiguous_regions()/boundary_nodes() for turning a region into candidate
exit points; the super-edge/choke-point machinery below it is new, since
once choke points start getting promoted the working set is no longer "the
boundary of one region."

Scope, stated plainly:
- Feature aggregation per super-node (population, hazard level, etc. - the
  doc's step 2) isn't implemented: GraphData doesn't carry those attributes
  yet, so this module only aggregates what routing itself needs.
- Only the doc's super-edge strategy (b) - max-flow/min-cut - is
  implemented. Strategy (a) (explicit non-overlapping shortest paths with
  stored backup alternatives) is skipped: the flow solver this feeds
  already splits demand across multiple paths once one super-edge
  saturates, which substantially softens the need for explicit backups.
- The doc's "repeat until no choke points found" has no termination
  guarantee on a real city graph, so recursion is bounded by `max_depth`
  (default 2) plus a conductance threshold, with a recursion-wide visited
  set so a choke point can never be re-promoted at a later level.
- Muster points are chosen locally to each region (`select_muster_points`
  only looks at a region's own induced subgraph - the doc's step 3, "well-
  connected to the interior"), but the super-edge/choke-point search
  between two muster points (`super_edge_capacity`/`identify_choke_points`,
  and so `build_supergraph`) runs over the WHOLE graph by default, not just
  `source_region | target_region` - real choke points (the doc's own
  examples, bridges/mountain passes) sit BETWEEN two drawn regions, not
  inside either one, so restricting the search to the regions' own
  interiors would make most cross-region super-edges come back
  unreachable. Pass an explicit `within` to scope the search narrower if
  ever needed (e.g. a known corridor) - it isn't derived automatically.
- Recursive sub-problems stay restricted to the same `within` (or the whole
  graph) at every level, not narrowed to the cut's reachable/non_reachable
  side per level - a deliberate simplification (that narrowing is a
  performance optimization, not a correctness one; `max_depth` and the
  visited-node set already bound the recursion).
- A "choke point" (a promotable NODE, tracked in HierarchicalSupergraph.
  choke_points) and a "choke edge" (a super-edge whose OWN connection is a
  bottleneck, tracked in .choke_edges, `is_choke_edge` on the graph edge)
  are different things and both matter: whenever two muster points are
  connected by a single thin edge with nothing genuinely new to split out
  (the doc's own "bridge" example - the min-cut's promoted node just IS one
  of the two endpoints already), there's no node to promote, but the
  connection is still exactly the kind of bottleneck a user would want
  flagged. build_supergraph() always checks for this, independent of
  `max_depth` and of whether a promotable node exists.
"""

from dataclasses import dataclass, field

import networkx as nx
import numpy as np
from sklearn.cluster import KMeans

from .compressor import GraphCompressor, collapse_to_digraph

DEFAULT_CHOKE_CONDUCTANCE_THRESHOLD = 0.3


@dataclass(frozen=True)
class SuperEdge:
    capacity: float
    weight: float
    path: list  # real graph node ids, in travel order - [] if unreachable, [node_a] if node_a == node_b


@dataclass
class HierarchicalSupergraph:
    graph: nx.DiGraph  # SUPER_SOURCE/SUPER_TARGET wired to top-level musters; super-edges carry capacity+weight
    source_muster_points: list
    target_muster_points: list
    choke_points: list = field(default_factory=list)  # every promoted NEW node across all levels
    # Every super-edge (u, v) whose own connection is itself a bottleneck
    # (the min-cut conductance test passed), whether or not that bottleneck
    # produced a promotable node distinct from u/v - see build_supergraph()'s
    # connect() for why these are tracked separately from choke_points: a
    # single-edge bridge directly between two muster points has nowhere to
    # promote a new node (the bottleneck IS the edge), but is still exactly
    # the kind of choke point a user would want to see flagged.
    choke_edges: list = field(default_factory=list)


class HierarchicalDecomposer:
    def __init__(self, graph, capacity_attr="capacity", weight_attr="free_flow_time"):
        self.graph = graph
        self.compressor = GraphCompressor(graph)
        self.capacity_attr = capacity_attr
        self.weight_attr = weight_attr

    # -- muster-point selection ----------------------------------------------

    def select_muster_points(self, region, k, method="degree_centrality"):
        """Up to `k` nodes of `region`'s boundary (compressor.boundary_nodes)
        best suited as exit points, per `method`:

        - "degree_centrality": highest-degree boundary nodes (deterministic).
        - "conductance": boundary nodes on the lowest-conductance bipartition
          of the region (a Fiedler-vector sweep) - can return fewer than `k`
          if the region has no `k` distinct low-conductance points.
        - "spectral_kmeans": cluster the boundary nodes in a small spectral
          (normalized-Laplacian) embedding of the region, one pick per
          cluster (the boundary node nearest that cluster's centroid).
        """
        region = set(region)
        boundary = sorted(self.compressor.boundary_nodes(region), key=str)
        if k <= 0 or not boundary:
            return []
        if method == "degree_centrality":
            return self._select_by_degree_centrality(boundary, k)
        if method == "conductance":
            return self._select_by_conductance(region, boundary, k)
        if method == "spectral_kmeans":
            return self._select_by_spectral_kmeans(region, boundary, k)
        raise ValueError(
            f"Unknown muster-point method {method!r}; choose one of "
            "'degree_centrality', 'conductance', 'spectral_kmeans'"
        )

    def _select_by_degree_centrality(self, boundary, k):
        ranked = sorted(boundary, key=lambda n: (-self.graph.degree(n), str(n)))
        return ranked[:k]

    def _region_undirected_subgraph(self, region):
        """A simple (no parallel edges, no direction) view of `region`'s
        induced subgraph - what the spectral/conductance methods need;
        topology only, direction and duplicate OSM-way edges don't matter
        for finding a structural bottleneck."""
        return nx.Graph(self.graph.subgraph(region).to_undirected())

    def _select_by_conductance(self, region, boundary, k):
        undirected = self._region_undirected_subgraph(region)
        if undirected.number_of_nodes() < 2 or undirected.number_of_edges() == 0:
            return boundary[:k]
        try:
            fiedler = nx.algebraicconnectivity.fiedler_vector(undirected)
        except (nx.NetworkXError, nx.AmbiguousSolution):
            return boundary[:k]

        # Sweep prefixes of the Fiedler-ordered nodes, keeping the prefix
        # with the lowest conductance (the standard Cheeger-sweep heuristic
        # for finding a low-conductance bipartition).
        ordered_nodes = [n for _, n in sorted(zip(fiedler, undirected.nodes()), key=lambda pair: pair[0])]
        best_side, best_conductance = None, float("inf")
        for i in range(1, len(ordered_nodes)):
            side = set(ordered_nodes[:i])
            try:
                conductance = nx.conductance(undirected, side)
            except ZeroDivisionError:
                continue
            if conductance < best_conductance:
                best_conductance, best_side = conductance, side
        if best_side is None:
            return boundary[:k]

        candidates = self.compressor.boundary_nodes(best_side) & set(boundary)
        if not candidates:
            return boundary[:k]
        if len(candidates) > k:
            candidates = sorted(candidates, key=lambda n: (self._crossing_capacity(n, best_side), str(n)))[:k]
        return sorted(candidates, key=str)

    def _crossing_capacity(self, node, within_set):
        """Total capacity of `node`'s edges (either direction) leaving
        `within_set` - used to rank candidate muster points by how
        bottlenecked their crossing is (lower = more of a choke point)."""
        total = 0.0
        for _, v, data in self.graph.out_edges(node, data=True):
            if v not in within_set:
                total += data.get(self.capacity_attr, 1.0)
        for u, _, data in self.graph.in_edges(node, data=True):
            if u not in within_set:
                total += data.get(self.capacity_attr, 1.0)
        return total

    def _select_by_spectral_kmeans(self, region, boundary, k):
        undirected = self._region_undirected_subgraph(region)
        nodes = list(undirected.nodes())
        boundary_in_region = [b for b in boundary if b in undirected]
        # Not enough structure to cluster meaningfully, or already <= k
        # boundary nodes - nothing to gain from clustering.
        if len(nodes) < 3 or len(boundary_in_region) <= k:
            return boundary_in_region[:k]

        laplacian = nx.normalized_laplacian_matrix(undirected, nodelist=nodes).toarray()
        # Dense eigendecomposition - fine at the region sizes a user-drawn
        # polygon produces (hundreds, not tens of thousands, of nodes).
        # Above roughly 2000 nodes this should switch to a sparse solver
        # (scipy.sparse.linalg.eigsh with shift-invert); not needed yet.
        _eigenvalues, eigenvectors = np.linalg.eigh(laplacian)
        n_components = min(k, len(nodes) - 1)
        embedding = eigenvectors[:, 1 : n_components + 1]  # skip the trivial constant eigenvector

        index = {node: i for i, node in enumerate(nodes)}
        boundary_embedding = np.array([embedding[index[b]] for b in boundary_in_region])
        n_clusters = min(k, len(boundary_in_region))
        # Clustering ONLY the boundary nodes (not the whole region) means
        # every cluster is guaranteed to contain boundary nodes by
        # construction - sidesteps the failure mode where a per-region
        # cluster happens to contain no boundary node at all.
        kmeans = KMeans(n_clusters=n_clusters, n_init="auto", random_state=0).fit(boundary_embedding)

        chosen = []
        for cluster in range(n_clusters):
            members = [i for i, label in enumerate(kmeans.labels_) if label == cluster]
            if not members:
                continue
            centroid = kmeans.cluster_centers_[cluster]
            nearest = min(members, key=lambda i: np.linalg.norm(boundary_embedding[i] - centroid))
            chosen.append(boundary_in_region[nearest])
        return chosen

    # -- super-edges + choke points -------------------------------------------

    def _collapse_to_digraph(self, within=None):
        """A simple DiGraph over `within` (the whole graph if None) - see
        evaccast.core.routing.compressor.collapse_to_digraph()."""
        return collapse_to_digraph(self.graph, self.capacity_attr, self.weight_attr, nodes=within)

    def super_edge_capacity(self, node_a, node_b, within=None):
        """The max-flow/min-cut capacity between `node_a` and `node_b`,
        over the whole graph by default (or restricted to `within`, if
        given), plus the free-flow-time shortest path over the same
        subgraph - both its length (.weight) and its actual node sequence
        (.path), so a caller can draw the real route a super-edge
        represents rather than a straight line between its endpoints.
        capacity=0 means unreachable (empty .path)."""
        if node_a == node_b:
            return SuperEdge(capacity=float("inf"), weight=0.0, path=[node_a])
        collapsed = self._collapse_to_digraph(within)
        if node_a not in collapsed or node_b not in collapsed:
            return SuperEdge(capacity=0.0, weight=float("inf"), path=[])
        try:
            cut_value, _partition = nx.minimum_cut(collapsed, node_a, node_b, capacity="capacity")
        except nx.NetworkXUnbounded:
            cut_value = float("inf")
        except nx.NetworkXError:
            return SuperEdge(capacity=0.0, weight=float("inf"), path=[])
        try:
            weight, path = nx.single_source_dijkstra(collapsed, node_a, target=node_b, weight="weight")
        except nx.NetworkXNoPath:
            weight, path = float("inf"), []
        return SuperEdge(capacity=cut_value, weight=weight, path=path)

    def identify_choke_points(self, node_a, node_b, within=None, threshold=DEFAULT_CHOKE_CONDUCTANCE_THRESHOLD):
        """The reachable-side endpoint(s) of the min-cut between `node_a`
        and `node_b` ("the last real intersection before the bottleneck" -
        matching the doc's "keep the edge only up to the choke point"), but
        only when the cut is a genuine bottleneck: cut_value relative to how
        much capacity each side has is below `threshold`. Empty if node_a
        and node_b are the same node, unreachable, or the cut isn't
        bottleneck-like enough to be worth promoting."""
        if node_a == node_b:
            return []
        collapsed = self._collapse_to_digraph(within)
        if node_a not in collapsed or node_b not in collapsed:
            return []
        try:
            cut_value, (reachable, non_reachable) = nx.minimum_cut(collapsed, node_a, node_b, capacity="capacity")
        except (nx.NetworkXUnbounded, nx.NetworkXError):
            return []
        if cut_value <= 0:
            return []

        min_volume = min(self._volume(collapsed, reachable), self._volume(collapsed, non_reachable))
        if min_volume <= 0 or cut_value / min_volume >= threshold:
            return []

        promoted = {u for u, v in collapsed.edges() if u in reachable and v in non_reachable}
        return sorted(promoted, key=str)

    @staticmethod
    def _volume(collapsed, nodes):
        """Sum of capacity over every edge (either direction) touching
        `nodes` - a rough measure of how much capacity this side of a cut
        represents, used only to judge whether a cut is a genuine
        bottleneck (low ratio to the cut value) or an arbitrary split of a
        well-connected area (high ratio)."""
        nodes = set(nodes)
        return sum(data.get("capacity", 1.0) for u, v, data in collapsed.edges(data=True) if u in nodes or v in nodes)

    # -- putting it together ---------------------------------------------------

    def build_supergraph(
        self, source_region, target_region, k=3, method="degree_centrality",
        max_depth=2, choke_conductance_threshold=DEFAULT_CHOKE_CONDUCTANCE_THRESHOLD, within=None,
    ):
        """The doc's 6-step procedure: pick muster points for each region,
        wire a super-edge between every source/target muster-point pair
        (recursively promoting choke points found along the way, up to
        `max_depth` levels), and return the resulting compact supergraph.

        `within` scopes the super-edge/choke-point search (None = the whole
        graph, the right default - a real choke point, per the doc's own
        bridge/mountain-pass examples, sits BETWEEN the two regions, not
        inside either one). Muster-point selection itself always stays
        local to each region regardless of `within`."""
        source_region, target_region = set(source_region), set(target_region)
        source_musters = self.select_muster_points(source_region, k, method)
        target_musters = self.select_muster_points(target_region, k, method)

        graph = nx.DiGraph()
        graph.add_node(GraphCompressor.SUPER_SOURCE, synthetic=True)
        graph.add_node(GraphCompressor.SUPER_TARGET, synthetic=True)
        for muster in source_musters:
            graph.add_node(muster)
            graph.add_edge(GraphCompressor.SUPER_SOURCE, muster, capacity=float("inf"), weight=0.0)
        for muster in target_musters:
            graph.add_node(muster)
            graph.add_edge(muster, GraphCompressor.SUPER_TARGET, capacity=float("inf"), weight=0.0)

        choke_points = []
        choke_edges = []
        promoted = set()  # recursion-wide, so a choke point is never re-promoted at a later level

        def connect(a, b, depth):
            super_edge = self.super_edge_capacity(a, b, within)
            if super_edge.capacity <= 0:
                return  # unreachable within this subregion - no super-edge to add

            # Always check whether THIS connection is a bottleneck at all -
            # independent of `depth`, and independent of whether there's a
            # genuinely new node to promote. A single-edge bridge directly
            # between two muster points has no third node to split out (the
            # min-cut's promoted node just IS `a` or `b` already), but it's
            # still exactly the kind of choke point worth flagging - that's
            # what identify_choke_points() finding a non-empty result means,
            # even after the a/b/already-promoted filter below empties it.
            raw_chokes = self.identify_choke_points(a, b, within, choke_conductance_threshold)
            is_choke_edge = bool(raw_chokes)

            # Only a genuinely NEW node (not a, not b, not already promoted
            # at an earlier level) is worth recursing on for finer
            # resolution - and only while there's recursion budget left.
            new_chokes = [c for c in raw_chokes if depth > 0 and c not in promoted and c not in (a, b)]

            if not new_chokes:
                graph.add_edge(
                    a, b, capacity=super_edge.capacity, weight=super_edge.weight, path=super_edge.path,
                    is_choke_edge=is_choke_edge,
                )
                if is_choke_edge:
                    choke_edges.append((a, b))
                return
            for choke in new_chokes:
                promoted.add(choke)
                choke_points.append(choke)
                graph.add_node(choke)
                connect(a, choke, depth - 1)
                connect(choke, b, depth - 1)

        for source_muster in source_musters:
            for target_muster in target_musters:
                connect(source_muster, target_muster, max_depth)

        return HierarchicalSupergraph(
            graph=graph, source_muster_points=source_musters, target_muster_points=target_musters,
            choke_points=choke_points, choke_edges=choke_edges,
        )
