import type { TransitRoute, Prediction, ServiceAlert, Stop, RouteAdvice } from '../types/transit';

type CityId = 'boston' | 'nyc' | 'bart';

const BOSTON_API = import.meta.env.VITE_BOSTON_API || '/api/boston';
const NYC_API = import.meta.env.VITE_NYC_API || '/api/nyc';
const BART_API = import.meta.env.VITE_BART_API || '/api/bart';
const ADVISOR_API = import.meta.env.VITE_ADVISOR_API || '/api/advisor';

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
  return fetchJson<Prediction[]>(`${getBaseUrl(city)}/predictions?stopId=${encodeURIComponent(stopId)}`);
}

export async function fetchAlerts(city: CityId): Promise<ServiceAlert[]> {
  return fetchJson<ServiceAlert[]>(`${getBaseUrl(city)}/alerts`);
}

export async function fetchStops(city: CityId, routeId: string): Promise<Stop[]> {
  return fetchJson<Stop[]>(`${getBaseUrl(city)}/stops?routeId=${encodeURIComponent(routeId)}`);
}

export async function getRouteAdvice(
  city: CityId,
  fromStopId: string,
  toStopId: string
): Promise<RouteAdvice> {
  return fetchJson<RouteAdvice>(
    `${ADVISOR_API}/advice?city=${encodeURIComponent(city)}&from=${encodeURIComponent(fromStopId)}&to=${encodeURIComponent(toStopId)}`
  );
}
