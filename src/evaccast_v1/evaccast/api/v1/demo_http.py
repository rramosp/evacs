r"""FastAPI demo endpoint: POST /osm-route computes an evacuation routing
plan directly from lat/lon source/sink points - no place name needed, the
road network is fetched around the points themselves (see
evaccast.core.network.fetch_graph_around()).

Each source/sink point carries its own optional population (source) /
capacity (sink) - see SourcePoint/SinkPoint below - which
evaccast.api.v1.routing.route_between_points() treats as a real per-site
demand/capacity constraint via SystemOptimumRoutePlanner (each source's
population is required to leave from exactly that site, each sink can't
absorb more than its own stated capacity - see that module's own
docstring), not just a reported statistic. A site with no population/
capacity given contributes/accepts nothing extra - see
evaccast.core.routing.system_optimum's own per-region fallback rules.

Test this with (see examples/sample_request.json for a full request body,
including a real avoid_geojson obstacle zone):

    curl -w "\n" -X POST http://127.0.0.1:8000/api/v1/osm-route \
        -H "Content-Type: application/json" \
        -d @examples/sample_request.json
"""

from fastapi import APIRouter
from geojson_pydantic import FeatureCollection
from pydantic import BaseModel, Field

from .routing import route_between_points

router = APIRouter()


class SourcePoint(BaseModel):
    """One evacuation source site: a point plus how many evacuees are
    there right now - its demand (see route_between_points())."""

    loc: tuple[float, float]  # (lat, lon)
    population: int | None = None
    # Not yet used - reserved for a future population -> vehicle-count
    # conversion (see doc/draft api.pdf's "vehicle occupancy").
    vehicle_occupancy: int | None = None


class SinkPoint(BaseModel):
    """One evacuation target site: a point plus the most evacuees it can
    absorb - its capacity (see route_between_points())."""

    loc: tuple[float, float]  # (lat, lon)
    capacity: int | None = None
    vehicle_occupancy: int | None = None  # not yet used - see SourcePoint


class RouteRequest(BaseModel):
    """Request model for the /osm-route endpoint."""

    sources: list[SourcePoint] = Field(min_length=1)
    sinks: list[SinkPoint] = Field(min_length=1)
    avoid_geojson: str | dict | None = None
    dist_buffer: float = 1000
    network_type: str = "drive"
    algorithm: str = "capacity_scaling"
    time_horizon_hours: float = Field(default=1.0, gt=0)
    allow_unsheltered: bool = False
    # Debugging aid: give every road this one free-flow speed (km/h),
    # ignoring OSM maxspeed tags - changes travel times/route choice only.
    speed_override_kph: float | None = Field(default=None, gt=0)


class RouteResult(BaseModel):
    """Result of an /osm-route request."""

    routes: FeatureCollection
    # The network's own max sustainable throughput (vehicles/hour) between
    # `sources` and `sinks` - a theoretical upper bound no routing plan can
    # beat (see evaccast.api.v1.routing.RouteComputation).
    max_flow_veh_per_hr: float
    # Lower bound on the evacuation time, in hours - the slowest of the
    # network-wide, per-source and per-sink max-flow bounds (see
    # evaccast.core.planning.evacuation_time_lower_bound()). None if no
    # horizon could ever move everyone.
    time_estimate: float | None = None
    # Evacuees that couldn't reach a sink within time_horizon_hours - only
    # ever nonzero when the request set allow_unsheltered.
    unsheltered: float = 0.0

    model_config = {"arbitrary_types_allowed": True}


@router.post("/osm-route", response_model=RouteResult)
async def osm_routing_post(request: RouteRequest):
    computation = route_between_points(
        sources=[s.loc for s in request.sources],
        sinks=[s.loc for s in request.sinks],
        source_populations=[s.population for s in request.sources],
        sink_capacities=[s.capacity for s in request.sinks],
        avoid_geojson=request.avoid_geojson,
        dist_buffer=request.dist_buffer,
        network_type=request.network_type,
        algorithm=request.algorithm,
        time_horizon_hours=request.time_horizon_hours,
        allow_unsheltered=request.allow_unsheltered,
        speed_override_kph=request.speed_override_kph,
    )
    return RouteResult(
        routes=computation.routes,
        max_flow_veh_per_hr=computation.max_flow_veh_per_hr,
        time_estimate=computation.min_evac_time_hours,
        unsheltered=computation.unsheltered,
    )
