import { useState, useMemo } from 'react'
import { statusColor, statusLabel, agentColor, agentAbbrev, sourceLabel, timeAgo, formatTokens, formatDuration, isEmptyRun, isStaleRun, truncate } from './utils'

const FILTER_OPTIONS = [
  { key: 'all', label: 'All Runs' },
  { key: 'linear', label: 'Linear' },
  { key: 'github', label: 'GitHub' },
  { key: 'jira', label: 'Jira' },
  { key: 'prompt', label: 'CLI / Prompt' },
]

const SORT_OPTIONS = [
  { key: 'newest', label: 'Newest First' },
  { key: 'oldest', label: 'Oldest First' },
  { key: 'tokens-desc', label: 'Most Tokens' },
  { key: 'name-asc', label: 'Name A-Z' },
]

export default function RunsOverview({ runs, searchQuery, onSelectRun, sseStatus }) {
  const [filterSource, setFilterSource] = useState('all')
  const [filterProject, setFilterProject] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [showFilter, setShowFilter] = useState(false)
  const [showProjectFilter, setShowProjectFilter] = useState(false)
  const [showSort, setShowSort] = useState(false)
  const [showAllCompleted, setShowAllCompleted] = useState(false)

  // Dynamic project options
  const projectOptions = useMemo(() => {
    const ids = [...new Set(runs.filter(r => r.project_id).map(r => r.project_id))]
    return [{ key: 'all', label: 'All Projects' }, ...ids.map(id => ({ key: id, label: id }))]
  }, [runs])

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
    if (filterSource !== 'all') {
      list = list.filter(r => r.ticket_source === filterSource)
    }
    if (filterProject !== 'all') {
      list = list.filter(r => r.project_id === filterProject)
    }
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case 'oldest': return (a.last_event_ts || 0) - (b.last_event_ts || 0)
        case 'tokens-desc': {
          const at = (a.steps || []).reduce((s, st) => s + (st.tokens || 0), 0)
          const bt = (b.steps || []).reduce((s, st) => s + (st.tokens || 0), 0)
          return bt - at
        }
        case 'name-asc': return (a.ticket_title || a.run_id || '').localeCompare(b.ticket_title || b.run_id || '')
        default: return (b.last_event_ts || 0) - (a.last_event_ts || 0)
      }
    })
    return list
  }, [runs, searchQuery, filterSource, sortBy])

  const active = filtered.filter(r => ['executing', 'planning', 'pending', 'waiting_human_review', 'rework'].includes(r.status))
  const failed = filtered.filter(r => r.status === 'failed')
  const completed = filtered.filter(r => r.status === 'completed')

  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="headline text-2xl font-bold text-on-surface">Runs Overview</h1>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-sm text-on-surface-variant">Real-time AI orchestration pipeline monitor.</p>
            <SseIndicator status={sseStatus} />
          </div>
        </div>
        <div className="flex items-center gap-2 relative">
          <div className="relative">
            <HeaderButton
              icon={<FilterIcon />}
              label={filterSource === 'all' ? 'Filter' : FILTER_OPTIONS.find(o => o.key === filterSource)?.label}
              active={filterSource !== 'all'}
              onClick={() => { setShowFilter(!showFilter); setShowSort(false) }}
            />
            {showFilter && (
              <Dropdown
                options={FILTER_OPTIONS}
                selected={filterSource}
                onSelect={k => { setFilterSource(k); setShowFilter(false) }}
                onClose={() => setShowFilter(false)}
              />
            )}
          </div>
          <div className="relative">
            <HeaderButton
              icon={<ProjectIcon />}
              label={filterProject === 'all' ? 'Project' : filterProject}
              active={filterProject !== 'all'}
              onClick={() => { setShowProjectFilter(!showProjectFilter); setShowFilter(false); setShowSort(false) }}
            />
            {showProjectFilter && (
              <Dropdown
                options={projectOptions}
                selected={filterProject}
                onSelect={k => { setFilterProject(k); setShowProjectFilter(false) }}
                onClose={() => setShowProjectFilter(false)}
              />
            )}
          </div>
          <div className="relative">
            <HeaderButton
              icon={<SortIcon />}
              label={SORT_OPTIONS.find(o => o.key === sortBy)?.label || 'Sort'}
              active={sortBy !== 'newest'}
              onClick={() => { setShowSort(!showSort); setShowFilter(false) }}
            />
            {showSort && (
              <Dropdown
                options={SORT_OPTIONS}
                selected={sortBy}
                onSelect={k => { setSortBy(k); setShowSort(false) }}
                onClose={() => setShowSort(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Three-column Kanban */}
      <div className="flex-1 grid grid-cols-3 gap-4 min-h-0 overflow-hidden">
        {/* Active column */}
        <Column title="Active" count={active.length} statusKey="executing">
          <div className="space-y-3">
            {active.map(run => (
              <ActiveRunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
        </Column>

        {/* Failed column */}
        <Column title="Failed" count={failed.length} statusKey="failed">
          <div className="space-y-3">
            {failed.map(run => (
              <FailedRunCard key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} />
            ))}
          </div>
        </Column>

        {/* Completed column */}
        <Column
          title="Completed"
          count={completed.length}
          statusKey="completed"
          action={completed.length > 8 ? (showAllCompleted ? 'Show Less' : 'See All') : null}
          onAction={() => setShowAllCompleted(!showAllCompleted)}
        >
          <div className="space-y-0">
            {(showAllCompleted ? completed : completed.slice(0, 8)).map((run, i) => (
              <CompletedItem key={`${run.project_id}/${run.run_id}`} run={run} onClick={() => onSelectRun(run)} even={i % 2 === 0} />
            ))}
          </div>
          {!showAllCompleted && completed.length > 8 && (
            <p className="label-technical text-2xs text-on-surface-variant text-center mt-3">
              + {completed.length - 8} more completed runs
            </p>
          )}
        </Column>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center">
          <div className="w-14 h-14 rounded bg-surface-container flex items-center justify-center mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-on-surface-variant">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </div>
          <p className="text-on-surface font-medium">No runs to display</p>
          <p className="text-on-surface-variant text-sm mt-1">Runs will appear here when tasks are executed</p>
        </div>
      )}

      {/* FAB */}
      <button className="fixed bottom-6 right-6 w-12 h-12 rounded gradient-primary text-on-primary flex items-center justify-center shadow-ambient hover:opacity-90 transition-opacity z-50">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M8 3v10M3 8h10" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  )
}

/* ── Column ── */

function Column({ title, count, statusKey, action, onAction, children }) {
  return (
    <div className="flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="label-technical text-sm font-semibold text-on-surface">{title}</h2>
          <span
            className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded text-2xs font-bold text-on-primary"
            style={{ backgroundColor: `var(--sf-status-${statusKey})` }}
          >
            {count}
          </span>
        </div>
        {action && (
          <button onClick={onAction} className="text-2xs text-primary font-medium label-technical hover:underline">{action}</button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto pr-1 -mr-1">
        {children}
      </div>
    </div>
  )
}

/* ── Active Run Card ── */

function ActiveRunCard({ run, onClick }) {
  const steps = run.steps || []
  const completedSteps = steps.filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || steps.length
  const currentStep = steps.find(s => s.status === 'running')
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokens || 0), 0)
  const stale = isStaleRun(run)
  const duration = run.started_at && run.last_event_ts
    ? run.last_event_ts - new Date(run.started_at).getTime()
    : null
  const alerts = Array.isArray(run.operational_alerts) ? run.operational_alerts : []
  const pct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-surface-container rounded p-5 transition-all duration-200 hover:bg-surface-container-high group ${
        stale ? 'opacity-50' : ''
      } ${run.status === 'executing' ? 'animate-glow-pulse' : ''}`}
    >
      {stale && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="label-technical text-2xs px-1.5 py-0.5 rounded bg-status-warning/20 text-status-warning font-bold">STALE</span>
          <span className="text-2xs text-on-surface-variant">No events in over 1 hour</span>
        </div>
      )}
      {/* Title + badges */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="font-display font-semibold text-sm text-on-surface leading-snug">
          {run.ticket_title || run.run_id}
        </h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {run.classification && (
            <span className="label-technical text-2xs px-2 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
              {run.classification.replace(/_/g, ' ')}
            </span>
          )}
          {run.resumed_count > 0 && (
            <span className="label-technical text-2xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
              Resumed{run.resumed_count > 1 ? ` ×${run.resumed_count}` : ''}
            </span>
          )}
          {run.trigger_source && (
            <span className="label-technical text-2xs px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
              {run.trigger_source === 'linear_webhook' ? '⚡ Webhook' : run.trigger_source === 'cli' ? '⌨ CLI' : run.trigger_source}
            </span>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="flex items-center gap-2 text-2xs text-on-surface-variant font-mono mb-3">
        {run.ticket_id && <span>{run.ticket_id}</span>}
        {run.ticket_id && <span className="text-on-surface-variant">|</span>}
        <span className="truncate max-w-[120px] font-mono opacity-60" title={run.run_id}>{run.run_id?.slice(-8)}</span>
        {run.branch && <span className="text-on-surface-variant">|</span>}
        {run.branch && <span className="truncate max-w-[180px]">{run.branch}</span>}
      </div>

      {/* Pipeline strip */}
      {steps.length > 0 && (
        <PipelineStrip steps={steps} className="mb-3" />
      )}

      {/* Current agent */}
      {currentStep && (
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-1.5 h-1.5 rounded-full animate-pulse-soft" style={{ backgroundColor: agentColor(currentStep.agent) }} />
            <span className="label-technical text-2xs font-bold" style={{ color: agentColor(currentStep.agent) }}>
              Current: {currentStep.agent}
            </span>
          </div>
          <p className="text-xs text-on-surface-variant leading-relaxed pl-3.5">
            "{truncate(currentStep.task, 80)}"
          </p>
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
        <MetricPair label="Progress" value={`${completedSteps}/${totalSteps} Steps (${pct}%)`} />
        <MetricPair label="Consumption" value={`${formatTokens(totalTokens)} Tokens`} />
        <MetricPair label="Duration" value={duration ? formatDuration(duration) : '-'} />
        <MetricPair label="Last Event" value={run.last_event_ts ? timeAgo(run.last_event_ts) : '-'} />
      </div>

      {/* Alerts */}
      {alerts.slice(0, 2).map(alert => (
        <div
          key={alert.code || alert.label}
          className={`flex items-center gap-2 px-3 py-1.5 rounded text-2xs mb-1.5 ${
            alert.level === 'error'
              ? 'bg-status-failed/10 text-status-failed'
              : 'bg-status-warning/10 text-status-warning'
          }`}
        >
          <span>{alert.level === 'error' ? '\u26D4' : '\u26A0'}</span>
          <span>{alert.label}{alert.detail ? ` (${alert.detail})` : ''}</span>
        </div>
      ))}

      {/* PR badge */}
      {run.pr_url && (
        <a
          href={run.pr_url}
          target="_blank"
          rel="noreferrer"
          onClick={e => e.stopPropagation()}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-2xs bg-status-completed/10 text-status-completed hover:bg-status-completed/20 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.5 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm6 8a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM5 5.5v5A3.5 3.5 0 0 0 8.5 14H10v-1.5H8.5a2 2 0 0 1-2-2v-5H5Zm6-2v3.17a3 3 0 0 1-.88 2.12l-.7.71 1.06 1.06.7-.7a4.5 4.5 0 0 0 1.32-3.19V3.5H11Z"/>
          </svg>
          <span>PR #{run.pr_url.split('/').pop()}</span>
        </a>
      )}
    </button>
  )
}

/* ── Failed Run Card ── */

function FailedRunCard({ run, onClick }) {
  const steps = run.steps || []
  const failedStep = steps.find(s => s.status === 'failed')
  const alerts = Array.isArray(run.operational_alerts) ? run.operational_alerts : []
  const errorMsg = alerts.find(a => a.level === 'error')?.label || failedStep?.task || 'Unknown error'

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-surface-container rounded p-5 transition-all duration-200 hover:bg-surface-container-high"
    >
      {/* Title + badges */}
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="font-display font-semibold text-sm text-on-surface leading-snug">
          {run.ticket_title || run.run_id}
        </h3>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {run.classification && (
            <span className="label-technical text-2xs px-2 py-0.5 rounded bg-surface-container-highest text-on-surface-variant">
              {run.classification.replace(/_/g, ' ')}
            </span>
          )}
          {run.resumed_count > 0 && (
            <span className="label-technical text-2xs px-1.5 py-0.5 rounded bg-primary/20 text-primary">
              Resumed{run.resumed_count > 1 ? ` ×${run.resumed_count}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Ticket ID + run ID */}
      <div className="flex items-center gap-2 text-2xs text-on-surface-variant font-mono mb-3">
        {run.ticket_id && <span>{run.ticket_id}</span>}
        {run.ticket_id && <span>|</span>}
        <span className="opacity-60" title={run.run_id}>{run.run_id?.slice(-8)}</span>
      </div>

      {/* Pipeline strip */}
      {steps.length > 0 && (
        <PipelineStrip steps={steps} className="mb-3" />
      )}

      {/* Error box */}
      <div className="bg-status-failed/10 rounded p-3 mb-3">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-status-failed text-2xs">{'\u26D4'}</span>
          <span className="label-technical text-2xs font-bold text-status-failed">Critical Failure</span>
        </div>
        <p className="text-xs text-status-failed/80 leading-relaxed">
          "{truncate(errorMsg, 100)}"
        </p>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="text-2xs text-on-surface-variant">
          {run.last_event_ts ? `Occurred ${timeAgo(run.last_event_ts)}` : ''}
        </span>
        <span className="label-technical text-2xs font-bold text-primary hover:underline">
          Rerun from Step {failedStep?.step_number || '?'}
        </span>
      </div>
    </button>
  )
}

