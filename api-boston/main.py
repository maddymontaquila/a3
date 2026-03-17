"""Boston MBTA Transit Data API — FastAPI service."""

from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

# ---------------------------------------------------------------------------
# OpenTelemetry — auto-instrument before app creation
# ---------------------------------------------------------------------------
otlp_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
if otlp_endpoint:
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        service_name = os.environ.get("OTEL_SERVICE_NAME", "api-boston")
        resource = Resource.create({"service.name": service_name})
        provider = TracerProvider(resource=resource)

        # Use Aspire-provided cert if available, otherwise try insecure
        cert_path = os.environ.get("OTEL_EXPORTER_OTLP_CERTIFICATE")
        if cert_path and os.path.exists(cert_path):
            import grpc
            with open(cert_path, "rb") as f:
                credentials = grpc.ssl_channel_credentials(root_certificates=f.read())
            exporter = OTLPSpanExporter(endpoint=otlp_endpoint, credentials=credentials)
        elif otlp_endpoint.startswith("https"):
            exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=False)
        else:
            exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)

        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        HTTPXClientInstrumentor().instrument()
        _otel_fastapi_instrumentor = FastAPIInstrumentor()
    except Exception:
        logging.exception("OpenTelemetry setup failed — continuing without tracing")
        _otel_fastapi_instrumentor = None
else:
    _otel_fastapi_instrumentor = None

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Boston MBTA Transit API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if _otel_fastapi_instrumentor is not None:
    _otel_fastapi_instrumentor.instrument_app(app)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MBTA_BASE_URL = "https://api-v3.mbta.com"
MBTA_API_KEY = os.environ.get("MBTA_API_KEY")

logger = logging.getLogger("api-boston")

# Cache TTLs (seconds)
CACHE_TTL_PREDICTIONS = 30
CACHE_TTL_ALERTS = 120
CACHE_TTL_ROUTES = 3600
CACHE_TTL_STOPS = 3600

# ---------------------------------------------------------------------------
# Redis helper
# ---------------------------------------------------------------------------
_redis_client: Any = None


def _get_redis():
    """Return a Redis client (lazy, singleton). Returns None when unavailable."""
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    conn_str = os.environ.get("ConnectionStrings__cache")
    if not conn_str:
        return None

    try:
        import redis as _redis_mod

        # Aspire may provide Redis connection in different formats:
        #   redis://:password@host:port  (URI format)
        #   host:port,password=xxx       (StackExchange.Redis format)
        if conn_str.startswith("redis://") or conn_str.startswith("rediss://"):
            parsed = urlparse(conn_str)
            host = parsed.hostname or "localhost"
            port = parsed.port or 6379
            password = parsed.password or None
        else:
            host, port, password = "localhost", 6379, None
            parts = conn_str.split(",")
            for part in parts:
                part = part.strip()
                if "=" in part:
                    k, v = part.split("=", 1)
                    if k.lower() == "password":
                        password = v
                elif ":" in part and host == "localhost":
                    h, p = part.rsplit(":", 1)
                    host = h
                    try:
                        port = int(p)
                    except ValueError:
                        pass
                elif part and host == "localhost":
                    host = part

        # Detect TLS (rediss:// scheme)
        use_ssl = conn_str.startswith("rediss://")

        _redis_client = _redis_mod.Redis(
            host=host, port=port, password=password, decode_responses=True, socket_timeout=2,
            ssl=use_ssl, ssl_cert_reqs=None,  # skip cert verify for Aspire dev certs
        )
        _redis_client.ping()
        logger.info("Connected to Redis at %s:%s", host, port)
        return _redis_client
    except Exception:
        logger.warning("Redis unavailable — caching disabled")
        _redis_client = None
        return None


def _cache_get(key: str) -> Any | None:
    try:
        r = _get_redis()
        if r is None:
            return None
        raw = r.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _cache_set(key: str, value: Any, ttl: int) -> None:
    try:
        r = _get_redis()
        if r is None:
            return
        r.setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        pass


def _cache_key(prefix: str, *parts: str) -> str:
    h = hashlib.sha256("|".join(parts).encode()).hexdigest()[:12]
    return f"mbta:{prefix}:{h}"


# ---------------------------------------------------------------------------
# MBTA API client
# ---------------------------------------------------------------------------
async def _mbta_get(path: str, params: dict[str, str] | None = None) -> dict:
    params = dict(params or {})
    if MBTA_API_KEY:
        params["api_key"] = MBTA_API_KEY

    async with httpx.AsyncClient(base_url=MBTA_BASE_URL, timeout=15) as client:
        resp = await client.get(path, params=params)
        resp.raise_for_status()
        return resp.json()


# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------

def _attr(item: dict) -> dict:
    return item.get("attributes", {})


