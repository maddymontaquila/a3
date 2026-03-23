#!/usr/bin/env dotnet run
#:property PublishAot=false
#:package Microsoft.Extensions.Http.Resilience@*
#:package Microsoft.Extensions.ServiceDiscovery@*
#:package OpenTelemetry.Exporter.OpenTelemetryProtocol@*
#:package OpenTelemetry.Extensions.Hosting@*
#:package OpenTelemetry.Instrumentation.AspNetCore@*
#:package OpenTelemetry.Instrumentation.Http@*
#:package OpenTelemetry.Instrumentation.Runtime@*
#:package Aspire.StackExchange.Redis@*

using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

// OTel
builder.Logging.AddOpenTelemetry(l => { l.IncludeFormattedMessage = true; l.IncludeScopes = true; });
builder.Services.AddOpenTelemetry()
    .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation().AddRuntimeInstrumentation())
    .WithTracing(t => t.AddSource(builder.Environment.ApplicationName)
        .AddAspNetCoreInstrumentation(o => o.Filter = c => !c.Request.Path.StartsWithSegments("/health") && !c.Request.Path.StartsWithSegments("/alive"))
        .AddHttpClientInstrumentation());
if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
    builder.Services.AddOpenTelemetry().UseOtlpExporter();

builder.Services.AddHealthChecks().AddCheck("self", () => HealthCheckResult.Healthy(), ["live"]);
builder.Services.AddServiceDiscovery();
builder.Services.ConfigureHttpClientDefaults(h => { h.AddStandardResilienceHandler(); h.AddServiceDiscovery(); });
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

// Redis via Aspire integration — handles connection string, health checks, and OTel tracing
if (!string.IsNullOrEmpty(builder.Configuration.GetConnectionString("cache")))
    builder.AddRedisClient("cache");

builder.Services.AddHttpClient("subwayinfo", c => { c.BaseAddress = new Uri("https://subwayinfo.nyc"); c.Timeout = TimeSpan.FromSeconds(15); });

var app = builder.Build();
app.UseCors();
if (app.Environment.IsDevelopment()) { app.MapHealthChecks("/healthz"); app.MapHealthChecks("/alive", new() { Predicate = r => r.Tags.Contains("live") }); }

// Cache helpers — degrade gracefully when Redis is unavailable
var redis = app.Services.GetService<IConnectionMultiplexer>();
async Task<T?> CacheGet<T>(string key, JsonTypeInfo<T> jsonTypeInfo) where T : class {
    try { if (redis is null) return null; var v = await redis.GetDatabase().StringGetAsync(key);
        return v.HasValue ? JsonSerializer.Deserialize((string)v!, jsonTypeInfo) : null; } catch { return null; } }
async Task CacheSet<T>(string key, T val, int seconds, JsonTypeInfo<T> jsonTypeInfo) {
    try { if (redis is not null) await redis.GetDatabase().StringSetAsync(key, JsonSerializer.Serialize(val, jsonTypeInfo), TimeSpan.FromSeconds(seconds)); } catch { } }

// Route data
var routes = new (string id, string name, string color, string textColor)[] {
    ("1","1 · Broadway–7 Av Local","#EE352E","#FFFFFF"), ("2","2 · 7 Av Express","#EE352E","#FFFFFF"),
    ("3","3 · 7 Av Express","#EE352E","#FFFFFF"), ("4","4 · Lexington Av Express","#00933C","#FFFFFF"),
    ("5","5 · Lexington Av Express","#00933C","#FFFFFF"), ("6","6 · Lexington Av Local","#00933C","#FFFFFF"),
    ("7","7 · Flushing Local & Express","#B933AD","#FFFFFF"), ("A","A · 8 Av Express","#0039A6","#FFFFFF"),
    ("C","C · 8 Av Local","#0039A6","#FFFFFF"), ("E","E · 8 Av Local","#0039A6","#FFFFFF"),
    ("B","B · 6 Av Express","#FF6319","#FFFFFF"), ("D","D · 6 Av Express","#FF6319","#FFFFFF"),
    ("F","F · 6 Av Local","#FF6319","#FFFFFF"), ("M","M · 6 Av Local","#FF6319","#FFFFFF"),
    ("G","G · Brooklyn–Queens Crosstown","#6CBE45","#FFFFFF"), ("J","J · Nassau St Express","#996633","#FFFFFF"),
    ("Z","Z · Nassau St Express","#996633","#FFFFFF"), ("L","L · 14 St–Canarsie Local","#A7A9AC","#000000"),
    ("N","N · Broadway Express","#FCCC0A","#000000"), ("Q","Q · Broadway Express","#FCCC0A","#000000"),
    ("R","R · Broadway Local","#FCCC0A","#000000"), ("W","W · Broadway Local","#FCCC0A","#000000"),
    ("S","S · 42 St Shuttle","#808183","#FFFFFF"),
};
var routeLookup = routes.ToDictionary(r => r.id, r => r.name);

// ── Endpoints ──────────────────────────────────────────────────────

app.MapGet("/health", () => Results.Json(new HealthOut("healthy", "api-nyc"), AppJsonContext.Default.HealthOut));

app.MapGet("/routes", () => Results.Json(routes.Select(r =>
    new RouteOut(r.id, r.name, r.color, r.textColor, "subway")).ToArray(), AppJsonContext.Default.RouteOutArray));

