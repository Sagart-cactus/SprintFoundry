import { useMemo } from 'react'
import { agentColor, formatTokens, timeAgo, truncate } from './utils'

/* ── Agent metadata ── */

const AGENT_META = {
  orchestrator:   { class: 'Sovereign',    metrics: ['Total Runs', 'Tokens'] },
  developer:      { class: 'Builder',      metrics: ['Total Runs', 'Tokens'] },
  'go-developer': { class: 'System',       metrics: ['Total Runs', 'Tokens'] },
  security:       { class: 'Guardian',     metrics: ['Total Runs', 'Vulns Found'] },
  'ui-ux':        { class: 'Creative',     metrics: ['Total Runs', 'Tokens'] },
  architect:      { class: 'Designer',     metrics: ['Total Runs', 'Schema Changes'] },
  qa:             { class: 'Quality',      metrics: ['Bugs Found', 'Test Coverage'] },
  'go-qa':        { class: 'Performance',  metrics: ['Total Runs', 'Tokens'] },
  product:        { class: 'Analyst',      metrics: ['Specs Drafted', 'Tokens'] },
  'code-review':  { class: 'Auditor',      metrics: ['PRs Scanned', 'Tokens'] },
  devops:         { class: 'Infra',        metrics: ['Total Runs', 'Tokens'] },
  'merge-bot':    { class: 'Utility',      metrics: ['Merges', 'Conflicts'] },
  'docs-auditor': { class: 'Content',      metrics: ['Total Runs', 'Tokens'] },
}

function getAgentMeta(agent) {
  return AGENT_META[agent] || { class: 'Agent', metrics: ['Total Runs', 'Tokens'] }
}

/* ── Main component ── */

export default function AgentFleet({ runs, onSelectRun }) {
  const { agents, totalActiveThreads, avgSuccessRate, totalFleetTokens } = useMemo(() => {
    const map = new Map()
    let activeThreads = 0
    let fleetTokens = 0

    for (const run of runs) {
      for (const step of (run.steps || [])) {
        const agent = step.agent
        if (!map.has(agent)) {
          map.set(agent, {
            agent,
            totalRuns: 0,
            running: 0,
            completed: 0,
            failed: 0,
            totalTokens: 0,
            activeSteps: [],
            recentSteps: [],
          })
        }
        const entry = map.get(agent)
        entry.totalRuns++
        if (step.status === 'running') {
          entry.running++
          activeThreads++
          entry.activeSteps.push({ step, run })
        } else if (step.status === 'completed') {
          entry.completed++
        } else if (step.status === 'failed') {
          entry.failed++
        }
        entry.totalTokens += step.tokens || 0
        fleetTokens += step.tokens || 0
        if (step.started_at) entry.recentSteps.push({ step, run })
      }
    }

    let totalCompleted = 0
    let totalWithOutcome = 0
    for (const entry of map.values()) {
      entry.recentSteps.sort((a, b) => new Date(b.step.started_at) - new Date(a.step.started_at))
      entry.recentSteps = entry.recentSteps.slice(0, 5)
      totalCompleted += entry.completed
      totalWithOutcome += entry.completed + entry.failed
    }

    const sorted = Array.from(map.values()).sort((a, b) =>
      b.running !== a.running ? b.running - a.running : b.totalRuns - a.totalRuns
    )

    return {
      agents: sorted,
      totalActiveThreads: activeThreads,
      avgSuccessRate: totalWithOutcome > 0 ? Math.round((totalCompleted / totalWithOutcome) * 100) : 0,
      totalFleetTokens: fleetTokens,
    }
  }, [runs])

  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="w-14 h-14 rounded bg-surface-container flex items-center justify-center mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-on-surface-variant">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
          </svg>
        </div>
        <p className="text-on-surface font-medium font-display">No agent activity</p>
        <p className="text-on-surface-variant text-sm mt-1">Agent data appears when runs execute</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Page header */}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="headline text-2xl font-bold text-on-surface tracking-headline">Agent Fleet</h1>
          <p className="text-sm text-on-surface-variant mt-1">
            Aggregate Operational Intelligence — <span className="font-mono text-2xs">{agents.length} agent types</span>
          </p>
        </div>

        {/* Hero stats */}
        <div className="flex items-center gap-6">
          <HeroStat label="Active Threads" value={totalActiveThreads} />
          <HeroStat label="Avg Success" value={`${avgSuccessRate}%`} />
        </div>
      </div>

      {/* Agent grid */}
      <div className="flex-1 overflow-y-auto -mr-2 pr-2">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.map(entry => (
            <AgentCard key={entry.agent} entry={entry} onSelectRun={onSelectRun} />
          ))}
        </div>
      </div>

      {/* Fleet footer */}
      <FleetFooter totalTokens={totalFleetTokens} />
    </div>
  )
}

/* ── Hero Stat ── */

function HeroStat({ label, value }) {
  return (
    <div className="text-right">
      <div className="label-technical text-2xs text-on-surface-variant">{label}</div>
      <div className="font-display text-xl font-bold text-on-surface tabular-nums">{value}</div>
    </div>
  )
}

/* ── Agent Card ── */

