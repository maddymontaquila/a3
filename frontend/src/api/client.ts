import type { TransitRoute, Prediction, ServiceAlert, Stop, RouteAdvice } from '../types/transit';

type CityId = 'boston' | 'nyc' | 'bart';

// API URLs injected by Vite define from Aspire service discovery
declare const __API_BOSTON__: string;
declare const __API_NYC__: string;
declare const __API_BART__: string;
declare const __API_ADVISOR__: string;

const BOSTON_API = typeof __API_BOSTON__ !== 'undefined' ? __API_BOSTON__ : 'http://localhost:5180';
const NYC_API = typeof __API_NYC__ !== 'undefined' ? __API_NYC__ : 'http://localhost:5181';
const BART_API = typeof __API_BART__ !== 'undefined' ? __API_BART__ : 'http://localhost:5182';
const ADVISOR_API = typeof __API_ADVISOR__ !== 'undefined' ? __API_ADVISOR__ : 'http://localhost:5183';

function getBaseUrl(city: CityId): string {
  switch (city) {
    case 'boston': return BOSTON_API;
    case 'nyc': return NYC_API;
    case 'bart': return BART_API;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchRoutes(city: CityId): Promise<TransitRoute[]> {
  return fetchJson<TransitRoute[]>(`${getBaseUrl(city)}/routes`);
}

export async function fetchPredictions(city: CityId, stopId: string): Promise<Prediction[]> {
  return fetchJson<Prediction[]>(`${getBaseUrl(city)}/predictions?stop=${encodeURIComponent(stopId)}`);
}

export async function fetchAlerts(city: CityId): Promise<ServiceAlert[]> {
  return fetchJson<ServiceAlert[]>(`${getBaseUrl(city)}/alerts`);
}

export async function fetchStops(city: CityId, routeId: string): Promise<Stop[]> {
  return fetchJson<Stop[]>(`${getBaseUrl(city)}/stops?route=${encodeURIComponent(routeId)}`);
}

export async function getRouteAdvice(
  city: CityId,
  fromStopId: string,
  toStopId: string
): Promise<RouteAdvice> {
  const res = await fetch(`${ADVISOR_API}/advise`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city, fromStop: fromStopId, toStop: toStopId }),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
