import { useQuery } from '@tanstack/react-query';
import { fetchRoutes, fetchPredictions, fetchAlerts, fetchStops } from '../api/client';

type CityId = 'boston' | 'nyc' | 'bart';

export function useRoutes(city: CityId) {
  return useQuery({
    queryKey: ['routes', city],
    queryFn: () => fetchRoutes(city),
    staleTime: 10 * 60 * 1000,  // routes are static-ish, 10 min
    gcTime: 30 * 60 * 1000,     // keep in cache 30 min
  });
}

export function usePredictions(city: CityId, stopId: string | null) {
  return useQuery({
    queryKey: ['predictions', city, stopId],
    queryFn: () => fetchPredictions(city, stopId!),
    enabled: !!stopId,
    staleTime: 15_000,           // predictions update every 15s
    gcTime: 5 * 60 * 1000,      // keep old predictions 5 min
    refetchInterval: 15_000,
  });
}

export function useAlerts(city: CityId) {
  return useQuery({
    queryKey: ['alerts', city],
    queryFn: () => fetchAlerts(city),
    staleTime: 60_000,           // alerts refresh every 60s
    gcTime: 10 * 60 * 1000,     // keep 10 min
    refetchInterval: 60_000,
  });
}

export function useStops(city: CityId, routeId: string | null) {
  return useQuery({
    queryKey: ['stops', city, routeId],
    queryFn: () => fetchStops(city, routeId!),
    enabled: !!routeId,
    staleTime: 10 * 60 * 1000,  // stops rarely change
    gcTime: 30 * 60 * 1000,     // keep 30 min
  });
}