function AgentCard({ entry, onSelectRun }) {
  const color = agentColor(entry.agent)
  const meta = getAgentMeta(entry.agent)
  const isActive = entry.running > 0
  const successRate = entry.completed + entry.failed > 0
    ? Math.round((entry.completed / (entry.completed + entry.failed)) * 100)
    : 0

  // Metric values — map labels to actual data
  const metricValues = meta.metrics.map(label => {
    switch (label) {
      case 'Total Runs': return entry.totalRuns
      case 'Tokens': return formatTokens(entry.totalTokens)
      case 'Vulns Found': return entry.failed > 0 ? entry.failed : 0
      case 'Schema Changes': return entry.completed
      case 'Bugs Found': return entry.failed
      case 'Test Coverage': return `${successRate}%`
      case 'Specs Drafted': return entry.completed
      case 'PRs Scanned': return entry.totalRuns
      case 'Merges': return entry.completed
      case 'Conflicts': return entry.failed
      default: return entry.totalRuns
    }
  })

  return (
    <div
      className={`bg-surface-container rounded overflow-hidden flex transition-all duration-200 hover:bg-surface-container-high group ${
        isActive ? 'shadow-glow-executing' : ''
      }`}
    >
      {/* Left accent strip */}
      <div className="w-1 flex-shrink-0" style={{ backgroundColor: color }} />

      <div className="flex-1 min-w-0 p-4">
        {/* Header: agent name + active badge */}
        <div className="flex items-center justify-between mb-1">
          <h3
            className="font-display font-bold text-sm tracking-technical uppercase"
            style={{ color }}
          >
            {entry.agent}
          </h3>
          {isActive && (
            <span
              className="text-2xs font-bold px-2 py-0.5 rounded text-on-primary label-technical"
              style={{ backgroundColor: color }}
            >
              {entry.running} Active
            </span>
          )}
        </div>

        {/* Class label */}
        <div className="label-technical text-2xs text-on-surface-variant mb-3">
          Class: {meta.class}
        </div>

        {/* Metric boxes */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {meta.metrics.map((label, i) => (
            <div key={label} className="bg-surface-container-lowest rounded p-2.5">
              <div className="label-technical text-2xs text-on-surface-variant leading-none mb-1.5">{label}</div>
              <div className="font-display text-lg font-bold text-on-surface tabular-nums leading-none">
                {metricValues[i]}
              </div>
            </div>
          ))}
        </div>

        {/* Success rate */}
        <div className="flex items-center gap-2 mb-3">
          <div className="label-technical text-2xs text-on-surface-variant flex-shrink-0">Success Rate</div>
          <div className="flex-1 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${successRate}%`, backgroundColor: color }}
            />
          </div>
          <span className="text-2xs font-mono text-on-surface tabular-nums flex-shrink-0">{successRate}%</span>
        </div>

        {/* Current activity (active agents) */}
        {isActive && entry.activeSteps.length > 0 && (
          <div className="pt-3 space-y-1.5" style={{ borderTop: '1px solid var(--sf-outline-variant)' }}>
            <div className="label-technical text-2xs text-on-surface-variant mb-1">Current Activity</div>
            {entry.activeSteps.map(({ step, run }, i) => (
              <button
                key={i}
                onClick={() => onSelectRun(run)}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded bg-surface-container-low hover:bg-surface-container-high transition-colors"
              >
                <div
                  className="w-1.5 h-1.5 rounded-full animate-pulse-soft flex-shrink-0"
                  style={{ backgroundColor: color }}
                />
                <span className="text-2xs text-on-surface truncate flex-1">
                  {truncate(step.task || run.ticket_title || run.run_id, 50)}
                </span>
                <span className="text-2xs font-mono text-on-surface-variant flex-shrink-0">
                  (Step {step.step_number})
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Recent history (inactive agents) */}
        {!isActive && entry.recentSteps.length > 0 && (
          <div className="pt-3 space-y-1" style={{ borderTop: '1px solid var(--sf-outline-variant)' }}>
            <div className="label-technical text-2xs text-on-surface-variant mb-1">Recent History</div>
            {entry.recentSteps.slice(0, 3).map(({ step, run }, i) => (
              <button
                key={i}
                onClick={() => onSelectRun(run)}
                className="w-full text-left flex items-center gap-2 px-2.5 py-1 rounded hover:bg-surface-container-low transition-colors"
              >
                <span className="text-2xs text-on-surface-variant truncate flex-1">
                  {truncate(run.ticket_title || run.run_id, 40)}
                </span>
                <span className="text-2xs font-mono text-on-surface-variant flex-shrink-0">
                  {step.started_at ? timeAgo(step.started_at) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Fleet Footer ── */

function FleetFooter({ totalTokens }) {
  return (
    <div className="mt-4 flex items-center justify-between px-4 py-3 bg-surface-container-low rounded">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-on-surface-variant">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <path d="M5 8h6M8 5v6" strokeLinecap="round" />
          </svg>
          <span className="label-technical text-2xs text-on-surface-variant">Total Fleet Tokens</span>
          <span className="font-display font-bold text-on-surface">{totalTokens.toLocaleString()}</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button className="px-3 py-1.5 rounded bg-surface-container text-sm text-on-surface-variant hover:bg-surface-container-high transition-colors label-technical text-2xs">
          Export Report
        </button>
        <button className="px-3 py-1.5 rounded gradient-primary text-sm text-on-primary hover:opacity-90 transition-opacity label-technical text-2xs">
          Scale Fleet
        </button>
      </div>
    </div>
  )
}
