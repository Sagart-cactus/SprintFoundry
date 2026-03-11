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
        <div className="w-14 h-14 rounded-2xl bg-surface-200 border border-surface-300 flex items-center justify-center mb-4">
          <span className="text-2xl text-ink-300">&#9670;</span>
        </div>
        <p className="text-ink-500 text-sm font-medium">No agent activity</p>
        <p className="text-ink-400 text-xs mt-1">Agent data appears when runs execute</p>
      </div>
    )
  }

  return (
    <div className="max-w-[1400px] space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-400">Agent Fleet</h2>
        <span className="text-[10px] font-mono text-ink-300 bg-surface-200 px-2 py-0.5 rounded-full border border-surface-300">
          {agents.length} types
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
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
    <div className={`bg-surface-100 border rounded-2xl shadow-card p-4 transition-all duration-200 ${
      isActive ? 'border-status-running-border ring-1 ring-status-running/10' : 'border-surface-300'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          {isActive && <div className="w-2 h-2 rounded-full bg-status-running animate-pulse-soft" />}
          <span className={`text-sm font-mono font-bold ${ac.text}`}>{entry.agent}</span>
        </div>
        {isActive && (
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-status-running-light text-status-running border border-status-running-border">
            {entry.running} active
          </span>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2 mb-3">
        <StatCell label="Runs" value={entry.totalRuns} />
        <StatCell label="Done" value={entry.completed} color="text-status-success" />
        <StatCell label="Failed" value={entry.failed} color="text-status-error" />
        <StatCell label="Tokens" value={formatTokens(entry.totalTokens)} />
      </div>

      {/* Success rate */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono text-ink-400">Success rate</span>
          <span className="text-[10px] font-mono text-ink-700">{successRate}%</span>
        </div>
        <div className="h-1 bg-surface-200 rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-status-success transition-all duration-500" style={{ width: `${successRate}%` }} />
        </div>
      </div>

      {/* Active steps */}
      {entry.activeSteps.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-surface-300">
          <p className="text-[10px] uppercase tracking-wider text-ink-400 mb-1">Currently Running</p>
          {entry.activeSteps.map(({ step, run }, i) => (
            <button key={i} onClick={() => onSelectRun(run)}
              className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg bg-status-running-light border border-status-running-border hover:shadow-sm transition-all">
              <div className="w-1 h-1 rounded-full bg-status-running animate-pulse" />
              <span className="text-[10px] font-mono text-ink-700 truncate flex-1">{run.ticket_title || run.run_id}</span>
              <span className="text-[10px] font-mono text-ink-400">#{step.step_number}</span>
            </button>
          ))}
        </div>
      )}

      {/* Recent */}
      {entry.recentSteps.length > 0 && !isActive && (
        <div className="space-y-1 pt-2 border-t border-surface-300">
          <p className="text-[10px] uppercase tracking-wider text-ink-400 mb-1">Recent</p>
          {entry.recentSteps.slice(0, 3).map(({ step, run }, i) => {
            const sc = statusColor(step.status)
            return (
              <button key={i} onClick={() => onSelectRun(run)}
                className="w-full text-left flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-surface-200 transition-colors">
                <div className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                <span className="text-[10px] font-mono text-ink-500 truncate flex-1">{run.ticket_title || run.run_id}</span>
                <span className="text-[10px] font-mono text-ink-300">{step.started_at ? timeAgo(step.started_at) : ''}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StatCell({ label, value, color = 'text-ink-900' }) {
  return (
    <div className="text-center">
      <p className={`text-sm font-mono font-semibold ${color}`}>{value}</p>
      <p className="text-[9px] font-mono text-ink-400 uppercase">{label}</p>
    </div>
  )
}
