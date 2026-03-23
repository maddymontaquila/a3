import type { TransitRoute, Prediction, ServiceAlert, Stop } from '../types/transit';

type CityId = 'boston' | 'nyc' | 'bart' | 'dc';

const BOSTON_API = '/api/boston';
const NYC_API = '/api/nyc';
const BART_API = '/api/bart';
const DC_API = '/api/dc';
const ADVISOR_API = '/api/advisor';

function getBaseUrl(city: CityId): string {
  switch (city) {
    case 'boston': return BOSTON_API;
    case 'nyc': return NYC_API;
    case 'bart': return BART_API;
    case 'dc': return DC_API;
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

export interface StatusBriefing {
  city: string;
  briefing: string;
  alertCount: number;
  generatedAt: string;
}

export async function fetchBriefing(city: CityId): Promise<StatusBriefing> {
  const res = await fetch(`${ADVISOR_API}/briefing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ city }),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
