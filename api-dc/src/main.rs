use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::Json,
    routing::get,
    Router,
};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use std::{env, sync::Arc};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;

const WMATA_BASE: &str = "https://api.wmata.com";

// ── Shared response types (same contract as Boston/NYC/BART) ───────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TransitRoute {
    id: String,
    name: String,
    color: String,
    text_color: String,
    #[serde(rename = "type")]
    route_type: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Prediction {
    route_id: String,
    route_name: String,
    stop_id: String,
    stop_name: String,
    direction: String,
    arrival_time: Option<String>,
    minutes_away: Option<f64>,
    status: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceAlert {
    id: String,
    severity: String,
    header: String,
    description: String,
    affected_routes: Vec<String>,
    active_period: ActivePeriod,
    updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActivePeriod {
    start: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Stop {
    id: String,
    name: String,
    latitude: f64,
    longitude: f64,
    route_ids: Vec<String>,
}

// ── WMATA API response types ───────────────────────────────────────

#[derive(Deserialize)]
struct WmataLines {
    #[serde(rename = "Lines")]
    lines: Vec<WmataLine>,
}

#[derive(Deserialize)]
struct WmataLine {
    #[serde(rename = "LineCode")]
    line_code: String,
    #[serde(rename = "DisplayName")]
    display_name: String,
}

#[derive(Deserialize)]
struct WmataStations {
    #[serde(rename = "Stations")]
    stations: Vec<WmataStation>,
}

#[derive(Deserialize)]
struct WmataStation {
    #[serde(rename = "Code")]
    code: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "Lat")]
    lat: f64,
    #[serde(rename = "Lon")]
    lon: f64,
    #[serde(rename = "LineCode1")]
    line_code1: Option<String>,
    #[serde(rename = "LineCode2")]
    line_code2: Option<String>,
    #[serde(rename = "LineCode3")]
    line_code3: Option<String>,
    #[serde(rename = "LineCode4")]
    line_code4: Option<String>,
}

#[derive(Deserialize)]
struct WmataTrains {
    #[serde(rename = "Trains")]
    trains: Vec<WmataTrain>,
}

#[derive(Deserialize)]
struct WmataTrain {
    #[serde(rename = "DestinationName")]
    destination_name: Option<String>,
    #[serde(rename = "Line")]
    line: Option<String>,
    #[serde(rename = "LocationCode")]
    location_code: Option<String>,
    #[serde(rename = "LocationName")]
    location_name: Option<String>,
    #[serde(rename = "Min")]
    min: Option<String>,
}

#[derive(Deserialize)]
struct WmataIncidents {
    #[serde(rename = "Incidents")]
    incidents: Vec<WmataIncident>,
}

#[derive(Deserialize)]
struct WmataIncident {
    #[serde(rename = "IncidentID")]
    incident_id: String,
    #[serde(rename = "Description")]
    description: Option<String>,
    #[serde(rename = "IncidentType")]
    incident_type: Option<String>,
    #[serde(rename = "LinesAffected")]
    lines_affected: Option<String>,
    #[serde(rename = "DateUpdated")]
    date_updated: Option<String>,
}

// ── App state ──────────────────────────────────────────────────────

struct AppState {
    client: reqwest::Client,
    redis: Option<redis::aio::ConnectionManager>,
    api_key: String,
}

type SharedState = Arc<AppState>;

// ── Redis helpers ──────────────────────────────────────────────────

async fn cache_get<T: for<'de> Deserialize<'de>>(state: &AppState, key: &str) -> Option<T> {
    let redis = state.redis.as_ref()?;
    let mut conn = redis.clone();
    let val: Option<String> = conn.get(key).await.ok()?;
    val.and_then(|v| serde_json::from_str(&v).ok())
}

async fn cache_set<T: Serialize>(state: &AppState, key: &str, val: &T, ttl_secs: u64) {
    if let Some(redis) = &state.redis {
        let mut conn = redis.clone();
        if let Ok(json) = serde_json::to_string(val) {
            let _: Result<(), _> = conn.set_ex(key, json, ttl_secs).await;
        }
    }
}

// ── Line metadata ──────────────────────────────────────────────────

fn line_color(code: &str) -> (&'static str, &'static str) {
    match code {
        "RD" => ("#BF0D3E", "#FFFFFF"),
        "OR" => ("#ED8B00", "#FFFFFF"),
        "YL" => ("#FFD100", "#000000"),
        "GR" => ("#00B140", "#FFFFFF"),
        "BL" => ("#009CDE", "#FFFFFF"),
        "SV" => ("#919D9D", "#FFFFFF"),
        _ => ("#888888", "#FFFFFF"),
    }
}

fn line_name(code: &str) -> &'static str {
    match code {
        "RD" => "Red Line",
        "OR" => "Orange Line",
        "YL" => "Yellow Line",
        "GR" => "Green Line",
        "BL" => "Blue Line",
        "SV" => "Silver Line",
        _ => "Unknown",
    }
}

