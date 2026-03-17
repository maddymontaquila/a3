package main

import (
	"context"
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
)

// ---------------------------------------------------------------------------
// Transit contract types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BART API response shapes (json=y mode)
// ---------------------------------------------------------------------------

const (
	bartBaseURL = "https://api.bart.gov/api/"
	bartAPIKey  = "MW9S-E7SL-26DU-VV8V"
)

type bartRoutesResp struct {
	Root struct {
		Routes struct {
			Route []bartRoute `json:"route"`
		} `json:"routes"`
	} `json:"root"`
}

type bartRoute struct {
	Name     string `json:"name"`
	Abbr     string `json:"abbr"`
	RouteID  string `json:"routeID"`
	Number   string `json:"number"`
	HexColor string `json:"hexcolor"`
	Color    string `json:"color"`
}

type bartRouteInfoResp struct {
	Root struct {
		Routes struct {
			Route json.RawMessage `json:"route"`
		} `json:"routes"`
	} `json:"root"`
}

type bartRouteInfo struct {
	Name     string `json:"name"`
	Abbr     string `json:"abbr"`
	RouteID  string `json:"routeID"`
	Number   string `json:"number"`
	HexColor string `json:"hexcolor"`
	Color    string `json:"color"`
	Config   struct {
		Station json.RawMessage `json:"station"`
	} `json:"config"`
}

type bartStationsResp struct {
	Root struct {
		Stations struct {
			Station []bartStation `json:"station"`
		} `json:"stations"`
	} `json:"root"`
}

type bartStation struct {
	Name string `json:"name"`
	Abbr string `json:"abbr"`
	Lat  string `json:"gtfs_latitude"`
	Lng  string `json:"gtfs_longitude"`
}

type bartETDResp struct {
	Root struct {
		Station json.RawMessage `json:"station"`
	} `json:"root"`
}

type bartETDStation struct {
	Name string          `json:"name"`
	Abbr string          `json:"abbr"`
	ETD  json.RawMessage `json:"etd"`
}

type bartETD struct {
	Destination  string         `json:"destination"`
	Abbreviation string         `json:"abbreviation"`
	Estimate     []bartEstimate `json:"estimate"`
}

type bartEstimate struct {
	Minutes   string `json:"minutes"`
	Direction string `json:"direction"`
	Color     string `json:"color"`
	HexColor  string `json:"hexcolor"`
}

type bartBSAResp struct {
	Root struct {
		BSA json.RawMessage `json:"bsa"`
	} `json:"root"`
}

