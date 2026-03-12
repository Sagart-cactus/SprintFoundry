const SSE_DOT = {
  connected: 'bg-status-success',
  connecting: 'bg-status-warning animate-pulse',
  disconnected: 'bg-status-error',
}

export default function Topbar({ view, onViewChange, stats, sseStatus, searchQuery, onSearchChange, onBack, selectedRun, onRefresh }) {
  return (
    <header className="h-14 flex-shrink-0 flex items-center justify-between px-5 border-b border-surface-200 bg-surface-0 z-40">
      <div className="flex items-center gap-4">
        {onBack && (
          <button
            onClick={onBack}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-400 hover:text-ink-900 hover:bg-surface-100 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}

        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-brand flex items-center justify-center">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3h4v4H3V3zm6 0h4v4H9V3zM3 9h4v4H3V9zm6 2.5L11 9l2 2.5h-4z" fill="white"/>
            </svg>
          </div>
          <span className="font-semibold text-sm text-ink-900 tracking-tight">
            SprintFoundry
          </span>
        </div>

        {!onBack && (
          <nav className="flex items-center ml-1 border-l border-surface-200 pl-4 gap-1">
            <NavTab active={view === 'runs'} onClick={() => onViewChange('runs')}>Runs</NavTab>
            <NavTab active={view === 'agents'} onClick={() => onViewChange('agents')}>Agents</NavTab>
          </nav>
        )}

        {onBack && selectedRun && (
          <div className="flex items-center gap-2 border-l border-surface-200 pl-4">
            <span className="font-mono text-xs text-ink-500">{selectedRun.project_id}</span>
            <span className="text-ink-300">/</span>
            <span className="font-mono text-xs text-ink-700 font-medium">{selectedRun.run_id}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4">
        {!onBack && (
          <div className="hidden sm:flex items-center gap-3 text-sm mr-2">
            <Stat value={stats.active} label="active" color="text-status-running" />
            <span className="text-surface-300">·</span>
            <Stat value={stats.failed} label="failed" color="text-status-error" />
            <span className="text-surface-300">·</span>
            <Stat value={stats.completed} label="done" color="text-status-success" />
          </div>
        )}

        {!onBack && (
          <div className="relative">
            <input
              type="text"
              placeholder="Search runs..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-8 w-48 bg-surface-50 border border-surface-200 rounded-lg px-3 pr-8 text-sm text-ink-900 placeholder:text-ink-400 focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/10 transition-all"
            />
            <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        )}

        <button
          onClick={onRefresh}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-ink-400 hover:text-ink-700 hover:bg-surface-100 transition-colors"
          title="Refresh"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 1v5h5M15 15v-5h-5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2.5 10A6 6 0 0113 3.5M13.5 6A6 6 0 013 12.5" strokeLinecap="round"/>
          </svg>
        </button>

        <div className="flex items-center gap-1.5 pl-3 border-l border-surface-200">
          <div className={`w-2 h-2 rounded-full ${SSE_DOT[sseStatus] || SSE_DOT.disconnected}`} />
          <span className="text-xs font-medium text-ink-400">{sseStatus === 'connected' ? 'Live' : sseStatus}</span>
        </div>
      </div>
    </header>
  )
}

function NavTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-all duration-150 ${
        active
          ? 'bg-brand text-white shadow-xs'
          : 'text-ink-500 hover:text-ink-900 hover:bg-surface-100'
      }`}
    >
      {children}
    </button>
  )
}

function Stat({ value, label, color }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`font-mono font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-ink-400">{label}</span>
    </span>
  )
}