def _normalize_route(item: dict) -> dict:
    a = _attr(item)
    return {
        "id": item["id"],
        "name": a.get("long_name") or a.get("short_name", ""),
        "color": f"#{a['color']}" if a.get("color") else None,
        "textColor": f"#{a['text_color']}" if a.get("text_color") else None,
        "type": a.get("type"),
    }


def _normalize_prediction(item: dict, included: dict[tuple[str, str], dict]) -> dict:
    a = _attr(item)
    rels = item.get("relationships", {})

    route_ref = (rels.get("route", {}).get("data") or {})
    route_key = (route_ref.get("type", ""), route_ref.get("id", ""))
    route_inc = included.get(route_key, {})

    stop_ref = (rels.get("stop", {}).get("data") or {})
    stop_key = (stop_ref.get("type", ""), stop_ref.get("id", ""))
    stop_inc = included.get(stop_key, {})

    arrival_str = a.get("arrival_time") or a.get("departure_time")
    minutes_away = None
    if arrival_str:
        try:
            arrival_dt = datetime.fromisoformat(arrival_str)
            now = datetime.now(timezone.utc)
            minutes_away = max(0, round((arrival_dt - now).total_seconds() / 60, 1))
        except Exception:
            pass

    return {
        "routeId": route_ref.get("id"),
        "routeName": _attr(route_inc).get("long_name") or _attr(route_inc).get("short_name"),
        "stopId": stop_ref.get("id"),
        "stopName": _attr(stop_inc).get("name"),
        "direction": a.get("direction_id"),
        "arrivalTime": arrival_str,
        "minutesAway": minutes_away,
        "status": a.get("status"),
    }


def _normalize_alert(item: dict) -> dict:
    a = _attr(item)
    rels = item.get("relationships", {})

    affected = []
    for entity in (a.get("informed_entity") or []):
        rid = entity.get("route")
        if rid and rid not in affected:
            affected.append(rid)

    periods = a.get("active_period") or []
    active_period = None
    if periods:
        p = periods[0]
        active_period = {"start": p.get("start"), "end": p.get("end")}

    # Map MBTA numeric severity to our string format
    raw_sev = a.get("severity", 0)
    if isinstance(raw_sev, int):
        severity = "severe" if raw_sev >= 7 else "warning" if raw_sev >= 4 else "info"
    else:
        severity = str(raw_sev).lower() if raw_sev else "info"

    return {
        "id": item["id"],
        "severity": severity,
        "header": a.get("header"),
        "description": a.get("description"),
        "affectedRoutes": affected,
        "activePeriod": active_period,
        "updatedAt": a.get("updated_at"),
    }


def _normalize_stop(item: dict) -> dict:
    a = _attr(item)
    rels = item.get("relationships", {})

    route_ids = []
    route_data = (rels.get("route", {}) or {}).get("data")
    if isinstance(route_data, list):
        route_ids = [r["id"] for r in route_data if "id" in r]
    elif isinstance(route_data, dict) and "id" in route_data:
        route_ids = [route_data["id"]]

    return {
        "id": item["id"],
        "name": a.get("name"),
        "latitude": a.get("latitude"),
        "longitude": a.get("longitude"),
        "routeIds": route_ids,
    }


def _build_included_index(data: dict) -> dict[tuple[str, str], dict]:
    idx: dict[tuple[str, str], dict] = {}
    for inc in data.get("included", []):
        idx[(inc.get("type", ""), inc.get("id", ""))] = inc
    return idx


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "api-boston"}


@app.get("/routes")
async def list_routes():
    cache_key = _cache_key("routes", "subway")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    data = await _mbta_get("/routes", {"filter[type]": "0,1"})
    result = [_normalize_route(item) for item in data.get("data", [])]
    _cache_set(cache_key, result, CACHE_TTL_ROUTES)
    return result


@app.get("/predictions")
async def get_predictions(stop: str = Query(..., description="Stop ID")):
    cache_key = _cache_key("predictions", stop)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    data = await _mbta_get("/predictions", {"filter[stop]": stop, "include": "route,stop"})
    included = _build_included_index(data)
    result = [_normalize_prediction(item, included) for item in data.get("data", [])]
    _cache_set(cache_key, result, CACHE_TTL_PREDICTIONS)
    return result


@app.get("/alerts")
async def list_alerts():
    cache_key = _cache_key("alerts", "transit")
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    data = await _mbta_get("/alerts", {"filter[route_type]": "0,1"})
    result = [_normalize_alert(item) for item in data.get("data", [])]
    _cache_set(cache_key, result, CACHE_TTL_ALERTS)
    return result


@app.get("/stops")
async def list_stops(route: str = Query(..., description="Route ID")):
    cache_key = _cache_key("stops", route)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    data = await _mbta_get("/stops", {"filter[route]": route})
    result = [_normalize_stop(item) for item in data.get("data", [])]
    _cache_set(cache_key, result, CACHE_TTL_STOPS)
    return result


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
