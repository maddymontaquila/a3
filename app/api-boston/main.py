"""Boston MBTA Transit Data API — FastAPI service."""
from __future__ import annotations
import hashlib, json, logging, os
from datetime import datetime, timezone
from typing import Any, Callable
import httpx
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

# --- OpenTelemetry ---
_otel_instrumentor = None
_otel_tracer_provider = None
_otel_meter_provider = None
if _otlp := os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
    try:
        from opentelemetry import metrics, trace
        from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.instrumentation.redis import RedisInstrumentor
        from opentelemetry.sdk.metrics import MeterProvider
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        resource = Resource.create({"service.name": os.environ.get("OTEL_SERVICE_NAME", "api-boston")})
        _otel_tracer_provider = TracerProvider(resource=resource)
        cert = os.environ.get("OTEL_EXPORTER_OTLP_CERTIFICATE")
        if cert and os.path.exists(cert):
            import grpc
            with open(cert, "rb") as f:
                creds = grpc.ssl_channel_credentials(root_certificates=f.read())
            trace_exporter = OTLPSpanExporter(endpoint=_otlp, credentials=creds)
            metric_exporter = OTLPMetricExporter(endpoint=_otlp, credentials=creds)
        else:
            insecure = not _otlp.startswith("https")
            trace_exporter = OTLPSpanExporter(endpoint=_otlp, insecure=insecure)
            metric_exporter = OTLPMetricExporter(endpoint=_otlp, insecure=insecure)
        _otel_tracer_provider.add_span_processor(BatchSpanProcessor(trace_exporter))
        _otel_meter_provider = MeterProvider(
            resource=resource,
            metric_readers=[PeriodicExportingMetricReader(metric_exporter)],
        )
        trace.set_tracer_provider(_otel_tracer_provider)
        metrics.set_meter_provider(_otel_meter_provider)
        HTTPXClientInstrumentor().instrument(
            tracer_provider=_otel_tracer_provider,
            meter_provider=_otel_meter_provider,
        )
        RedisInstrumentor().instrument(
            tracer_provider=_otel_tracer_provider,
            meter_provider=_otel_meter_provider,
        )
        _otel_instrumentor = FastAPIInstrumentor()
    except Exception:
        logging.exception("OpenTelemetry setup failed — continuing without telemetry")

