"""Small geometry helpers shared by node-selection criteria (evaccast.core.
selection) and, eventually, area-based routing requests. Pure shapely/numpy
- no Bokeh, no FastAPI.
"""

import numpy as np
from scipy.spatial import Delaunay, QhullError
from shapely import contains_xy
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.ops import unary_union

# How many line segments approximate a quarter-circle in a buffered disk/
# annulus (see criterion_geometry() in selection.py) - higher is smoother
# but slower.
CIRCLE_QUAD_SEGS = 48

# alpha_shape_geometry()'s concavity knob: a Delaunay triangle survives into
# the shape only if its circumradius is at or below this percentile of every
# triangle's circumradius. Lower = tighter/more concave (but more prone to
# fragmenting into several pieces on sparse selections); higher = closer to
# the convex hull. 90 keeps the shape hugging the selected nodes' actual
# footprint without falling apart on everyday selections.
ALPHA_SHAPE_PERCENTILE = 90

# The sphere radius EPSG:3857 (Web Mercator) projects from.
WEB_MERCATOR_RADIUS_M = 6378137.0


def mercator_scale(y):
    """Web Mercator's scale factor at EPSG:3857 northing `y`: how many
    3857 units one ground meter spans there (sec(latitude), which is
    cosh(y / R) in projected terms - about 1.58 at Brussels). Mercator is
    conformal, so this holds in every direction: divide a 3857 distance by
    it to get ground meters, multiply a ground radius by it to draw a true
    circle. Exact at `y`; within ~0.1% across a city-sized (~10 km) area."""
    return np.cosh(np.asarray(y, dtype=float) / WEB_MERCATOR_RADIUS_M)


def map_bounds_polygon(x, y):
    """A rectangle covering the extent of `x`/`y` (with a small margin) -
    the finite 'universe' a '>=' distance criterion's region (the exterior
    of a circle, otherwise unbounded) gets clipped to. None for an empty
    graph."""
    if len(x) == 0:
        return None
    margin = 0.05 * max(x.max() - x.min(), y.max() - y.min(), 1.0)
    return box(x.min() - margin, y.min() - margin, x.max() + margin, y.max() + margin)


def point_buffer_radius(x, y):
    """A small radius (relative to the extent of `x`/`y`) used to turn
    isolated points into a visible shape - see alpha_shape_geometry()."""
    bounds = map_bounds_polygon(x, y)
    if bounds is None:
        return 1.0
    minx, miny, maxx, maxy = bounds.bounds
    return 0.01 * max(maxx - minx, maxy - miny, 1.0)


def alpha_shape_geometry(xs, ys, radius, alpha_percentile=ALPHA_SHAPE_PERCENTILE, quad_segs=CIRCLE_QUAD_SEGS):
    """A concave hull ('alpha shape') tracing the actual footprint of the
    given (xs, ys) points, instead of a convex hull that would bridge over
    the gaps a selection doesn't cover. Built by Delaunay-triangulating the
    points and keeping only the triangles whose circumradius is at or below
    the `alpha_percentile` of every triangle's circumradius - the largest,
    most stretched-out triangles (which is what the gaps between clusters
    produce) get dropped, and unioning what's left traces a tighter
    boundary. Falls back to a union of small `radius`-sized circles around
    each point when there aren't enough points to triangulate, or the
    points are too degenerate (collinear/duplicated) for Delaunay to
    handle. Returns None for zero points.

    Every point in `xs`/`ys` is guaranteed to fall within the returned
    geometry: culling the largest triangles can - by design, since that's
    what makes this a *concave* hull - drop small, sparse, or outlying
    clusters of points from the shape entirely, even though they're still
    genuinely part of whatever selection this is representing (verified
    against a real scenario: ~15% of a selection's nodes were falling
    outside their own drawn shape this way). Anything the culled shape
    doesn't actually cover gets a small buffer of its own unioned back in,
    so a routing planner (which reads the underlying selection directly,
    not this drawing of it) can never legitimately route to a point that
    then looks - wrongly - like it's outside the shown region.
    """
    n = len(xs)
    if n == 0:
        return None
    pts = np.column_stack([np.asarray(xs, dtype=float), np.asarray(ys, dtype=float)])
    fallback = lambda: unary_union([Point(p).buffer(radius, quad_segs=quad_segs) for p in pts])  # noqa: E731
    if n < 4:
        return fallback()
    try:
        tri = Delaunay(pts)
    except QhullError:
        return fallback()

    triangles = pts[tri.simplices]
    a = np.linalg.norm(triangles[:, 1] - triangles[:, 0], axis=1)
    b = np.linalg.norm(triangles[:, 2] - triangles[:, 1], axis=1)
    c = np.linalg.norm(triangles[:, 0] - triangles[:, 2], axis=1)
    s = (a + b + c) / 2
    area = np.sqrt(np.clip(s * (s - a) * (s - b) * (s - c), 0, None))
    with np.errstate(divide="ignore", invalid="ignore"):
        circumradii = np.where(area > 0, (a * b * c) / (4 * area), np.inf)

    finite = circumradii[np.isfinite(circumradii)]
    if len(finite) == 0:
        return fallback()
    threshold = np.percentile(finite, alpha_percentile)
    kept = triangles[circumradii <= threshold]
    if len(kept) == 0:
        return fallback()
    shape = unary_union([Polygon(t) for t in kept])

    covered = contains_xy(shape, pts[:, 0], pts[:, 1])
    if not covered.all():
        stragglers = unary_union([Point(p).buffer(radius, quad_segs=quad_segs) for p in pts[~covered]])
        shape = unary_union([shape, stragglers])
    return shape


