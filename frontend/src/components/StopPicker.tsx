import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import type { Stop, TransitRoute } from '../types/transit';

interface StopPickerProps {
  stops: Stop[];
  routes: TransitRoute[];
  value: string | null;
  onChange: (stopId: string | null) => void;
  placeholder?: string;
}

export function StopPicker({ stops, routes, value, onChange, placeholder = 'Search stops...' }: StopPickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const routeMap = useMemo(() => {
    const map = new Map<string, TransitRoute>();
    for (const r of routes) map.set(r.id, r);
    return map;
  }, [routes]);

  const filtered = useMemo(() => {
    if (!search) return stops;
    const q = search.toLowerCase();
    return stops.filter((s) => s.name.toLowerCase().includes(q));
  }, [stops, search]);

  const selectedStop = stops.find((s) => s.id === value);

  return (
    <div className="stop-picker">
      <div className="stop-picker-input" onClick={() => setOpen(!open)}>
        <Search size={16} />
        <span className="stop-picker-value">
          {selectedStop ? selectedStop.name : placeholder}
        </span>
      </div>
      {open && (
        <div className="stop-picker-dropdown">
          <input
            type="text"
            className="stop-picker-search"
            placeholder="Filter stops..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="stop-picker-list">
            {filtered.length === 0 && (
              <div className="stop-picker-empty">No stops found</div>
            )}
            {filtered.map((stop) => (
              <button
                key={stop.id}
                className={`stop-picker-item ${value === stop.id ? 'selected' : ''}`}
                onClick={() => {
                  onChange(stop.id);
                  setOpen(false);
                  setSearch('');
                }}
              >
                <span className="stop-name">{stop.name}</span>
                <span className="stop-routes">
                  {stop.routeIds.map((rid) => {
                    const r = routeMap.get(rid);
                    return (
                      <span
                        key={rid}
                        className="route-badge-mini"
                        style={{ backgroundColor: r ? r.color : '#666', color: r ? r.textColor : '#fff' }}
                      >
                        {r?.name ?? rid}
                      </span>
                    );
                  })}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