type bartBSA struct {
	ID          string          `json:"id"`
	Station     string          `json:"station"`
	Type        string          `json:"type"`
	Description json.RawMessage `json:"description"`
	Posted      string          `json:"posted"`
	Expires     string          `json:"expires"`
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

var (
	tracer      trace.Tracer
	redisClient *redis.Client
	httpClient  *http.Client
)

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

func main() {
	ctx := context.Background()

	shutdown := initTracer(ctx)
	defer shutdown(ctx)

	initRedis()

	httpClient = &http.Client{
		Transport: otelhttp.NewTransport(http.DefaultTransport),
		Timeout:   10 * time.Second,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/routes", cors(withSpan("GET /routes", handleRoutes)))
	mux.HandleFunc("/predictions", cors(withSpan("GET /predictions", handlePredictions)))
	mux.HandleFunc("/alerts", cors(withSpan("GET /alerts", handleAlerts)))
	mux.HandleFunc("/stops", cors(withSpan("GET /stops", handleStops)))
	mux.HandleFunc("/health", cors(handleHealth))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8082"
	}

	log.Printf("api-bart listening on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}

// ---------------------------------------------------------------------------
// OpenTelemetry
// ---------------------------------------------------------------------------

func initTracer(ctx context.Context) func(context.Context) {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		log.Println("OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled")
		tracer = otel.Tracer("api-bart")
		return func(context.Context) {}
	}

	opts := []otlptracegrpc.Option{}

	// Strip scheme for gRPC dial target and configure TLS accordingly.
	if strings.HasPrefix(endpoint, "http://") {
		endpoint = strings.TrimPrefix(endpoint, "http://")
		opts = append(opts, otlptracegrpc.WithInsecure())
	} else if strings.HasPrefix(endpoint, "https://") {
		endpoint = strings.TrimPrefix(endpoint, "https://")
	} else {
		opts = append(opts, otlptracegrpc.WithInsecure())
	}
	opts = append(opts, otlptracegrpc.WithEndpoint(endpoint))

	exporter, err := otlptracegrpc.New(ctx, opts...)
	if err != nil {
		log.Printf("Failed to create OTLP exporter: %v", err)
		tracer = otel.Tracer("api-bart")
		return func(context.Context) {}
	}

	res, _ := resource.New(ctx,
		resource.WithAttributes(semconv.ServiceName("api-bart")),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	tracer = tp.Tracer("api-bart")

	return func(ctx context.Context) { _ = tp.Shutdown(ctx) }
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

func initRedis() {
	connStr := os.Getenv("ConnectionStrings__cache")
	if connStr == "" {
		log.Println("ConnectionStrings__cache not set, caching disabled")
		return
	}

	// Aspire may provide Redis connection in different formats:
	//   redis://:password@host:port  (URI format)
	//   host:port,password=xxx       (StackExchange.Redis format)
	var opts *redis.Options
	var err error

	if strings.HasPrefix(connStr, "redis://") || strings.HasPrefix(connStr, "rediss://") {
		opts, err = redis.ParseURL(connStr)
	} else {
		// Parse StackExchange.Redis format: host:port,password=xxx,ssl=false,...
		opts = &redis.Options{}
		parts := strings.Split(connStr, ",")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if kv := strings.SplitN(part, "=", 2); len(kv) == 2 {
				switch strings.ToLower(kv[0]) {
				case "password":
					opts.Password = kv[1]
				case "ssl":
					// ignore for now
				}
			} else if part != "" && opts.Addr == "" {
				opts.Addr = part
			}
		}
		if opts.Addr == "" {
			opts.Addr = "localhost:6379"
		}
	}

	if err != nil {
		log.Printf("Failed to parse Redis URL: %v", err)
		return
	}

	redisClient = redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		log.Printf("Redis ping failed (will retry on use): %v", err)
	} else {
		log.Println("Redis connected")
	}
}

func cacheGet(ctx context.Context, key string) (string, bool) {
	if redisClient == nil {
		return "", false
	}
	val, err := redisClient.Get(ctx, key).Result()
	if err != nil {
		return "", false
	}
	return val, true
}

func cacheSet(ctx context.Context, key, value string, ttl time.Duration) {
	if redisClient == nil {
		return
	}
	_ = redisClient.Set(ctx, key, value, ttl).Err()
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

func cors(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

func withSpan(name string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, span := tracer.Start(r.Context(), name,
			trace.WithAttributes(
				attribute.String("http.method", r.Method),
				attribute.String("http.url", r.URL.String()),
			),
		)
		defer span.End()
		next(w, r.WithContext(ctx))
	}
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// ---------------------------------------------------------------------------
// BART API client
// ---------------------------------------------------------------------------

func bartGet(ctx context.Context, endpoint string, params url.Values) ([]byte, error) {
	ctx, span := tracer.Start(ctx, "BART API "+endpoint,
		trace.WithAttributes(attribute.String("bart.endpoint", endpoint)),
	)
	defer span.End()

	params.Set("key", bartAPIKey)
	params.Set("json", "y")
	u := bartBaseURL + endpoint + "?" + params.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("BART API returned status %d", resp.StatusCode)
	}

	return io.ReadAll(resp.Body)
}

// ---------------------------------------------------------------------------
// Color normalisation
// ---------------------------------------------------------------------------

func normalizeColor(hexColor string) (color, textColor string) {
	hex := strings.ToUpper(strings.TrimPrefix(hexColor, "#"))
	switch hex {
	case "FFFF33", "FFD700":
		return "#FFD700", "#000000"
	case "FF9933", "FF8C00":
		return "#FF8C00", "#FFFFFF"
	case "FF0000", "CC0000":
		return "#FF0000", "#FFFFFF"
	case "0099CC", "0000FF":
		return "#0000FF", "#FFFFFF"
	case "339933", "008000":
		return "#008000", "#FFFFFF"
	case "D5CFA3", "DAC49B":
		return "#DAC49B", "#000000"
	default:
		return "#" + hex, "#000000"
	}
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

func handleHealth(w http.ResponseWriter, r *http.Request) {
	status := map[string]string{"status": "healthy", "service": "api-bart"}
	if redisClient != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if err := redisClient.Ping(ctx).Err(); err != nil {
			status["redis"] = "disconnected"
		} else {
			status["redis"] = "connected"
		}
	} else {
		status["redis"] = "not configured"
	}
	writeJSON(w, http.StatusOK, status)
}

func handleRoutes(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const cacheKey = "bart:routes"

	if cached, ok := cacheGet(ctx, cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(cached))
		return
	}

	data, err := bartGet(ctx, "route.aspx", url.Values{"cmd": {"routes"}})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to fetch routes: "+err.Error())
		return
	}

	var resp bartRoutesResp
	if err := json.Unmarshal(data, &resp); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to parse routes: "+err.Error())
		return
	}

	routes := make([]Route, 0, len(resp.Root.Routes.Route))
	for _, br := range resp.Root.Routes.Route {
		color, textColor := normalizeColor(br.HexColor)
		routes = append(routes, Route{
			ID:        br.Number,
			Name:      br.Name,
			Color:     color,
			TextColor: textColor,
			Type:      "heavy-rail",
		})
	}

	result, _ := json.Marshal(routes)
	cacheSet(ctx, cacheKey, string(result), time.Hour)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

func handlePredictions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	stopID := strings.ToUpper(r.URL.Query().Get("stop"))
	if stopID == "" {
		writeError(w, http.StatusBadRequest, "Missing required parameter: stop")
		return
	}

	cacheKey := "bart:predictions:" + stopID
	if cached, ok := cacheGet(ctx, cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(cached))
		return
	}

	data, err := bartGet(ctx, "etd.aspx", url.Values{"cmd": {"etd"}, "orig": {stopID}})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to fetch predictions: "+err.Error())
		return
	}

	var resp bartETDResp
	if err := json.Unmarshal(data, &resp); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to parse predictions: "+err.Error())
		return
	}

	// station may be array or single object; handle both
	var stations []bartETDStation
	if err := json.Unmarshal(resp.Root.Station, &stations); err != nil {
		var single bartETDStation
		if err2 := json.Unmarshal(resp.Root.Station, &single); err2 == nil {
			stations = []bartETDStation{single}
		}
	}

	predictions := make([]Prediction, 0)
	now := time.Now()

	for _, stn := range stations {
		var etds []bartETD
		if err := json.Unmarshal(stn.ETD, &etds); err != nil {
			var single bartETD
			if err2 := json.Unmarshal(stn.ETD, &single); err2 == nil {
				etds = []bartETD{single}
			}
		}

		for _, etd := range etds {
			for _, est := range etd.Estimate {
				p := Prediction{
					StopID:    stn.Abbr,
					StopName:  stn.Name,
					Direction: est.Direction,
					RouteName: etd.Destination,
					RouteID:   strings.ToLower(est.Color),
				}

				switch est.Minutes {
				case "Leaving":
					mins := 0
					p.MinutesAway = &mins
					p.Status = "Departing"
					t := now.Format(time.RFC3339)
					p.ArrivalTime = &t
				default:
					if mins, err := strconv.Atoi(est.Minutes); err == nil {
						p.MinutesAway = &mins
						p.Status = "On Time"
						t := now.Add(time.Duration(mins) * time.Minute).Format(time.RFC3339)
						p.ArrivalTime = &t
					} else {
						p.Status = est.Minutes
					}
				}

				predictions = append(predictions, p)
			}
		}
	}

	result, _ := json.Marshal(predictions)
	cacheSet(ctx, cacheKey, string(result), 30*time.Second)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

