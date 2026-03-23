// Common transit data types shared across all city APIs
// All 3 APIs (Boston, NYC, BART) normalize to these shapes

export interface TransitRoute {
  id: string;
  name: string;
  color: string;
  textColor: string;
  type: "subway" | "light-rail" | "heavy-rail";
}

export interface Prediction {
  routeId: string;
  routeName: string;
  stopId: string;
  stopName: string;
  direction: string;
  arrivalTime: string | null; // ISO 8601, null if unknown
  minutesAway: number | null;
  status: "on-time" | "delayed" | "approaching" | "stopped" | "scheduled";
}

export interface ServiceAlert {
  id: string;
  severity: "info" | "warning" | "severe" | string | number;
  header: string;
  description: string;
  affectedRoutes: string[];
  activePeriod: { start: string; end?: string };
  updatedAt: string;
}

export interface Stop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  routeIds: string[];
}

export interface City {
  id: "boston" | "nyc" | "bart";
  name: string;
  description: string;
  apiUrl: string;
}

export interface RouteAdvice {
  fromStop: string;
  toStop: string;
  city: string;
  recommendation: string;
  alternatives: string[];
  currentAlerts: ServiceAlert[];
  generatedAt: string;
}
