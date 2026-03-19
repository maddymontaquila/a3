package main

import (
"context"
"crypto/tls"
"encoding/json"
"fmt"
"io"
"log"
"net/http"
"net/url"
"os"
"strconv"
"strings"
"time"

"github.com/redis/go-redis/v9"
"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
"go.opentelemetry.io/otel"
"go.opentelemetry.io/otel/attribute"
"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
"go.opentelemetry.io/otel/sdk/resource"
sdktrace "go.opentelemetry.io/otel/sdk/trace"
semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
"go.opentelemetry.io/otel/trace"
"google.golang.org/grpc/credentials"
)

// Public response types — the frontend depends on these shapes.
type Route struct {
ID        string `json:"id"`
Name      string `json:"name"`
Color     string `json:"color"`
TextColor string `json:"textColor"`
Type      string `json:"type"`
}
type Prediction struct {
RouteID     string  `json:"routeId"`
RouteName   string  `json:"routeName"`
StopID      string  `json:"stopId"`
StopName    string  `json:"stopName"`
Direction   string  `json:"direction"`
ArrivalTime *string `json:"arrivalTime"`
MinutesAway *int    `json:"minutesAway"`
Status      string  `json:"status"`
}
type ServiceAlert struct {
ID             string   `json:"id"`
Severity       string   `json:"severity"`
Header         string   `json:"header"`
Description    string   `json:"description"`
AffectedRoutes []string `json:"affectedRoutes"`
ActivePeriod   struct {
Start string  `json:"start"`
End   *string `json:"end,omitempty"`
} `json:"activePeriod"`
UpdatedAt string `json:"updatedAt"`
}
type Stop struct {
ID        string   `json:"id"`
Name      string   `json:"name"`
Latitude  float64  `json:"latitude"`
Longitude float64  `json:"longitude"`
RouteIDs  []string `json:"routeIds"`
}

// BART API types — only fields we read are declared.
const bartBaseURL = "https://api.bart.gov/api/"
const bartAPIKey = "MW9S-E7SL-26DU-VV8V"

type bartRoute struct{ Name, Number, HexColor string }
type bartRouteInfo struct{ Config struct{ Station json.RawMessage `json:"station"` } `json:"config"` }
type bartStation struct {
Name, Abbr string
Lat        string `json:"gtfs_latitude"`
Lng        string `json:"gtfs_longitude"`
}
type bartETDStation struct{ Name, Abbr string; ETD json.RawMessage `json:"etd"` }
type bartETD struct {
Destination string                            `json:"destination"`
Estimate    []struct{ Minutes, Color string } `json:"estimate"`
}
type bartBSA struct {
ID, Station, Type string; Description json.RawMessage
Posted, Expires   string
}
type bartRoot[T any] struct{ Root T `json:"root"` }

var colorMap = map[string][2]string{
"FFFF33": {"#FFD700", "#000000"}, "FFD700": {"#FFD700", "#000000"},
"FF9933": {"#FF8C00", "#FFFFFF"}, "FF8C00": {"#FF8C00", "#FFFFFF"},
"FF0000": {"#FF0000", "#FFFFFF"}, "CC0000": {"#FF0000", "#FFFFFF"},
"0099CC": {"#0000FF", "#FFFFFF"}, "0000FF": {"#0000FF", "#FFFFFF"},
"339933": {"#008000", "#FFFFFF"}, "008000": {"#008000", "#FFFFFF"},
"D5CFA3": {"#DAC49B", "#000000"}, "DAC49B": {"#DAC49B", "#000000"},
}
var (
tracer      trace.Tracer
redisClient *redis.Client
httpClient  *http.Client
)

func main() {
ctx := context.Background()
shutdown := initTracer(ctx)
defer shutdown(ctx)
initRedis()
httpClient = &http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport), Timeout: 10 * time.Second}
mux := http.NewServeMux()
mux.HandleFunc("/routes", cors(withSpan("GET /routes", handleRoutes)))
mux.HandleFunc("/predictions", cors(withSpan("GET /predictions", handlePredictions)))
mux.HandleFunc("/alerts", cors(withSpan("GET /alerts", handleAlerts)))
mux.HandleFunc("/stops", cors(withSpan("GET /stops", handleStops)))
mux.HandleFunc("/health", cors(handleHealth))
port := os.Getenv("PORT")
if port == "" { port = "8082" }
log.Printf("api-bart listening on :%s", port)
log.Fatal(http.ListenAndServe(":"+port, mux))
}

