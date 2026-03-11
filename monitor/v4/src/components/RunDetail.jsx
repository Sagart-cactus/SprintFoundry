import { useState, useEffect, useRef } from 'react'
import { useRunDetail, fetchStepResult, fetchStepLog, resumeRun } from '../hooks/useMonitor'
import { statusColor, statusLabel, agentColor, formatDuration, formatTimestamp, formatTokens, timeAgo, eventLabel, eventDotColor } from './utils'
import AgentActivity from './AgentActivity'
import FileDiffs from './FileDiffs'

export default function RunDetail({ projectId, runId }) {
  const { run, events, loading } = useRunDetail(projectId, runId)
  const [selectedStep, setSelectedStep] = useState(null)
  const [stepResult, setStepResult] = useState(null)
  const [stepLog, setStepLog] = useState('')
  const [logTab, setLogTab] = useState('result')
  const feedRef = useRef(null)

  const steps = run?.steps || []
  const plan = run?.plan || null
  const color = statusColor(run?.status)

  useEffect(() => {
    if (!selectedStep && steps.length > 0) {
      const running = steps.find(s => s.status === 'running')
      const failed = steps.find(s => s.status === 'failed')
      setSelectedStep(running?.step_number ?? failed?.step_number ?? steps[0]?.step_number)
    }
  }, [steps, selectedStep])

  useEffect(() => {
    if (selectedStep == null) return
    setStepResult(null)
    setStepLog('')
    fetchStepResult(projectId, runId, selectedStep).then(d => setStepResult(d.result)).catch(() => {})
  }, [selectedStep, projectId, runId])

  useEffect(() => {
    if (selectedStep == null || logTab === 'result') return
    setStepLog('')
    const kind = logTab === 'stdout' ? 'agent_stdout' : 'agent_stderr'
    fetchStepLog(projectId, runId, selectedStep, kind).then(setStepLog).catch(() => setStepLog('(no log available)'))
  }, [selectedStep, logTab, projectId, runId])

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [events])

  if (loading || !run) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-20 bg-surface-200 rounded-2xl" />
        <div className="h-64 bg-surface-200 rounded-2xl" />
      </div>
    )
  }

  const currentStep = steps.find(s => s.step_number === selectedStep)
  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || steps.length
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens || 0), 0)

  return (
    <div className="max-w-[1400px] space-y-5 animate-fade-in">
      {/* Run header */}
      <div className="bg-surface-100 border border-surface-300 rounded-2xl shadow-card p-5">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="font-display font-bold text-lg text-ink-900 leading-tight">
              {run.ticket_title || run.run_id}
            </h2>
            <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
              <span className="text-xs font-mono text-ink-400 bg-surface-200 px-2 py-0.5 rounded">{run.project_id}</span>
              {run.ticket_id && <span className="text-xs font-mono text-ink-400">{run.ticket_id}</span>}
              {plan?.classification && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-brand-light text-brand-text border border-brand-medium">
                  {plan.classification}
                </span>
              )}
              {run.resumed && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                  resumed &times;{run.resumed_count || 1}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {run.pr_url && (
              <a href={run.pr_url} target="_blank" rel="noreferrer"
                className="text-[11px] font-mono text-status-running hover:underline font-medium">
                View PR &rarr;
              </a>
            )}
            <span className={`text-[11px] font-mono font-semibold px-2.5 py-1 rounded-full border ${color.badge}`}>
              {statusLabel(run.status)}
            </span>
          </div>
        </div>

        {/* Metrics */}
        <div className="flex items-center gap-5 text-xs font-mono flex-wrap">
          <Chip label="Steps" value={`${completedSteps}/${totalSteps}`} />
          <Chip label="Tokens" value={formatTokens(totalTokens)} />
          {run.started_at && <Chip label="Started" value={formatTimestamp(run.started_at)} />}
          {run.branch && <Chip label="Branch" value={run.branch} />}
        </div>

        {/* Full pipeline */}
        <div className="mt-4 pt-4 border-t border-surface-300">
          <FullPipeline steps={steps} selectedStep={selectedStep} onSelectStep={setSelectedStep} stepModels={run.step_models} />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* Step detail */}
        <div className="lg:col-span-3 space-y-4">
          {currentStep ? (
            <StepDetail
              step={currentStep}
              stepResult={stepResult}
              stepLog={stepLog}
              logTab={logTab}
              onLogTab={setLogTab}
              stepModel={run.step_models?.[currentStep.step_number]}
              projectId={projectId}
              runId={runId}
            />
          ) : (
            <div className="bg-surface-100 border border-surface-300 rounded-2xl p-8 text-center">
              <p className="text-ink-400 text-sm">Select a step from the pipeline above</p>
            </div>
          )}

          {run.status === 'failed' && (
            <ResumePanel projectId={projectId} runId={runId} steps={steps} />
          )}
        </div>

        {/* Event feed */}
        <div className="lg:col-span-2">
          <EventFeed events={events} feedRef={feedRef} />
        </div>
      </div>

      {/* File diffs */}
      <details className="bg-surface-100 border border-surface-300 rounded-2xl shadow-card overflow-hidden">
        <summary className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-ink-400 cursor-pointer hover:text-ink-700 transition-colors">
          Workspace Files &amp; Diffs
        </summary>
        <div className="px-5 pb-5 border-t border-surface-300 mt-0 pt-4">
          <FileDiffs projectId={projectId} runId={runId} />
        </div>
      </details>

      {/* Plan reasoning */}
      {plan?.reasoning && (
        <details className="bg-surface-100 border border-surface-300 rounded-2xl shadow-card overflow-hidden">
          <summary className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-ink-400 cursor-pointer hover:text-ink-700 transition-colors">
            Plan Reasoning
          </summary>
          <div className="px-5 pb-5 border-t border-surface-300">
            <p className="text-xs text-ink-700 leading-relaxed whitespace-pre-wrap mt-3">{plan.reasoning}</p>
          </div>
        </details>
      )}
    </div>
  )
}