def _exterior_vertex_count(geometry):
    polys = list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]
    return sum(len(poly.exterior.coords) for poly in polys if not poly.is_empty)


def simplify_polygon_for_render(geometry, alpha_percentile=ALPHA_SHAPE_PERCENTILE, min_vertices=50):
    """A much cheaper-to-render approximation of `geometry` (a Polygon or
    MultiPolygon) for a map overlay: an alpha shape (see
    alpha_shape_geometry() above) around `geometry`'s own exterior
    vertices, tracing its real footprint - not a convex hull, which would
    bridge over real gaps between disjoint pieces. On typical inputs (e.g.
    a MultiPolygon unioned from hundreds of small, mostly-disjoint source
    polygons, the kind one obstacle-group import can carry) this collapses
    it to far fewer vertices/pieces - Bokeh's multi_polygons glyph draws
    one path per piece, so cutting piece count is what actually speeds up
    rendering, not just cutting vertices per piece. But the alpha shape of
    a genuinely sparse/scattered layout can end up MORE complex than the
    original (bridging gaps pulls in long triangles whose own union traces
    a wigglier outline), so this only uses it when it actually comes out
    cheaper - never returns something pricier to draw than `geometry`
    itself.

    Display only - anything correctness-sensitive (e.g. pruning graph
    nodes/edges by intersection) should keep using the original geometry;
    this can shift a boundary by about `geometry`'s own extent times
    point_buffer_radius()'s fraction. Returns `geometry` unchanged if it's
    empty, or has too few vertices to be worth the attempt."""
    if geometry is None or geometry.is_empty:
        return geometry
    original_vertices = _exterior_vertex_count(geometry)
    if original_vertices < min_vertices:
        return geometry
    polys = list(geometry.geoms) if hasattr(geometry, "geoms") else [geometry]
    xs = np.concatenate([np.asarray(poly.exterior.coords.xy[0]) for poly in polys if not poly.is_empty])
    ys = np.concatenate([np.asarray(poly.exterior.coords.xy[1]) for poly in polys if not poly.is_empty])
    radius = point_buffer_radius(xs, ys)
    simplified = alpha_shape_geometry(xs, ys, radius, alpha_percentile=alpha_percentile)
    if simplified is None or _exterior_vertex_count(simplified) >= original_vertices:
        return geometry
    return simplified


def polygon_rings(geom):
    """(xs, ys) in the nested list-of-polygons-of-rings shape Bokeh's
    multi_polygons glyph expects for ONE row of its source - the structure
    that lets a single glyph entry draw a shape with a hole (an annulus) or
    several disjoint pieces (e.g. an alpha shape that split into separate
    clusters) all at once. Tolerates a GeometryCollection (shapely can
    produce one from an intersection/union that only touches at a point or
    edge) by keeping just its polygonal parts. Returns ([], []) for an
    empty/missing/non-polygonal geometry."""
    if geom is None or geom.is_empty:
        return [], []
    if isinstance(geom, MultiPolygon):
        polys = list(geom.geoms)
    elif isinstance(geom, Polygon):
        polys = [geom]
    elif hasattr(geom, "geoms"):
        polys = [g for g in geom.geoms if isinstance(g, Polygon) and not g.is_empty]
    else:
        polys = []
    xs, ys = [], []
    for poly in polys:
        if poly.is_empty:
            continue
        rings = [poly.exterior, *poly.interiors]
        xs.append([list(ring.coords.xy[0]) for ring in rings])
        ys.append([list(ring.coords.xy[1]) for ring in rings])
    return xs, ys
