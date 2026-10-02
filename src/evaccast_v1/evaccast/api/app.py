"""FastAPI app factory for the EvacCAST REST API - mounts
evaccast.api.v1.demo_http's router under /api/v1 (see that module for the
actual request/response contract; POST /api/v1/osm-route is the one real
endpoint today).

Run with:
    uv run evaccast-api
or, for development with auto-reload:
    uv run uvicorn evaccast.api.app:app --reload
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .v1.demo_http import router


def create_app():
    app = FastAPI(title="EvacCAST")
    app.include_router(router, prefix="/api/v1")

    @app.exception_handler(ValueError)
    async def value_error_handler(request: Request, exc: ValueError):
        # route_between_points() raises plain ValueError for a malformed-
        # but-well-typed request (e.g. no source gives a population) -
        # surface it as a 422 rather than an unhandled 500.
        return JSONResponse(status_code=422, content={"error": str(exc)})

    return app


app = create_app()


def main():
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