// ── Handlers ───────────────────────────────────────────────────────

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "healthy", "service": "api-dc" }))
}

#[tracing::instrument(skip(state))]
async fn get_routes(
    State(state): State<SharedState>,
) -> Result<Json<Vec<TransitRoute>>, StatusCode> {
    if let Some(cached) = cache_get::<Vec<TransitRoute>>(&state, "dc:routes").await {
        return Ok(Json(cached));
    }

    let resp = state
        .client
        .get(format!("{WMATA_BASE}/Rail.svc/json/jLines"))
        .header("api_key", &state.api_key)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        tracing::warn!("WMATA jLines returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let data = resp
        .json::<WmataLines>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let routes: Vec<TransitRoute> = data
        .lines
        .iter()
        .map(|line| {
            let (color, text_color) = line_color(&line.line_code);
            TransitRoute {
                id: line.line_code.clone(),
                name: format!("{} Line", line.display_name),
                color: color.to_string(),
                text_color: text_color.to_string(),
                route_type: "heavy-rail".to_string(),
            }
        })
        .collect();

    cache_set(&state, "dc:routes", &routes, 3600).await;
    Ok(Json(routes))
}

#[derive(Deserialize)]
struct StopQuery {
    route: String,
}

#[tracing::instrument(skip_all, fields(route = %params.route))]
async fn get_stops(
    State(state): State<SharedState>,
    Query(params): Query<StopQuery>,
) -> Result<Json<Vec<Stop>>, StatusCode> {
    let cache_key = format!("dc:stops:{}", params.route);
    if let Some(cached) = cache_get::<Vec<Stop>>(&state, &cache_key).await {
        return Ok(Json(cached));
    }

    let resp = state
        .client
        .get(format!("{WMATA_BASE}/Rail.svc/json/jStations"))
        .query(&[("LineCode", &params.route)])
        .header("api_key", &state.api_key)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        tracing::warn!("WMATA jStations returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let data = resp
        .json::<WmataStations>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let stops: Vec<Stop> = data.stations
        .iter()
        .map(|s| {
            let route_ids = [&s.line_code1, &s.line_code2, &s.line_code3, &s.line_code4]
                .iter()
                .filter_map(|c| c.as_ref())
                .filter(|c| !c.is_empty())
                .cloned()
                .collect();
            Stop {
                id: s.code.clone(),
                name: s.name.clone(),
                latitude: s.lat,
                longitude: s.lon,
                route_ids,
            }
        })
        .collect();

    cache_set(&state, &cache_key, &stops, 3600).await;
    Ok(Json(stops))
}

#[derive(Deserialize)]
struct PredictionQuery {
    stop: String,
}

#[tracing::instrument(skip_all, fields(stop = %params.stop))]
async fn get_predictions(
    State(state): State<SharedState>,
    Query(params): Query<PredictionQuery>,
) -> Result<Json<Vec<Prediction>>, StatusCode> {
    let cache_key = format!("dc:predictions:{}", params.stop);
    if let Some(cached) = cache_get::<Vec<Prediction>>(&state, &cache_key).await {
        return Ok(Json(cached));
    }

    let resp = state
        .client
        .get(format!(
            "{WMATA_BASE}/StationPrediction.svc/json/GetPrediction/{}",
            params.stop
        ))
        .header("api_key", &state.api_key)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        tracing::warn!("WMATA GetPrediction returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let data = resp
        .json::<WmataTrains>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let predictions: Vec<Prediction> = data.trains
        .iter()
        .filter_map(|t| {
            let line = t.line.as_deref().unwrap_or("");
            if line.is_empty() || line == "--" || line == "No" {
                return None;
            }
            let mins_str = t.min.as_deref().unwrap_or("");
            let minutes_away = match mins_str {
                "ARR" | "BRD" => Some(0.0),
                "" | "---" => None,
                s => s.parse::<f64>().ok(),
            };
            let status = match mins_str {
                "ARR" => "approaching",
                "BRD" => "on-time",
                _ if minutes_away.is_some() => "on-time",
                _ => "scheduled",
            };
            Some(Prediction {
                route_id: line.to_string(),
                route_name: line_name(line).to_string(),
                stop_id: t.location_code.clone().unwrap_or_default(),
                stop_name: t.location_name.clone().unwrap_or_default(),
                direction: t
                    .destination_name
                    .clone()
                    .unwrap_or_else(|| "Unknown".to_string()),
                arrival_time: None,
                minutes_away,
                status: status.to_string(),
            })
        })
        .collect();

    cache_set(&state, &cache_key, &predictions, 30).await;
    Ok(Json(predictions))
}

#[tracing::instrument(skip(state))]
async fn get_alerts(
    State(state): State<SharedState>,
) -> Result<Json<Vec<ServiceAlert>>, StatusCode> {
    if let Some(cached) = cache_get::<Vec<ServiceAlert>>(&state, "dc:alerts").await {
        return Ok(Json(cached));
    }

    let resp = state
        .client
        .get(format!("{WMATA_BASE}/Incidents.svc/json/Incidents"))
        .header("api_key", &state.api_key)
        .send()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    if !resp.status().is_success() {
        tracing::warn!("WMATA Incidents returned {}", resp.status());
        return Err(StatusCode::BAD_GATEWAY);
    }

    let data = resp
        .json::<WmataIncidents>()
        .await
        .map_err(|_| StatusCode::BAD_GATEWAY)?;

    let alerts: Vec<ServiceAlert> = data.incidents
        .iter()
        .map(|inc| {
            let lines: Vec<String> = inc
                .lines_affected
                .as_deref()
                .unwrap_or("")
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();

            let severity = match inc.incident_type.as_deref() {
                Some("Delay") => "warning",
                Some("Alert") => "severe",
                _ => "info",
            };

            let description = inc.description.clone().unwrap_or_default();
            let header: String = description.chars().take(120).collect();

            ServiceAlert {
                id: inc.incident_id.clone(),
                severity: severity.to_string(),
                header,
                description,
                affected_routes: lines,
                active_period: ActivePeriod {
                    start: inc.date_updated.clone().unwrap_or_default(),
                    end: None,
                },
                updated_at: inc.date_updated.clone().unwrap_or_default(),
            }
        })
        .collect();

    cache_set(&state, "dc:alerts", &alerts, 120).await;
    Ok(Json(alerts))
}

// ── Connection string parsing ──────────────────────────────────────

fn parse_connection_string(conn_str: &str) -> Option<String> {
    if conn_str.starts_with("redis://") || conn_str.starts_with("rediss://") {
        return Some(conn_str.to_string());
    }
    // StackExchange format: host:port,password=xxx,ssl=true
    let mut host = "";
    let mut password = None;
    let mut ssl = false;
    for part in conn_str.split(',') {
        let part = part.trim();
        if let Some(val) = part.strip_prefix("password=") {
            password = Some(val);
        } else if let Some(val) = part.strip_prefix("ssl=") {
            ssl = val.eq_ignore_ascii_case("true");
        } else if !part.contains('=') {
            host = part;
        }
    }
    let scheme = if ssl { "rediss" } else { "redis" };
    let auth = password
        .map(|p| {
            let encoded: String = p.bytes().map(|b| match b {
                b'@' | b':' | b'/' | b'?' | b'#' | b'[' | b']' => format!("%{:02X}", b),
                _ => String::from(b as char),
            }).collect();
            format!(":{encoded}@")
        })
        .unwrap_or_default();
    Some(format!("{scheme}://{auth}{host}"))
}

// ── Telemetry ──────────────────────────────────────────────────────

fn init_telemetry() {
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_otlp::WithTonicConfig;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "api_dc=info,tower_http=info".into());

    let fmt_layer = tracing_subscriber::fmt::layer().compact();

    if let Ok(endpoint) = env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        // Parse headers from OTEL_EXPORTER_OTLP_HEADERS
        let mut metadata = tonic::metadata::MetadataMap::new();
        if let Ok(h) = env::var("OTEL_EXPORTER_OTLP_HEADERS") {
            for pair in h.split(',') {
                if let Some((k, v)) = pair.split_once('=') {
                    if let (Ok(name), Ok(val)) = (
                        k.parse::<tonic::metadata::MetadataKey<tonic::metadata::Ascii>>(),
                        v.parse::<tonic::metadata::MetadataValue<tonic::metadata::Ascii>>(),
                    ) {
                        metadata.insert(name, val);
                    }
                }
            }
        }

        // Configure TLS like the Go BART API: load cert from OTEL_EXPORTER_OTLP_CERTIFICATE
        let tls_config = if endpoint.starts_with("https://") {
            use opentelemetry_otlp::tonic_types::transport::{Certificate, ClientTlsConfig};
            if let Ok(cert_path) = env::var("OTEL_EXPORTER_OTLP_CERTIFICATE") {
                if let Ok(pem) = std::fs::read_to_string(&cert_path) {
                    Some(ClientTlsConfig::new()
                        .ca_certificate(Certificate::from_pem(pem))
                        .domain_name("otlp.dev.localhost"))
                } else {
                    Some(ClientTlsConfig::new())
                }
            } else if let Ok(cert_dir) = env::var("SSL_CERT_DIR") {
                // Try loading cert from SSL_CERT_DIR
                let pem = std::fs::read_dir(&cert_dir)
                    .ok()
                    .and_then(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .find(|e| {
                                e.path()
                                    .extension()
                                    .is_some_and(|ext| ext == "crt" || ext == "pem")
                            })
                            .and_then(|e| {
                                std::fs::read_to_string(e.path()).ok()
                            })
                    });
                if let Some(pem) = pem {
                    Some(ClientTlsConfig::new()
                        .ca_certificate(Certificate::from_pem(pem))
                        .domain_name("otlp.dev.localhost"))
                } else {
                    Some(ClientTlsConfig::new())
                }
            } else {
                Some(ClientTlsConfig::new())
            }
        } else {
            None
        };

        let mut builder = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(&endpoint)
            .with_metadata(metadata);

        if let Some(tls) = tls_config {
            builder = builder.with_tls_config(tls);
        }

        match builder.build() {
            Ok(exporter) => {
                let provider = opentelemetry_sdk::trace::SdkTracerProvider::builder()
                    .with_batch_exporter(exporter)
                    .with_resource(
                        opentelemetry_sdk::Resource::builder()
                            .with_service_name(
                                env::var("OTEL_SERVICE_NAME")
                                    .unwrap_or_else(|_| "api-dc".into()),
                            )
                            .build(),
                    )
                    .build();

                let tracer = provider.tracer("api-dc");
                opentelemetry::global::set_tracer_provider(provider);

                let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
                tracing_subscriber::registry()
                    .with(env_filter)
                    .with(fmt_layer)
                    .with(otel_layer)
                    .init();

                tracing::info!("OpenTelemetry enabled → {endpoint}");
                return;
            }
            Err(e) => {
                eprintln!("Failed to create OTEL exporter: {e}");
            }
        }
    }

    // Fallback: no OTEL
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .init();
}