func handleAlerts(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const cacheKey = "bart:alerts"

	if cached, ok := cacheGet(ctx, cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(cached))
		return
	}

	data, err := bartGet(ctx, "bsa.aspx", url.Values{"cmd": {"bsa"}})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to fetch alerts: "+err.Error())
		return
	}

	var resp bartBSAResp
	if err := json.Unmarshal(data, &resp); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to parse alerts: "+err.Error())
		return
	}

	// BSA can be array or single object
	var bsas []bartBSA
	if err := json.Unmarshal(resp.Root.BSA, &bsas); err != nil {
		var single bartBSA
		if err2 := json.Unmarshal(resp.Root.BSA, &single); err2 == nil {
			bsas = []bartBSA{single}
		}
	}

	alerts := make([]ServiceAlert, 0, len(bsas))
	for _, b := range bsas {
		desc := extractCDATA(b.Description)
		alert := ServiceAlert{
			ID:             b.ID,
			Severity:       normalizeSeverity(b.Type),
			Header:         desc,
			Description:    desc,
			AffectedRoutes: []string{},
			UpdatedAt:      b.Posted,
		}
		alert.ActivePeriod.Start = b.Posted
		if b.Expires != "" {
			alert.ActivePeriod.End = &b.Expires
		}
		if b.Station != "" && b.Station != "BART" {
			alert.AffectedRoutes = []string{b.Station}
		}
		alerts = append(alerts, alert)
	}

	result, _ := json.Marshal(alerts)
	cacheSet(ctx, cacheKey, string(result), 2*time.Minute)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