func initTracer(ctx context.Context) func(context.Context) {
noop := func(context.Context) {}
ep := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
if ep == "" { log.Println("OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled"); tracer = otel.Tracer("api-bart"); return noop }
var opts []otlptracegrpc.Option
switch {
case strings.HasPrefix(ep, "http://"):
ep = strings.TrimPrefix(ep, "http://")
opts = append(opts, otlptracegrpc.WithInsecure())
case strings.HasPrefix(ep, "https://"):
ep = strings.TrimPrefix(ep, "https://")
creds := credentials.NewTLS(&tls.Config{InsecureSkipVerify: true})
if cp := os.Getenv("OTEL_EXPORTER_OTLP_CERTIFICATE"); cp != "" {
if c, err := credentials.NewClientTLSFromFile(cp, ""); err == nil { creds = c }
}
opts = append(opts, otlptracegrpc.WithTLSCredentials(creds))
default:
opts = append(opts, otlptracegrpc.WithInsecure())
}
opts = append(opts, otlptracegrpc.WithEndpoint(ep))
exp, err := otlptracegrpc.New(ctx, opts...)
if err != nil { log.Printf("Failed to create OTLP exporter: %v", err); tracer = otel.Tracer("api-bart"); return noop }
svc := os.Getenv("OTEL_SERVICE_NAME")
if svc == "" { svc = "api-bart" }
res, _ := resource.New(ctx, resource.WithAttributes(semconv.ServiceName(svc)))
tp := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp), sdktrace.WithResource(res))
otel.SetTracerProvider(tp)
tracer = tp.Tracer("api-bart")
return func(ctx context.Context) { _ = tp.Shutdown(ctx) }
}

func initRedis() {
cs := os.Getenv("ConnectionStrings__cache")
if cs == "" { log.Println("ConnectionStrings__cache not set, caching disabled"); return }
var opts *redis.Options
var err error
if strings.HasPrefix(cs, "redis://") || strings.HasPrefix(cs, "rediss://") {
opts, err = redis.ParseURL(cs)
if err == nil && opts.TLSConfig != nil { opts.TLSConfig.InsecureSkipVerify = true }
} else {
opts = &redis.Options{}
for _, p := range strings.Split(cs, ",") {
p = strings.TrimSpace(p)
if kv := strings.SplitN(p, "=", 2); len(kv) == 2 {
if strings.ToLower(kv[0]) == "password" { opts.Password = kv[1] }
} else if p != "" && opts.Addr == "" { opts.Addr = p }
}
if opts.Addr == "" { opts.Addr = "localhost:6379" }
}
if err != nil { log.Printf("Failed to parse Redis URL: %v", err); return }
redisClient = redis.NewClient(opts)
ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
defer cancel()
if err := redisClient.Ping(ctx).Err(); err != nil {
log.Printf("Redis ping failed (will retry on use): %v", err)
} else { log.Println("Redis connected") }
}

func cors(next http.HandlerFunc) http.HandlerFunc {
return func(w http.ResponseWriter, r *http.Request) {
h := w.Header()
h.Set("Access-Control-Allow-Origin", "*")
h.Set("Access-Control-Allow-Methods", "GET, OPTIONS")
h.Set("Access-Control-Allow-Headers", "Content-Type")
if r.Method == http.MethodOptions { w.WriteHeader(http.StatusNoContent); return }
next(w, r)
}
}
func withSpan(name string, next http.HandlerFunc) http.HandlerFunc {
return func(w http.ResponseWriter, r *http.Request) {
ctx, span := tracer.Start(r.Context(), name, trace.WithAttributes(attribute.String("http.method", r.Method), attribute.String("http.url", r.URL.String())))
defer span.End()
next(w, r.WithContext(ctx))
}
}
func writeJSON(w http.ResponseWriter, code int, v any) {
w.Header().Set("Content-Type", "application/json"); w.WriteHeader(code); json.NewEncoder(w).Encode(v)
}
func writeError(w http.ResponseWriter, code int, msg string) {
writeJSON(w, code, map[string]string{"error": msg})
}

