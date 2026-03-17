#!/usr/bin/env dotnet run
#:package Microsoft.Extensions.Http.Resilience@*
#:package Microsoft.Extensions.ServiceDiscovery@*
#:package OpenTelemetry.Exporter.OpenTelemetryProtocol@*
#:package OpenTelemetry.Extensions.Hosting@*
#:package OpenTelemetry.Instrumentation.AspNetCore@*
#:package OpenTelemetry.Instrumentation.Http@*
#:package OpenTelemetry.Instrumentation.Runtime@*
#:package StackExchange.Redis@*

using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.ServiceDiscovery;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;
using StackExchange.Redis;

// ---------------------------------------------------------------------------
// NYC MTA Subway — Transit Data API  (file-based C# minimal API)
// ---------------------------------------------------------------------------

var builder = WebApplication.CreateBuilder(args);
builder.AddServiceDefaults();

// CORS
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

// Redis (optional — gracefully degrades when unavailable)
var redisConn = builder.Configuration.GetConnectionString("cache")
    ?? Environment.GetEnvironmentVariable("ConnectionStrings__cache");

if (!string.IsNullOrEmpty(redisConn))
{
    builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    {
        var opts = ConfigurationOptions.Parse(redisConn);
        opts.AbortOnConnectFail = false;
        opts.ConnectTimeout = 3000;
        return ConnectionMultiplexer.Connect(opts);
    });
}

builder.Services.AddSingleton<CacheService>();
builder.Services.AddHttpClient("mta", c => c.Timeout = TimeSpan.FromSeconds(15));

var app = builder.Build();
app.UseCors();
app.MapDefaultEndpoints();

var jsonOpts = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

// ── Health ─────────────────────────────────────────────────────────
app.MapGet("/health", () => Results.Json(
    new { status = "healthy", service = "api-nyc" }, jsonOpts));

// ── Routes ─────────────────────────────────────────────────────────
app.MapGet("/routes", async (CacheService cache) =>
{
    const string key = "mta:routes:subway";
    var cached = await cache.GetAsync<List<Route>>(key);
    if (cached is not null) return Results.Json(cached, jsonOpts);

    var result = SubwayData.Routes;
    await cache.SetAsync(key, result, TimeSpan.FromSeconds(3600));
    return Results.Json(result, jsonOpts);
});

// ── Predictions ────────────────────────────────────────────────────
app.MapGet("/predictions", async (string stop, CacheService cache) =>
{
    var key = CacheService.Key("predictions", stop);
    var cached = await cache.GetAsync<List<Prediction>>(key);
    if (cached is not null) return Results.Json(cached, jsonOpts);

    // Generate realistic mock predictions for the requested stop
    var result = PredictionGenerator.Generate(stop);
    await cache.SetAsync(key, result, TimeSpan.FromSeconds(30));
    return Results.Json(result, jsonOpts);
});

// ── Alerts ─────────────────────────────────────────────────────────
app.MapGet("/alerts", async (CacheService cache, IHttpClientFactory httpFactory, ILogger<Program> log) =>
{
    const string key = "mta:alerts:subway";
    var cached = await cache.GetAsync<List<Alert>>(key);
    if (cached is not null) return Results.Json(cached, jsonOpts);

    var result = new List<Alert>();
    try
    {
        var client = httpFactory.CreateClient("mta");
        var resp = await client.GetAsync(
            "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json");
        if (resp.IsSuccessStatusCode)
        {
            var json = await resp.Content.ReadAsStringAsync();
            result = AlertParser.Parse(json);
        }
    }
    catch (Exception ex)
    {
        log.LogWarning(ex, "Failed to fetch MTA alerts — returning empty list");
    }

    await cache.SetAsync(key, result, TimeSpan.FromSeconds(120));
    return Results.Json(result, jsonOpts);
});

