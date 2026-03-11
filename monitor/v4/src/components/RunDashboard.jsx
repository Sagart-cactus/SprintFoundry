import { useMemo } from 'react'
import { statusColor, statusLabel, agentColor, timeAgo, formatTokens, formatDuration, isEmptyRun, isStaleRun } from './utils'

export default function RunDashboard({ runs, searchQuery, onSelectRun }) {
  const filtered = useMemo(() => {
    let list = runs.filter(r => !isEmptyRun(r))
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(r =>
        r.run_id?.toLowerCase().includes(q) ||
        r.project_id?.toLowerCase().includes(q) ||
        r.ticket_title?.toLowerCase().includes(q) ||
        r.ticket_id?.toLowerCase().includes(q) ||
        r.classification?.toLowerCase().includes(q)
      )
    }
    return list
  }, [runs, searchQuery])

  const active = filtered.filter(r => ['executing', 'planning', 'pending', 'waiting_human_review', 'rework'].includes(r.status))
  const failed = filtered.filter(r => r.status === 'failed')
  const completed = filtered.filter(r => r.status === 'completed')

  return (
    <div className="space-y-8 max-w-[1400px]">
      {active.length > 0 && (
        <Section title="Active Runs" count={active.length}>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {active.map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} expanded />
            ))}
          </div>
        </Section>
      )}

      {failed.length > 0 && (
        <Section title="Failed" count={failed.length}>
          <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
            {failed.map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
        </Section>
      )}

      {completed.length > 0 && (
        <Section title="Completed" count={completed.length}>
          <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
            {completed.slice(0, 12).map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
          {completed.length > 12 && (
            <p className="text-xs text-ink-400 mt-3 text-center">
              + {completed.length - 12} more completed runs
            </p>
          )}
        </Section>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="w-14 h-14 rounded-2xl bg-surface-200 border border-surface-300 flex items-center justify-center mb-4">
            <span className="text-2xl text-ink-300">&#9638;</span>
          </div>
          <p className="text-ink-500 text-sm font-medium">No runs to display</p>
          <p className="text-ink-400 text-xs mt-1">Runs will appear here when tasks are executed</p>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, children }) {
  return (
    <section className="animate-fade-in">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-400">{title}</h2>
        <span className="text-[10px] font-mono text-ink-300 bg-surface-200 px-2 py-0.5 rounded-full border border-surface-300">
          {count}
        </span>
      </div>
      {children}
    </section>
  )
}

function RunCard({ run, onClick, expanded = false }) {
  const color = statusColor(run.status)
  const steps = run.steps || []
  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || steps.length
  const currentStep = steps.find(s => s.status === 'running')
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens || 0), 0)
  const stale = isStaleRun(run)
  const resumed = run.resumed || (run.resumed_count > 0)
  const duration = run.started_at && run.last_event_ts
    ? run.last_event_ts - new Date(run.started_at).getTime()
    : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-surface-100 border border-surface-300 rounded-2xl shadow-card hover:shadow-card-hover transition-all duration-200 hover:border-surface-400 ${expanded ? 'p-5' : 'p-4'} ${stale ? 'opacity-50' : ''}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <h3 className={`font-medium text-ink-900 leading-snug truncate ${expanded ? 'text-sm' : 'text-[13px]'}`}>
            {run.ticket_title || run.run_id}
          </h3>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-[10px] font-mono text-ink-400 bg-surface-200 px-1.5 py-0.5 rounded">
              {run.project_id}
            </span>
            {run.classification && (
              <span className="text-[10px] font-mono text-ink-400 bg-surface-200 px-1.5 py-0.5 rounded">
                {run.classification}
              </span>
            )}
            {run.ticket_id && (
              <span className="text-[10px] font-mono text-ink-300">{run.ticket_id}</span>
            )}
            {run.ticket_source && (
              <span className="text-[10px] font-mono text-ink-300 uppercase">{run.ticket_source}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {resumed && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
              Resumed{run.resumed_count > 1 ? ` x${run.resumed_count}` : ''}
            </span>
          )}
          {stale && (
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-200 text-ink-400 border border-surface-300 italic">
              Stale
            </span>
          )}
          <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${color.badge}`}>
            {statusLabel(run.status)}
          </span>
        </div>
      </div>

      {/* Pipeline */}
      {steps.length > 0 && (
        <div className="mb-3">
          <StepPipeline steps={steps} expanded={expanded} />
        </div>
      )}

      {/* Active agent */}
      {currentStep && expanded && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-xl bg-status-running-light border border-status-running-border">
          <div className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
          <span className="text-[11px] font-mono font-medium text-status-running">{currentStep.agent}</span>
          <span className="text-[10px] text-ink-500 truncate flex-1">{currentStep.task}</span>
        </div>
      )}

      {/* Progress bar */}
      {totalSteps > 0 && (
        <div className="mb-2.5 h-1 w-full bg-surface-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ease-out ${color.bar}`}
            style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
          />
        </div>
      )}

      {/* Metrics */}
      <div className="flex items-center gap-4 text-[10px] font-mono text-ink-400">
        {totalSteps > 0 && (
          <span><span className="text-ink-700">{completedSteps}</span>/{totalSteps} steps</span>
        )}
        {totalTokens > 0 && <span>{formatTokens(totalTokens)} tok</span>}
        {duration && <span>{formatDuration(duration)}</span>}
        {run.last_event_ts && (
          <span className="ml-auto">{timeAgo(run.last_event_ts)}</span>
        )}
      </div>
    </button>
  )
}

function StepPipeline({ steps, expanded }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {steps.map((step, i) => {
        const color = statusColor(step.status)
        const ac = agentColor(step.agent)
        const isRunning = step.status === 'running'

        return (
          <div key={step.step_number ?? i} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1.5 h-6 px-2 rounded-lg border transition-all ${
                isRunning
                  ? `${ac.bg} ${ac.border} ${ac.text}`
                  : step.status === 'completed'
                    ? `${color.bg} ${color.border}`
                    : step.status === 'failed'
                      ? `${color.bg} ${color.border}`
                      : 'bg-surface-200 border-surface-300'
              }`}
              title={`Step ${step.step_number}: ${step.agent} — ${step.status}`}
            >
              {isRunning && <div className="w-1 h-1 rounded-full bg-current animate-pulse" />}
              <span className={`text-[10px] font-mono font-medium ${isRunning ? '' : color.text}`}>
                {expanded ? step.agent : (step.agent || '').slice(0, 4)}
              </span>
              {step.status === 'completed' && <span className="text-[9px] text-status-success">&#10003;</span>}
              {step.status === 'failed' && <span className="text-[9px] text-status-error">&#10007;</span>}
            </div>
            {i < steps.length - 1 && (
              <svg width="10" height="6" className="text-surface-400 flex-shrink-0">
                <path d="M0 3 L7 3" stroke="currentColor" strokeWidth="1" fill="none" />
                <path d="M5 1 L8 3 L5 5" stroke="currentColor" strokeWidth="1" fill="none" />
              </svg>
            )}
          </div>
        )
      })}
    </div>
  )
}
