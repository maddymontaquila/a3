import { useState } from 'react';
import './App.css';
import { CitySelector } from './components/CitySelector';
import { TransitDashboard } from './components/TransitDashboard';
import { ServiceAlerts } from './components/ServiceAlerts';
import { StatusBriefing } from './components/StatusBriefing';
import type { City } from './types/transit';

type CityId = City['id'];

interface CityState {
  routeId: string | null;
  stopId: string | null;
}

function App() {
  const [city, setCity] = useState<CityId>('boston');
  const [perCity, setPerCity] = useState<Record<CityId, CityState>>({
    boston: { routeId: null, stopId: null },
    nyc: { routeId: null, stopId: null },
    bart: { routeId: null, stopId: null },
    dc: { routeId: null, stopId: null },
  });

  const current = perCity[city];

  const setRouteId = (routeId: string | null) =>
    setPerCity((prev) => ({ ...prev, [city]: { ...prev[city], routeId, stopId: null } }));

  const setStopId = (stopId: string | null) =>
    setPerCity((prev) => ({ ...prev, [city]: { ...prev[city], stopId } }));

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">A3 — All Aboard Aspire 🚂</h1>
        <CitySelector selected={city} onSelect={setCity} />
      </header>

      <div className="app-body">
        <main className="app-main">
          <TransitDashboard
            city={city}
            selectedRouteId={current.routeId}
            selectedStopId={current.stopId}
            onSelectRoute={setRouteId}
            onSelectStop={setStopId}
          />
          <StatusBriefing city={city} />
        </main>
        <aside className="app-sidebar">
          <ServiceAlerts city={city} />
        </aside>
      </div>
    </div>
  );
}

export default App;