// ── Stops ──────────────────────────────────────────────────────────
app.MapGet("/stops", async (string route, CacheService cache) =>
{
    var key = CacheService.Key("stops", route);
    var cached = await cache.GetAsync<List<Stop>>(key);
    if (cached is not null) return Results.Json(cached, jsonOpts);

    var result = SubwayData.GetStopsForRoute(route);
    await cache.SetAsync(key, result, TimeSpan.FromSeconds(3600));
    return Results.Json(result, jsonOpts);
});

app.Run();

// ═══════════════════════════════════════════════════════════════════
// Data models
// ═══════════════════════════════════════════════════════════════════

record Route(string Id, string Name, string Color, string TextColor, string Type);
record Prediction(string RouteId, string RouteName, string StopId, string StopName,
    int Direction, string ArrivalTime, double MinutesAway, string Status);
record Alert(string Id, string Severity, string Header, string? Description,
    List<string> AffectedRoutes, ActivePeriod ActivePeriod, string UpdatedAt);
record ActivePeriod(string? Start, string? End);
record Stop(string Id, string Name, double Latitude, double Longitude, List<string> RouteIds);

// ═══════════════════════════════════════════════════════════════════
// Redis cache service (graceful fallback when Redis is unavailable)
// ═══════════════════════════════════════════════════════════════════

class CacheService
{
    private readonly IConnectionMultiplexer? _redis;
    private readonly ILogger<CacheService> _log;

    public CacheService(IServiceProvider sp, ILogger<CacheService> log)
    {
        _redis = sp.GetService<IConnectionMultiplexer>();
        _log = log;
    }

