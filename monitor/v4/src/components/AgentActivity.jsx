import { useState, useEffect, useRef } from 'react'
import { fetchStepLog } from '../hooks/useMonitor'

// ── JSONL parsing ──

function parseJsonSafe(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

function parseAgentItems(raw) {
  const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return []
  const items = []
  let buffer = ''
  for (const line of lines) {
    const candidate = buffer ? `${buffer}\n${line}` : line
    const parsed = parseJsonSafe(candidate)
    if (parsed && typeof parsed === 'object') { items.push(parsed); buffer = '' }
    else buffer = candidate
  }
  if (buffer) {
    const parsed = parseJsonSafe(buffer)
    if (parsed && typeof parsed === 'object') items.push(parsed)
  }
  return items
}

function pickStr(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function textFromContent(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(i => typeof i === 'string' ? i : pickStr(i, ['text', 'output_text', 'message'])).filter(Boolean).join('\n')
  }
  if (typeof value === 'object') return pickStr(value, ['text', 'output_text', 'message'])
  return ''
}

function shortText(value, max = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : text.slice(0, max) + '...'
}

function getStepNumber(item) {
  return item?.step ?? item?.step_number ?? item?.data?.step ?? item?.data?.step_number ?? null
}

// ── Classification (mirrors v3 logic) ──

const ICONS = {
  'Command': '$ ',
  'File edit': '~ ',
  'Tool call': '> ',
  'Thought': '? ',
  'Message': '> ',
  'Guardrail': '! ',
  'Result': '= ',
  'Session': '# ',
}

function classifyItem(item) {
  const nested = item?.item ?? {}
  const kind = pickStr(nested, ['type']) || pickStr(item, ['type', 'event_type'])
  const command = pickStr(nested, ['command', 'cmd']) || pickStr(item, ['command', 'cmd'])
  const normCmd = pickStr(item?.data, ['command', 'cmd'])
  const normPath = pickStr(item?.data, ['path', 'file_path', 'target_path'])
  const normTool = pickStr(item?.data, ['tool_name', 'name'])
  const normThought = pickStr(item?.data, ['text', 'message', 'reason'])
  const thought = pickStr(nested, ['prompt', 'instructions', 'input']) || pickStr(item, ['prompt', 'instructions', 'input']) || normThought || textFromContent(nested.input) || textFromContent(item.input)
  const message = pickStr(nested, ['text', 'message', 'assistant_message', 'output_text']) || pickStr(item, ['message', 'assistant_message', 'output_text']) || textFromContent(nested.output) || textFromContent(item.output)

  const lower = String(kind).toLowerCase()

  if (lower === 'agent_command_run') return { kind: 'Command', preview: shortText(normCmd || normTool || 'command'), isCode: true, isError: false }
  if (lower === 'agent_file_edit') return { kind: 'File edit', preview: shortText(normPath || normTool || 'file'), isCode: true, isError: false }
  if (lower === 'agent_tool_call') return { kind: 'Tool call', preview: shortText(normTool || 'tool call'), isCode: false, isError: false }
  if (lower === 'agent_thinking') return { kind: 'Thought', preview: shortText(normThought || 'thinking'), isCode: false, isError: false }
  if (lower === 'agent_guardrail_block') return { kind: 'Guardrail', preview: shortText(normThought || normCmd || normPath || 'blocked'), isCode: false, isError: true }
  if (lower === 'command_execution' || command) return { kind: 'Command', preview: shortText(command || message || thought), isCode: true, isError: false }
  if (lower === 'agent_message' || lower === 'message') return { kind: 'Message', preview: shortText(message || thought), isCode: false, isError: false }
  if (lower === 'thought' || lower === 'reasoning') return { kind: 'Thought', preview: shortText(thought || message), isCode: false, isError: false }
  if (lower.includes('thread.started') || lower.includes('turn.started')) return { kind: 'Session', preview: '', isCode: false, isError: false }

  // Claude SDK JSONL: { type: "assistant", content: [...] }
  if (lower === 'assistant') {
    const content = (Array.isArray(item?.message?.content) && item.message.content) || (Array.isArray(item?.content) && item.content) || []
    const thinking = content.find(c => c?.type === 'thinking')
    if (thinking?.thinking) return { kind: 'Thought', preview: shortText(thinking.thinking), isCode: false, isError: false }
    const toolUse = content.find(c => c?.type === 'tool_use')
    if (toolUse) {
      const toolName = String(toolUse?.name || '')
      const input = toolUse?.input && typeof toolUse.input === 'object' ? toolUse.input : {}
      const toolCmd = pickStr(input, ['command', 'cmd'])
      const toolPath = pickStr(input, ['file_path', 'path'])
      const toolPreview = toolCmd || toolPath || toolName || 'tool call'
      const isCmdTool = /^(bash|task|taskoutput)$/i.test(toolName) || Boolean(toolCmd)
      return { kind: isCmdTool ? 'Command' : 'Tool call', preview: shortText(toolPreview), isCode: isCmdTool, isError: false }
    }
    const textBlock = content.find(c => c?.type === 'text' && typeof c?.text === 'string')
    if (textBlock?.text) return { kind: 'Message', preview: shortText(textBlock.text), isCode: false, isError: false }
  }

  if (lower === 'result') return { kind: 'Result', preview: shortText(pickStr(item, ['result']) || 'completed'), isCode: false, isError: false }

  // Check for errors
  const isErr = isErrorLike(item)
  return { kind: 'Event', preview: shortText(message || command || thought), isCode: false, isError: isErr }
}

function isErrorLike(item) {
  if (pickStr(item, ['error', 'reason']) || pickStr(item?.data, ['error', 'reason'])) return true
  const topType = pickStr(item, ['type', 'event_type']).toLowerCase()
  if (/(error|failed|exception|denied|blocked)/i.test(topType)) return true
  const nested = item?.item ?? {}
  const nestedExit = nested?.exit_code
  if (typeof nestedExit === 'number' && nestedExit !== 0) {
    // grep/rg returning 1 with no output is not an error
    const cmd = pickStr(nested, ['command', 'cmd']).toLowerCase()
    if (nestedExit === 1 && !String(nested?.aggregated_output || '').trim() && (/\brg\b/.test(cmd) || /\bgrep\b/.test(cmd))) return false
    return true
  }
  return false
}

// ── Kind styling ──

const KIND_STYLES = {
  'Command': { bg: 'bg-slate-50', border: 'border-slate-200', icon: 'text-slate-500', label: 'text-slate-700' },
  'File edit': { bg: 'bg-amber-50', border: 'border-amber-200', icon: 'text-amber-500', label: 'text-amber-700' },
  'Tool call': { bg: 'bg-blue-50', border: 'border-blue-200', icon: 'text-blue-500', label: 'text-blue-700' },
  'Thought': { bg: 'bg-violet-50', border: 'border-violet-200', icon: 'text-violet-400', label: 'text-violet-600' },
  'Message': { bg: 'bg-emerald-50', border: 'border-emerald-200', icon: 'text-emerald-500', label: 'text-emerald-700' },
  'Guardrail': { bg: 'bg-red-50', border: 'border-red-200', icon: 'text-red-500', label: 'text-red-700' },
  'Result': { bg: 'bg-green-50', border: 'border-green-200', icon: 'text-green-500', label: 'text-green-700' },
  'Session': { bg: 'bg-surface-200', border: 'border-surface-300', icon: 'text-ink-300', label: 'text-ink-400' },
  'Event': { bg: 'bg-surface-200', border: 'border-surface-300', icon: 'text-ink-400', label: 'text-ink-500' },
}

// ── Component ──

export default function AgentActivity({ projectId, runId, stepNumber }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [expandedIds, setExpandedIds] = useState(new Set())
  const listRef = useRef(null)

  useEffect(() => {
    if (stepNumber == null) return
    setLoading(true)
    setItems([])
    fetchStepLog(projectId, runId, stepNumber, 'agent_stdout')
      .then(raw => {
        const parsed = parseAgentItems(raw)
        const filtered = parsed.filter(item => {
          const step = getStepNumber(item)
          return step === null || step === stepNumber
        })
        const target = filtered.length ? filtered : parsed
        const classified = target
          .map((item, i) => ({ item, cls: classifyItem(item), index: i }))
          .filter(row => row.cls.kind !== 'Event' || row.cls.isError)
        setItems(classified.slice(-200))
        setLoading(false)
      })
      .catch(() => { setItems([]); setLoading(false) })
  }, [projectId, runId, stepNumber])

  // Auto-scroll to bottom on new items
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [items])

  function toggleExpand(index) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  if (loading) {
    return (
      <div className="py-6 text-center">
        <p className="text-xs text-ink-400 animate-pulse">Loading agent activity...</p>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-xs text-ink-300 italic">No structured activity captured for this step.</p>
      </div>
    )
  }

  return (
    <div ref={listRef} className="space-y-1.5 max-h-[50vh] overflow-y-auto">
      {items.map(({ item, cls, index }, visibleIdx) => {
        const style = KIND_STYLES[cls.kind] || KIND_STYLES.Event
        const expanded = expandedIds.has(index)

        return (
          <div key={index} className={`rounded-xl border ${style.border} ${cls.isError ? 'border-red-300 bg-red-50/50' : style.bg} overflow-hidden transition-all`}>
            <button
              onClick={() => toggleExpand(index)}
              className="w-full text-left flex items-start gap-2.5 px-3 py-2 hover:bg-black/[0.02] transition-colors"
            >
              <span className={`text-[10px] font-mono font-bold mt-px flex-shrink-0 w-14 ${style.label}`}>
                {cls.kind}
              </span>
              <span className={`text-[11px] leading-snug flex-1 min-w-0 ${cls.isCode ? 'font-mono text-ink-700' : 'text-ink-600'} ${cls.preview ? '' : 'italic text-ink-300'}`}>
                {cls.preview || '(empty)'}
              </span>
              <span className="text-[9px] font-mono text-ink-300 flex-shrink-0 mt-px">
                #{visibleIdx + 1}
              </span>
            </button>

            {expanded && (
              <div className="border-t border-surface-300 bg-surface-50">
                <pre className="px-3 py-2 text-[10px] font-mono text-ink-600 leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                  {JSON.stringify(item, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
