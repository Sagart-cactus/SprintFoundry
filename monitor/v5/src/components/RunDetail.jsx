import { useState, useEffect, useRef } from 'react'
import { useRunDetail, fetchStepResult, fetchStepLog, resumeRun, fetchReviews, submitReview } from '../hooks/useMonitor'
import { statusColor, statusLabel, agentColor, agentAbbrev, formatDuration, formatTokens, timeAgo, eventLabel, sourceLabel } from './utils'
import AgentActivity from './AgentActivity'
import FileDiffs from './FileDiffs'

/* ── Helpers ── */

function getDefaultStepNumber(steps) {
  if (steps.length === 0) return null
  const running = steps.find(s => s.status === 'running')
  const failed = steps.find(s => s.status === 'failed')
  return running?.step_number ?? failed?.step_number ?? steps[0]?.step_number ?? null
}

/* ── Main component ── */

export default function RunDetail({ projectId, runId }) {
  const { run, events, loading } = useRunDetail(projectId, runId)
  const [selectedStep, setSelectedStep] = useState(null)
  const [stepResult, setStepResult] = useState(null)
  const [outputLog, setOutputLog] = useState('')
  const [handoffState, setHandoffState] = useState('idle')
  const [rightTab, setRightTab] = useState('workspace')
  const [fileCount, setFileCount] = useState(0)
  const [reviews, setReviews] = useState([])
  const [planExpanded, setPlanExpanded] = useState(false)
  const feedRef = useRef(null)

  const steps = run?.steps || []
  const plan = run?.plan || null
  const currentStep = steps.find(s => s.step_number === selectedStep)

  // Reset on run change
  useEffect(() => {
    setSelectedStep(null)
    setStepResult(null)
    setOutputLog('')
    setRightTab('workspace')
  }, [projectId, runId])

  // Auto-select step
  useEffect(() => {
    const hasSelectedStep = steps.some(s => s.step_number === selectedStep)
    if (selectedStep == null || !hasSelectedStep) {
      setSelectedStep(getDefaultStepNumber(steps))
    }
  }, [steps, selectedStep])

  // Fetch step result on selection
  useEffect(() => {
    if (selectedStep == null) return
    let cancelled = false
    setStepResult(null)
    fetchStepResult(projectId, runId, selectedStep)
      .then(d => { if (!cancelled) setStepResult(d.result) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedStep, projectId, runId])

  // Fetch stdout for output stream
  useEffect(() => {
    if (selectedStep == null) return
    let cancelled = false
    setOutputLog('')
    fetchStepLog(projectId, runId, selectedStep, 'agent_stdout')
      .then(log => { if (!cancelled) setOutputLog(log) })
      .catch(() => { if (!cancelled) setOutputLog('') })
    return () => { cancelled = true }
  }, [selectedStep, projectId, runId])

  // Auto-scroll event feed
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [events])

  // Handoff copy timeout
  useEffect(() => {
    if (handoffState === 'idle') return
    const timeoutId = window.setTimeout(() => setHandoffState('idle'), 1800)
    return () => window.clearTimeout(timeoutId)
  }, [handoffState])

  // Fetch reviews for human gate status
  useEffect(() => {
    if (run?.status !== 'waiting_human_review') { setReviews([]); return }
    let cancelled = false
    fetchReviews(projectId, runId)
      .then(data => { if (!cancelled) setReviews(Array.isArray(data?.reviews) ? data.reviews : Array.isArray(data) ? data : []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [run?.status, projectId, runId])

  async function handleCopyHandoff() {
    const command = typeof run?.handoff_command === 'string' ? run.handoff_command.trim() : ''
    if (!command || run?.handoff_eligible !== true) return
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(command)
      } else {
        const input = document.createElement('textarea')
        input.value = command
        input.setAttribute('readonly', 'true')
        input.style.position = 'absolute'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.select()
        const copied = document.execCommand('copy')
        document.body.removeChild(input)
        if (!copied) throw new Error('Clipboard access is unavailable')
      }
      setHandoffState('copied')
    } catch {
      setHandoffState('failed')
    }
  }

  // Loading state
  if (loading || !run) {
    return (
      <div className="space-y-3 animate-pulse h-full">
        <div className="h-16 bg-surface-container rounded" />
        <div className="flex-1 flex gap-3">
          <div className="w-16 bg-surface-container rounded" />
          <div className="flex-1 bg-surface-container rounded" />
          <div className="flex-1 bg-surface-container rounded" />
        </div>
      </div>
    )
  }

  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || steps.length
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens || 0), 0)
  const duration = run.started_at && run.last_event_ts
    ? run.last_event_ts - new Date(run.started_at).getTime()
    : null
  const handoffEligible = run.handoff_eligible === true && typeof run.handoff_command === 'string' && run.handoff_command.trim().length > 0
  const statusInfo = statusColor(run.status)

  return (
    <div className="h-full flex flex-col gap-3 animate-fade-in">
      {/* ── Run Header ── */}
      <RunHeader
        run={run}
        plan={plan}
        statusInfo={statusInfo}
        completedSteps={completedSteps}
        totalSteps={totalSteps}
        totalTokens={totalTokens}
        duration={duration}
        handoffEligible={handoffEligible}
        handoffState={handoffState}
        onCopyHandoff={handleCopyHandoff}
      />

      {/* ── Plan Section (P0-3) ── */}
      {plan && (
        <PlanSection plan={plan} events={events} expanded={planExpanded} onToggle={() => setPlanExpanded(p => !p)} />
      )}

      {/* ── Human Review Panel (P0-4) ── */}
      {run.status === 'waiting_human_review' && reviews.length > 0 && (
        <ReviewPanel reviews={reviews} projectId={projectId} runId={runId} steps={steps} />
      )}

      {/* ── Main content: Pipeline + Activity + Workspace ── */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Vertical Pipeline */}
        <StepPipeline
          steps={steps}
          selectedStep={selectedStep}
          onSelectStep={setSelectedStep}
          stepModels={run.step_models}
          projectId={projectId}
          runId={runId}
          runStatus={run.status}
        />

        {/* Activity Panel */}
        <div className="flex-[55] min-w-0 flex flex-col gap-3">
          <div className="flex-1 bg-surface-container rounded overflow-hidden flex flex-col min-h-0">
            <ActivityHeader step={currentStep} stepModel={run.step_models?.[currentStep?.step_number]} />
            <div className="flex-1 overflow-y-auto p-3">
              {currentStep ? (
                <AgentActivity projectId={projectId} runId={runId} stepNumber={currentStep.step_number} />
              ) : (
                <div className="h-full flex items-center justify-center">
                  <p className="text-sm text-on-surface-variant">Select a step from the pipeline</p>
                </div>
              )}
            </div>
          </div>

          {/* Output Stream */}
          <OutputStream log={outputLog} />
        </div>

        {/* Right Panel: Workspace / History */}
        <div className="flex-[45] min-w-0 flex flex-col bg-surface-container rounded overflow-hidden">
          {/* Tab bar */}
          <div className="flex items-center border-b border-outline-variant">
            <button
              onClick={() => setRightTab('workspace')}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-2xs font-medium transition-colors ${
                rightTab === 'workspace'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 6l4-3 4 3v7H4V6z" />
                <path d="M2 6l6-5 6 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="label-technical">Workspace</span>
            </button>
            <button
              onClick={() => setRightTab('history')}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-2xs font-medium transition-colors ${
                rightTab === 'history'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 2.5" strokeLinecap="round" />
              </svg>
              <span className="label-technical">History</span>
            </button>
            <button
              onClick={() => setRightTab('result')}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-2xs font-medium transition-colors ${
                rightTab === 'result'
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3h10v10H3z" />
                <path d="M6 7h4M6 9.5h2.5" strokeLinecap="round" />
              </svg>
              <span className="label-technical">Result</span>
            </button>
            {rightTab === 'workspace' && fileCount > 0 && (
              <span className="ml-auto mr-3 text-2xs font-bold px-2 py-0.5 rounded bg-primary/20 text-primary label-technical">
                {fileCount} Changed
              </span>
            )}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {rightTab === 'workspace' ? (
              <div className="h-full flex flex-col">
                <div className="flex-1 overflow-auto">
                  <FileDiffs projectId={projectId} runId={runId} onFileCount={setFileCount} />
                </div>
                <ContextIntel plan={plan} stepResult={stepResult} />
              </div>
            ) : rightTab === 'result' ? (
              <StepResultPanel stepResult={stepResult} step={currentStep} />
            ) : (
              <EventFeed events={events} feedRef={feedRef} />
            )}
          </div>
        </div>
      </div>

      {/* Resume panel for failed runs */}
      {run.status === 'failed' && (
        <ResumePanel projectId={projectId} runId={runId} steps={steps} />
      )}
    </div>
  )
}

/* ── Run Header ── */

function RunHeader({ run, plan, statusInfo, completedSteps, totalSteps, totalTokens, duration, handoffEligible, handoffState, onCopyHandoff }) {
  const operationalAlerts = Array.isArray(run.operational_alerts) ? run.operational_alerts : []

  return (
    <div className="bg-surface-container rounded overflow-hidden">
      {/* Main header row */}
      <div className="px-4 py-3 flex items-center gap-4">
        {/* Left: Source + Title + Status */}
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {run.ticket_source && (
            run.ticket_url ? (
              <a
                href={run.ticket_url}
                target="_blank"
                rel="noreferrer"
                className="flex-shrink-0 text-2xs font-mono font-bold px-2 py-1 rounded bg-surface-container-high text-on-surface-variant label-technical hover:text-primary transition-colors"
              >
                {run.ticket_id || sourceLabel(run.ticket_source)}
              </a>
            ) : (
              <span className="flex-shrink-0 text-2xs font-mono font-bold px-2 py-1 rounded bg-surface-container-high text-on-surface-variant label-technical">
                {run.ticket_id || sourceLabel(run.ticket_source)}
              </span>
            )
          )}
          <h2 className="font-display font-bold text-on-surface truncate">
            {run.ticket_title || run.run_id}
          </h2>
          <StatusPill status={run.status} statusInfo={statusInfo} />
          {run.resumed && (
            <span className="text-2xs px-1.5 py-px rounded bg-primary/20 text-primary font-medium flex-shrink-0">
              Resumed{run.resumed_count > 1 ? ` x${run.resumed_count}` : ''}
            </span>
          )}
        </div>

        {/* Center: Project + Branch */}
        <div className="flex items-center gap-3 text-2xs text-on-surface-variant flex-shrink-0">
          <span className="flex items-center gap-1">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="2" width="12" height="12" rx="2" />
            </svg>
            {run.project_id}
          </span>
          {run.branch && (
            <span className="flex items-center gap-1 font-mono">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="5" cy="4" r="2" />
                <circle cx="11" cy="12" r="2" />
                <path d="M5 6v2c0 2 2 4 6 4" />
              </svg>
              <span className="max-w-[160px] truncate">{run.branch}</span>
            </span>
          )}
        </div>

        {/* Right: PR + Duration + Tokens + Handoff */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {run.pr_url && (
            <a
              href={run.pr_url}
              target="_blank"
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 text-2xs font-bold text-status-completed hover:underline"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M6.5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm6 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM5 5.5v5A3.5 3.5 0 0 0 8.5 14H10v-1.5H8.5a2 2 0 0 1-2-2v-5H5Zm6-2v3.17a3 3 0 0 1-.88 2.12l-.7.71 1.06 1.06.7-.7a4.5 4.5 0 0 0 1.32-3.19V3.5H11Z"/>
              </svg>
              PR #{run.pr_url.split('/').pop()}
            </a>
          )}
          {totalTokens > 0 && (
            <span className="text-2xs font-mono text-on-surface-variant">{formatTokens(totalTokens)} tok</span>
          )}
          {duration != null && (
            <span className="flex items-center gap-1 text-2xs text-on-surface-variant font-mono">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5V8l2.5 2.5" strokeLinecap="round" />
              </svg>
              {formatDuration(duration)}
            </span>
          )}
          {handoffEligible && (
            <button
              type="button"
              onClick={onCopyHandoff}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-2xs font-bold label-technical ghost-border text-primary hover:bg-primary/10 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="5" y="5" width="9" height="9" rx="1.5" />
                <path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" />
              </svg>
              {handoffState === 'copied' ? 'COPIED' : handoffState === 'failed' ? 'FAILED' : 'COPY HANDOFF'}
            </button>
          )}
        </div>
      </div>

      {/* Secondary info row: classification + progress + alerts */}
      {(plan?.classification || totalSteps > 0 || operationalAlerts.length > 0 || run.hosting_mode) && (
        <div className="px-4 py-2 border-t border-outline-variant flex items-center gap-4 text-2xs">
          {plan?.classification && (
            <span className="label-technical font-bold text-primary px-2 py-0.5 rounded bg-primary/10">
              {plan.classification.replace(/_/g, ' ')}
            </span>
          )}
          {run.hosting_mode && (
            <span className="font-mono text-on-surface-variant">{run.hosting_mode}</span>
          )}
          {run.trigger_source && (
            <span className="px-2 py-0.5 rounded bg-surface-container-highest text-on-surface-variant label-technical">
              {run.trigger_source === 'linear_webhook' ? '⚡ Webhook' : run.trigger_source}
            </span>
          )}
          {run.sandbox_state && (
            <span className="font-mono text-on-surface-variant">{run.sandbox_state}</span>
          )}
          {run.ticket_repo_url && (
            <a href={run.ticket_repo_url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors"
              onClick={e => e.stopPropagation()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="opacity-60">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              <span className="font-mono truncate max-w-[160px]">{run.ticket_repo_url.replace('https://github.com/', '')}</span>
            </a>
          )}
          {totalSteps > 0 && (
            <div className="flex items-center gap-2 flex-1 max-w-xs">
              <span className="text-on-surface-variant font-mono tabular-nums">{completedSteps}/{totalSteps}</span>
              <div className="flex-1 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: `${(completedSteps / totalSteps) * 100}%`,
                    backgroundColor: `var(--sf-status-${statusInfo.key})`,
                  }}
                />
              </div>
            </div>
          )}
          {operationalAlerts.slice(0, 3).map(alert => (
            <span
              key={alert.code || alert.label}
              className={`px-2 py-0.5 rounded font-medium ${
                alert.level === 'error'
                  ? 'bg-status-failed/10 text-status-failed'
                  : 'bg-status-warning/10 text-status-warning'
              }`}
              title={alert.detail || ''}
            >
              {alert.label}
            </span>
          ))}
          {run.started_at && (
            <span className="text-on-surface-variant ml-auto">Started {timeAgo(run.started_at)}</span>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Status Pill ── */

function StatusPill({ status, statusInfo }) {
  return (
    <span
      className="flex items-center gap-1.5 text-2xs font-bold px-2 py-0.5 rounded flex-shrink-0 label-technical"
      style={{
        backgroundColor: `var(--sf-status-${statusInfo.key}, var(--sf-status-pending))`,
        color: 'var(--sf-on-primary)',
      }}
    >
      {(status === 'executing' || status === 'running') && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse-soft" />
      )}
      {statusInfo.label}
    </span>
  )
}

/* ── Vertical Step Pipeline ── */

function StepPipeline({ steps, selectedStep, onSelectStep, stepModels, projectId, runId, runStatus }) {
  return (
    <div className="w-16 flex-shrink-0 bg-surface-container-low rounded py-3 flex flex-col items-center gap-1">
      {steps.map((step, i) => {
        const color = agentColor(step.agent)
        const abbrev = agentAbbrev(step.agent)
        const isSelected = step.step_number === selectedStep
        const isRunning = step.status === 'running'
        const isCompleted = step.status === 'completed'
        const isFailed = step.status === 'failed'
        const isRework = step.is_rework || step.step_number >= 900

        return (
          <div key={step.step_number ?? i} className="flex flex-col items-center">
            {/* Connector line */}
            {i > 0 && (
              <div
                className="w-px h-3 -mb-0.5"
                style={{
                  backgroundColor: steps[i - 1].status === 'completed' ? agentColor(steps[i - 1].agent) : 'var(--sf-outline-variant)',
                }}
              />
            )}

            {/* Step circle */}
            <div className="relative">
              <button
                onClick={() => onSelectStep(step.step_number)}
                title={`Step ${step.step_number}: ${step.agent} — ${step.status}${isRework ? ' (rework)' : ''}`}
                className={`relative w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                  isSelected ? 'ring-2 ring-offset-2' : ''
                }`}
                style={{
                  backgroundColor: isCompleted || isRunning || isFailed
                    ? color + (isSelected ? '' : '30')
                    : 'var(--sf-surface-container-high)',
                  ringColor: isSelected ? color : undefined,
                  '--tw-ring-offset-color': 'var(--sf-surface-container-low)',
                  '--tw-ring-color': color,
                }}
              >
                {isCompleted ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={isSelected ? '#fff' : color} strokeWidth="2">
                    <path d="M4 8l3 3 5-5.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : isRunning ? (
                  <div className="w-3 h-3 rounded-full animate-pulse-soft" style={{ backgroundColor: '#fff' }} />
                ) : isFailed ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke={isSelected ? '#fff' : color} strokeWidth="2">
                    <path d="M5 5l6 6M11 5l-6 6" strokeLinecap="round" />
                  </svg>
                ) : (
                  <div className="w-2.5 h-2.5 rounded-full bg-on-surface-variant/30" />
                )}

                {/* Active glow */}
                {isRunning && (
                  <div
                    className="absolute inset-0 rounded-full animate-glow-pulse"
                    style={{ boxShadow: `0 0 12px ${color}40` }}
                  />
                )}
              </button>

              {/* Per-step resume button (P0-5) */}
              {isFailed && runStatus === 'failed' && (
                <button
                  onClick={e => { e.stopPropagation(); resumeRun(projectId, runId, step.step_number) }}
                  title={`Resume from step ${step.step_number}`}
                  className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-status-failed flex items-center justify-center hover:scale-110 transition-transform"
                >
                  <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5">
                    <path d="M3 2l10 6-10 6V2z" fill="#fff" stroke="none" />
                  </svg>
                </button>
              )}
            </div>

            {/* Agent label + rework badge */}
            <span
              className={`text-2xs font-bold mt-1 label-technical ${isSelected ? 'text-on-surface' : 'text-on-surface-variant'}`}
              style={isSelected || isCompleted || isRunning ? { color } : undefined}
            >
              {abbrev}
            </span>
            {isRework && (
              <span className="text-[9px] font-bold px-1 rounded bg-status-rework/20 text-status-rework label-technical -mt-0.5">
                RW
              </span>
            )}
            {isCompleted && (step.duration_ms || step.tokens) && (
              <div className="flex flex-col items-center -mt-0.5">
                {step.duration_ms && (
                  <span className="text-[8px] text-on-surface-variant font-mono">{formatDuration(step.duration_ms)}</span>
                )}
                {step.tokens && (
                  <span className="text-[8px] text-on-surface-variant font-mono">{formatTokens(step.tokens)}</span>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── Activity Header ── */

function ActivityHeader({ step, stepModel }) {
  if (!step) return null
  const color = agentColor(step.agent)

  return (
    <>
      <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded flex items-center justify-center" style={{ backgroundColor: color + '30' }}>
            <AgentIcon agent={step.agent} color={color} />
          </div>
          <span className="label-technical text-xs font-bold" style={{ color }}>
            {step.agent.toUpperCase()} ACTIVITY
          </span>
          {step.status === 'running' && (
            <div className="w-1.5 h-1.5 rounded-full animate-pulse-soft" style={{ backgroundColor: color }} />
          )}
        </div>
        <div className="flex items-center gap-2">
          {stepModel && (
            <span className="text-2xs font-mono text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded">
              {stepModel}
            </span>
          )}
          {step.tokens > 0 && (
            <span className="text-2xs font-mono text-on-surface-variant">{formatTokens(step.tokens)} tok</span>
          )}
        </div>
      </div>
      {step.task && (
        <div className="px-4 py-1.5 border-b border-outline-variant">
          <p className="text-2xs text-on-surface-variant leading-relaxed truncate">
            {step.task}
          </p>
        </div>
      )}
      {/* Rework alert banner (P0-2) */}
      {(step.is_rework || step.step_number >= 900 || step.rework_reason) && (
        <div className="mx-4 mt-2 mb-1 px-3 py-1.5 rounded bg-status-rework/10 flex items-center gap-2">
          <span className="text-status-rework text-xs">{'↺'}</span>
          <span className="text-2xs text-status-rework">
            <span className="font-bold">Rework{step.rework_attempt ? ` (attempt ${step.rework_attempt})` : ''}</span>
            {step.rework_reason && <span> — {step.rework_reason}</span>}
          </span>
        </div>
      )}
    </>
  )
}

/* ── Agent Icon ── */

function AgentIcon({ agent, color, size = 14 }) {
  const type = agent?.replace(/-.*/, '') || ''
  switch (type) {
    case 'developer':
    case 'go':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <circle cx="8" cy="8" r="5" />
          <circle cx="8" cy="8" r="2" fill={color} />
        </svg>
      )
    case 'security':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <path d="M8 2L3 4.5v3.5c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4.5L8 2z" />
        </svg>
      )
    case 'architect':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M2 6h12M6 2v12" />
        </svg>
      )
    case 'qa':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <rect x="2" y="3" width="12" height="10" rx="1" />
          <path d="M5 7h6M5 10h4" strokeLinecap="round" />
        </svg>
      )
    case 'orchestrator':
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 2v2M8 12v2M2 8h2M12 8h2M4 4l1.5 1.5M10.5 10.5L12 12M12 4l-1.5 1.5M5.5 10.5L4 12" />
        </svg>
      )
    default:
      return (
        <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.5">
          <circle cx="8" cy="6" r="3" />
          <path d="M3 14c0-3 2.5-4 5-4s5 1 5 4" />
        </svg>
      )
  }
}

/* ── Output Stream ── */

function OutputStream({ log }) {
  const ref = useRef(null)
  const lines = (log || '').split('\n').filter(Boolean).slice(-50)

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [log])

  return (
    <div className="h-40 bg-surface-container rounded overflow-hidden flex flex-col flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-2 border-b border-outline-variant">
        <span className="label-technical text-2xs text-on-surface-variant">Output Stream</span>
        <span className="label-technical text-2xs text-on-surface-variant">STDOUT</span>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto p-3 bg-surface-container-lowest font-mono text-[11px] leading-relaxed">
        {lines.length === 0 ? (
          <div className="flex items-center gap-2 text-on-surface-variant">
            <span className="w-2 h-2 rounded-full bg-status-completed animate-pulse-soft" />
            Stream connected ...
          </div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className={`${getLogLineColor(line)}`}>
              {line}
            </div>
          ))
        )}
        <span className="inline-block w-1.5 h-3.5 bg-on-surface-variant/60 animate-pulse ml-0.5" />
      </div>
    </div>
  )
}

function getLogLineColor(line) {
  const lower = line.toLowerCase()
  if (lower.includes('success') || lower.includes('completed')) return 'text-status-completed'
  if (lower.includes('error') || lower.includes('failed')) return 'text-status-failed'
  if (lower.includes('exec') || lower.includes('running')) return 'text-status-warning'
  if (lower.includes('diff') || lower.includes('applying')) return 'text-on-surface-variant'
  return 'text-on-surface-variant/70'
}

/* ── Context Intel ── */

function ContextIntel({ plan, stepResult }) {
  const text = stepResult?.summary || plan?.reasoning
  if (!text) return null

  return (
    <div className="px-4 py-3 border-t border-outline-variant">
      <div className="flex items-center gap-1.5 mb-1.5">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-primary">
          <path d="M8 1l1.5 3.5L13 6l-2.5 3 .5 4L8 11.5 5 13l.5-4L3 6l3.5-1.5L8 1z" strokeLinejoin="round" />
        </svg>
        <span className="label-technical text-2xs font-bold text-primary">Context Intel</span>
      </div>
      <p className="text-xs text-on-surface-variant leading-relaxed line-clamp-3">
        {text}
      </p>
    </div>
  )
}

/* ── Event Feed (History tab) ── */

function EventFeed({ events, feedRef }) {
  const significant = events.filter(e =>
    e.event_type?.startsWith('task.') ||
    e.event_type?.startsWith('step.') ||
    e.event_type?.startsWith('human_gate.') ||
    e.event_type === 'pr.created'
  )

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2.5 border-b border-outline-variant flex items-center justify-between">
        <span className="label-technical text-2xs text-on-surface-variant">Events</span>
        <span className="text-2xs font-mono text-on-surface-variant tabular-nums">{significant.length}</span>
      </div>
      <div ref={feedRef} className="flex-1 overflow-y-auto px-1 py-1">
        {significant.length === 0 ? (
          <p className="text-xs text-on-surface-variant italic text-center py-10">No events yet</p>
        ) : (
          significant.map((event, i) => (
            <div key={`${event.timestamp}-${i}`} className="flex items-center gap-2 py-1.5 px-2.5 rounded hover:bg-surface-container-high/50 transition-colors">
              <EventDot eventType={event.event_type} />
              <span className="text-2xs font-mono text-on-surface-variant tabular-nums flex-shrink-0 w-14">
                {formatEventTime(event.timestamp)}
              </span>
              <span className="text-2xs font-medium text-on-surface truncate">{eventLabel(event.event_type)}</span>
              {event.data?.agent && (
                <span className="text-2xs font-mono flex-shrink-0" style={{ color: agentColor(event.data.agent) }}>
                  {event.data.agent}
                </span>
              )}
              {event.data?.step != null && (
                <span className="text-2xs font-mono text-on-surface-variant flex-shrink-0">#{event.data.step}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function EventDot({ eventType }) {
  let color = 'var(--sf-on-surface-variant)'
  if (eventType?.includes('completed') || eventType === 'pr.created') color = 'var(--sf-status-completed)'
  else if (eventType?.includes('failed')) color = 'var(--sf-status-failed)'
  else if (eventType?.includes('started')) color = 'var(--sf-status-executing)'
  else if (eventType?.includes('rework')) color = 'var(--sf-status-rework)'
  else if (eventType?.includes('human_gate')) color = 'var(--sf-status-warning)'

  return <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
}

function formatEventTime(ts) {
  if (!ts) return ''
  const d = new Date(typeof ts === 'number' ? ts : ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

/* ── Resume Panel ── */

function ResumePanel({ projectId, runId, steps }) {
  const [prompt, setPrompt] = useState('')
  const [resuming, setResuming] = useState(false)
  const failedStep = steps.find(s => s.status === 'failed')

  async function handleResume() {
    setResuming(true)
    try { await resumeRun(projectId, runId, failedStep?.step_number, prompt || undefined) }
    catch { /* */ }
    setResuming(false)
  }

  return (
    <div className="bg-status-failed/10 rounded p-4 flex items-start gap-4">
      <div className="flex items-center gap-2 flex-shrink-0">
        <div className="w-2 h-2 rounded-full bg-status-failed" />
        <span className="label-technical text-2xs font-bold text-status-failed">Resume This Run</span>
        {failedStep && (
          <span className="text-2xs font-mono text-on-surface-variant">
            from step {failedStep.step_number} ({failedStep.agent})
          </span>
        )}
      </div>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="Additional context for resume (optional)..."
        rows={1}
        className="flex-1 bg-surface-container-lowest rounded px-3 py-2 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-primary resize-none font-mono"
      />
      <button
        onClick={handleResume}
        disabled={resuming}
        className="h-8 px-4 rounded text-2xs font-bold label-technical bg-status-failed text-on-primary hover:opacity-90 transition-opacity disabled:opacity-50"
      >
        {resuming ? 'Resuming...' : 'Resume Run'}
      </button>
    </div>
  )
}

/* ── Plan Section (P0-3) ── */

function PlanSection({ plan, events, expanded, onToggle }) {
  const errors = events.filter(e =>
    e.event_type?.includes('failed') || e.event_type?.includes('error')
  ).slice(-6)

  return (
    <div className="bg-surface-container rounded overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-container-high/50 transition-colors"
      >
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
          className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="label-technical text-2xs font-bold text-on-surface-variant">Plan</span>
        {plan.plan_id && (
          <span className="text-2xs font-mono text-on-surface-variant">{plan.plan_id}</span>
        )}
        {plan.classification && (
          <span className="text-2xs font-bold text-primary px-1.5 py-px rounded bg-primary/10 label-technical">
            {plan.classification.replace(/_/g, ' ')}
          </span>
        )}
        <span className="text-2xs font-mono text-on-surface-variant">{plan.steps?.length || 0} steps</span>
        {errors.length > 0 && (
          <span className="ml-auto text-2xs font-bold px-1.5 py-px rounded bg-status-failed/10 text-status-failed">
            {errors.length} errors
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-outline-variant space-y-3 pt-3">
          {plan.reasoning && (
            <div>
              <span className="label-technical text-2xs text-on-surface-variant block mb-1">Reasoning</span>
              <p className="text-xs text-on-surface leading-relaxed">{plan.reasoning}</p>
            </div>
          )}
          {plan.steps?.length > 0 && (
            <div>
              <span className="label-technical text-2xs text-on-surface-variant block mb-1">Planned Steps</span>
              <div className="space-y-1">
                {plan.steps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 text-2xs">
                    <span className="w-5 text-right font-mono text-on-surface-variant">{s.step_number || i + 1}</span>
                    <span className="font-bold" style={{ color: agentColor(s.agent) }}>{s.agent}</span>
                    {s.task && <span className="text-on-surface-variant truncate">{s.task}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {errors.length > 0 && (
            <div>
              <span className="label-technical text-2xs text-status-failed block mb-1">Errors</span>
              <div className="space-y-1">
                {errors.map((e, i) => (
                  <div key={i} className="flex items-center gap-2 text-2xs">
                    <div className="w-1.5 h-1.5 rounded-full bg-status-failed flex-shrink-0" />
                    <span className="text-on-surface-variant truncate">{e.data?.message || eventLabel(e.event_type)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Human Review Panel (P0-4) ── */

function ReviewPanel({ reviews, projectId, runId, steps }) {
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(null)

  async function handleDecision(reviewId, decision) {
    setSubmitting(decision)
    try { await submitReview(projectId, runId, reviewId, decision, feedback || undefined) }
    catch { /* */ }
    setSubmitting(null)
    setFeedback('')
  }

  return (
    <div className="space-y-2">
      {reviews.map(review => {
        const step = steps.find(s => s.step_number === review.after_step)
        return (
          <div key={review.review_id} className="bg-status-warning/10 rounded p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-2xs font-bold px-2 py-0.5 rounded bg-status-warning/20 text-status-warning label-technical">
                Human Gate
              </span>
              <span className="text-2xs font-mono text-on-surface-variant">
                After step {review.after_step}{step ? ` · ${step.agent}` : ''} · {review.review_id}
              </span>
            </div>
            {review.summary && (
              <p className="text-xs text-on-surface leading-relaxed max-h-32 overflow-y-auto">
                {review.summary}
              </p>
            )}
            <textarea
              value={feedback}
              onChange={e => setFeedback(e.target.value)}
              placeholder="Optional feedback..."
              rows={2}
              className="w-full bg-surface-container-lowest rounded px-3 py-2 text-xs text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:ring-1 focus:ring-primary resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleDecision(review.review_id, 'approved')}
                disabled={submitting != null}
                className="flex-1 h-8 rounded text-2xs font-bold label-technical bg-status-completed text-on-primary hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {submitting === 'approved' ? 'Approving...' : 'Approve'}
              </button>
              <button
                onClick={() => handleDecision(review.review_id, 'rejected')}
                disabled={submitting != null}
                className="flex-1 h-8 rounded text-2xs font-bold label-technical border border-status-failed text-status-failed hover:bg-status-failed/10 transition-colors disabled:opacity-50"
              >
                {submitting === 'rejected' ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── Step Result Panel (P0-1) ── */

function StepResultPanel({ stepResult, step }) {
  if (!stepResult) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-xs text-on-surface-variant italic">
          {step ? 'Loading step result...' : 'Select a step to view its result'}
        </p>
      </div>
    )
  }

  const artifactsCreated = stepResult.artifacts_created || []
  const artifactsModified = stepResult.artifacts_modified || stepResult.files_modified || []
  const issues = stepResult.issues || []
  const metadata = stepResult.metadata || stepResult

  // Build a clean metadata object excluding already-displayed fields
  const metaEntries = Object.entries(metadata).filter(([k]) =>
    !['summary', 'status', 'artifacts_created', 'artifacts_modified', 'files_modified', 'issues', 'source'].includes(k)
  )

  return (
    <div className="h-full overflow-y-auto">
      {/* Summary */}
      <div className="px-4 py-3 border-b border-outline-variant">
        <span className="label-technical text-2xs text-on-surface-variant block mb-1">Summary</span>
        <div className="flex items-center gap-2 mb-1.5">
          {stepResult.status && (
            <span className={`text-2xs font-bold px-1.5 py-px rounded label-technical ${
              stepResult.status === 'complete' || stepResult.status === 'completed'
                ? 'bg-status-completed/10 text-status-completed'
                : 'bg-status-failed/10 text-status-failed'
            }`}>
              {stepResult.status}
            </span>
          )}
          {stepResult.source && (
            <span className="text-2xs font-mono text-on-surface-variant">{stepResult.source}</span>
          )}
        </div>
        {stepResult.summary && (
          <p className="text-xs text-on-surface leading-relaxed">{stepResult.summary}</p>
        )}
      </div>

      {/* Artifacts Created */}
      <CollapsibleSection title="Artifacts Created" count={artifactsCreated.length}>
        {artifactsCreated.length === 0 ? (
          <span className="text-2xs text-on-surface-variant italic">None</span>
        ) : (
          <div className="space-y-1">
            {artifactsCreated.map((f, i) => (
              <div key={i} className="text-2xs font-mono text-on-surface px-2 py-1 rounded bg-surface-container-lowest">
                {typeof f === 'string' ? f : f.path || f.name || JSON.stringify(f)}
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* Files Modified */}
      <CollapsibleSection title="Files Modified" count={artifactsModified.length}>
        {artifactsModified.length === 0 ? (
          <span className="text-2xs text-on-surface-variant italic">None</span>
        ) : (
          <div className="space-y-1">
            {artifactsModified.map((f, i) => (
              <div key={i} className="text-2xs font-mono text-on-surface px-2 py-1 rounded bg-surface-container-lowest">
                {typeof f === 'string' ? f : f.path || f.name || JSON.stringify(f)}
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* Issues */}
      <CollapsibleSection title="Issues" count={issues.length}>
        {issues.length === 0 ? (
          <span className="text-2xs text-on-surface-variant italic">None</span>
        ) : (
          <div className="space-y-1">
            {issues.map((issue, i) => (
              <div key={i} className="flex items-start gap-2 text-2xs">
                <div className="w-1.5 h-1.5 rounded-full bg-status-warning flex-shrink-0 mt-1" />
                <span className="text-on-surface">{typeof issue === 'string' ? issue : issue.message || JSON.stringify(issue)}</span>
              </div>
            ))}
          </div>
        )}
      </CollapsibleSection>

      {/* Metadata */}
      {metaEntries.length > 0 && (
        <CollapsibleSection title="Metadata" count={metaEntries.length}>
          <MetadataTree data={Object.fromEntries(metaEntries)} />
        </CollapsibleSection>
      )}
    </div>
  )
}

/* ── Collapsible Section ── */

function CollapsibleSection({ title, count, children }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-outline-variant">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-container-high/50 transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
          className={`transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="label-technical text-2xs font-bold text-on-surface-variant">{title}</span>
        {count != null && (
          <span className="text-2xs font-mono text-on-surface-variant">({count})</span>
        )}
      </button>
      {open && (
        <div className="px-4 pb-3">
          {children}
        </div>
      )}
    </div>
  )
}

/* ── Metadata Tree ── */

function MetadataTree({ data, depth = 0 }) {
  if (data == null) return <span className="text-2xs text-on-surface-variant italic">—</span>

  if (typeof data !== 'object') {
    if (typeof data === 'boolean') {
      return <span className={`text-2xs font-mono ${data ? 'text-status-completed' : 'text-on-surface-variant'}`}>{data ? 'Yes' : 'No'}</span>
    }
    if (typeof data === 'string' && (data.startsWith('http://') || data.startsWith('https://'))) {
      return <a href={data} target="_blank" rel="noreferrer" className="text-2xs font-mono text-primary hover:underline break-all">{data}</a>
    }
    return <span className="text-2xs font-mono text-on-surface break-all">{String(data)}</span>
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-2xs text-on-surface-variant italic">[]</span>
    if (data.every(v => typeof v !== 'object')) {
      return (
        <div className="flex flex-wrap gap-1">
          {data.map((v, i) => (
            <span key={i} className="text-2xs font-mono px-1.5 py-px rounded bg-surface-container-highest text-on-surface">{String(v)}</span>
          ))}
        </div>
      )
    }
  }

  const entries = Array.isArray(data) ? data.map((v, i) => [String(i), v]) : Object.entries(data)

  return (
    <div className={`space-y-1 ${depth > 0 ? 'ml-3 pl-2 border-l border-outline-variant/50' : ''}`}>
      {entries.map(([key, value]) => {
        const isObj = value != null && typeof value === 'object'
        if (isObj) {
          return (
            <details key={key} className="group">
              <summary className="flex items-center gap-2 cursor-pointer text-2xs hover:bg-surface-container-high/50 rounded px-1 py-0.5">
                <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
                  className="transition-transform group-open:rotate-90">
                  <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="font-mono text-on-surface-variant">{key}</span>
                <span className="text-on-surface-variant/50">
                  {Array.isArray(value) ? `[${value.length}]` : `{${Object.keys(value).length}}`}
                </span>
              </summary>
              <div className="mt-1">
                <MetadataTree data={value} depth={depth + 1} />
              </div>
            </details>
          )
        }
        return (
          <div key={key} className="flex items-baseline gap-2 text-2xs px-1">
            <span className="font-mono text-on-surface-variant flex-shrink-0">{key}:</span>
            <MetadataTree data={value} depth={depth + 1} />
          </div>
        )
      })}
    </div>
  )
}
