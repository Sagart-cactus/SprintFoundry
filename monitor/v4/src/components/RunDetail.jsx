import { useState, useEffect, useRef } from 'react'
import { useRunDetail, fetchStepResult, fetchStepLog, resumeRun } from '../hooks/useMonitor'
import { statusColor, statusLabel, agentColor, sourceStyle, formatDuration, formatTimestamp, formatTokens, timeAgo, eventLabel, eventDotColor } from './utils'
import AgentActivity from './AgentActivity'
import FileDiffs from './FileDiffs'

function getDefaultStepNumber(steps) {
  if (steps.length === 0) return null
  const running = steps.find(s => s.status === 'running')
  const failed = steps.find(s => s.status === 'failed')
  return running?.step_number ?? failed?.step_number ?? steps[0]?.step_number ?? null
}

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
    setSelectedStep(null)
    setStepResult(null)
    setStepLog('')
  }, [projectId, runId])

  useEffect(() => {
    const hasSelectedStep = steps.some(s => s.step_number === selectedStep)
    if (selectedStep == null || !hasSelectedStep) {
      setSelectedStep(getDefaultStepNumber(steps))
    }
  }, [steps, selectedStep])

  useEffect(() => {
    if (selectedStep == null) return
    let cancelled = false
    setStepResult(null)
    setStepLog('')
    fetchStepResult(projectId, runId, selectedStep)
      .then(d => { if (!cancelled) setStepResult(d.result) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selectedStep, projectId, runId])

  useEffect(() => {
    if (selectedStep == null || logTab === 'result') return
    let cancelled = false
    setStepLog('')
    const kind = logTab === 'stdout' ? 'agent_stdout' : 'agent_stderr'
    fetchStepLog(projectId, runId, selectedStep, kind)
      .then(log => { if (!cancelled) setStepLog(log) })
      .catch(() => { if (!cancelled) setStepLog('(no log available)') })
    return () => { cancelled = true }
  }, [selectedStep, logTab, projectId, runId])

  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight
  }, [events])

  if (loading || !run) {
    return (
      <div className="space-y-4 animate-pulse max-w-6xl">
        <div className="h-24 bg-surface-200 rounded-xl" />
        <div className="h-72 bg-surface-200 rounded-xl" />
      </div>
    )
  }

  const currentStep = steps.find(s => s.step_number === selectedStep)
  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || steps.length
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens || 0), 0)
  const src = run.ticket_source ? sourceStyle(run.ticket_source) : null
  const duration = run.started_at && run.last_event_ts
    ? run.last_event_ts - new Date(run.started_at).getTime()
    : null

  return (
    <div className="max-w-6xl space-y-4 animate-fade-in">
      {/* Run header — left status strip like RunCard */}
      <div className="bg-surface-0 border border-surface-200 rounded-xl shadow-card overflow-hidden flex">
        <div className={`w-1.5 flex-shrink-0 ${color.bar}`} />
        <div className="flex-1 min-w-0 p-5">
          {/* Row 1: Title + status + PR */}
          <div className="flex items-start justify-between gap-4 mb-2">
            <h2 className="text-lg font-semibold text-ink-900 leading-tight truncate">
              {run.ticket_title || run.run_id}
            </h2>
            <div className="flex items-center gap-2 flex-shrink-0">
              {run.pr_url && (
                <a href={run.pr_url} target="_blank" rel="noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 text-2xs font-semibold text-status-success px-2 py-0.5 rounded bg-status-success-light border border-status-success-border hover:shadow-sm transition-all">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
                    <path d="M6.5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm6 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM5 5.5v5A3.5 3.5 0 0 0 8.5 14H10v-1.5H8.5a2 2 0 0 1-2-2v-5H5Zm6-2v3.17a3 3 0 0 1-.88 2.12l-.7.71 1.06 1.06.7-.7a4.5 4.5 0 0 0 1.32-3.19V3.5H11Z"/>
                  </svg>
                  PR
                </a>
              )}
              {run.resumed && (
                <span className="text-2xs px-1.5 py-px rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium">
                  Resumed{run.resumed_count > 1 ? ` ×${run.resumed_count}` : ''}
                </span>
              )}
              <span className={`text-2xs font-semibold px-2 py-0.5 rounded border ${color.badge}`}>
                {statusLabel(run.status)}
              </span>
            </div>
          </div>

          {/* Row 2: Flat metadata line — source · ticket · project · classification · branch */}
          <div className="flex items-center gap-1.5 text-xs text-ink-400 mb-3 flex-wrap">
            {src && (
              <span className={`inline-flex items-center gap-1 font-medium ${src.color}`}>
                <SourceIcon source={run.ticket_source} />
                {run.ticket_id && run.ticket_url ? (
                  <a href={run.ticket_url} target="_blank" rel="noreferrer"
                    className="hover:underline" onClick={e => e.stopPropagation()}>
                    {run.ticket_id}
                  </a>
                ) : (
                  run.ticket_id || src.label
                )}
              </span>
            )}
            {!src && run.ticket_id && (
              <span className="font-mono">{run.ticket_id}</span>
            )}
            <span className="text-ink-300">&middot;</span>
            <span>{run.project_id}</span>
            {plan?.classification && (
              <>
                <span className="text-ink-300">&middot;</span>
                <span className="text-brand font-medium">{plan.classification}</span>
              </>
            )}
            {run.branch && (
              <>
                <span className="text-ink-300">&middot;</span>
                <span className="font-mono text-ink-300 truncate max-w-[220px]">{run.branch}</span>
              </>
            )}
            {run.trigger_source && run.trigger_source !== 'cli' && (
              <>
                <span className="text-ink-300">&middot;</span>
                <span className="text-ink-300">via {run.trigger_source}</span>
              </>
            )}
          </div>

          {/* Row 3: Metrics — inline with middots, matching RunCard */}
          <div className="flex items-center gap-3 text-xs text-ink-400 mb-4">
            {totalSteps > 0 && (
              <div className="flex items-center gap-2 flex-1 min-w-0 max-w-xs">
                <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${color.bar}`}
                    style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
                  />
                </div>
                <span className="font-mono tabular-nums flex-shrink-0">{completedSteps}/{totalSteps}</span>
              </div>
            )}
            {totalTokens > 0 && <span className="font-mono">{formatTokens(totalTokens)}</span>}
            {duration && <span>{formatDuration(duration)}</span>}
            {run.started_at && <span>{formatTimestamp(run.started_at)}</span>}
            {run.ticket_repo_url && (
              <a href={run.ticket_repo_url} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-ink-400 hover:text-brand transition-colors ml-auto"
                onClick={e => e.stopPropagation()}>
                <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
                  <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/>
                </svg>
                Repo
              </a>
            )}
          </div>

          {/* Pipeline */}
          <FullPipeline steps={steps} selectedStep={selectedStep} onSelectStep={setSelectedStep} stepModels={run.step_models} />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
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
            <div className="bg-surface-0 border border-surface-200 rounded-xl p-10 text-center">
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

      {/* Collapsible sections */}
      <CollapsibleSection title="Workspace Files & Diffs">
        <FileDiffs projectId={projectId} runId={runId} />
      </CollapsibleSection>

      {plan?.reasoning && (
        <CollapsibleSection title="Plan Reasoning">
          <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap">{plan.reasoning}</p>
        </CollapsibleSection>
      )}
    </div>
  )
}

function CollapsibleSection({ title, children }) {
  return (
    <details className="bg-surface-0 border border-surface-200 rounded-xl shadow-card overflow-hidden group">
      <summary className="px-5 py-3 text-sm font-medium text-ink-500 cursor-pointer hover:text-ink-900 transition-colors flex items-center gap-2">
        <svg className="w-3.5 h-3.5 transition-transform group-open:rotate-90 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        {title}
      </summary>
      <div className="px-5 pb-4 border-t border-surface-200 pt-4">
        {children}
      </div>
    </details>
  )
}

function FullPipeline({ steps, selectedStep, onSelectStep, stepModels }) {
  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {steps.map((step, i) => {
        const color = statusColor(step.status)
        const ac = agentColor(step.agent)
        const isSelected = step.step_number === selectedStep
        const isRunning = step.status === 'running'
        const model = stepModels?.[String(step.step_number)] || ''

        return (
          <div key={step.step_number ?? i} className="flex items-center gap-0.5">
            <button
              onClick={() => onSelectStep(step.step_number)}
              title={`Step ${step.step_number}: ${step.agent}${model ? ` (${model})` : ''} — ${step.status}`}
              className={`flex items-center gap-1 h-7 px-2 rounded border text-2xs font-mono transition-all duration-100 ${
                isSelected
                  ? `${ac.bg} ${ac.border} ${ac.text} ring-2 ring-brand/20`
                  : isRunning
                    ? `${ac.bg} ${ac.border} ${ac.text}`
                    : step.status === 'completed'
                      ? `${color.bg} ${color.border} hover:shadow-sm`
                      : step.status === 'failed'
                        ? `${color.bg} ${color.border} hover:shadow-sm`
                        : 'bg-surface-100 border-surface-200 hover:shadow-sm'
              }`}
            >
              {isRunning && <div className="w-1 h-1 rounded-full bg-current animate-pulse" />}
              <span className="text-ink-400">{step.step_number}</span>
              <span className={`font-medium ${isSelected || isRunning ? '' : color.text}`}>
                {step.agent}
              </span>
              {step.status === 'completed' && <span className="text-status-success text-[9px]">&#10003;</span>}
              {step.status === 'failed' && <span className="text-status-error text-[9px]">&#10007;</span>}
              {step.is_rework && <span className="text-status-rework text-[9px]">&#8634;</span>}
            </button>
            {i < steps.length - 1 && (
              <span className="text-ink-300 text-[9px]">&rsaquo;</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── StepDetail: collapsed layered cake into 2 sections (header+content) ──

function StepDetail({ step, stepResult, stepLog, logTab, onLogTab, stepModel, projectId, runId }) {
  const color = statusColor(step.status)
  const ac = agentColor(step.agent)
  const duration = step.started_at && step.completed_at
    ? new Date(step.completed_at).getTime() - new Date(step.started_at).getTime()
    : step.started_at ? Date.now() - new Date(step.started_at).getTime() : null

  return (
    <div className="bg-surface-0 border border-surface-200 rounded-xl shadow-card overflow-hidden">
      {/* Compact header: agent + metrics + tabs all in one block */}
      <div className={`px-4 py-3 ${color.bg} border-b border-surface-200`}>
        {/* Agent name + status + model */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2">
            {step.status === 'running' && <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />}
            <span className={`text-sm font-mono font-bold ${ac.text}`}>{step.agent}</span>
            <span className="text-2xs font-mono text-ink-400">#{step.step_number}</span>
            {step.is_rework && <span className="text-2xs text-status-rework font-medium">rework</span>}
            {step.resumed && <span className="text-2xs text-blue-600 font-medium">resumed</span>}
          </div>
          <div className="flex items-center gap-2">
            {stepModel && (
              <span className="text-2xs font-mono text-ink-400 bg-surface-0/80 px-1.5 py-px rounded border border-surface-200">
                {stepModel}
              </span>
            )}
            <span className={`text-2xs font-semibold px-2 py-px rounded border ${color.badge}`}>
              {statusLabel(step.status)}
            </span>
          </div>
        </div>

        {/* Inline metrics */}
        <div className="flex items-center gap-3 text-2xs text-ink-400">
          {step.tokens > 0 && <span className="font-mono">{formatTokens(step.tokens)} tok</span>}
          {duration && <span>{formatDuration(duration)}</span>}
          {step.started_at && <span>{formatTimestamp(step.started_at)}</span>}
        </div>
      </div>

      {/* Task description — only if present, light background, no extra border */}
      {step.task && (
        <div className="px-4 py-2.5 bg-surface-50 border-b border-surface-100">
          <p className="text-xs text-ink-600 leading-relaxed">{step.task}</p>
        </div>
      )}

      {/* Tabs — tighter, integrated */}
      <div className="px-4 py-1.5 border-b border-surface-200 flex items-center gap-0.5">
        {['result', 'activity', 'stdout', 'stderr'].map(tab => (
          <button
            key={tab}
            onClick={() => onLogTab(tab)}
            className={`px-2.5 py-1 text-2xs font-medium rounded transition-all duration-100 capitalize ${
              logTab === tab
                ? 'bg-brand text-white'
                : 'text-ink-400 hover:text-ink-700 hover:bg-surface-100'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4 max-h-[50vh] overflow-y-auto">
        {logTab === 'result' ? (
          <StepResultView result={stepResult} />
        ) : logTab === 'activity' ? (
          <AgentActivity projectId={projectId} runId={runId} stepNumber={step.step_number} />
        ) : (
          <pre className="text-xs font-mono text-ink-700 leading-relaxed whitespace-pre-wrap break-words">
            {stepLog || <span className="text-ink-300 italic">Loading...</span>}
          </pre>
        )}
      </div>
    </div>
  )
}

function StepResultView({ result }) {
  if (!result) return <p className="text-sm text-ink-300 italic">No result available yet</p>

  return (
    <div className="space-y-3">
      {result.summary && (
        <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap bg-surface-50 rounded-lg p-3.5 border border-surface-200">
          {result.summary}
        </p>
      )}

      {(result.artifacts_created?.length > 0 || result.artifacts?.length > 0) && (
        <FileList label="Created" files={result.artifacts_created || result.artifacts} color="text-status-success" />
      )}
      {result.artifacts_modified?.length > 0 && (
        <FileList label="Modified" files={result.artifacts_modified} color="text-status-warning" />
      )}

      {result.issues?.length > 0 && (
        <div>
          <p className="text-2xs uppercase tracking-wider text-status-error font-medium mb-1.5">Issues ({result.issues.length})</p>
          <div className="space-y-1">
            {result.issues.map((issue, i) => (
              <div key={i} className="px-3 py-2 rounded-lg bg-status-error-light border border-status-error-border">
                <p className="text-xs text-status-error leading-relaxed">{issue}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {result.rework_reason && (
        <div className="px-3 py-2 rounded-lg bg-status-warning-light border border-status-warning-border">
          <p className="text-2xs uppercase tracking-wider text-status-warning font-medium mb-0.5">Rework Reason</p>
          <p className="text-xs text-ink-700 leading-relaxed">{result.rework_reason}</p>
        </div>
      )}
    </div>
  )
}

function FileList({ label, files, color }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-ink-400 font-medium mb-1">{label} ({files.length})</p>
      <div className="flex flex-wrap gap-1">
        {files.map((f, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-2xs font-mono text-ink-600 px-2 py-0.5 rounded bg-surface-50 border border-surface-200">
            <span className={`text-[8px] ${color}`}>&#9632;</span>
            {f}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Source icon ──

function SourceIcon({ source }) {
  if (source === 'linear') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
        <path d="M1.16 10.2a7.03 7.03 0 0 1-.46-1.6l5.7 5.7a7.03 7.03 0 0 1-1.6-.46L1.16 10.2Zm3.08 2.81L.43 9.2a7 7 0 0 0 .65 1.42l1.75 1.75a7 7 0 0 0 1.42.65Zm-2.68-4.2L5.8 13.05a7.03 7.03 0 0 1-1.82-.78L.78 9.01a7 7 0 0 1-.78-1.82l-.01.01Zm-.63-1.07 7.3 7.3c.34-.12.67-.26.99-.42L2.28 7.68c-.16.32-.3.65-.42.99Zm8.28 7.72.02-.01-7.65-7.65a7 7 0 0 0-.2.56l7.29 7.3c.18-.07.36-.13.54-.2Zm1.12-.52L2.06 6.67A7 7 0 0 0 .96 8.08l6.96 6.96a7 7 0 0 0 1.41-1.1ZM14.48 13A7 7 0 0 0 8 1a7 7 0 0 0-5.44 2.6L13 14.04c.55-.3 1.05-.66 1.49-1.05Z"/>
      </svg>
    )
  }
  if (source === 'github') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
      </svg>
    )
  }
  if (source === 'jira') {
    return (
      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="flex-shrink-0">
        <path d="M15.52 7.27 8.73.48 8 0 2.64 5.36.48 7.52a.67.67 0 0 0 0 .96l4.89 4.89L8 16l5.36-5.36.16-.16 2-2a.67.67 0 0 0 0-.96ZM8 10.18 5.82 8 8 5.82 10.18 8 8 10.18Z"/>
      </svg>
    )
  }
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="flex-shrink-0">
      <path d="M4 5l3 3-3 3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 11h3" strokeLinecap="round"/>
    </svg>
  )
}

// ── Event feed — dense log-style ──

function EventFeed({ events, feedRef }) {
  const significant = events.filter(e =>
    e.event_type?.startsWith('task.') ||
    e.event_type?.startsWith('step.') ||
    e.event_type?.startsWith('human_gate.') ||
    e.event_type === 'pr.created'
  )

  return (
    <div className="bg-surface-0 border border-surface-200 rounded-xl shadow-card flex flex-col h-full max-h-[70vh]">
      <div className="px-4 py-2.5 border-b border-surface-200 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-ink-600 uppercase tracking-wider">Events</h3>
        <span className="text-2xs font-mono text-ink-300 tabular-nums">{significant.length}</span>
      </div>
      <div ref={feedRef} className="flex-1 overflow-y-auto px-1 py-1">
        {significant.length === 0 ? (
          <p className="text-xs text-ink-300 italic text-center py-10">No events yet</p>
        ) : (
          significant.map((event, i) => {
            const dotColor = eventDotColor(event.event_type)
            return (
              <div key={`${event.timestamp}-${i}`} className="flex items-center gap-2 py-1 px-2.5 rounded hover:bg-surface-50 transition-colors">
                <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                <span className="text-2xs font-mono text-ink-300 tabular-nums flex-shrink-0 w-16">
                  {formatTimestamp(event.timestamp)}
                </span>
                <span className="text-2xs font-medium text-ink-600 truncate">{eventLabel(event.event_type)}</span>
                {event.data?.agent && <span className="text-2xs font-mono text-ink-400 flex-shrink-0">{event.data.agent}</span>}
                {event.data?.step != null && <span className="text-2xs font-mono text-ink-300 flex-shrink-0">#{event.data.step}</span>}
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
    <div className="bg-status-warning-light border border-status-warning-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="w-2 h-2 rounded-full bg-status-warning" />
        <h3 className="text-xs font-semibold text-status-warning">Resume This Run</h3>
        {failedStep && (
          <span className="text-2xs font-mono text-ink-400">
            from step {failedStep.step_number} ({failedStep.agent})
          </span>
        )}
      </div>
      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        placeholder="Additional context for resume (optional)..."
        rows={2}
        className="w-full bg-surface-0 border border-surface-200 rounded-lg px-3 py-2 text-xs text-ink-700 placeholder:text-ink-400 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 resize-none"
      />
      <button
        onClick={handleResume}
        disabled={resuming}
        className="mt-2 h-8 px-3.5 rounded-lg text-xs font-semibold bg-status-warning text-white hover:bg-status-warning/90 transition-all disabled:opacity-50 cursor-pointer"
      >
        {resuming ? 'Resuming...' : 'Resume Run'}
      </button>
    </div>
  )
}
