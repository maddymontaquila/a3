import { useState } from 'react';
import { AlertTriangle, Info, AlertOctagon, ChevronDown, ChevronUp } from 'lucide-react';
import { useAlerts, useRoutes } from '../hooks/useTransitData';
import type { City, ServiceAlert } from '../types/transit';

interface ServiceAlertsProps {
  city: City['id'];
}

const SEVERITY_CONFIG: Record<ServiceAlert['severity'], { color: string; bg: string; icon: typeof Info }> = {
  info: { color: '#60a5fa', bg: '#1e3a5f', icon: Info },
  warning: { color: '#fbbf24', bg: '#4a3f1f', icon: AlertTriangle },
  severe: { color: '#f87171', bg: '#5f1e1e', icon: AlertOctagon },
};

export function ServiceAlerts({ city }: ServiceAlertsProps) {
  const { data: alerts, isLoading } = useAlerts(city);
  const { data: routes } = useRoutes(city);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const routeMap = new Map((routes ?? []).map((r) => [r.id, r]));

  return (
    <div className="service-alerts">
      <h2><AlertTriangle size={18} /> Service Alerts</h2>
      {isLoading ? (
        <div className="loading">Loading alerts...</div>
      ) : alerts && alerts.length > 0 ? (
        <div className="alert-list">
          {alerts.map((alert) => {
            const severity = (alert.severity?.toLowerCase() ?? 'info') as ServiceAlert['severity'];
            const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.info;
            const Icon = cfg.icon;
            const isOpen = expanded.has(alert.id);
            return (
              <div
                key={alert.id}
                className="alert-card"
                style={{ borderLeftColor: cfg.color, backgroundColor: cfg.bg }}
              >
                <button className="alert-header" onClick={() => toggle(alert.id)}>
                  <Icon size={16} style={{ color: cfg.color, flexShrink: 0 }} />
                  <span className="alert-title">{alert.header}</span>
                  {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>
                <div className="alert-routes">
                  {alert.affectedRoutes.map((rid) => {
                    const r = routeMap.get(rid);
                    return (
                      <span
                        key={rid}
                        className="route-badge-mini"
                        style={{
                          backgroundColor: r ? r.color : '#444',
                          color: r ? r.textColor : '#fff',
                        }}
                      >
                        {r?.name ?? rid}
                      </span>
                    );
                  })}
                </div>
                {isOpen && (
                  <p className="alert-description">{alert.description}</p>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state">No active alerts ✅</div>
      )}
    </div>
  );
}
