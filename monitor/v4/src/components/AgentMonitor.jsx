import { useMemo } from 'react'
import { agentColor, statusColor, formatTokens, timeAgo } from './utils'

export default function AgentMonitor({ runs, onSelectRun }) {
  const agents = useMemo(() => {
    const map = new Map()
    for (const run of runs) {
      for (const step of (run.steps || [])) {
        const agent = step.agent
        if (!map.has(agent)) {
          map.set(agent, { agent, totalRuns: 0, running: 0, completed: 0, failed: 0, totalTokens: 0, activeSteps: [], recentSteps: [] })
        }
        const entry = map.get(agent)
        entry.totalRuns++
        if (step.status === 'running') { entry.running++; entry.activeSteps.push({ step, run }) }
        else if (step.status === 'completed') entry.completed++
        else if (step.status === 'failed') entry.failed++
        entry.totalTokens += step.tokens || 0
        if (step.started_at) entry.recentSteps.push({ step, run })
      }
    }
    for (const entry of map.values()) {
      entry.recentSteps.sort((a, b) => new Date(b.step.started_at) - new Date(a.step.started_at))
      entry.recentSteps = entry.recentSteps.slice(0, 5)
    }
    return Array.from(map.values()).sort((a, b) => b.running !== a.running ? b.running - a.running : b.totalRuns - a.totalRuns)
  }, [runs])

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <div className="w-14 h-14 rounded-xl bg-surface-100 border border-surface-200 flex items-center justify-center mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-300">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
          </svg>
        </div>
        <p className="text-ink-600 text-base font-medium">No agent activity</p>
        <p className="text-ink-400 text-sm mt-1">Agent data appears when runs execute</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl space-y-5 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="w-1 h-5 rounded-full bg-status-planning" />
        <h2 className="text-base font-semibold text-ink-900">Agent Fleet</h2>
        <span className="text-sm font-mono text-ink-400 tabular-nums">
          {agents.length} types
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {agents.map(entry => (
          <AgentCard key={entry.agent} entry={entry} onSelectRun={onSelectRun} />
        ))}
      </div>
    </div>
  )
}

function AgentCard({ entry, onSelectRun }) {
  const ac = agentColor(entry.agent)
  const isActive = entry.running > 0
  const successRate = entry.completed + entry.failed > 0
    ? Math.round((entry.completed / (entry.completed + entry.failed)) * 100)
    : 0

  return (
    <div className={`bg-surface-0 border rounded-xl shadow-card overflow-hidden flex transition-all duration-150 ${
      isActive ? 'border-status-running-border ring-1 ring-status-running/10' : 'border-surface-200'
    }`}>
      {/* Left accent strip using agent color */}
      <div className={`w-1 flex-shrink-0`} style={{ backgroundColor: ac.accent }} />

      <div className="flex-1 min-w-0 p-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            {isActive && <div className="w-2 h-2 rounded-full bg-status-running animate-pulse-soft" />}
            <span className={`text-sm font-mono font-bold ${ac.text}`}>{entry.agent}</span>
          </div>
          {isActive && (
            <span className="text-2xs font-medium px-1.5 py-px rounded bg-status-running-light text-status-running border border-status-running-border">
              {entry.running} active
            </span>
          )}
        </div>

        {/* Inline stats — not a grid, just a row */}
        <div className="flex items-center gap-3 text-xs text-ink-400 mb-3">
          <span><strong className="text-ink-700 font-mono">{entry.totalRuns}</strong> runs</span>
          <span className="text-ink-300">&middot;</span>
          <span><strong className="text-status-success font-mono">{entry.completed}</strong> done</span>
          <span className="text-ink-300">&middot;</span>
          <span><strong className="text-status-error font-mono">{entry.failed}</strong> fail</span>
          {entry.totalTokens > 0 && (
            <>
              <span className="text-ink-300">&middot;</span>
              <span className="font-mono">{formatTokens(entry.totalTokens)} tok</span>
            </>
          )}
        </div>

        {/* Success rate bar */}
        <div className="flex items-center gap-2 mb-3">
          <div className="flex-1 h-1 bg-surface-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full bg-status-success transition-all duration-500" style={{ width: `${successRate}%` }} />
          </div>
          <span className="text-2xs font-mono text-ink-400 tabular-nums">{successRate}%</span>
        </div>

        {/* Active steps */}
        {entry.activeSteps.length > 0 && (
          <div className="space-y-1 pt-2.5 border-t border-surface-100">
            {entry.activeSteps.map(({ step, run }, i) => (
              <button key={i} onClick={() => onSelectRun(run)}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-status-running-light border border-status-running-border hover:shadow-sm transition-all">
                <div className="w-1.5 h-1.5 rounded-full bg-status-running animate-pulse" />
                <span className="text-2xs text-ink-700 truncate flex-1">{run.ticket_title || run.run_id}</span>
                <span className="text-2xs font-mono text-ink-400">#{step.step_number}</span>
              </button>
            ))}
          </div>
        )}

        {/* Recent steps */}
        {entry.recentSteps.length > 0 && !isActive && (
          <div className="space-y-0.5 pt-2.5 border-t border-surface-100">
            {entry.recentSteps.slice(0, 3).map(({ step, run }, i) => {
              const sc = statusColor(step.status)
              return (
                <button key={i} onClick={() => onSelectRun(run)}
                  className="w-full text-left flex items-center gap-2 px-2.5 py-1 rounded-lg hover:bg-surface-50 transition-colors">
                  <div className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                  <span className="text-2xs text-ink-500 truncate flex-1">{run.ticket_title || run.run_id}</span>
                  <span className="text-2xs text-ink-300">{step.started_at ? timeAgo(step.started_at) : ''}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
