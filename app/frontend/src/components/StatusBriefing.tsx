import { useState } from 'react';
import { Sparkles, RefreshCw } from 'lucide-react';
import { fetchBriefing, type StatusBriefing as BriefingData } from '../api/client';
import type { City } from '../types/transit';

interface StatusBriefingProps {
  city: City['id'];
}

export function StatusBriefing({ city }: StatusBriefingProps) {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cityNames: Record<string, string> = {
    boston: 'Boston MBTA',
    nyc: 'NYC Subway',
    bart: 'Bay Area BART',
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBriefing(city);
      setBriefing(result);
    } catch (err: any) {
      setError(err.message || 'Failed to generate briefing');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="status-briefing">
      <h2><Sparkles size={18} /> AI Status Briefing</h2>

      {!briefing && !loading && !error && (
        <div className="briefing-prompt">
          <p>Get an AI-powered summary of what's happening on the {cityNames[city]} right now.</p>
          <button className="briefing-button" onClick={generate}>
            <Sparkles size={16} /> What's happening?
          </button>
        </div>
      )}

      {loading && (
        <div className="briefing-loading">
          <RefreshCw size={20} className="spin" />
          <span>Analyzing live transit data...</span>
        </div>
      )}

      {error && (
        <div className="briefing-error">
          <p>{error}</p>
          <button className="briefing-button" onClick={generate}>Try again</button>
        </div>
      )}

      {briefing && !loading && (
        <div className="briefing-content">
          <p className="briefing-text">{briefing.briefing}</p>
          <div className="briefing-meta">
            <span>{briefing.alertCount} active alert{briefing.alertCount !== 1 ? 's' : ''}</span>
            <span>·</span>
            <span>{new Date(briefing.generatedAt).toLocaleTimeString()}</span>
            <button className="briefing-refresh" onClick={generate} title="Refresh briefing">
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
