import { useState, useEffect, useCallback } from 'react'
import { fetchFiles, fetchDiff } from '../hooks/useMonitor'

export default function FileDiffs({ projectId, runId, onFileCount }) {
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedFile, setSelectedFile] = useState(null)
  const [diffs, setDiffs] = useState({})
  const [loadingDiff, setLoadingDiff] = useState(null)

  useEffect(() => {
    setLoading(true)
    fetchFiles(projectId, runId)
      .then(data => {
        const sorted = (data.files || [])
          .filter(f => !f.path.startsWith('.git/') && !f.path.startsWith('.sprintfoundry/') && !f.path.startsWith('.agent-context/'))
          .sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0))
        setFiles(sorted)
        onFileCount?.(sorted.length)
        setLoading(false)
        // Auto-select first file
        if (sorted.length > 0 && !selectedFile) {
          loadDiffFor(sorted[0].path)
        }
      })
      .catch(() => { setFiles([]); setLoading(false) })
  }, [projectId, runId])

  async function loadDiffFor(filePath) {
    setSelectedFile(filePath)
    if (diffs[filePath]) return
    setLoadingDiff(filePath)
    try {
      const data = await fetchDiff(projectId, runId, filePath)
      setDiffs(prev => ({ ...prev, [filePath]: data }))
    } catch {
      setDiffs(prev => ({ ...prev, [filePath]: { diff: '(diff unavailable)', kind: 'none' } }))
    }
    setLoadingDiff(null)
  }

  if (loading) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-on-surface-variant animate-pulse">Loading files...</p>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-on-surface-variant italic">No files found in workspace.</p>
      </div>
    )
  }

  const diffData = selectedFile ? diffs[selectedFile] : null
  const isLoadingSelected = loadingDiff === selectedFile

  return (
    <div className="flex flex-col h-full">
      {/* File tabs */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-outline-variant overflow-x-auto">
        {files.slice(0, 20).map(file => {
          const isActive = selectedFile === file.path
          const fileDiff = diffs[file.path]
          const fileName = file.path.split('/').pop()
          const kind = fileDiff?.kind

          return (
            <button
              key={file.path}
              onClick={() => loadDiffFor(file.path)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-2xs font-mono whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-surface-container-high text-on-surface'
                  : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/50'
              }`}
            >
              <FileIcon kind={kind} />
              {fileName}
              {kind === 'new' && (
                <span className="text-2xs font-bold px-1 py-px rounded bg-status-completed/20 text-status-completed label-technical" style={{ fontSize: '9px' }}>NEW</span>
              )}
              {kind === 'diff' && (
                <span className="text-2xs font-bold px-1 py-px rounded bg-status-warning/20 text-status-warning label-technical" style={{ fontSize: '9px' }}>MOD</span>
              )}
            </button>
          )
        })}
      </div>

      {/* Diff viewer */}
      {selectedFile && (
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* File path header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-outline-variant">
            <div className="flex items-center gap-2">
              <FileIcon kind={diffData?.kind} />
              <span className="label-technical text-2xs text-on-surface">{selectedFile.toUpperCase()}</span>
            </div>
          </div>

          {/* Diff content */}
          <div className="flex-1 overflow-auto">
            {isLoadingSelected ? (
              <div className="px-4 py-5 text-center">
                <p className="text-xs text-on-surface-variant animate-pulse">Loading diff...</p>
              </div>
            ) : !diffData?.diff || diffData?.kind === 'none' ? (
              <div className="px-4 py-4">
                <p className="text-xs text-on-surface-variant italic">No changes detected</p>
              </div>
            ) : (
              <DiffView diff={diffData.diff} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileIcon({ kind }) {
  if (kind === 'new') return <span className="text-xs text-status-completed font-bold flex-shrink-0">+</span>
  if (kind === 'diff') return <span className="text-xs text-status-warning font-bold flex-shrink-0">~</span>
  if (kind === 'untracked') return <span className="text-xs text-status-planning font-bold flex-shrink-0">?</span>
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-on-surface-variant flex-shrink-0">
      <path d="M4 2h5.5L13 5.5V13a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
      <path d="M9.5 2v4H13" />
    </svg>
  )
}

function DiffView({ diff }) {
  const lines = diff.split('\n')

  return (
    <div className="overflow-x-auto font-mono text-[11px] leading-[1.7]">
      {lines.map((line, i) => {
        let cls = 'text-on-surface-variant bg-transparent'
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-500/10'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-500/10'
        else if (line.startsWith('@@')) cls = 'text-primary bg-primary/5 font-semibold'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls = 'text-on-surface-variant/60 bg-surface-container-high/30'

        return (
          <div key={i} className={`px-4 whitespace-pre ${cls}`}>
            {line || ' '}
          </div>
        )
      })}
    </div>
  )
}