func handleStops(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	routeID := r.URL.Query().Get("route")
	if routeID == "" {
		writeError(w, http.StatusBadRequest, "Missing required parameter: route")
		return
	}

	cacheKey := "bart:stops:" + routeID
	if cached, ok := cacheGet(ctx, cacheKey); ok {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(cached))
		return
	}

	// Fetch route config (station list for this route).
	routeData, err := bartGet(ctx, "route.aspx", url.Values{
		"cmd":   {"routeinfo"},
		"route": {routeID},
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to fetch route info: "+err.Error())
		return
	}

	var routeResp bartRouteInfoResp
	if err := json.Unmarshal(routeData, &routeResp); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to parse route info: "+err.Error())
		return
	}

	// route may be a single object or an array
	var ri bartRouteInfo
	if err := json.Unmarshal(routeResp.Root.Routes.Route, &ri); err != nil {
		var ris []bartRouteInfo
		if err2 := json.Unmarshal(routeResp.Root.Routes.Route, &ris); err2 == nil && len(ris) > 0 {
			ri = ris[0]
		} else {
			writeError(w, http.StatusInternalServerError, "Failed to parse route details")
			return
		}
	}

	// station list inside config can be array or single string
	var stationAbbrs []string
	if err := json.Unmarshal(ri.Config.Station, &stationAbbrs); err != nil {
		var single string
		if err2 := json.Unmarshal(ri.Config.Station, &single); err2 == nil {
			stationAbbrs = []string{single}
		}
	}

	// Fetch full station catalogue for lat/lng.
	stnData, err := bartGet(ctx, "stn.aspx", url.Values{"cmd": {"stns"}})
	if err != nil {
		writeError(w, http.StatusBadGateway, "Failed to fetch stations: "+err.Error())
		return
	}

	var stnResp bartStationsResp
	if err := json.Unmarshal(stnData, &stnResp); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to parse stations: "+err.Error())
		return
	}

	lookup := make(map[string]bartStation, len(stnResp.Root.Stations.Station))
	for _, s := range stnResp.Root.Stations.Station {
		lookup[s.Abbr] = s
	}

	stops := make([]Stop, 0, len(stationAbbrs))
	for _, abbr := range stationAbbrs {
		stn, ok := lookup[abbr]
		if !ok {
			continue
		}
		lat, _ := strconv.ParseFloat(stn.Lat, 64)
		lng, _ := strconv.ParseFloat(stn.Lng, 64)
		stops = append(stops, Stop{
			ID:        stn.Abbr,
			Name:      stn.Name,
			Latitude:  lat,
			Longitude: lng,
			RouteIDs:  []string{routeID},
		})
	}

	result, _ := json.Marshal(stops)
	cacheSet(ctx, cacheKey, string(result), time.Hour)
	w.Header().Set("Content-Type", "application/json")
	w.Write(result)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func extractCDATA(raw json.RawMessage) string {
	var obj map[string]string
	if err := json.Unmarshal(raw, &obj); err == nil {
		if v, ok := obj["#cdata-section"]; ok {
			return v
		}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	return string(raw)
}

func normalizeSeverity(bartType string) string {
	switch strings.ToLower(bartType) {
	case "delay":
		return "warning"
	case "emergency":
		return "severe"
	default:
		return "info"
	}
}
