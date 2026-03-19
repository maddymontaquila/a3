#!/usr/bin/env dotnet run
#:package Microsoft.Extensions.Http.Resilience@*
#:package Microsoft.Extensions.ServiceDiscovery@*
#:package OpenTelemetry.Exporter.OpenTelemetryProtocol@*
#:package OpenTelemetry.Extensions.Hosting@*
#:package OpenTelemetry.Instrumentation.AspNetCore@*
#:package OpenTelemetry.Instrumentation.Http@*
#:package OpenTelemetry.Instrumentation.Runtime@*
#:package StackExchange.Redis@*

using System.Net.Http.Json;
using System.Text.Json;
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

// Redis (optional)
var redisConn = builder.Configuration.GetConnectionString("cache");
if (!string.IsNullOrEmpty(redisConn))
    builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    {
        var opts = ConfigurationOptions.Parse(redisConn);
        opts.AbortOnConnectFail = false;
        return ConnectionMultiplexer.Connect(opts);
    });

builder.Services.AddHttpClient("subwayinfo", c => { c.BaseAddress = new Uri("https://subwayinfo.nyc"); c.Timeout = TimeSpan.FromSeconds(15); });

var app = builder.Build();
app.UseCors();
if (app.Environment.IsDevelopment()) { app.MapHealthChecks("/healthz"); app.MapHealthChecks("/alive", new() { Predicate = r => r.Tags.Contains("live") }); }

var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

// Cache helpers — degrade gracefully when Redis is unavailable
var redis = app.Services.GetService<IConnectionMultiplexer>();
var cacheGet = async (string key) => { try { if (redis is null) return (string?)null; var v = await redis.GetDatabase().StringGetAsync(key); return v.HasValue ? (string?)v! : null; } catch { return null; } };
var cacheSet = async (string key, object val, TimeSpan ttl) => { try { if (redis is not null) await redis.GetDatabase().StringSetAsync(key, JsonSerializer.Serialize(val, json), ttl); } catch { } };

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

app.MapGet("/health", () => Results.Json(new { status = "healthy", service = "api-nyc" }, json));

app.MapGet("/routes", async () =>
{
    const string key = "nyc:routes";
    var cached = await cacheGet(key);
    if (cached is not null) return Results.Text(cached, "application/json");
    var data = routes.Select(r => new { id = r.id, name = r.name, color = r.color, textColor = r.textColor, type = "subway" }).ToArray();
    await cacheSet(key, data, TimeSpan.FromSeconds(3600));
    return Results.Json(data, json);
});

app.MapGet("/predictions", async (string stop, IHttpClientFactory hf, ILogger<Program> log) =>
{
    var key = $"nyc:pred:{stop}";
    var cached = await cacheGet(key);
    if (cached is not null) return Results.Text(cached, "application/json");
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var resp = await client.GetFromJsonAsync<JsonElement>($"/api/arrivals?station_id={Uri.EscapeDataString(stop)}&limit=20");
        var sid = resp.GetProperty("stationId").GetString() ?? stop;
        var sname = resp.GetProperty("stationName").GetString() ?? "";
        var preds = resp.GetProperty("arrivals").EnumerateArray().Select(a =>
        {
            var line = a.GetProperty("line").GetString() ?? "";
            var mins = a.GetProperty("minutesAway").GetDouble();
            return new {
                routeId = line, routeName = routeLookup.GetValueOrDefault(line, line),
                stopId = sid, stopName = sname,
                direction = a.GetProperty("headsign").GetString() ?? "",
                arrivalTime = a.GetProperty("arrivalTime").GetString() ?? "",
                minutesAway = mins, status = mins <= 1 ? "approaching" : "on-time",
            };
        }).ToArray();
        await cacheSet(key, preds, TimeSpan.FromSeconds(30));
        return Results.Json(preds, json);
    }
    catch (Exception ex) { log.LogWarning(ex, "predictions failed for {Stop}", stop); return Results.Json(Array.Empty<object>(), json); }
});

app.MapGet("/alerts", async (IHttpClientFactory hf, ILogger<Program> log) =>
{
    const string key = "nyc:alerts";
    var cached = await cacheGet(key);
    if (cached is not null) return Results.Text(cached, "application/json");
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var items = await client.GetFromJsonAsync<JsonElement>("/api/alerts");
        var alerts = items.EnumerateArray().Select(a => new {
            id = a.GetProperty("id").GetString() ?? "",
            severity = (a.GetProperty("severity").GetString() ?? "info").ToLowerInvariant(),
            header = a.GetProperty("headerText").GetString() ?? "",
            description = a.TryGetProperty("descriptionText", out var dt) ? dt.GetString() : null,
            affectedRoutes = a.GetProperty("affectedLines").EnumerateArray().Select(x => x.GetString() ?? "").ToArray(),
            activePeriod = a.GetProperty("activePeriods").EnumerateArray().Select(p => new {
                start = p.TryGetProperty("start", out var ps) ? ps.GetString() : null,
                end = p.TryGetProperty("end", out var pe) ? pe.GetString() : null,
            }).FirstOrDefault(),
            updatedAt = DateTimeOffset.UtcNow.ToString("o"),
        }).ToArray();
        await cacheSet(key, alerts, TimeSpan.FromSeconds(120));
        return Results.Json(alerts, json);
    }
    catch (Exception ex) { log.LogWarning(ex, "alerts fetch failed"); return Results.Json(Array.Empty<object>(), json); }
});

app.MapGet("/stops", async (string? route, IHttpClientFactory hf, ILogger<Program> log) =>
{
    var key = $"nyc:stops:{route ?? "all"}";
    var cached = await cacheGet(key);
    if (cached is not null) return Results.Text(cached, "application/json");
    try
    {
        var client = hf.CreateClient("subwayinfo");
        var url = string.IsNullOrWhiteSpace(route) ? "/api/stations" : $"/api/stations?line={Uri.EscapeDataString(route)}";
        var items = await client.GetFromJsonAsync<JsonElement>(url);
        var stops = items.EnumerateArray().Select(s => new {
            id = s.GetProperty("id").GetString() ?? "",
            name = s.GetProperty("name").GetString() ?? "",
            latitude = s.GetProperty("lat").GetDouble(),
            longitude = s.GetProperty("lon").GetDouble(),
            routeIds = s.GetProperty("lines").EnumerateArray().Select(x => x.GetString() ?? "").ToArray(),
        }).ToArray();
        await cacheSet(key, stops, TimeSpan.FromSeconds(3600));
        return Results.Json(stops, json);
    }
    catch (Exception ex) { log.LogWarning(ex, "stops fetch failed"); return Results.Json(Array.Empty<object>(), json); }
});

app.Run();