    public static string Key(string prefix, params string[] parts)
    {
        var raw = string.Join("|", parts);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..12];
        return $"mta:{prefix}:{hash}";
    }

    public async Task<T?> GetAsync<T>(string key) where T : class
    {
        try
        {
            if (_redis is null) return null;
            var db = _redis.GetDatabase();
            var val = await db.StringGetAsync(key);
            return val.HasValue
                ? JsonSerializer.Deserialize<T>((string)val!, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                : null;
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Cache read miss for {Key}", key);
            return null;
        }
    }

    public async Task SetAsync<T>(string key, T value, TimeSpan ttl)
    {
        try
        {
            if (_redis is null) return;
            var db = _redis.GetDatabase();
            var json = JsonSerializer.Serialize(value, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase
            });
            await db.StringSetAsync(key, json, ttl);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Cache write failed for {Key}", key);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// NYC Subway static data
// ═══════════════════════════════════════════════════════════════════

static class SubwayData
{
    public static readonly List<Route> Routes = new()
    {
        new("1", "1 · Broadway – 7 Avenue Local",         "#EE352E", "#FFFFFF", "subway"),
        new("2", "2 · 7 Avenue Express",                  "#EE352E", "#FFFFFF", "subway"),
        new("3", "3 · 7 Avenue Express",                  "#EE352E", "#FFFFFF", "subway"),
        new("4", "4 · Lexington Avenue Express",          "#00933C", "#FFFFFF", "subway"),
        new("5", "5 · Lexington Avenue Express",          "#00933C", "#FFFFFF", "subway"),
        new("6", "6 · Lexington Avenue Local",            "#00933C", "#FFFFFF", "subway"),
        new("7", "7 · Flushing Local & Express",          "#B933AD", "#FFFFFF", "subway"),
        new("A", "A · 8 Avenue Express",                  "#0039A6", "#FFFFFF", "subway"),
        new("C", "C · 8 Avenue Local",                    "#0039A6", "#FFFFFF", "subway"),
        new("E", "E · 8 Avenue Local",                    "#0039A6", "#FFFFFF", "subway"),
        new("B", "B · 6 Avenue Express",                  "#FF6319", "#FFFFFF", "subway"),
        new("D", "D · 6 Avenue Express",                  "#FF6319", "#FFFFFF", "subway"),
        new("F", "F · 6 Avenue Local",                    "#FF6319", "#FFFFFF", "subway"),
        new("M", "M · 6 Avenue Local",                    "#FF6319", "#FFFFFF", "subway"),
        new("G", "G · Brooklyn–Queens Crosstown",         "#6CBE45", "#FFFFFF", "subway"),
        new("J", "J · Nassau Street Express",             "#996633", "#FFFFFF", "subway"),
        new("Z", "Z · Nassau Street Express",             "#996633", "#FFFFFF", "subway"),
        new("L", "L · 14 Street–Canarsie Local",          "#A7A9AC", "#000000", "subway"),
        new("N", "N · Broadway Express",                  "#FCCC0A", "#000000", "subway"),
        new("Q", "Q · Broadway Express",                  "#FCCC0A", "#000000", "subway"),
        new("R", "R · Broadway Local",                    "#FCCC0A", "#000000", "subway"),
        new("W", "W · Broadway Local",                    "#FCCC0A", "#000000", "subway"),
        new("S", "S · 42 Street Shuttle",                 "#808183", "#FFFFFF", "subway"),
    };

    // Major stations with real coordinates & route associations
    private static readonly List<Stop> AllStops = new()
    {
        // 1/2/3 (Red) — Broadway–7th Ave
        new("101",  "Van Cortlandt Park – 242 St",   40.8892, -73.8987, new() { "1" }),
        new("103",  "238 St",                         40.8847, -73.9009, new() { "1" }),
        new("120",  "96 St",                          40.7937, -73.9722, new() { "1", "2", "3" }),
        new("123",  "72 St",                          40.7785, -73.9819, new() { "1", "2", "3" }),
        new("127",  "Times Sq – 42 St",               40.7557, -73.9870, new() { "1", "2", "3", "7", "N", "Q", "R", "W", "S" }),
        new("130",  "34 St – Penn Station",            40.7505, -73.9910, new() { "1", "2", "3", "A", "C", "E" }),
        new("132",  "14 St",                          40.7378, -73.9990, new() { "1", "2", "3" }),
        new("137",  "Chambers St",                    40.7152, -74.0095, new() { "1", "2", "3" }),
        new("139",  "Fulton St",                      40.7102, -74.0071, new() { "2", "3", "4", "5", "A", "C", "J", "Z" }),

        // 4/5/6 (Green) — Lexington Ave
        new("401",  "Woodlawn",                       40.8860, -73.8787, new() { "4" }),
        new("416",  "125 St",                         40.8041, -73.9376, new() { "4", "5", "6" }),
        new("621",  "Grand Central – 42 St",          40.7527, -73.9772, new() { "4", "5", "6", "7", "S" }),
        new("625",  "Union Sq – 14 St",               40.7355, -73.9903, new() { "4", "5", "6", "L", "N", "Q", "R", "W" }),
        new("629",  "Brooklyn Bridge – City Hall",    40.7131, -74.0040, new() { "4", "5", "6", "J", "Z" }),
        new("631",  "Fulton St",                      40.7102, -74.0071, new() { "4", "5", "A", "C", "J", "Z" }),
        new("635",  "Borough Hall",                   40.6921, -73.9900, new() { "4", "5" }),
        new("640",  "Atlantic Av – Barclays Ctr",     40.6844, -73.9784, new() { "2", "3", "4", "5", "B", "D", "N", "Q", "R" }),

        // 7 (Purple) — Flushing
        new("701",  "Flushing – Main St",             40.7596, -73.8301, new() { "7" }),
        new("705",  "Junction Blvd",                  40.7494, -73.8696, new() { "7" }),
        new("710",  "74 St – Broadway",               40.7468, -73.8916, new() { "7" }),
        new("718",  "Queensboro Plaza",               40.7509, -73.9402, new() { "7", "N", "W" }),
        new("719",  "Court Sq",                       40.7471, -73.9460, new() { "7", "E", "G", "M" }),
        new("721",  "Grand Central – 42 St",          40.7527, -73.9772, new() { "7", "S" }),
        new("723",  "Times Sq – 42 St",               40.7557, -73.9870, new() { "7", "1", "2", "3", "N", "Q", "R", "W", "S" }),
        new("726",  "34 St – Hudson Yards",           40.7554, -74.0024, new() { "7" }),

        // A/C/E (Blue) — 8th Ave
        new("A02",  "Inwood – 207 St",                40.8681, -73.9199, new() { "A" }),
        new("A15",  "125 St",                         40.8109, -73.9583, new() { "A", "B", "C", "D" }),
        new("A24",  "59 St – Columbus Circle",        40.7681, -73.9819, new() { "A", "B", "C", "D", "1" }),
        new("A27",  "42 St – Port Authority",         40.7572, -73.9900, new() { "A", "C", "E" }),
        new("A28",  "34 St – Penn Station",           40.7505, -73.9910, new() { "A", "C", "E", "1", "2", "3" }),
        new("A31",  "14 St",                          40.7382, -74.0003, new() { "A", "C", "E", "L" }),
        new("A32",  "W 4 St – Washington Sq",         40.7323, -74.0005, new() { "A", "C", "E", "B", "D", "F", "M" }),
        new("A36",  "Fulton St",                      40.7102, -74.0071, new() { "A", "C", "2", "3", "4", "5", "J", "Z" }),
        new("A41",  "Jay St – MetroTech",             40.6923, -73.9872, new() { "A", "C", "F", "R" }),
        new("A65",  "Howard Beach – JFK Airport",     40.6609, -73.8303, new() { "A" }),

        // B/D/F/M (Orange) — 6th Ave
        new("D01",  "Norwood – 205 St",               40.8749, -73.8789, new() { "D" }),
        new("D13",  "145 St",                         40.8247, -73.9443, new() { "B", "D" }),
        new("D14",  "125 St",                         40.8109, -73.9583, new() { "B", "D" }),
        new("D17",  "7 Av",                           40.7625, -73.9817, new() { "B", "D", "E" }),
        new("D20",  "47-50 Sts – Rockefeller Ctr",    40.7587, -73.9812, new() { "B", "D", "F", "M" }),
        new("D21",  "42 St – Bryant Park",            40.7542, -73.9844, new() { "B", "D", "F", "M", "7" }),
        new("D22",  "34 St – Herald Sq",              40.7498, -73.9877, new() { "B", "D", "F", "M", "N", "Q", "R", "W" }),
        new("D25",  "W 4 St – Washington Sq",         40.7323, -74.0005, new() { "B", "D", "F", "M", "A", "C", "E" }),
        new("F15",  "Delancey St – Essex St",         40.7187, -73.9882, new() { "F", "M", "J", "Z" }),

        // G (Light Green) — Brooklyn–Queens Crosstown
        new("G14",  "Court Sq",                       40.7471, -73.9460, new() { "G", "7", "E", "M" }),
        new("G22",  "Metropolitan Av",                40.7128, -73.9513, new() { "G", "L" }),
        new("G24",  "Bedford – Nostrand Avs",         40.6896, -73.9535, new() { "G" }),
        new("G26",  "Hoyt – Schermerhorn Sts",        40.6884, -73.9851, new() { "G", "A", "C" }),
        new("G28",  "Bergen St",                      40.6861, -73.9759, new() { "G", "F" }),
        new("G29",  "Carroll St",                     40.6803, -73.9750, new() { "G", "F" }),
        new("G35",  "Church Av",                      40.6601, -73.9797, new() { "G", "F" }),

        // J/Z (Brown) — Nassau St
        new("J12",  "Jamaica Center – Parsons/Archer", 40.7023, -73.8010, new() { "J", "Z" }),
        new("J17",  "Woodhaven Blvd",                 40.6934, -73.8523, new() { "J", "Z" }),
        new("J27",  "Marcy Av",                       40.7083, -73.9580, new() { "J", "M", "Z" }),
        new("J29",  "Essex St",                       40.7182, -73.9874, new() { "J", "M", "Z" }),
        new("J30",  "Chambers St",                    40.7130, -74.0036, new() { "J", "Z" }),
        new("J31",  "Fulton St",                      40.7102, -74.0071, new() { "J", "Z", "2", "3", "4", "5", "A", "C" }),
        new("J32",  "Broad St",                       40.7065, -74.0110, new() { "J", "Z" }),

        // L (Gray) — 14th St–Canarsie
        new("L01",  "8 Av",                           40.7399, -74.0026, new() { "L", "A", "C", "E" }),
        new("L02",  "6 Av",                           40.7378, -73.9969, new() { "L", "F", "M" }),
        new("L03",  "Union Sq – 14 St",               40.7355, -73.9903, new() { "L", "4", "5", "6", "N", "Q", "R", "W" }),
        new("L06",  "3 Av",                           40.7327, -73.9860, new() { "L" }),
        new("L08",  "1 Av",                           40.7307, -73.9815, new() { "L" }),
        new("L10",  "Bedford Av",                     40.7178, -73.9567, new() { "L" }),
        new("L17",  "Myrtle – Wyckoff Avs",           40.6994, -73.9122, new() { "L", "M" }),
        new("L29",  "Canarsie – Rockaway Pkwy",       40.6462, -73.9016, new() { "L" }),

        // N/Q/R/W (Yellow) — Broadway
        new("N01",  "Astoria – Ditmars Blvd",         40.7754, -73.9120, new() { "N", "W" }),
        new("N08",  "Queensboro Plaza",               40.7509, -73.9402, new() { "N", "W", "7" }),
        new("N10",  "Lexington Av / 59 St",           40.7629, -73.9679, new() { "N", "R", "W", "4", "5", "6" }),
        new("N12",  "5 Av / 59 St",                   40.7644, -73.9735, new() { "N", "R", "W" }),
        new("R15",  "49 St",                          40.7600, -73.9842, new() { "N", "R", "W" }),
        new("R16",  "Times Sq – 42 St",               40.7557, -73.9870, new() { "N", "Q", "R", "W", "1", "2", "3", "7", "S" }),
        new("R17",  "34 St – Herald Sq",              40.7498, -73.9877, new() { "N", "Q", "R", "W", "B", "D", "F", "M" }),
        new("R20",  "Union Sq – 14 St",               40.7355, -73.9903, new() { "N", "Q", "R", "W", "4", "5", "6", "L" }),
        new("R23",  "Canal St",                       40.7201, -74.0013, new() { "N", "Q", "R", "W", "J", "Z", "6" }),
        new("Q15",  "DeKalb Av",                      40.6907, -73.9818, new() { "Q", "B", "R" }),
        new("Q17",  "Coney Island – Stillwell Av",    40.5773, -73.9814, new() { "N", "Q", "D", "F" }),

        // S (Shuttle)
        new("S01",  "Grand Central – 42 St",          40.7527, -73.9772, new() { "S", "4", "5", "6", "7" }),
        new("S03",  "Times Sq – 42 St",               40.7557, -73.9870, new() { "S", "1", "2", "3", "7", "N", "Q", "R", "W" }),
    };

    public static List<Stop> GetStopsForRoute(string routeId)
    {
        var id = routeId.ToUpperInvariant();
        return AllStops
            .Where(s => s.RouteIds.Contains(id))
            .ToList();
    }
}

// ═══════════════════════════════════════════════════════════════════
// Prediction generator (realistic mock — real-time needs GTFS-RT)
// ═══════════════════════════════════════════════════════════════════

static class PredictionGenerator
{
    private static readonly string[] Statuses = { "On Time", "Delayed", "Approaching" };

    public static List<Prediction> Generate(string stopId)
    {
        var stop = SubwayData.GetStopsForRoute("1") // search all stops
            .Concat(SubwayData.GetStopsForRoute("4"))
            .Concat(SubwayData.GetStopsForRoute("7"))
            .Concat(SubwayData.GetStopsForRoute("A"))
            .Concat(SubwayData.GetStopsForRoute("B"))
            .Concat(SubwayData.GetStopsForRoute("G"))
            .Concat(SubwayData.GetStopsForRoute("J"))
            .Concat(SubwayData.GetStopsForRoute("L"))
            .Concat(SubwayData.GetStopsForRoute("N"))
            .Concat(SubwayData.GetStopsForRoute("S"))
            .DistinctBy(s => s.Id)
            .FirstOrDefault(s => s.Id.Equals(stopId, StringComparison.OrdinalIgnoreCase));

        if (stop is null)
            return new List<Prediction>();

        var now = DateTimeOffset.UtcNow;
        var rng = new Random(now.Minute * 60 + now.Second / 10); // semi-stable within 10s windows
        var predictions = new List<Prediction>();

        foreach (var routeId in stop.RouteIds)
        {
            var route = SubwayData.Routes.FirstOrDefault(r => r.Id == routeId);
            if (route is null) continue;

            for (var dir = 0; dir <= 1; dir++)
            {
                var minutesAway = rng.Next(1, 15);
                var arrivalTime = now.AddMinutes(minutesAway);
                var status = minutesAway <= 1 ? "Approaching"
                    : rng.NextDouble() < 0.15 ? "Delayed" : "On Time";

                predictions.Add(new Prediction(
                    RouteId: route.Id,
                    RouteName: route.Name,
                    StopId: stop.Id,
                    StopName: stop.Name,
                    Direction: dir,
                    ArrivalTime: arrivalTime.ToString("o"),
                    MinutesAway: minutesAway,
                    Status: status));
            }
        }

        return predictions.OrderBy(p => p.MinutesAway).ToList();
    }
}

// ═══════════════════════════════════════════════════════════════════
// MTA alert parser (JSON feed)
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// Aspire ServiceDefaults (inlined — normally a project reference)
// ═══════════════════════════════════════════════════════════════════

static class ServiceDefaultsExtensions
{
    public static WebApplicationBuilder AddServiceDefaults(this WebApplicationBuilder builder)
    {
        // OpenTelemetry
        builder.Logging.AddOpenTelemetry(logging =>
        {
            logging.IncludeFormattedMessage = true;
            logging.IncludeScopes = true;
        });

        builder.Services.AddOpenTelemetry()
            .WithMetrics(metrics =>
            {
                metrics.AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation();
            })
            .WithTracing(tracing =>
            {
                tracing.AddSource(builder.Environment.ApplicationName)
                    .AddAspNetCoreInstrumentation(o =>
                        o.Filter = ctx =>
                            !ctx.Request.Path.StartsWithSegments("/health")
                            && !ctx.Request.Path.StartsWithSegments("/alive"))
                    .AddHttpClientInstrumentation();
            });

        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
            builder.Services.AddOpenTelemetry().UseOtlpExporter();

        // Health checks
        builder.Services.AddHealthChecks()
            .AddCheck("self", () => HealthCheckResult.Healthy(), ["live"]);

        // Service discovery + resilience
        builder.Services.AddServiceDiscovery();
        builder.Services.ConfigureHttpClientDefaults(http =>
        {
            http.AddStandardResilienceHandler();
            http.AddServiceDiscovery();
        });

        return builder;
    }

    public static WebApplication MapDefaultEndpoints(this WebApplication app)
    {
        if (app.Environment.IsDevelopment())
        {
            app.MapHealthChecks("/healthz");
            app.MapHealthChecks("/alive", new HealthCheckOptions
            {
                Predicate = r => r.Tags.Contains("live")
            });
        }
        return app;
    }
}

// ═══════════════════════════════════════════════════════════════════
// MTA alert parser (JSON feed)
// ═══════════════════════════════════════════════════════════════════

static class AlertParser
{
    public static List<Alert> Parse(string json)
    {
        var alerts = new List<Alert>();
        try
        {
            using var doc = JsonDocument.Parse(json);

            // The MTA GTFS-RT JSON feed has entity[] at the root
            if (!doc.RootElement.TryGetProperty("entity", out var entities))
                return alerts;

            foreach (var entity in entities.EnumerateArray())
            {
                if (!entity.TryGetProperty("alert", out var alertEl))
                    continue;

                var id = entity.TryGetProperty("id", out var idEl)
                    ? idEl.GetString() ?? "" : "";

                var header = "";
                if (alertEl.TryGetProperty("header_text", out var ht)
                    && ht.TryGetProperty("translation", out var htArr))
                {
                    foreach (var t in htArr.EnumerateArray())
                    {
                        if (t.TryGetProperty("language", out var lang) && lang.GetString() == "en")
                        {
                            header = t.TryGetProperty("text", out var txt) ? txt.GetString() ?? "" : "";
                            break;
                        }
                    }
                    if (string.IsNullOrEmpty(header) && htArr.GetArrayLength() > 0)
                    {
                        var first = htArr[0];
                        header = first.TryGetProperty("text", out var txt) ? txt.GetString() ?? "" : "";
                    }
                }

                var description = "";
                if (alertEl.TryGetProperty("description_text", out var dt)
                    && dt.TryGetProperty("translation", out var dtArr))
                {
                    foreach (var t in dtArr.EnumerateArray())
                    {
                        if (t.TryGetProperty("language", out var lang) && lang.GetString() == "en")
                        {
                            description = t.TryGetProperty("text", out var txt) ? txt.GetString() ?? "" : "";
                            break;
                        }
                    }
                    if (string.IsNullOrEmpty(description) && dtArr.GetArrayLength() > 0)
                    {
                        var first = dtArr[0];
                        description = first.TryGetProperty("text", out var txt) ? txt.GetString() ?? "" : "";
                    }
                }

                var severity = "INFO";
                if (alertEl.TryGetProperty("severity_level", out var sev))
                    severity = sev.GetString() ?? "INFO";

                var affectedRoutes = new List<string>();
                if (alertEl.TryGetProperty("informed_entity", out var informed))
                {
                    foreach (var ie in informed.EnumerateArray())
                    {
                        if (ie.TryGetProperty("route_id", out var rid))
                        {
                            var routeId = rid.GetString();
                            if (!string.IsNullOrEmpty(routeId) && !affectedRoutes.Contains(routeId))
                                affectedRoutes.Add(routeId);
                        }
                    }
                }

                string? periodStart = null, periodEnd = null;
                if (alertEl.TryGetProperty("active_period", out var periods)
                    && periods.GetArrayLength() > 0)
                {
                    var p = periods[0];
                    if (p.TryGetProperty("start", out var s))
                    {
                        if (s.ValueKind == JsonValueKind.Number)
                            periodStart = DateTimeOffset.FromUnixTimeSeconds(s.GetInt64()).ToString("o");
                        else
                            periodStart = s.GetString();
                    }
                    if (p.TryGetProperty("end", out var e))
                    {
                        if (e.ValueKind == JsonValueKind.Number)
                            periodEnd = DateTimeOffset.FromUnixTimeSeconds(e.GetInt64()).ToString("o");
                        else
                            periodEnd = e.GetString();
                    }
                }

                var updatedAt = DateTimeOffset.UtcNow.ToString("o");
                if (alertEl.TryGetProperty("transit_realtime.mercury_alert", out var mercury)
                    && mercury.TryGetProperty("updated_at", out var upd))
                {
                    if (upd.ValueKind == JsonValueKind.Number)
                        updatedAt = DateTimeOffset.FromUnixTimeSeconds(upd.GetInt64()).ToString("o");
                    else
                        updatedAt = upd.GetString() ?? updatedAt;
                }

                alerts.Add(new Alert(
                    Id: id,
                    Severity: severity,
                    Header: header,
                    Description: string.IsNullOrEmpty(description) ? null : description,
                    AffectedRoutes: affectedRoutes,
                    ActivePeriod: new ActivePeriod(periodStart, periodEnd),
                    UpdatedAt: updatedAt));
            }
        }
        catch
        {
            // Return whatever we've parsed so far
        }

        return alerts;
    }
}
