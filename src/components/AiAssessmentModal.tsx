import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  SourceArea,
  TargetArea,
  RedArea,
  VehicleFleet,
  ComputedRoute,
  PickupLocationState,
  SourceInternalCluster,
  ActiveVehicleUnit,
  TwinTelemetryStats,
  LogEntry,
  BrusselsMetroConfig,
  BrusselsMetroMatchedStation,
  BrusselsMetroCorridor,
  RoutingAlgorithm,
  Sentinel2LayerState,
  Sentinel1LayerState,
  GlofasForecastState,
  DataOverlayLayer,
} from '../types/evacuation';
import { formatMMSS } from '../services/twinEngine';
import {
  buildAiAssessmentPrompt,
  DEFAULT_AI_ASSESSMENT_INSTRUCTIONS,
} from '../services/aiAssessmentPromptBuilder';
import { MarkdownRenderer } from '../utils/markdownRenderer';
import {
  Sparkles,
  X,
  Wand2,
  Copy,
  Check,
  Lock,
  Send,
  Loader2,
  AlertTriangle,
} from 'lucide-react';

interface AiAssessmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  scenarioName: string;
  routingAlgorithm: RoutingAlgorithm;
  elapsedTwinSeconds: number;
  twinSpeed: number;
  sourceAreas: SourceArea[];
  targetAreas: TargetArea[];
  redAreas: RedArea[];
  vehicleFleets: VehicleFleet[];
  computedRoutes: ComputedRoute[];
  clusters: SourceInternalCluster[];
  pickupStates: PickupLocationState[];
  vehicles: ActiveVehicleUnit[];
  telemetryStats: TwinTelemetryStats;
  totalEvacuated: number;
  totalInTransit: number;
  totalRemainingAtSource: number;
  totalWaitingAtPickups: number;
  logs: LogEntry[];
  hasBrusselsAreas: boolean;
  brusselsMetroConfig: BrusselsMetroConfig;
  sourceMetroStations: BrusselsMetroMatchedStation[];
  targetMetroStations: BrusselsMetroMatchedStation[];
  metroCorridors: BrusselsMetroCorridor[];
  sentinel2Layer?: Sentinel2LayerState;
  sentinel1Layer?: Sentinel1LayerState;
  glofasForecast?: GlofasForecastState;
  dataOverlays?: DataOverlayLayer[];
}

