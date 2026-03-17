import { useQuery } from '@tanstack/react-query';
import { fetchRoutes, fetchPredictions, fetchAlerts, fetchStops } from '../api/client';

type CityId = 'boston' | 'nyc' | 'bart';

export function useRoutes(city: CityId) {
  return useQuery({
    queryKey: ['routes', city],
    queryFn: () => fetchRoutes(city),
    staleTime: 5 * 60 * 1000,
  });
}

export function usePredictions(city: CityId, stopId: string | null) {
  return useQuery({
    queryKey: ['predictions', city, stopId],
    queryFn: () => fetchPredictions(city, stopId!),
    enabled: !!stopId,
    refetchInterval: 15_000,
  });
}

export function useAlerts(city: CityId) {
  return useQuery({
    queryKey: ['alerts', city],
    queryFn: () => fetchAlerts(city),
    refetchInterval: 60_000,
  });
}

export function useStops(city: CityId, routeId: string | null) {
  return useQuery({
    queryKey: ['stops', city, routeId],
    queryFn: () => fetchStops(city, routeId!),
    enabled: !!routeId,
    staleTime: 5 * 60 * 1000,
  });
}