// ── Main ───────────────────────────────────────────────────────────

#[tokio::main]
async fn main() {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");

    init_telemetry();

    let port = env::var("PORT").unwrap_or_else(|_| "8088".to_string());
    let api_key = env::var("WMATA_API_KEY").unwrap_or_default();

    // Connect to Redis (optional — graceful fallback)
    let redis = if let Ok(conn_str) = env::var("ConnectionStrings__cache") {
        match parse_connection_string(&conn_str) {
            Some(url) => match redis::Client::open(url.as_str()) {
                Ok(client) => match redis::aio::ConnectionManager::new(client).await {
                    Ok(mgr) => {
                        tracing::info!("Connected to Redis");
                        Some(mgr)
                    }
                    Err(e) => {
                        tracing::warn!("Redis connection failed: {e}");
                        None
                    }
                },
                Err(e) => {
                    tracing::warn!("Invalid Redis URL: {e}");
                    None
                }
            },
            None => None,
        }
    } else {
        tracing::info!("No Redis configured, caching disabled");
        None
    };

    let state = Arc::new(AppState {
        client: reqwest::Client::new(),
        redis,
        api_key,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([axum::http::Method::GET, axum::http::Method::OPTIONS])
        .allow_headers(Any);

    let app = Router::new()
        .route("/health", get(health))
        .route("/routes", get(get_routes))
        .route("/stops", get(get_stops))
        .route("/predictions", get(get_predictions))
        .route("/alerts", get(get_alerts))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let addr = format!("localhost:{port}");
    tracing::info!("DC Metro API listening on {addr}");

    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");
    axum::serve(listener, app).await.expect("Server error");
}
