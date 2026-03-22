export default function SideNav({ view, onViewChange, theme, onToggleTheme }) {
  return (
    <aside className="w-60 flex-shrink-0 h-full flex flex-col bg-surface-container-low">
      {/* Logo */}
      <div className="px-5 pt-6 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded gradient-primary flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 3h4v4H3V3zm6 0h4v4H9V3zM3 9h4v4H3V9zm6 2.5L11 9l2 2.5h-4z" fill="var(--sf-on-primary)"/>
            </svg>
          </div>
          <div>
            <div className="font-display font-semibold text-sm tracking-headline text-on-surface">SprintFoundry</div>
            <div className="label-technical text-2xs text-on-surface-variant">AI Orchestrator</div>
          </div>
        </div>
      </div>

      {/* New Run button */}
      <div className="px-4 mb-4">
        <button className="w-full h-9 rounded gradient-primary text-on-primary text-sm font-medium flex items-center justify-center gap-2 hover:opacity-90 transition-opacity">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 3v10M3 8h10" strokeLinecap="round"/>
          </svg>
          New Run
        </button>
      </div>

      {/* Nav links */}
      <nav className="flex-1 px-3 space-y-0.5">
        <NavItem
          active={view === 'runs'}
          onClick={() => onViewChange('runs')}
          icon={<GridIcon />}
          label="Runs"
        />
        <NavItem
          active={view === 'agents'}
          onClick={() => onViewChange('agents')}
          icon={<AgentsIcon />}
          label="Agents"
        />
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-5 space-y-0.5">
        {/* Theme toggle */}
        <button
          onClick={onToggleTheme}
          className="w-full flex items-center gap-3 px-3 py-2 rounded text-sm text-on-surface-variant hover:bg-surface-container transition-colors"
        >
          {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          <span>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</span>
        </button>

        <NavItem icon={<SettingsIcon />} label="Settings" />
        <NavItem icon={<SupportIcon />} label="Support" />
      </div>
    </aside>
  )
}

function NavItem({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
        active
          ? 'bg-primary-fixed text-primary font-medium'
          : 'text-on-surface-variant hover:bg-surface-container'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}

function AgentsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="5" r="3" />
      <path d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6" strokeLinecap="round" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4" strokeLinecap="round" />
    </svg>
  )
}

function SupportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6" />
      <path d="M6 6a2 2 0 1 1 2 2v1.5" strokeLinecap="round" />
      <circle cx="8" cy="12" r="0.5" fill="currentColor" />
    </svg>
  )
}

function SunIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" strokeLinecap="round" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M13.5 8.5a5.5 5.5 0 0 1-6-6 5.5 5.5 0 1 0 6 6Z" />
    </svg>
  )
}
