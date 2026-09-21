import React, { useState, useRef, useEffect } from 'react';
import { LogEntry, LogLevel } from '../types/evacuation';
import { Terminal, Filter, Trash2, ArrowDownCircle, ChevronDown, ChevronUp } from 'lucide-react';

interface BottomLogPanelProps {
  logs: LogEntry[];
  onClearLogs: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const BottomLogPanel: React.FC<BottomLogPanelProps> = ({
  logs,
  onClearLogs,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const [filterLevel, setFilterLevel] = useState<'ALL' | LogLevel>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs =
    filterLevel === 'ALL' ? logs : logs.filter((l) => l.level === filterLevel);

  const latestLog = filteredLogs.length > 0 ? filteredLogs[filteredLogs.length - 1] : null;

  useEffect(() => {
    if (!isCollapsed && autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [filteredLogs, autoScroll, isCollapsed]);

  return (
    <section
      className={`cockpit-bottom-panel ${isCollapsed ? 'collapsed' : ''}`}
      id="bottom-logs-panel"
    >
      <header className="bottom-panel-header">
        <div className="bottom-title-group" style={{ minWidth: 0, flex: 1 }}>
          <Terminal size={15} className="terminal-icon" style={{ flexShrink: 0 }} />
          <span className="bottom-panel-title" style={{ flexShrink: 0 }}>
            SYSTEM, ROUTING &amp; SIMULATION LOGS
          </span>
          <span className="log-count-badge" style={{ flexShrink: 0 }}>
            {filteredLogs.length} events
          </span>
          {isCollapsed && latestLog && (
            <span className="collapsed-latest-log-preview" title={latestLog.message}>
              [{latestLog.level}] {latestLog.message}
            </span>
          )}
        </div>

        <div className="bottom-panel-controls" style={{ flexShrink: 0 }}>
          {!isCollapsed && (
            <>
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
            </>
          )}

          {onToggleCollapse && (
            <button
              type="button"
              id="btn-toggle-bottom-panel"
              className="btn-collapse-panel"
              onClick={onToggleCollapse}
              title={isCollapsed ? 'Expand System & Simulation Log Panel' : 'Collapse System & Simulation Log Panel'}
            >
              {isCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              <span>{isCollapsed ? 'Expand Logs' : 'Collapse'}</span>
            </button>
          )}
        </div>
      </header>

      {!isCollapsed && (
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
      )}
    </section>
  );
};