export const AiAssessmentModal: React.FC<AiAssessmentModalProps> = ({
  isOpen,
  onClose,
  scenarioName,
  routingAlgorithm,
  elapsedTwinSeconds,
  twinSpeed,
  sourceAreas,
  targetAreas,
  redAreas,
  vehicleFleets,
  computedRoutes,
  clusters,
  pickupStates,
  vehicles,
  telemetryStats,
  totalEvacuated,
  totalInTransit,
  totalRemainingAtSource,
  totalWaitingAtPickups,
  logs,
  hasBrusselsAreas,
  brusselsMetroConfig,
  sourceMetroStations,
  targetMetroStations,
  metroCorridors,
  sentinel2Layer,
  sentinel1Layer,
  glofasForecast,
  dataOverlays,
}) => {
  const [instructionsForAi, setInstructionsForAi] = useState<string>(
    DEFAULT_AI_ASSESSMENT_INSTRUCTIONS
  );
  const [generatedPrompt, setGeneratedPrompt] = useState<string>('');
  const [hasBuiltPrompt, setHasBuiltPrompt] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [assessmentMarkdown, setAssessmentMarkdown] = useState<string | null>(null);
  const [errorPopupMessage, setErrorPopupMessage] = useState<string | null>(null);
  const [configuredEndpoint, setConfiguredEndpoint] = useState<string>(
    'https://generativelanguage.googleapis.com/v1beta/openai'
  );
  const [configuredModel, setConfiguredModel] = useState<string>('gemini-3.8-flash');

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (errorPopupMessage) {
          setErrorPopupMessage(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, errorPopupMessage]);

  // Reset transient view & load active config.yaml endpoint + model when opened
  useEffect(() => {
    if (isOpen) {
      setAssessmentMarkdown(null);
      setErrorPopupMessage(null);
      fetch('/api/ai-assessment/config')
        .then((res) => res.json())
        .then(
          (data: {
            ok?: boolean;
            modelEndpoint?: string;
            model?: string;
          }) => {
            if (data?.ok) {
              if (data.modelEndpoint) setConfiguredEndpoint(data.modelEndpoint);
              if (data.model) setConfiguredModel(data.model);
            }
          }
        )
        .catch(() => {
          // Keep default config display if unreachable
        });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isCompleted =
    totalRemainingAtSource === 0 && totalInTransit === 0 && totalEvacuated > 0;

  const handleBuildPrompt = () => {
    const prompt = buildAiAssessmentPrompt({
      userInstructions: instructionsForAi,
      scenarioName,
      routingAlgorithm,
      elapsedTwinSeconds,
      twinSpeed,
      sourceAreas,
      targetAreas,
      redAreas,
      vehicleFleets,
      computedRoutes,
      clusters,
      pickupStates,
      vehicles,
      telemetryStats,
      totalEvacuated,
      totalInTransit,
      totalRemainingAtSource,
      totalWaitingAtPickups,
      logs,
      hasBrusselsAreas,
      brusselsMetroConfig,
      sourceMetroStations,
      targetMetroStations,
      metroCorridors,
      sentinel2Layer,
      sentinel1Layer,
      glofasForecast,
      dataOverlays,
    });
    setGeneratedPrompt(prompt);
    setHasBuiltPrompt(true);
    setCopied(false);
  };

  const handleSendPrompt = async () => {
    if (!hasBuiltPrompt || !generatedPrompt || isSending) return;
    setIsSending(true);
    try {
      const res = await fetch('/api/ai-assessment/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: generatedPrompt }),
      });

      let payload: {
        ok?: boolean;
        content?: string;
        error?: string;
        model?: string;
        modelEndpoint?: string;
      } | null = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }

      if (payload?.modelEndpoint) setConfiguredEndpoint(payload.modelEndpoint);
      if (payload?.model) setConfiguredModel(payload.model);

      if (!res.ok || !payload?.ok || typeof payload.content !== 'string') {
        const errMsg =
          payload?.error ||
          `Request failed with status ${res.status} ${res.statusText}`;
        setErrorPopupMessage(errMsg);
        return;
      }

      // Remove all prompt builder components and display the Markdown response
      setAssessmentMarkdown(payload.content);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setErrorPopupMessage(`Failed to communicate with AI endpoint: ${errMsg}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyPrompt = async () => {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      const temp = document.createElement('textarea');
      temp.value = generatedPrompt;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  return createPortal(
    <div
      id="ai-assessment-modal-backdrop"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        backgroundColor: 'rgba(4, 9, 18, 0.80)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
    >
      {/* Smooth continuous keyframe animation for moving waiting indicator */}
      <style>{`
        @keyframes aiAssessmentSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>

      <div
        id="ai-assessment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-assessment-modal-title"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(980px, 95vw)',
          maxHeight: '90vh',
          backgroundColor: 'hsl(222, 30%, 11%)',
          border: '1px solid rgba(167, 139, 250, 0.5)',
          borderRadius: '12px',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.82)',
          color: '#f8fafc',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {/* Modal Header */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            padding: '15px 22px',
            background:
              'linear-gradient(90deg, rgba(15, 23, 42, 0.98) 0%, rgba(30, 41, 59, 0.95) 100%)',
            borderBottom: '1px solid rgba(167, 139, 250, 0.3)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '8px',
                background: 'rgba(139, 92, 246, 0.18)',
                border: '1px solid rgba(167, 139, 250, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#c4b5fd',
              }}
            >
              <Sparkles size={19} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <h2
                  id="ai-assessment-modal-title"
                  style={{
                    margin: 0,
                    fontSize: '1.05rem',
                    fontWeight: 700,
                    letterSpacing: '0.02em',
                    color: '#f8fafc',
                  }}
                >
                  AI Assessment
                </h2>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: '999px',
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    background: isCompleted
                      ? 'rgba(16, 185, 129, 0.2)'
                      : 'rgba(245, 158, 11, 0.2)',
                    color: isCompleted ? '#34d399' : '#fbbf24',
                    border: isCompleted
                      ? '1px solid rgba(16, 185, 129, 0.45)'
                      : '1px solid rgba(245, 158, 11, 0.45)',
                  }}
                >
                  {isCompleted
                    ? 'COMPLETED (100%)'
                    : elapsedTwinSeconds > 0
                    ? `STOPPED AT T+${formatMMSS(elapsedTwinSeconds)}`
                    : 'INITIAL SNAPSHOT (T+00:00)'}
                </span>
              </div>
              <p
                style={{
                  margin: '2px 0 0 0',
                  fontSize: '0.75rem',
                  color: '#94a3b8',
                }}
              >
                Scenario: <strong style={{ color: '#e2e8f0' }}>{scenarioName}</strong> &bull;
                Twin Clock:{' '}
                <strong style={{ color: '#c4b5fd', fontFamily: 'monospace' }}>
                  {formatMMSS(elapsedTwinSeconds)} ({Math.round(elapsedTwinSeconds)}s)
                </strong>
              </p>
            </div>
          </div>

          <button
            id="btn-close-ai-assessment"
            type="button"
            onClick={onClose}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '7px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              background: 'rgba(51, 65, 85, 0.6)',
              color: '#f8fafc',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <X size={15} />
            <span>Close</span>
          </button>
        </header>

        {/* Modal Body: Either the rendered Markdown response OR the prompt builder components */}
        <div
          style={{
            padding: '18px 22px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            flex: 1,
          }}
        >
          {assessmentMarkdown !== null ? (
            <MarkdownRenderer content={assessmentMarkdown} />
          ) : (
            <>
              {/* 1. Instructions for AI (Editable Text Box) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label
                  htmlFor="input-instructions-for-ai"
                  style={{
                    fontSize: '0.84rem',
                    fontWeight: 700,
                    color: '#e2e8f0',
                    letterSpacing: '0.01em',
                  }}
                >
                  Instructions for AI
                </label>
                <textarea
                  id="input-instructions-for-ai"
                  rows={5}
                  value={instructionsForAi}
                  onChange={(e) => setInstructionsForAi(e.target.value)}
                  placeholder="Enter custom instructions for the AI assessment (e.g., focus areas, constraints, parameter tuning goals)..."
                  style={{
                    width: '100%',
                    minHeight: '115px',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid rgba(148, 163, 184, 0.35)',
                    background: 'rgba(15, 23, 42, 0.85)',
                    color: '#f8fafc',
                    fontSize: '0.8rem',
                    lineHeight: 1.45,
                    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
                    resize: 'vertical',
                  }}
                />
              </div>

              {/* 2. Action Row: 'build prompt' button, 'Send' button + active endpoint/model badge, and Copy helper */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  flexWrap: 'wrap',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    id="btn-build-ai-prompt"
                    type="button"
                    disabled={isSending}
                    onClick={handleBuildPrompt}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '9px 18px',
                      borderRadius: '7px',
                      border: '1px solid rgba(167, 139, 250, 0.65)',
                      background:
                        'linear-gradient(135deg, rgba(139, 92, 246, 0.35) 0%, rgba(79, 70, 229, 0.48) 100%)',
                      color: '#f8fafc',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      cursor: isSending ? 'not-allowed' : 'pointer',
                      boxShadow: '0 4px 14px rgba(139, 92, 246, 0.25)',
                      opacity: isSending ? 0.65 : 1,
                    }}
                  >
                    <Wand2 size={15} style={{ color: '#c4b5fd' }} />
                    <span>build prompt</span>
                  </button>

                  <button
                    id="btn-send-ai-prompt"
                    type="button"
                    disabled={!hasBuiltPrompt || isSending}
                    onClick={handleSendPrompt}
                    title={
                      !hasBuiltPrompt
                        ? 'Click "build prompt" first to enable Send'
                        : `Send prompt to ${configuredModel} (${configuredEndpoint})`
                    }
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '9px 18px',
                      borderRadius: '7px',
                      border:
                        hasBuiltPrompt && !isSending
                          ? '1px solid rgba(52, 211, 153, 0.65)'
                          : '1px solid rgba(148, 163, 184, 0.25)',
                      background:
                        hasBuiltPrompt && !isSending
                          ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.32) 0%, rgba(5, 150, 105, 0.48) 100%)'
                          : 'rgba(30, 41, 59, 0.45)',
                      color: hasBuiltPrompt && !isSending ? '#f8fafc' : '#64748b',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      cursor: hasBuiltPrompt && !isSending ? 'pointer' : 'not-allowed',
                      boxShadow:
                        hasBuiltPrompt && !isSending
                          ? '0 4px 14px rgba(16, 185, 129, 0.22)'
                          : 'none',
                    }}
                  >
                    {isSending ? (
                      <Loader2
                        size={15}
                        style={{
                          color: '#34d399',
                          animation: 'aiAssessmentSpin 0.8s linear infinite',
                        }}
                      />
                    ) : (
                      <Send
                        size={15}
                        style={{ color: hasBuiltPrompt ? '#34d399' : '#64748b' }}
                      />
                    )}
                    <span>{isSending ? 'Sending...' : 'Send'}</span>
                  </button>

                  {/* Endpoint and Model info displayed right beside the Send button */}
                  <div
                    id="ai-assessment-endpoint-info"
                    style={{
                      display: 'inline-flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      padding: '4px 10px',
                      borderRadius: '6px',
                      background: 'rgba(15, 23, 42, 0.75)',
                      border: '1px solid rgba(148, 163, 184, 0.22)',
                      fontSize: '0.7rem',
                      lineHeight: 1.35,
                      color: '#94a3b8',
                    }}
                  >
                    <div>
                      Model:{' '}
                      <strong style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>
                        {configuredModel}
                      </strong>
                    </div>
                    <div
                      style={{
                        maxWidth: '340px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={configuredEndpoint}
                    >
                      Endpoint:{' '}
                      <span style={{ color: '#c4b5fd', fontFamily: 'monospace' }}>
                        {configuredEndpoint}
                      </span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {generatedPrompt && (
                    <span style={{ fontSize: '0.73rem', color: '#94a3b8' }}>
                      {generatedPrompt.length.toLocaleString()} chars (~
                      {Math.round(generatedPrompt.length / 4).toLocaleString()} tokens)
                    </span>
                  )}
                  <button
                    id="btn-copy-ai-prompt"
                    type="button"
                    disabled={!generatedPrompt || isSending}
                    onClick={handleCopyPrompt}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '7px 13px',
                      borderRadius: '6px',
                      border: generatedPrompt
                        ? '1px solid rgba(56, 189, 248, 0.45)'
                        : '1px solid rgba(148, 163, 184, 0.2)',
                      background: generatedPrompt
                        ? 'rgba(14, 165, 233, 0.16)'
                        : 'rgba(30, 41, 59, 0.4)',
                      color: generatedPrompt ? '#7dd3fc' : '#64748b',
                      fontSize: '0.76rem',
                      fontWeight: 600,
                      cursor: generatedPrompt && !isSending ? 'pointer' : 'not-allowed',
                    }}
                    title={
                      generatedPrompt
                        ? 'Copy generated prompt to clipboard'
                        : 'Click "build prompt" first'
                    }
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    <span>{copied ? 'Copied!' : 'Copy Prompt'}</span>
                  </button>
                </div>
              </div>

              {/* 3. Prompt for AI (Disabled for User Editing) */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                  }}
                >
                  <label
                    htmlFor="output-prompt-for-ai"
                    style={{
                      fontSize: '0.84rem',
                      fontWeight: 700,
                      color: '#e2e8f0',
                      letterSpacing: '0.01em',
                    }}
                  >
                    Prompt for AI
                  </label>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.7rem',
                      color: '#94a3b8',
                    }}
                  >
                    <Lock size={12} />
                    <span>Read-only (generated by &ldquo;build prompt&rdquo;)</span>
                  </span>
                </div>
                <textarea
                  id="output-prompt-for-ai"
                  readOnly
                  aria-readonly="true"
                  rows={15}
                  value={generatedPrompt}
                  placeholder='Click "build prompt" above to compile your custom instructions along with all simulation parameters, telemetry, per-area/pickup/dropoff/behavior/fleet/metro metrics, and event logs...'
                  style={{
                    width: '100%',
                    minHeight: '280px',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    border: '1px solid rgba(167, 139, 250, 0.28)',
                    background: 'rgba(9, 14, 26, 0.92)',
                    color: '#cbd5e1',
                    fontSize: '0.77rem',
                    lineHeight: 1.5,
                    fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                    resize: 'vertical',
                    cursor: 'default',
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Error Popup Dialog (shown on top if LLM call fails, without altering AI Assessment window state) */}
      {errorPopupMessage && (
        <div
          id="ai-assessment-error-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            setErrorPopupMessage(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 10001,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            id="ai-assessment-error-popup"
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(520px, 92vw)',
              backgroundColor: 'hsl(222, 32%, 12%)',
              border: '1px solid rgba(239, 68, 68, 0.65)',
              borderRadius: '10px',
              boxShadow: '0 20px 50px rgba(0, 0, 0, 0.9)',
              padding: '20px 22px',
              color: '#f8fafc',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <AlertTriangle size={20} style={{ color: '#f87171', flexShrink: 0 }} />
              <h3
                style={{
                  margin: 0,
                  fontSize: '0.98rem',
                  fontWeight: 700,
                  color: '#fca5a5',
                }}
              >
                AI Assessment Request Error
              </h3>
            </div>
            <div
              style={{
                fontSize: '0.82rem',
                lineHeight: 1.5,
                color: '#e2e8f0',
                background: 'rgba(15, 23, 42, 0.85)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '6px',
                padding: '10px 12px',
                wordBreak: 'break-word',
                maxHeight: '260px',
                overflowY: 'auto',
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              }}
            >
              {errorPopupMessage}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                id="btn-dismiss-ai-error-popup"
                type="button"
                onClick={() => setErrorPopupMessage(null)}
                style={{
                  padding: '7px 16px',
                  borderRadius: '6px',
                  border: '1px solid rgba(239, 68, 68, 0.55)',
                  background: 'rgba(239, 68, 68, 0.22)',
                  color: '#fecaca',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
