import { useMemo } from 'react'
import { statusColor, statusLabel, agentColor, sourceStyle, timeAgo, formatTokens, formatDuration, isEmptyRun, isStaleRun } from './utils'

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
    <div className="space-y-8 max-w-6xl">
      {active.length > 0 && (
        <Section title="Active" count={active.length} color="bg-status-running">
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {active.map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} expanded />
            ))}
          </div>
        </Section>
      )}

      {failed.length > 0 && (
        <Section title="Failed" count={failed.length} color="bg-status-error">
          <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
            {failed.map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
        </Section>
      )}

      {completed.length > 0 && (
        <Section title="Completed" count={completed.length} color="bg-status-success">
          <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
            {completed.slice(0, 12).map(run => (
              <RunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
          {completed.length > 12 && (
            <p className="text-sm text-ink-400 mt-3 text-center">
              + {completed.length - 12} more completed runs
            </p>
          )}
        </Section>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="w-14 h-14 rounded-xl bg-surface-100 border border-surface-200 flex items-center justify-center mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-300">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <p className="text-ink-600 text-base font-medium">No runs to display</p>
          <p className="text-ink-400 text-sm mt-1">Runs will appear here when tasks are executed</p>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, color, children }) {
  return (
    <section className="animate-fade-in">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-1 h-5 rounded-full ${color}`} />
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        <span className="text-sm font-mono text-ink-400 tabular-nums">{count}</span>
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
  const src = run.ticket_source ? sourceStyle(run.ticket_source) : null

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-surface-0 border border-surface-200 rounded-xl shadow-card hover:shadow-card-hover transition-all duration-150 hover:border-surface-300 overflow-hidden flex ${stale ? 'opacity-50' : ''}`}
    >
      {/* Left status strip */}
      <div className={`w-1 flex-shrink-0 ${color.bar}`} />

      <div className={`flex-1 min-w-0 ${expanded ? 'p-4' : 'p-3.5'}`}>
        {/* Row 1: Title + status badge */}
        <div className="flex items-start justify-between gap-3 mb-1.5">
          <h3 className="text-sm font-medium text-ink-900 leading-snug truncate">
            {run.ticket_title || run.run_id}
          </h3>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {run.pr_url && <PrBadge />}
            {resumed && (
              <span className="text-2xs px-1.5 py-px rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium">
                Resumed{run.resumed_count > 1 ? ` ×${run.resumed_count}` : ''}
              </span>
            )}
            <span className={`text-2xs font-semibold px-2 py-px rounded border ${color.badge}`}>
              {statusLabel(run.status)}
            </span>
          </div>
        </div>

        {/* Row 2: Compact metadata — source, ticket, project, classification, branch */}
        <div className="flex items-center gap-1.5 text-xs text-ink-400 mb-2.5 flex-wrap">
          {src && (
            <span className={`inline-flex items-center gap-1 font-medium ${src.color}`}>
              <SourceIcon source={run.ticket_source} />
              {run.ticket_id || src.label}
            </span>
          )}
          {!src && run.ticket_id && (
            <span className="font-mono">{run.ticket_id}</span>
          )}
          <span className="text-ink-300">&middot;</span>
          <span>{run.project_id}</span>
          {run.classification && (
            <>
              <span className="text-ink-300">&middot;</span>
              <span className="text-brand font-medium">{run.classification}</span>
            </>
          )}
          {run.branch && expanded && (
            <>
              <span className="text-ink-300">&middot;</span>
              <span className="font-mono text-ink-300 truncate max-w-[180px]">{run.branch}</span>
            </>
          )}
        </div>

        {/* Pipeline chips */}
        {steps.length > 0 && (
          <div className="mb-2.5">
            <StepPipeline steps={steps} expanded={expanded} />
          </div>
        )}

        {/* Active agent (expanded only) */}
        {currentStep && expanded && (
          <div className="mb-2.5 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-status-running-light border border-status-running-border">
            <div className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
            <span className="text-xs font-mono font-semibold text-status-running">{currentStep.agent}</span>
            <span className="text-xs text-ink-500 truncate flex-1">{currentStep.task}</span>
          </div>
        )}

        {/* Progress bar + metrics combined */}
        <div className="flex items-center gap-3">
          {totalSteps > 0 && (
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="flex-1 h-1.5 bg-surface-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ease-out ${color.bar}`}
                  style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
                />
              </div>
              <span className="text-xs text-ink-500 font-mono tabular-nums flex-shrink-0">
                {completedSteps}/{totalSteps}
              </span>
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-ink-400 flex-shrink-0">
            {totalTokens > 0 && <span className="font-mono">{formatTokens(totalTokens)}</span>}
            {duration && <span>{formatDuration(duration)}</span>}
            {run.last_event_ts && <span className="text-ink-300">{timeAgo(run.last_event_ts)}</span>}
          </div>
        </div>
      </div>
    </button>
  )
}

function StepPipeline({ steps, expanded }) {
  return (
    <div className="flex items-center gap-0.5 flex-wrap">
      {steps.map((step, i) => {
        const color = statusColor(step.status)
        const ac = agentColor(step.agent)
        const isRunning = step.status === 'running'

        return (
          <div key={step.step_number ?? i} className="flex items-center gap-0.5">
            <div
              className={`flex items-center gap-1 h-[22px] px-1.5 rounded border text-2xs font-mono transition-all ${
                isRunning
                  ? `${ac.bg} ${ac.border} ${ac.text}`
                  : step.status === 'completed'
                    ? `${color.bg} ${color.border}`
                    : step.status === 'failed'
                      ? `${color.bg} ${color.border}`
                      : 'bg-surface-100 border-surface-200'
              }`}
              title={`Step ${step.step_number}: ${step.agent} — ${step.status}`}
            >
              {isRunning && <div className="w-1 h-1 rounded-full bg-current animate-pulse" />}
              <span className={`font-medium ${isRunning ? '' : color.text}`}>
                {expanded ? step.agent : (step.agent || '').slice(0, 3)}
              </span>
              {step.status === 'completed' && <span className="text-status-success text-[9px]">&#10003;</span>}
              {step.status === 'failed' && <span className="text-status-error text-[9px]">&#10007;</span>}
            </div>
            {i < steps.length - 1 && (
              <span className="text-ink-300 text-[9px]">&rsaquo;</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Small components ──

function PrBadge() {
  return (
    <span className="text-2xs font-semibold px-1.5 py-px rounded bg-status-success-light text-status-success border border-status-success-border" title="PR created">
      PR
    </span>
  )
}

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