# --- App ---
app = FastAPI(title="Boston MBTA Transit API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
if _otel_instrumentor:
    _otel_instrumentor.instrument_app(
        app,
        tracer_provider=_otel_tracer_provider,
        meter_provider=_otel_meter_provider,
    )

MBTA_BASE = "https://api-v3.mbta.com"
MBTA_KEY = os.environ.get("MBTA_API_KEY")
logger = logging.getLogger("api-boston")
TTLS = {"predictions": 30, "alerts": 120, "routes": 3600, "stops": 3600}

# --- Redis / caching ---
_rc: Any = None

def _get_redis():
    global _rc
    if _rc is not None:
        return _rc
    conn = os.environ.get("ConnectionStrings__cache")
    if not conn:
        return None
    try:
        import redis
        if conn.startswith(("redis://", "rediss://")):
            from urllib.parse import urlparse
            p = urlparse(conn)
            host, port, pw = p.hostname or "localhost", p.port or 6379, p.password
            ssl = conn.startswith("rediss://")
        else:
            # StackExchange format: host:port,password=xxx,ssl=True
            opts, hp = {}, None
            for part in conn.split(","):
                part = part.strip()
                if "=" in part:
                    k, v = part.split("=", 1)
                    opts[k.strip().lower()] = v.strip()
                elif not hp:
                    hp = part
            hp = (hp or "localhost").rsplit(":", 1)
            host, port = hp[0], int(hp[1]) if len(hp) > 1 else 6379
            pw, ssl = opts.get("password"), opts.get("ssl", "").lower() == "true"
        _rc = redis.Redis(host=host, port=port, password=pw, decode_responses=True,
                          socket_timeout=2, ssl=ssl, ssl_cert_reqs=None)
        _rc.ping()
        logger.info("Connected to Redis at %s:%s", host, port)
        return _rc
    except Exception:
        logger.warning("Redis unavailable — caching disabled")
        _rc = None
        return None

def _cache_get(prefix: str, *parts: str) -> tuple[Any | None, str]:
    key = f"mbta:{prefix}:{hashlib.sha256('|'.join(parts).encode()).hexdigest()[:12]}"
    try:
        r = _get_redis()
        if r and (raw := r.get(key)):
            return json.loads(raw), key
    except Exception:
        pass
    return None, key

def _cache_set(key: str, value: Any, ttl: int) -> None:
    try:
        r = _get_redis()
        if r:
            r.setex(key, ttl, json.dumps(value, default=str))
    except Exception:
        pass

# --- MBTA client ---
async def _mbta_get(path: str, params: dict[str, str] | None = None) -> dict:
    p = dict(params or {})
    if MBTA_KEY:
        p["api_key"] = MBTA_KEY
    async with httpx.AsyncClient(base_url=MBTA_BASE, timeout=15) as c:
        r = await c.get(path, params=p)
        r.raise_for_status()
        return r.json()

async def _cached_fetch(prefix: str, key_parts: tuple[str, ...], path: str,
                        params: dict, norm: Callable, *, with_included: bool = False) -> list:
    cached, key = _cache_get(prefix, *key_parts)
    if cached is not None:
        return cached
    data = await _mbta_get(path, params)
    items = data.get("data", [])
    if with_included:
        inc = {(i["type"], i["id"]): i for i in data.get("included", []) if "type" in i and "id" in i}
        result = [norm(i, inc) for i in items]
    else:
        result = [norm(i) for i in items]
    _cache_set(key, result, TTLS[prefix])
    return result

# --- Normalizers ---
def _a(item: dict) -> dict:
    return item.get("attributes", {})

def _ref(rels: dict, name: str) -> dict:
    return (rels.get(name, {}).get("data") or {})

def _normalize_route(item: dict) -> dict:
    a = _a(item)
    return {"id": item["id"], "name": a.get("long_name") or a.get("short_name", ""),
            "color": f"#{a['color']}" if a.get("color") else None,
            "textColor": f"#{a['text_color']}" if a.get("text_color") else None,
            "type": a.get("type")}

def _normalize_prediction(item: dict, inc: dict) -> dict:
    a, rels = _a(item), item.get("relationships", {})
    rr, sr = _ref(rels, "route"), _ref(rels, "stop")
    ra = _a(inc.get((rr.get("type", ""), rr.get("id", "")), {}))
    sa = _a(inc.get((sr.get("type", ""), sr.get("id", "")), {}))
    arr = a.get("arrival_time") or a.get("departure_time")
    mins = None
    if arr:
        try:
            mins = max(0, round((datetime.fromisoformat(arr) - datetime.now(timezone.utc)).total_seconds() / 60, 1))
        except Exception:
            pass
    did = a.get("direction_id", 0)
    dests, names = ra.get("direction_destinations") or [], ra.get("direction_names") or []
    direction = (dests[did] if did is not None and did < len(dests)
                 else names[did] if did is not None and did < len(names)
                 else "Inbound" if did == 1 else "Outbound")
    return {"routeId": rr.get("id"), "routeName": ra.get("long_name") or ra.get("short_name"),
            "stopId": sr.get("id"), "stopName": sa.get("name"), "direction": direction,
            "arrivalTime": arr, "minutesAway": mins, "status": a.get("status")}

def _normalize_alert(item: dict) -> dict:
    a = _a(item)
    affected = list(dict.fromkeys(e["route"] for e in (a.get("informed_entity") or []) if e.get("route")))
    periods = a.get("active_period") or []
    raw = a.get("severity", 0)
    sev = ("severe" if raw >= 7 else "warning" if raw >= 4 else "info") if isinstance(raw, int) else (str(raw).lower() or "info")
    return {"id": item["id"], "severity": sev, "header": a.get("header"),
            "description": a.get("description"), "affectedRoutes": affected,
            "activePeriod": {"start": periods[0].get("start"), "end": periods[0].get("end")} if periods else None,
            "updatedAt": a.get("updated_at")}

def _normalize_stop(item: dict) -> dict:
    a = _a(item)
    rd = (item.get("relationships", {}).get("route", {}) or {}).get("data")
    ids = ([r["id"] for r in rd if "id" in r] if isinstance(rd, list)
           else [rd["id"]] if isinstance(rd, dict) and "id" in rd else [])
    return {"id": item["id"], "name": a.get("name"), "latitude": a.get("latitude"),
            "longitude": a.get("longitude"), "routeIds": ids}

# --- Endpoints ---
@app.get("/health")
async def health():
    return {"status": "healthy", "service": "api-boston"}

@app.get("/routes")
async def list_routes():
    return await _cached_fetch("routes", ("subway",), "/routes", {"filter[type]": "0,1"}, _normalize_route)

@app.get("/predictions")
async def get_predictions(stop: str = Query(..., description="Stop ID")):
    return await _cached_fetch("predictions", (stop,), "/predictions",
                               {"filter[stop]": stop, "include": "route,stop"}, _normalize_prediction, with_included=True)

@app.get("/alerts")
async def list_alerts():
    return await _cached_fetch("alerts", ("transit",), "/alerts", {"filter[route_type]": "0,1"}, _normalize_alert)

@app.get("/stops")
async def list_stops(route: str = Query(..., description="Route ID")):
    return await _cached_fetch("stops", (route,), "/stops", {"filter[route]": route}, _normalize_stop)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
