import React, { useState, useRef, useEffect } from 'react';
import { LogEntry, LogLevel } from '../types/evacuation';
import { Terminal, Filter, Trash2, ArrowDownCircle } from 'lucide-react';

interface BottomLogPanelProps {
  logs: LogEntry[];
  onClearLogs: () => void;
}

export const BottomLogPanel: React.FC<BottomLogPanelProps> = ({ logs, onClearLogs }) => {
  const [filterLevel, setFilterLevel] = useState<'ALL' | LogLevel>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs =
    filterLevel === 'ALL' ? logs : logs.filter((l) => l.level === filterLevel);

  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll]);

  return (
    <section className="cockpit-bottom-panel" id="bottom-logs-panel">
      <header className="bottom-panel-header">
        <div className="bottom-title-group">
          <Terminal size={15} className="terminal-icon" />
          <span className="bottom-panel-title">SYSTEM, ROUTING & SIMULATION LOGS</span>
          <span className="log-count-badge">{filteredLogs.length} events</span>
        </div>

        <div className="bottom-panel-controls">
          <div className="log-filter-pills">
            <Filter size={12} />
            {(['ALL', 'ROUTING', 'SIMULATION', 'WARN', 'INFO'] as const).map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`log-filter-pill ${filterLevel === lvl ? 'active' : ''}`}
                onClick={() => setFilterLevel(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`btn-log-tool ${autoScroll ? 'active' : ''}`}
            onClick={() => setAutoScroll(!autoScroll)}
            title="Toggle Auto-Scroll"
          >
            <ArrowDownCircle size={14} />
            <span>Auto-scroll</span>
          </button>

          <button
            type="button"
            className="btn-log-tool"
            onClick={onClearLogs}
            title="Clear Console Logs"
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        </div>
      </header>

      <div ref={logContainerRef} className="log-stream-container">
        {filteredLogs.length === 0 ? (
          <div className="empty-logs-state">
            No log entries matching filter [{filterLevel}]. Compute evacuation routes or run simulation to view live telemetry events.
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div key={log.id} className={`log-entry-row log-level-${log.level.toLowerCase()}`}>
              <span className="log-wall-time">[{log.timestamp}]</span>
              <span className="log-sim-time">T+{log.simTimeFormatted}</span>
              <span className={`log-level-badge badge-${log.level.toLowerCase()}`}>
                {log.level}
              </span>
              <span className="log-message-text">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
};
