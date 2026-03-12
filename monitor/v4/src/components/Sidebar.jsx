import { useMemo, useState } from 'react'
import { statusColor, sourceStyle, timeAgo, isEmptyRun, isStaleRun } from './utils'

export default function Sidebar({ runs, view, selectedRun, onSelectRun, onViewChange, searchQuery }) {
  const [projectFilter, setProjectFilter] = useState('all')
  const [showEmpty, setShowEmpty] = useState(false)

  const projects = useMemo(() => {
    return [...new Set(runs.map(r => r.project_id))].sort()
  }, [runs])

  const filtered = useMemo(() => {
    let list = runs
    if (projectFilter !== 'all') {
      list = list.filter(r => r.project_id === projectFilter)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(r =>
        r.run_id?.toLowerCase().includes(q) ||
        r.project_id?.toLowerCase().includes(q) ||
        r.ticket_title?.toLowerCase().includes(q) ||
        r.ticket_id?.toLowerCase().includes(q)
      )
    }
    return list
  }, [runs, projectFilter, searchQuery])

  const active = filtered.filter(r => ['executing', 'planning', 'pending', 'waiting_human_review', 'rework'].includes(r.status) && !isEmptyRun(r))
  const empty = filtered.filter(r => isEmptyRun(r))
  const failed = filtered.filter(r => r.status === 'failed')
  const completed = filtered.filter(r => r.status === 'completed')

  return (
    <aside className="w-60 flex-shrink-0 border-r border-surface-200 bg-surface-0 overflow-y-auto">
      {projects.length > 1 && (
        <div className="px-3 pt-3">
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="w-full h-8 text-sm bg-surface-50 border border-surface-200 rounded-lg px-2.5 text-ink-700 focus:outline-none focus:border-brand/40"
          >
            <option value="all">All projects</option>
            {projects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}

      <div className="p-2">
        {active.length > 0 && (
          <RunGroup label="Active" count={active.length} runs={active} selectedRun={selectedRun} onSelectRun={onSelectRun} />
        )}
        {failed.length > 0 && (
          <RunGroup label="Failed" count={failed.length} runs={failed} selectedRun={selectedRun} onSelectRun={onSelectRun} />
        )}
        {completed.length > 0 && (
          <RunGroup label="Completed" count={completed.length} runs={completed.slice(0, 20)} selectedRun={selectedRun} onSelectRun={onSelectRun} />
        )}
        {empty.length > 0 && (
          <div className="mt-2">
            <button
              onClick={() => setShowEmpty(!showEmpty)}
              className="w-full text-center text-xs text-ink-400 hover:text-ink-700 py-2 border border-dashed border-surface-300 rounded-lg hover:bg-surface-50 transition-colors"
            >
              {showEmpty ? 'Hide' : 'Show'} {empty.length} empty run{empty.length > 1 ? 's' : ''}
            </button>
            {showEmpty && (
              <div className="mt-1.5 space-y-0.5">
                {empty.map(run => (
                  <SidebarItem key={`${run.project_id}/${run.run_id}`} run={run} active={false} onClick={() => onSelectRun(run)} />
                ))}
              </div>
            )}
          </div>
        )}
        {filtered.length === 0 && (
          <div className="px-2 py-12 text-center">
            <p className="text-ink-400 text-sm">No runs found</p>
          </div>
        )}
      </div>
    </aside>
  )
}

function RunGroup({ label, count, runs, selectedRun, onSelectRun }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between px-2.5 mb-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-400">{label}</h3>
        <span className="text-xs font-mono text-ink-300 tabular-nums">{count}</span>
      </div>
      <div className="space-y-0.5">
        {runs.map(run => (
          <SidebarItem
            key={`${run.project_id}/${run.run_id}`}
            run={run}
            active={selectedRun?.run_id === run.run_id && selectedRun?.project_id === run.project_id}
            onClick={() => onSelectRun(run)}
          />
        ))}
      </div>
    </div>
  )
}

function SidebarItem({ run, active, onClick }) {
  const color = statusColor(run.status)
  const currentStep = (run.steps || []).find(s => s.status === 'running')
  const completedSteps = (run.steps || []).filter(s => s.status === 'completed').length
  const totalSteps = run.step_count || (run.steps || []).length
  const stale = isStaleRun(run)

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-2.5 py-2 rounded-lg transition-all duration-100 group ${
        active
          ? 'bg-brand-light border border-brand-medium'
          : 'hover:bg-surface-50 border border-transparent'
      } ${stale ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-2">
        <div className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${color.dot} ${run.status === 'running' || run.status === 'executing' ? 'animate-pulse-soft' : ''}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-ink-900 truncate leading-tight">
            {run.ticket_title || run.run_id}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {run.ticket_source && run.ticket_source !== 'prompt' && (
              <span className={`text-[10px] font-medium ${sourceStyle(run.ticket_source).color}`}>
                {sourceStyle(run.ticket_source).label}
              </span>
            )}
            <span className="text-xs text-ink-400 truncate">
              {run.project_id}
            </span>
            {totalSteps > 0 && (
              <span className="text-xs font-mono text-ink-300 tabular-nums">
                {completedSteps}/{totalSteps}
              </span>
            )}
          </div>
          {currentStep && (
            <div className="flex items-center gap-1.5 mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
              <span className="text-xs text-status-running font-medium truncate">{currentStep.agent}</span>
            </div>
          )}
        </div>
      </div>

      {totalSteps > 0 && (
        <div className="mt-2 h-1 w-full bg-surface-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${color.bar}`}
            style={{ width: `${(completedSteps / totalSteps) * 100}%` }}
          />
        </div>
      )}
    </button>
  )
}
