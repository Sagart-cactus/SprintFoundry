const SSE_DOT = {
  connected: 'bg-status-success',
  connecting: 'bg-status-warning animate-pulse',
  disconnected: 'bg-status-error',
}

export default function Topbar({ view, onViewChange, stats, sseStatus, searchQuery, onSearchChange, onBack, selectedRun, onRefresh }) {
  return (
    <header className="h-12 flex-shrink-0 flex items-center justify-between px-4 border-b border-surface-300 bg-surface-100 z-40">
      <div className="flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="w-7 h-7 flex items-center justify-center rounded-md text-ink-400 hover:text-ink-900 hover:bg-surface-200 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}

        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-brand" />
          <span className="font-display font-bold text-[13px] tracking-tight text-ink-900">
            SPRINTFOUNDRY
          </span>
        </div>

        {!onBack && (
          <nav className="flex items-center ml-2 border-l border-surface-300 pl-3 gap-0.5">
            <NavTab active={view === 'runs'} onClick={() => onViewChange('runs')}>Runs</NavTab>
            <NavTab active={view === 'agents'} onClick={() => onViewChange('agents')}>Agents</NavTab>
          </nav>
        )}

        {onBack && selectedRun && (
          <span className="font-mono text-xs text-ink-400 truncate max-w-[300px] border-l border-surface-300 pl-3">
            {selectedRun.project_id} / {selectedRun.run_id}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {!onBack && (
          <div className="hidden sm:flex items-center gap-2.5 text-xs font-mono mr-1">
            <Stat label="active" value={stats.active} color="text-status-running" />
            <span className="text-surface-400">·</span>
            <Stat label="fail" value={stats.failed} color="text-status-error" />
            <span className="text-surface-400">·</span>
            <Stat label="done" value={stats.completed} color="text-status-success" />
          </div>
        )}

        {!onBack && (
          <div className="relative">
            <input
              type="text"
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-7 w-40 bg-surface-200 border border-surface-300 rounded-md px-2.5 pr-7 text-xs font-mono text-ink-900 placeholder:text-ink-300 focus:outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand/10 transition-all"
            />
            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-ink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        )}

        <button
          onClick={onRefresh}
          className="w-7 h-7 flex items-center justify-center rounded-md text-ink-400 hover:text-ink-700 hover:bg-surface-200 transition-colors"
          title="Refresh"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 1v5h5M15 15v-5h-5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2.5 10A6 6 0 0113 3.5M13.5 6A6 6 0 013 12.5" strokeLinecap="round"/>
          </svg>
        </button>

        <div className="flex items-center gap-1.5 pl-2 border-l border-surface-300">
          <div className={`w-1.5 h-1.5 rounded-full ${SSE_DOT[sseStatus] || SSE_DOT.disconnected}`} />
          <span className="text-[10px] font-mono text-ink-400">{sseStatus === 'connected' ? 'Live' : sseStatus}</span>
        </div>
      </div>
    </header>
  )
}

function NavTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-150 ${
        active
          ? 'bg-ink-900 text-white'
          : 'text-ink-500 hover:text-ink-900 hover:bg-surface-200'
      }`}
    >
      {children}
    </button>
  )
}

function Stat({ label, value, color }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`${color} font-semibold tabular-nums`}>{value}</span>
      <span className="text-ink-400">{label}</span>
    </span>
  )
}