/* ── Completed Item (compact list row) ── */

function CompletedItem({ run, onClick, even }) {
  const steps = run.steps || []
  const duration = run.started_at && run.last_event_ts
    ? run.last_event_ts - new Date(run.started_at).getTime()
    : null

  return (
    <button
      onClick={onClick}
      className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-container-high ${
        even ? 'bg-surface-container-low' : 'bg-surface-container'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-on-surface truncate">{run.ticket_title || run.run_id}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {run.ticket_id && (
              <span className="text-2xs text-on-surface-variant font-mono">{run.ticket_id}</span>
            )}
            {run.classification && (
              <span className="label-technical text-[9px] px-1 py-px rounded bg-surface-container-highest text-on-surface-variant">
                {run.classification.replace(/_/g, ' ')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-3">
          <span className="text-2xs text-on-surface-variant">Done in {duration ? formatDuration(duration) : '-'}</span>
          <div className="w-5 h-5 rounded-full bg-status-completed flex items-center justify-center">
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="var(--sf-on-primary)" strokeWidth="2">
              <path d="M2.5 6l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>
      {steps.length > 0 && (
        <PipelineStrip steps={steps} className="mt-1.5" />
      )}
    </button>
  )
}

/* ── Pipeline Strip (colored bars) ── */

function PipelineStrip({ steps, className = '' }) {
  const showLabels = steps.length <= 8
  return (
    <div className={`flex items-center gap-1 ${className}`}>
      {steps.map((step, i) => {
        const color = step.status === 'running'
          ? agentColor(step.agent)
          : step.status === 'completed'
            ? agentColor(step.agent)
            : step.status === 'failed'
              ? 'var(--sf-status-failed)'
              : 'var(--sf-surface-container-highest)'
        const opacity = step.status === 'pending' ? 0.3 : 1
        const isRunning = step.status === 'running'

        return (
          <div
            key={step.step_number ?? i}
            className={`flex-1 ${showLabels ? 'h-5 flex items-center justify-center' : 'h-2'} rounded-sm transition-all ${isRunning ? 'animate-pulse-soft' : ''}`}
            style={{ backgroundColor: color, opacity }}
            title={`Step ${step.step_number}: ${step.agent} — ${step.status}`}
          >
            {showLabels && (
              <span className="text-[8px] font-bold text-white leading-none select-none">
                {agentAbbrev(step.agent)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ── Small components ── */

function MetricPair({ label, value }) {
  return (
    <div>
      <div className="label-technical text-2xs text-on-surface-variant">{label}</div>
      <div className="text-xs font-mono text-on-surface font-medium">{value}</div>
    </div>
  )
}

function HeaderButton({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function Dropdown({ options, selected, onSelect, onClose }) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 w-44 bg-surface-container-lowest rounded shadow-ambient z-50 py-1 ghost-border">
        {options.map(opt => (
          <button
            key={opt.key}
            onClick={() => onSelect(opt.key)}
            className={`w-full text-left px-3 py-2 text-sm transition-colors ${
              selected === opt.key
                ? 'text-primary bg-primary/10 font-medium'
                : 'text-on-surface hover:bg-surface-container-high'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </>
  )
}

function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h12M4 8h8M6 12h4" strokeLinecap="round" />
    </svg>
  )
}

function SortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 3v10M4 13l-2-2M4 13l2-2M12 13V3M12 3l-2 2M12 3l2 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ProjectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4h4l2 2h6v7H2V4z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SseIndicator({ status }) {
  const config = {
    connected: { color: 'bg-status-completed', label: 'Live', pulse: true },
    connecting: { color: 'bg-status-warning', label: 'Connecting', pulse: true },
    disconnected: { color: 'bg-on-surface-variant', label: 'Offline', pulse: false },
  }
  const { color, label, pulse } = config[status] || config.disconnected
  return (
    <span className="flex items-center gap-1.5 text-2xs text-on-surface-variant">
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${pulse ? 'animate-pulse-soft' : ''}`} />
      {label}
    </span>
  )
}
