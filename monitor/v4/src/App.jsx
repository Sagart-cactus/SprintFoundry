import { useState, useMemo } from 'react'
import { useRuns } from './hooks/useMonitor'
import Topbar from './components/Topbar'
import Sidebar from './components/Sidebar'
import RunDashboard from './components/RunDashboard'
import RunDetail from './components/RunDetail'
import AgentMonitor from './components/AgentMonitor'
import StatusBar from './components/StatusBar'

export default function App() {
  const { runs, loading, sseStatus, refresh } = useRuns()
  const [view, setView] = useState('runs')
  const [selectedRun, setSelectedRun] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  const stats = useMemo(() => {
    const active = runs.filter(r => ['executing', 'planning', 'pending', 'waiting_human_review', 'rework'].includes(r.status))
    const failed = runs.filter(r => r.status === 'failed')
    const completed = runs.filter(r => r.status === 'completed')
    return { active: active.length, failed: failed.length, completed: completed.length, total: runs.length }
  }, [runs])

  function openRun(run) {
    setSelectedRun({ project_id: run.project_id, run_id: run.run_id })
    setView('detail')
  }

  function goBack() {
    setSelectedRun(null)
    setView('runs')
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Topbar
        view={view}
        onViewChange={setView}
        stats={stats}
        sseStatus={sseStatus}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onBack={view === 'detail' ? goBack : null}
        selectedRun={selectedRun}
      />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          runs={runs}
          view={view}
          selectedRun={selectedRun}
          onSelectRun={openRun}
          onViewChange={setView}
          searchQuery={searchQuery}
        />

        <main className="flex-1 overflow-y-auto p-6 bg-surface-50">
          {loading ? (
            <div className="space-y-4 animate-pulse">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-32 bg-surface-200 rounded-2xl" />
              ))}
            </div>
          ) : view === 'detail' && selectedRun ? (
            <RunDetail projectId={selectedRun.project_id} runId={selectedRun.run_id} />
          ) : view === 'agents' ? (
            <AgentMonitor runs={runs} onSelectRun={openRun} />
          ) : (
            <RunDashboard runs={runs} searchQuery={searchQuery} onSelectRun={openRun} />
          )}
        </main>
      </div>

      <StatusBar sseStatus={sseStatus} stats={stats} onRefresh={refresh} />
    </div>
  )
}