// serveCached returns true (and writes the response) on a cache hit.
func serveCached(w http.ResponseWriter, ctx context.Context, key string) bool {
if redisClient == nil { return false }
if v, err := redisClient.Get(ctx, key).Result(); err == nil {
w.Header().Set("Content-Type", "application/json"); w.Write([]byte(v)); return true
}
return false
}

// writeAndCache marshals v, stores it in Redis, and writes the HTTP response.
func writeAndCache(w http.ResponseWriter, ctx context.Context, key string, v any, ttl time.Duration) {
b, _ := json.Marshal(v)
if redisClient != nil { redisClient.Set(ctx, key, string(b), ttl) }
w.Header().Set("Content-Type", "application/json"); w.Write(b)
}

// bartFetch calls a BART API endpoint with tracing, returning the unmarshalled root contents.
func bartFetch[T any](ctx context.Context, ep string, params url.Values) (T, error) {
var zero T
ctx, span := tracer.Start(ctx, "BART API "+ep, trace.WithAttributes(attribute.String("bart.endpoint", ep)))
defer span.End()
params.Set("key", bartAPIKey); params.Set("json", "y")
req, err := http.NewRequestWithContext(ctx, http.MethodGet, bartBaseURL+ep+"?"+params.Encode(), nil)
if err != nil { return zero, err }
resp, err := httpClient.Do(req)
if err != nil { return zero, err }
defer resp.Body.Close()
if resp.StatusCode != http.StatusOK { return zero, fmt.Errorf("BART API returned status %d", resp.StatusCode) }
data, err := io.ReadAll(resp.Body)
if err != nil { return zero, err }
var wr bartRoot[T]
if err := json.Unmarshal(data, &wr); err != nil { return zero, err }
return wr.Root, nil
}

// unmarshalFlexible handles BART's inconsistent JSON (single object or array).
func unmarshalFlexible[T any](raw json.RawMessage) []T {
var arr []T
if json.Unmarshal(raw, &arr) == nil { return arr }
var s T
if json.Unmarshal(raw, &s) == nil { return []T{s} }
return nil
}
func normalizeColor(hex string) (string, string) {
h := strings.ToUpper(strings.TrimPrefix(hex, "#"))
if c, ok := colorMap[h]; ok { return c[0], c[1] }
return "#" + h, "#000000"
}
func extractCDATA(raw json.RawMessage) string {
var obj map[string]string
if json.Unmarshal(raw, &obj) == nil {
if v, ok := obj["#cdata-section"]; ok { return v }
}
var s string
if json.Unmarshal(raw, &s) == nil { return s }
return string(raw)
}
func normalizeSeverity(t string) string {
switch strings.ToLower(t) {
case "delay":     return "warning"
case "emergency": return "severe"
default:          return "info"
}
}

// Handlers

func handleHealth(w http.ResponseWriter, r *http.Request) {
s := map[string]string{"status": "healthy", "service": "api-bart"}
if redisClient != nil {
ctx, cancel := context.WithTimeout(r.Context(), time.Second)
defer cancel()
if redisClient.Ping(ctx).Err() != nil { s["redis"] = "disconnected" } else { s["redis"] = "connected" }
} else { s["redis"] = "not configured" }
writeJSON(w, http.StatusOK, s)
}

func handleRoutes(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
const ck = "bart:routes"
if serveCached(w, ctx, ck) { return }
type inner struct{ Route []bartRoute `json:"route"` }
d, err := bartFetch[struct{ Routes inner `json:"routes"` }](ctx, "route.aspx", url.Values{"cmd": {"routes"}})
if err != nil { writeError(w, http.StatusBadGateway, "Failed to fetch routes: "+err.Error()); return }
routes := make([]Route, 0, len(d.Routes.Route))
for _, br := range d.Routes.Route {
c, tc := normalizeColor(br.HexColor)
routes = append(routes, Route{ID: br.Number, Name: br.Name, Color: c, TextColor: tc, Type: "heavy-rail"})
}
writeAndCache(w, ctx, ck, routes, time.Hour)
}

