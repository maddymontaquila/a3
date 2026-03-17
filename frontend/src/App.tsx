import { useState } from 'react';
import './App.css';
import { CitySelector } from './components/CitySelector';
import { TransitDashboard } from './components/TransitDashboard';
import { ServiceAlerts } from './components/ServiceAlerts';
import { RouteAdvisor } from './components/RouteAdvisor';
import type { City } from './types/transit';

function App() {
  const [city, setCity] = useState<City['id']>('boston');

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">A3 — All Aboard Aspire 🚂</h1>
        <CitySelector selected={city} onSelect={setCity} />
      </header>

      <div className="app-body">
        <main className="app-main">
          <TransitDashboard city={city} />
          <RouteAdvisor city={city} />
        </main>
        <aside className="app-sidebar">
          <ServiceAlerts city={city} />
        </aside>
      </div>
    </div>
  );
}

export default App;