app.MapGet("/predictions", async (string stop, IHttpClientFactory hf, ILogger<Program> log) =>
{
    var key = $"nyc:pred:{stop}";
    var cached = await CacheGet(key, AppJsonContext.Default.PredOutArray);
    if (cached is not null) return Results.Json(cached, AppJsonContext.Default.PredOutArray);
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var resp = await client.GetFromJsonAsync($"/api/arrivals?station_id={Uri.EscapeDataString(stop)}&limit=20", AppJsonContext.Default.ArrivalsResponse);
        var preds = (resp?.Arrivals ?? []).Select(a => {
            var routeId = a.Line ?? "";
            return new PredOut(
            routeId, routeLookup.TryGetValue(routeId, out var routeName) ? routeName : a.Line,
            resp?.StationId ?? stop, resp?.StationName ?? "",
            a.Headsign ?? "", a.ArrivalTime ?? "", a.MinutesAway,
            a.MinutesAway <= 1 ? "approaching" : "on-time"
        );
        }).ToArray();
        await CacheSet(key, preds, 30, AppJsonContext.Default.PredOutArray);
        return Results.Json(preds, AppJsonContext.Default.PredOutArray);
    }
    catch (Exception ex) { log.LogWarning(ex, "predictions failed for {Stop}", stop); return Results.Json(Array.Empty<PredOut>(), AppJsonContext.Default.PredOutArray); }
});

app.MapGet("/alerts", async (IHttpClientFactory hf, ILogger<Program> log) =>
{
    const string key = "nyc:alerts";
    var cached = await CacheGet(key, AppJsonContext.Default.AlertOutArray);
    if (cached is not null) return Results.Json(cached, AppJsonContext.Default.AlertOutArray);
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var items = await client.GetFromJsonAsync("/api/alerts", AppJsonContext.Default.SIAlertArray) ?? [];
        var alerts = items.Select(a => new AlertOut(
            a.Id ?? "", (a.Severity ?? "info").ToLowerInvariant(),
            a.HeaderText ?? "", a.DescriptionText,
            a.AffectedLines ?? [], a.ActivePeriods?.FirstOrDefault(),
            DateTimeOffset.UtcNow.ToString("o")
        )).ToArray();
        await CacheSet(key, alerts, 120, AppJsonContext.Default.AlertOutArray);
        return Results.Json(alerts, AppJsonContext.Default.AlertOutArray);
    }
    catch (Exception ex) { log.LogWarning(ex, "alerts fetch failed"); return Results.Json(Array.Empty<AlertOut>(), AppJsonContext.Default.AlertOutArray); }
});

app.MapGet("/stops", async (string? route, IHttpClientFactory hf, ILogger<Program> log) =>
{
    var key = $"nyc:stops:{route ?? "all"}";
    var cached = await CacheGet(key, AppJsonContext.Default.StopOutArray);
    if (cached is not null) return Results.Json(cached, AppJsonContext.Default.StopOutArray);
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var url = string.IsNullOrWhiteSpace(route) ? "/api/stations" : $"/api/stations?line={Uri.EscapeDataString(route)}";
        var items = await client.GetFromJsonAsync(url, AppJsonContext.Default.SIStationArray) ?? [];
        var stops = items.Select(s => new StopOut(s.Id ?? "", s.Name ?? "", s.Lat, s.Lon, s.Lines ?? [])).ToArray();
        await CacheSet(key, stops, 3600, AppJsonContext.Default.StopOutArray);
        return Results.Json(stops, AppJsonContext.Default.StopOutArray);
    }
    catch (Exception ex) { log.LogWarning(ex, "stops fetch failed"); return Results.Json(Array.Empty<StopOut>(), AppJsonContext.Default.StopOutArray); }
});

app.Run();

// ── Output types ───────────────────────────────────────────────────
record HealthOut(string Status, string Service);
record RouteOut(string Id, string Name, string Color, string TextColor, string Type);
record PredOut(string RouteId, string? RouteName, string StopId, string StopName, string Direction, string ArrivalTime, double MinutesAway, string Status);
record AlertOut(string Id, string Severity, string Header, string? Description, string[] AffectedRoutes, SIActivePeriod? ActivePeriod, string UpdatedAt);
record StopOut(string Id, string Name, double Latitude, double Longitude, string[] RouteIds);

// ── SubwayInfo.nyc response types ──────────────────────────────────
record ArrivalsResponse(string? StationId, string? StationName, Arrival[] Arrivals);
record Arrival(string? Line, string? Headsign, string? ArrivalTime, double MinutesAway);
record SIAlert(string? Id, string? HeaderText, string? DescriptionText, string? Severity, string[]? AffectedLines, SIActivePeriod[]? ActivePeriods);
record SIActivePeriod(string? Start, string? End);
record SIStation(string? Id, string? Name, double Lat, double Lon, string[]? Lines);

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(HealthOut))]
[JsonSerializable(typeof(RouteOut[]))]
[JsonSerializable(typeof(PredOut[]))]
[JsonSerializable(typeof(AlertOut[]))]
[JsonSerializable(typeof(StopOut[]))]
[JsonSerializable(typeof(ArrivalsResponse))]
[JsonSerializable(typeof(SIAlert[]))]
[JsonSerializable(typeof(SIStation[]))]
internal partial class AppJsonContext : JsonSerializerContext
{
}