func handlePredictions(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
stopID := strings.ToUpper(r.URL.Query().Get("stop"))
if stopID == "" { writeError(w, http.StatusBadRequest, "Missing required parameter: stop"); return }
ck := "bart:predictions:" + stopID
if serveCached(w, ctx, ck) { return }
d, err := bartFetch[struct{ Station json.RawMessage `json:"station"` }](ctx, "etd.aspx", url.Values{"cmd": {"etd"}, "orig": {stopID}})
if err != nil { writeError(w, http.StatusBadGateway, "Failed to fetch predictions: "+err.Error()); return }
var preds []Prediction
now := time.Now()
for _, stn := range unmarshalFlexible[bartETDStation](d.Station) {
for _, etd := range unmarshalFlexible[bartETD](stn.ETD) {
for _, est := range etd.Estimate {
p := Prediction{StopID: stn.Abbr, StopName: stn.Name, Direction: etd.Destination, RouteName: etd.Destination, RouteID: strings.ToLower(est.Color)}
if est.Minutes == "Leaving" {
m := 0; p.MinutesAway, p.Status = &m, "Departing"
t := now.Format(time.RFC3339); p.ArrivalTime = &t
} else if m, e := strconv.Atoi(est.Minutes); e == nil {
p.MinutesAway, p.Status = &m, "On Time"
t := now.Add(time.Duration(m) * time.Minute).Format(time.RFC3339); p.ArrivalTime = &t
} else { p.Status = est.Minutes }
preds = append(preds, p)
}
}
}
writeAndCache(w, ctx, ck, preds, 30*time.Second)
}

func handleAlerts(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
const ck = "bart:alerts"
if serveCached(w, ctx, ck) { return }
d, err := bartFetch[struct{ BSA json.RawMessage `json:"bsa"` }](ctx, "bsa.aspx", url.Values{"cmd": {"bsa"}})
if err != nil { writeError(w, http.StatusBadGateway, "Failed to fetch alerts: "+err.Error()); return }
bsas := unmarshalFlexible[bartBSA](d.BSA)
alerts := make([]ServiceAlert, 0, len(bsas))
for _, b := range bsas {
desc := extractCDATA(b.Description)
a := ServiceAlert{ID: b.ID, Severity: normalizeSeverity(b.Type), Header: desc, Description: desc, AffectedRoutes: []string{}, UpdatedAt: b.Posted}
a.ActivePeriod.Start = b.Posted
if b.Expires != "" { a.ActivePeriod.End = &b.Expires }
if b.Station != "" && b.Station != "BART" { a.AffectedRoutes = []string{b.Station} }
alerts = append(alerts, a)
}
writeAndCache(w, ctx, ck, alerts, 2*time.Minute)
}

func handleStops(w http.ResponseWriter, r *http.Request) {
ctx := r.Context()
rid := r.URL.Query().Get("route")
if rid == "" { writeError(w, http.StatusBadRequest, "Missing required parameter: route"); return }
ck := "bart:stops:" + rid
if serveCached(w, ctx, ck) { return }
type ri struct{ Route json.RawMessage `json:"route"` }
rd, err := bartFetch[struct{ Routes ri `json:"routes"` }](ctx, "route.aspx", url.Values{"cmd": {"routeinfo"}, "route": {rid}})
if err != nil { writeError(w, http.StatusBadGateway, "Failed to fetch route info: "+err.Error()); return }
ris := unmarshalFlexible[bartRouteInfo](rd.Routes.Route)
if len(ris) == 0 { writeError(w, http.StatusInternalServerError, "Failed to parse route details"); return }
abbrs := unmarshalFlexible[string](ris[0].Config.Station)
type si struct{ Station []bartStation `json:"station"` }
sd, err := bartFetch[struct{ Stations si `json:"stations"` }](ctx, "stn.aspx", url.Values{"cmd": {"stns"}})
if err != nil { writeError(w, http.StatusBadGateway, "Failed to fetch stations: "+err.Error()); return }
lk := make(map[string]bartStation, len(sd.Stations.Station))
for _, s := range sd.Stations.Station { lk[s.Abbr] = s }
stops := make([]Stop, 0, len(abbrs))
for _, a := range abbrs {
if s, ok := lk[a]; ok {
lat, _ := strconv.ParseFloat(s.Lat, 64); lng, _ := strconv.ParseFloat(s.Lng, 64)
stops = append(stops, Stop{ID: s.Abbr, Name: s.Name, Latitude: lat, Longitude: lng, RouteIDs: []string{rid}})
}
}
writeAndCache(w, ctx, ck, stops, time.Hour)
}
