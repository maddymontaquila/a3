import type { City } from '../types/transit';

const CITIES: City[] = [
  { id: 'boston', name: 'Boston', description: 'MBTA Subway', apiUrl: '' },
  { id: 'nyc', name: 'NYC', description: 'MTA Subway', apiUrl: '' },
  { id: 'bart', name: 'BART', description: 'Bay Area Rapid Transit', apiUrl: '' },
];

const CITY_EMOJI: Record<string, string> = {
  boston: '🦞',
  nyc: '🗽',
  bart: '🌉',
};

interface CitySelectorProps {
  selected: City['id'];
  onSelect: (id: City['id']) => void;
}

export function CitySelector({ selected, onSelect }: CitySelectorProps) {
  return (
    <div className="city-selector">
      {CITIES.map((city) => (
        <button
          key={city.id}
          className={`city-tab ${selected === city.id ? 'active' : ''}`}
          onClick={() => onSelect(city.id)}
        >
          <span className="city-emoji">{CITY_EMOJI[city.id]}</span>
          <span className="city-name">{city.name}</span>
          <span className="city-desc">{city.description}</span>
        </button>
      ))}
    </div>
  );
}
