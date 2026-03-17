import { useState } from 'react';
import { Train, Clock, MapPin } from 'lucide-react';
import { useRoutes, useStops, usePredictions } from '../hooks/useTransitData';
import type { City, Prediction } from '../types/transit';

interface TransitDashboardProps {
  city: City['id'];
}

function StatusBadge({ status }: { status: Prediction['status'] }) {
  const colors: Record<string, string> = {
    'on-time': '#22c55e',
    delayed: '#ef4444',
    approaching: '#f59e0b',
    stopped: '#ef4444',
    scheduled: '#6366f1',
  };
  return (
    <span className="status-badge" style={{ backgroundColor: colors[status] ?? '#666' }}>
      {status}
    </span>
  );
}

export function TransitDashboard({ city }: TransitDashboardProps) {
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);

  const { data: routes, isLoading: loadingRoutes, error: routesError } = useRoutes(city);
  const { data: stops, isLoading: loadingStops } = useStops(city, selectedRouteId);
  const { data: predictions, isLoading: loadingPredictions } = usePredictions(city, selectedStopId);

  if (routesError) {
    return <div className="error-state">Failed to load routes. Is the {city} API running?</div>;
  }

  return (
    <div className="transit-dashboard">
      <section className="routes-section">
        <h2><Train size={18} /> Routes</h2>
        {loadingRoutes ? (
          <div className="loading">Loading routes...</div>
        ) : (
          <div className="route-list">
            {routes?.map((route) => (
              <button
                key={route.id}
                className={`route-badge ${selectedRouteId === route.id ? 'active' : ''}`}
                style={{
                  backgroundColor: `#${route.color}`,
                  color: `#${route.textColor}`,
                  borderColor: selectedRouteId === route.id ? '#fff' : 'transparent',
                }}
                onClick={() => {
                  setSelectedRouteId(route.id === selectedRouteId ? null : route.id);
                  setSelectedStopId(null);
                }}
              >
                {route.name}
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedRouteId && (
        <section className="stops-section">
          <h2><MapPin size={18} /> Stops</h2>
          {loadingStops ? (
            <div className="loading">Loading stops...</div>
          ) : (
            <div className="stop-list">
              {stops?.map((stop) => (
                <button
                  key={stop.id}
                  className={`stop-item ${selectedStopId === stop.id ? 'active' : ''}`}
                  onClick={() => setSelectedStopId(stop.id === selectedStopId ? null : stop.id)}
                >
                  {stop.name}
                </button>
              ))}
              {stops?.length === 0 && <div className="empty-state">No stops found</div>}
            </div>
          )}
        </section>
      )}

      {selectedStopId && (
        <section className="predictions-section">
          <h2><Clock size={18} /> Predictions <span className="auto-refresh">auto-refreshes every 15s</span></h2>
          {loadingPredictions ? (
            <div className="loading">Loading predictions...</div>
          ) : predictions && predictions.length > 0 ? (
            <div className="prediction-list">
              {predictions.map((p, i) => {
                const route = routes?.find((r) => r.id === p.routeId);
                return (
                  <div key={i} className="prediction-card">
                    <span
                      className="prediction-dot"
                      style={{ backgroundColor: route ? `#${route.color}` : '#666' }}
                    />
                    <div className="prediction-info">
                      <span className="prediction-route">{p.routeName}</span>
                      <span className="prediction-direction">{p.direction}</span>
                    </div>
                    <div className="prediction-time">
                      {p.minutesAway !== null ? (
                        <span className="minutes-away">{p.minutesAway} min</span>
                      ) : (
                        <span className="minutes-away">--</span>
                      )}
                    </div>
                    <StatusBadge status={p.status} />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">No upcoming predictions</div>
          )}
        </section>
      )}
    </div>
  );
}
