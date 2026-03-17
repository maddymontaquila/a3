import { useState, useMemo } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { useRoutes, useStops } from '../hooks/useTransitData';
import { getRouteAdvice } from '../api/client';
import { StopPicker } from './StopPicker';
import type { City, RouteAdvice } from '../types/transit';

interface RouteAdvisorProps {
  city: City['id'];
}

export function RouteAdvisor({ city }: RouteAdvisorProps) {
  const [fromStopId, setFromStopId] = useState<string | null>(null);
  const [toStopId, setToStopId] = useState<string | null>(null);
  const [advice, setAdvice] = useState<RouteAdvice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  const { data: routes } = useRoutes(city);
  const { data: stops } = useStops(city, selectedRouteId);

  const allStops = useMemo(() => stops ?? [], [stops]);

  const handleGetAdvice = async () => {
    if (!fromStopId || !toStopId) return;
    setLoading(true);
    setError(null);
    setAdvice(null);
    try {
      const result = await getRouteAdvice(city, fromStopId, toStopId);
      setAdvice(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get advice');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="route-advisor">
      <h2><Sparkles size={18} /> Route Advisor <span className="ai-badge">AI</span></h2>

      <div className="advisor-route-select">
        <label>Select route to pick stops from:</label>
        <div className="route-list compact">
          {routes?.map((route) => (
            <button
              key={route.id}
              className={`route-badge ${selectedRouteId === route.id ? 'active' : ''}`}
              style={{
                backgroundColor: route.color,
                color: route.textColor,
                borderColor: selectedRouteId === route.id ? '#fff' : 'transparent',
              }}
              onClick={() => {
                setSelectedRouteId(route.id === selectedRouteId ? null : route.id);
                setFromStopId(null);
                setToStopId(null);
              }}
            >
              {route.name}
            </button>
          ))}
        </div>
      </div>

      {selectedRouteId && (
        <div className="advisor-pickers">
          <div className="picker-group">
            <label>From:</label>
            <StopPicker
              stops={allStops}
              routes={routes ?? []}
              value={fromStopId}
              onChange={setFromStopId}
              placeholder="Select origin stop..."
            />
          </div>
          <div className="picker-group">
            <label>To:</label>
            <StopPicker
              stops={allStops}
              routes={routes ?? []}
              value={toStopId}
              onChange={setToStopId}
              placeholder="Select destination stop..."
            />
          </div>
          <button
            className="advisor-button"
            onClick={handleGetAdvice}
            disabled={!fromStopId || !toStopId || loading}
          >
            {loading ? <Loader2 size={16} className="spinner" /> : <Sparkles size={16} />}
            {loading ? 'Getting Advice...' : 'Get Route Advice'}
          </button>
        </div>
      )}

      {error && <div className="advisor-error">{error}</div>}

      {advice && (
        <div className="advisor-result">
          <div className="advisor-recommendation">
            <h3>Recommendation</h3>
            <p>{advice.recommendation}</p>
          </div>
          {advice.alternatives.length > 0 && (
            <div className="advisor-alternatives">
              <h3>Alternatives</h3>
              <ul>
                {advice.alternatives.map((alt, i) => (
                  <li key={i}>{alt}</li>
                ))}
              </ul>
            </div>
          )}
          {advice.currentAlerts.length > 0 && (
            <div className="advisor-alerts">
              <h3>Relevant Alerts</h3>
              {advice.currentAlerts.map((alert) => (
                <div key={alert.id} className="advisor-alert-item">
                  <span className={`severity-dot severity-${alert.severity}`} />
                  {alert.header}
                </div>
              ))}
            </div>
          )}
          <div className="advisor-timestamp">Generated at {new Date(advice.generatedAt).toLocaleTimeString()}</div>
        </div>
      )}
    </div>
  );
}
