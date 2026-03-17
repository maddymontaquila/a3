"""GenAI Route Advisor — FastAPI service that recommends transit routes using OpenAI."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

import httpx
import redis
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# OpenTelemetry setup
# ---------------------------------------------------------------------------

OTEL_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
SERVICE_NAME = "api-advisor"

if OTEL_ENDPOINT:
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor

    resource = Resource.create({"service.name": SERVICE_NAME})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=OTEL_ENDPOINT, insecure=True)))
    trace.set_tracer_provider(provider)
    HTTPXClientInstrumentor().instrument()

logger = logging.getLogger(SERVICE_NAME)
logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="GenAI Route Advisor", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

if OTEL_ENDPOINT:
    FastAPIInstrumentor.instrument_app(app)

# ---------------------------------------------------------------------------
# Configuration helpers
# ---------------------------------------------------------------------------

CITY_ENV_MAP: dict[str, str] = {
    "boston": "services__api-boston__http__0",
    "nyc": "services__api-nyc__http__0",
    "bart": "services__api-bart__http__0",
}

CACHE_TTL_SECONDS = 120  # 2 minutes


def _parse_openai_connection_string(conn: str) -> dict[str, str]:
    """Parse Aspire-format connection string: Endpoint=...;Key=...;Model=..."""
    parts: dict[str, str] = {}
    for segment in conn.split(";"):
        segment = segment.strip()
        if "=" in segment:
            key, _, value = segment.partition("=")
            parts[key.strip()] = value.strip()
    return parts


def _get_openai_client() -> tuple[AsyncOpenAI, str]:
    """Return (AsyncOpenAI client, model) from the Aspire connection string."""
    conn = os.environ.get("ConnectionStrings__chat", "")
    if not conn:
        raise RuntimeError("ConnectionStrings__chat is not set")
    parsed = _parse_openai_connection_string(conn)
    endpoint = parsed.get("Endpoint", "https://api.openai.com/v1")
    api_key = parsed.get("Key", "")
    model = parsed.get("Model", "gpt-4o-mini")
    if not api_key:
        raise RuntimeError("No Key found in ConnectionStrings__chat")
    return AsyncOpenAI(base_url=endpoint, api_key=api_key), model


def _get_redis() -> redis.Redis | None:
    """Return a Redis client from Aspire connection string, or None."""
    conn = os.environ.get("ConnectionStrings__cache", "")
    if not conn:
        return None
    try:
        # Aspire may provide redis:// URI or StackExchange format (host:port,password=xxx)
        if conn.startswith("redis://") or conn.startswith("rediss://"):
            use_ssl = conn.startswith("rediss://")
            return redis.Redis.from_url(
                conn, decode_responses=True, socket_connect_timeout=2,
                ssl_cert_reqs=None if use_ssl else None,
            )
        else:
            host, port, password = "localhost", 6379, None
            for part in conn.split(","):
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
            return redis.Redis(host=host, port=port, password=password, decode_responses=True, socket_connect_timeout=2)
    except Exception:
        logger.warning("Failed to create Redis client", exc_info=True)
        return None


def _city_base_url(city: str) -> str:
    env_var = CITY_ENV_MAP.get(city)
    if not env_var:
        raise HTTPException(status_code=400, detail=f"Unknown city: {city}")
    url = os.environ.get(env_var, "")
    if not url:
        raise HTTPException(status_code=503, detail=f"Service URL not configured for {city}")
    return url.rstrip("/")


def _cache_key(city: str, from_stop: str, to_stop: str) -> str:
    raw = f"advisor:{city}:{from_stop}:{to_stop}"
    return f"advisor:{hashlib.sha256(raw.encode()).hexdigest()[:16]}"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class BriefingRequest(BaseModel):
    city: str


class BriefingResponse(BaseModel):
    city: str
    briefing: str
    alertCount: int
    generatedAt: str


class AdviseResponse(BaseModel):
    fromStop: str
    toStop: str
    city: str
    recommendation: str
    alternatives: list[str]
    currentAlerts: list[Any]
    generatedAt: str


# ---------------------------------------------------------------------------
# Transit data fetching
# ---------------------------------------------------------------------------


async def _fetch_predictions(client: httpx.AsyncClient, base_url: str, stop_id: str) -> list[dict]:
    """Fetch predictions for a stop from the city transit API."""
    try:
        resp = await client.get(f"{base_url}/predictions/{stop_id}", timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.warning("Failed to fetch predictions for stop %s", stop_id, exc_info=True)
        return []


async def _fetch_alerts(client: httpx.AsyncClient, base_url: str) -> list[dict]:
    """Fetch active service alerts from the city transit API."""
    try:
        resp = await client.get(f"{base_url}/alerts", timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.warning("Failed to fetch alerts", exc_info=True)
        return []


async def _fetch_routes(client: httpx.AsyncClient, base_url: str) -> list[dict]:
    """Fetch routes from the city transit API."""
    try:
        resp = await client.get(f"{base_url}/routes", timeout=10.0)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.warning("Failed to fetch routes", exc_info=True)
        return []


# ---------------------------------------------------------------------------
# OpenAI advice generation
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are a transit advisor. Given current train predictions and service alerts, "
    "recommend the best route between two stops. Be concise and practical. "
    "Consider delays, service disruptions, and alternative routes."
)

BRIEFING_SYSTEM_PROMPT = (
    "You are a friendly transit briefing announcer. Given the current service alerts "
    "and live train data for a city's subway system, give a concise, conversational "
    "status briefing (3-5 sentences). Mention specific lines and issues. If everything "
    "is running well, say so. Use a warm, helpful tone — like a local who knows the system. "
    "Don't use bullet points or headers — just natural flowing text."
)


async def _generate_briefing(city: str, alerts: list[dict], routes: list[dict]) -> str:
    """Call OpenAI to generate a transit status briefing."""
    ai_client, model = _get_openai_client()

    city_names = {"boston": "Boston MBTA", "nyc": "NYC Subway", "bart": "Bay Area BART"}
    city_name = city_names.get(city, city)

    alert_summary = json.dumps(alerts[:15], indent=2) if alerts else "No active alerts."
    route_summary = json.dumps(routes[:10], indent=2) if routes else "No route data."

    user_content = (
        f"City: {city_name}\n\n"
        f"Active service alerts ({len(alerts)} total):\n{alert_summary}\n\n"
        f"Routes:\n{route_summary}\n\n"
        "Give me a brief status update."
    )

    response = await ai_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": BRIEFING_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        temperature=0.7,
        max_tokens=300,
    )

    return response.choices[0].message.content or "Unable to generate briefing."


async def _generate_advice(
    from_stop: str,
    to_stop: str,
    city: str,
    from_predictions: list[dict],
    to_predictions: list[dict],
    alerts: list[dict],
) -> dict:
    """Call OpenAI to generate a route recommendation."""
    ai_client, model = _get_openai_client()

    user_content = (
        f"City: {city}\n"
        f"From stop: {from_stop}\n"
        f"To stop: {to_stop}\n\n"
        f"Current predictions at {from_stop}:\n{json.dumps(from_predictions, indent=2)}\n\n"
        f"Current predictions at {to_stop}:\n{json.dumps(to_predictions, indent=2)}\n\n"
        f"Active service alerts:\n{json.dumps(alerts, indent=2)}\n\n"
        "Respond in JSON with keys: recommendation (string), alternatives (list of strings), "
        "relevantAlerts (list of alert objects that are relevant to this route)."
    )

    response = await ai_client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
    )

    raw = response.choices[0].message.content or "{}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {"recommendation": raw, "alternatives": [], "relevantAlerts": []}

    return {
        "recommendation": parsed.get("recommendation", ""),
        "alternatives": parsed.get("alternatives", []),
        "relevantAlerts": parsed.get("relevantAlerts", []),
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "healthy"}


@app.post("/briefing", response_model=BriefingResponse)
async def briefing(req: BriefingRequest) -> BriefingResponse:
    city = req.city.lower()

    # Check cache
    cache_key = f"briefing:{city}"
    redis_client = _get_redis()
    if redis_client:
        try:
            cached = redis_client.get(cache_key)
            if cached:
                return BriefingResponse(**json.loads(cached))
        except Exception:
            pass

    # Fetch live data
    base_url = _city_base_url(city)
    async with httpx.AsyncClient() as client:
        alerts = await _fetch_alerts(client, base_url)
        routes = await _fetch_routes(client, base_url)

    # Generate briefing via OpenAI
    try:
        text = await _generate_briefing(city, alerts, routes)
    except Exception as exc:
        logger.error("OpenAI briefing failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to generate briefing") from exc

    result = BriefingResponse(
        city=city,
        briefing=text,
        alertCount=len(alerts),
        generatedAt=datetime.now(timezone.utc).isoformat(),
    )

    # Cache for 2 minutes
    if redis_client:
        try:
            redis_client.setex(cache_key, 120, result.model_dump_json())
        except Exception:
            pass

    return result


@app.post("/advise", response_model=AdviseResponse)
async def advise(req: AdviseRequest) -> AdviseResponse:
    city = req.city.lower()
    from_stop = req.fromStop
    to_stop = req.toStop

    # Check cache first
    redis_client = _get_redis()
    key = _cache_key(city, from_stop, to_stop)
    if redis_client:
        try:
            cached = redis_client.get(key)
            if cached:
                logger.info("Cache hit for %s", key)
                return AdviseResponse(**json.loads(cached))
        except Exception:
            logger.warning("Redis read failed, continuing without cache", exc_info=True)

    # Fetch transit data
    base_url = _city_base_url(city)
    async with httpx.AsyncClient() as client:
        from_predictions = await _fetch_predictions(client, base_url, from_stop)
        to_predictions = await _fetch_predictions(client, base_url, to_stop)
        alerts = await _fetch_alerts(client, base_url)

    # Generate advice via OpenAI
    try:
        advice = await _generate_advice(from_stop, to_stop, city, from_predictions, to_predictions, alerts)
    except Exception as exc:
        logger.error("OpenAI call failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="Failed to generate route advice") from exc

    result = AdviseResponse(
        fromStop=from_stop,
        toStop=to_stop,
        city=city,
        recommendation=advice["recommendation"],
        alternatives=advice["alternatives"],
        currentAlerts=advice["relevantAlerts"],
        generatedAt=datetime.now(timezone.utc).isoformat(),
    )

    # Cache the result
    if redis_client:
        try:
            redis_client.setex(key, CACHE_TTL_SECONDS, result.model_dump_json())
        except Exception:
            logger.warning("Redis write failed", exc_info=True)

    return result


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