function FullPipeline({ steps, selectedStep, onSelectStep, stepModels }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {steps.map((step, i) => {
        const color = statusColor(step.status)
        const ac = agentColor(step.agent)
        const isSelected = step.step_number === selectedStep
        const isRunning = step.status === 'running'
        const model = stepModels?.[String(step.step_number)] || ''

        return (
          <div key={step.step_number ?? i} className="flex items-center gap-1.5">
            <button
              onClick={() => onSelectStep(step.step_number)}
              title={`Step ${step.step_number}: ${step.agent}${model ? ` (${model})` : ''} — ${step.status}`}
              className={`flex items-center gap-2 h-8 px-3 rounded-xl border transition-all duration-150 ${
                isSelected
                  ? `${ac.bg} ${ac.border} ${ac.text} ring-2 ring-brand/15`
                  : isRunning
                    ? `${ac.bg} ${ac.border} ${ac.text}`
                    : `${color.bg} ${color.border} hover:shadow-sm`
              }`}
            >
              {isRunning && <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
              <span className="text-[11px] font-mono leading-none text-ink-400">{step.step_number}</span>
              <span className={`text-[11px] font-mono font-medium ${isSelected || isRunning ? '' : color.text}`}>
                {step.agent}
              </span>
              {step.status === 'completed' && <span className="text-[10px] text-status-success">&#10003;</span>}
              {step.status === 'failed' && <span className="text-[10px] text-status-error">&#10007;</span>}
              {step.is_rework && <span className="text-[10px] text-orange-500">&#8634;</span>}
            </button>
            {i < steps.length - 1 && (
              <svg width="12" height="8" className="text-surface-400 flex-shrink-0">
                <path d="M0 4 L10 4" stroke="currentColor" strokeWidth="1" fill="none" />
                <path d="M7 1.5 L10 4 L7 6.5" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            )}
          </div>
        )
      })}
    </div>
  )
}

function StepDetail({ step, stepResult, stepLog, logTab, onLogTab, stepModel, projectId, runId }) {
  const color = statusColor(step.status)
  const ac = agentColor(step.agent)
  const duration = step.started_at && step.completed_at
    ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
    : step.started_at ? Date.now() - new Date(step.started_at).getTime() : null

  return (
    <div className="bg-surface-100 border border-surface-300 rounded-2xl shadow-card overflow-hidden">
      {/* Header */}
      <div className={`px-5 py-4 border-b border-surface-300 ${color.bg}`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${color.dot} ${step.status === 'running' ? 'animate-pulse-soft' : ''}`} />
            <span className={`text-sm font-mono font-bold ${ac.text}`}>{step.agent}</span>
            <span className="text-[10px] font-mono text-ink-400">step {step.step_number}</span>
          </div>
          <div className="flex items-center gap-2">
            {stepModel && (
              <span className="text-[10px] font-mono text-ink-400 bg-surface-100/80 px-2 py-0.5 rounded-full border border-surface-300">
                {stepModel}
              </span>
            )}
            <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${color.badge}`}>
              {statusLabel(step.status)}
            </span>
          </div>
        </div>
      </div>

      {/* Task */}
      {step.task && (
        <div className="px-5 py-3 border-b border-surface-300">
          <p className="text-xs text-ink-700 leading-relaxed">{step.task}</p>
        </div>
      )}

      {/* Metrics */}
      <div className="px-5 py-2.5 border-b border-surface-300 flex items-center gap-5 text-[11px] font-mono text-ink-400 flex-wrap">
        {step.tokens > 0 && <span>{formatTokens(step.tokens)} tokens</span>}
        {duration && <span>{formatDuration(duration)}</span>}
        {step.started_at && <span>started {formatTimestamp(step.started_at)}</span>}
        {step.resumed && <span className="text-blue-600">resumed</span>}
        {step.is_rework && <span className="text-orange-500">rework</span>}
      </div>

      {/* Tabs */}
      <div className="px-5 py-2 border-b border-surface-300 flex items-center gap-1">
        {['result', 'activity', 'stdout', 'stderr'].map(tab => (
          <button
            key={tab}
            onClick={() => onLogTab(tab)}
            className={`px-3 py-1 text-[11px] font-mono rounded-lg transition-all duration-150 capitalize ${
              logTab === tab
                ? 'bg-brand-light text-brand-text border border-brand-medium'
                : 'text-ink-400 hover:text-ink-700 hover:bg-surface-200'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-5 max-h-[50vh] overflow-y-auto">
        {logTab === 'result' ? (
          <StepResultView result={stepResult} />
        ) : logTab === 'activity' ? (
          <AgentActivity projectId={projectId} runId={runId} stepNumber={step.step_number} />
        ) : (
          <pre className="text-[11px] font-mono text-ink-700 leading-relaxed whitespace-pre-wrap break-words">
            {stepLog || <span className="text-ink-300 italic">Loading...</span>}
          </pre>
        )}
      </div>
    </div>
  )
}

function StepResultView({ result }) {
  if (!result) return <p className="text-xs text-ink-300 italic">No result available yet</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-ink-400">Status</span>
        <span className={`text-xs font-mono font-semibold ${
          result.status === 'complete' ? 'text-status-success' :
          result.status === 'failed' ? 'text-status-error' :
          result.status === 'needs_rework' ? 'text-status-warning' : 'text-ink-500'
        }`}>{result.status}</span>
      </div>

      {result.summary && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-ink-400 mb-1">Summary</p>
          <p className="text-xs text-ink-700 leading-relaxed whitespace-pre-wrap bg-surface-200 rounded-xl p-3 border border-surface-300">
            {result.summary}
          </p>
        </div>
      )}

      {(result.artifacts_created?.length > 0 || result.artifacts?.length > 0) && (
        <FileList label="Artifacts Created" files={result.artifacts_created || result.artifacts} color="text-status-success" />
      )}
      {result.artifacts_modified?.length > 0 && (
        <FileList label="Files Modified" files={result.artifacts_modified} color="text-status-warning" />
      )}

      {result.issues?.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-status-error mb-1.5">Issues ({result.issues.length})</p>
          <div className="space-y-1.5">
            {result.issues.map((issue, i) => (
              <div key={i} className="px-3 py-2 rounded-xl bg-status-error-light border border-status-error-border">
                <p className="text-[11px] text-status-error leading-relaxed">{issue}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.rework_reason && (
        <div className="px-3 py-2 rounded-xl bg-status-warning-light border border-status-warning-border">
          <p className="text-[10px] uppercase tracking-wider text-status-warning mb-1">Rework Reason</p>
          <p className="text-[11px] text-ink-700 leading-relaxed">{result.rework_reason}</p>
        </div>
      )}
    </div>
  )
}

function FileList({ label, files, color }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-ink-400 mb-1.5">{label} ({files.length})</p>
      <div className="space-y-1">
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-surface-200 border border-surface-300">
            <span className={`text-[10px] ${color}`}>&#9632;</span>
            <span className="text-[11px] font-mono text-ink-700 truncate">{f}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Chip({ label, value }) {
  return (
    <span className="flex items-center gap-1.5 text-xs font-mono">
      <span className="text-ink-400">{label}</span>
      <span className="text-ink-700">{value}</span>
    </span>
  )
}

// ── Event feed ──

function EventFeed({ events, feedRef }) {
  const significant = events.filter(e =>
    e.event_type?.startsWith('task.') ||
    e.event_type?.startsWith('step.') ||
    e.event_type?.startsWith('human_gate.') ||
    e.event_type === 'pr.created'
  )

  return (
    <div className="bg-surface-100 border border-surface-300 rounded-2xl shadow-card flex flex-col h-full max-h-[70vh]">
      <div className="px-4 py-3 border-b border-surface-300 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-ink-400">Live Events</h3>
        <span className="text-[10px] font-mono text-ink-300">{significant.length}</span>
      </div>
      <div ref={feedRef} className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {significant.length === 0 ? (
          <p className="text-xs text-ink-300 italic text-center py-8">No events yet</p>
        ) : (
          significant.map((event, i) => {
            const dotColor = eventDotColor(event.event_type)
            return (
              <div key={`${event.timestamp}-${i}`} className="flex items-start gap-2.5 py-1.5 px-2 rounded-lg hover:bg-surface-200 transition-colors">
                <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${dotColor}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium text-ink-700">{eventLabel(event.event_type)}</span>
                    {event.data?.agent && <span className="text-[10px] font-mono text-ink-400">{event.data.agent}</span>}
                    {event.data?.step != null && <span className="text-[10px] font-mono text-ink-300">#{event.data.step}</span>}
                  </div>
                  <span className="text-[10px] font-mono text-ink-300">{formatTimestamp(event.timestamp)}</span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ── Resume panel ──

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
    <div className="bg-status-warning-light border border-status-warning-border rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-2 h-2 rounded-full bg-status-warning" />
        <h3 className="text-xs font-semibold text-status-warning">Resume This Run</h3>
        {failedStep && (
          <span className="text-[10px] font-mono text-ink-400">
            from step {failedStep.step_number} ({failedStep.agent})
          </span>
        )}
      </div>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="Additional context for resume (optional)..."
        rows={2}
        className="w-full bg-surface-100 border border-surface-300 rounded-xl px-3 py-2 text-xs font-mono text-ink-700 placeholder:text-ink-300 focus:outline-none focus:border-brand/40 focus:ring-2 focus:ring-brand/10 resize-none"
      />
      <button
        onClick={handleResume}
        disabled={resuming}
        className="mt-2 h-8 px-4 rounded-xl text-xs font-semibold bg-brand-light text-brand-text border border-brand-medium hover:bg-brand-medium transition-all disabled:opacity-50 cursor-pointer"
      >
        {resuming ? 'Resuming...' : 'Resume Run'}
      </button>
    </div>
  )
}
