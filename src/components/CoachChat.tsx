'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2, Brain, Trash2, Download, Archive, ChevronLeft } from 'lucide-react'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Marker for the in-flight streaming message so we can append tokens to it. */
  streaming?: boolean
}

/** An archived conversation — snapshotted when the active chat goes idle. */
interface ArchivedConversation {
  id: string
  archivedAt: number    // epoch ms
  messages: ChatMessage[]
}

const STORAGE_KEY = 'coach-chat-history-v1'
const ARCHIVE_KEY = 'coach-chat-archives-v1'
const ACTIVITY_KEY = 'coach-chat-last-activity-v1'
const MAX_PERSISTED_MESSAGES = 100   // localStorage cap so the key doesn't grow unbounded
const MAX_ARCHIVES = 50              // keep the most recent N archived conversations
const IDLE_MS = 30 * 60 * 1000       // 30 minutes of inactivity → auto-archive + clear

export default function CoachChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 'chat' = active conversation; 'archives' = browse archived ones.
  const [view, setView] = useState<'chat' | 'archives'>('chat')
  const [archives, setArchives] = useState<ArchivedConversation[]>([])
  const [openArchiveId, setOpenArchiveId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── localStorage helpers ────────────────────────────────────────────────
  const loadArchives = (): ArchivedConversation[] => {
    try {
      const raw = localStorage.getItem(ARCHIVE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw) as ArchivedConversation[]
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  const saveArchives = (list: ArchivedConversation[]) => {
    try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list.slice(0, MAX_ARCHIVES))) } catch { /* ignore */ }
  }
  const bumpActivity = () => {
    // eslint-disable-next-line react-hooks/purity -- called from handlers/effects, not render
    try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())) } catch { /* ignore */ }
  }

  // Move the current conversation into the archive and clear the active chat.
  // Used both by the idle timer and the mount-staleness check. `msgs` is
  // passed explicitly so callers can archive a snapshot they already hold.
  const archiveAndClear = (msgs: ChatMessage[]) => {
    const real = msgs.filter(m => !m.streaming && m.content.trim())
    if (real.length === 0) return
    const entry: ArchivedConversation = {
      id: `${Date.now()}-${real.length}`,
      archivedAt: Date.now(),
      messages: real,
    }
    const next = [entry, ...loadArchives()].slice(0, MAX_ARCHIVES)
    saveArchives(next)
    setArchives(next)
    setMessages([])
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  // Hydrate history + archives on mount. If the persisted active chat has been
  // idle past the threshold (e.g. the tab was closed overnight), archive it
  // immediately so the user opens to a fresh conversation with the old one
  // tucked into the archive.
  useEffect(() => {
    setArchives(loadArchives())   // eslint-disable-line react-hooks/set-state-in-effect -- one-shot hydration
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as ChatMessage[]
      if (!Array.isArray(parsed)) return
      const msgs = parsed.filter(m => m.role && m.content).slice(-MAX_PERSISTED_MESSAGES)
      if (msgs.length === 0) return
      const lastActivity = Number(localStorage.getItem(ACTIVITY_KEY) ?? '0')
      if (lastActivity > 0 && Date.now() - lastActivity >= IDLE_MS) {
        archiveAndClear(msgs)   // stale → archive on open
      } else {
        setMessages(msgs)
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Idle watcher: every 60s, if the active chat has gone untouched past the
  // threshold, archive it and clear. Only runs while the component is mounted
  // (the mount check above covers the tab-closed case).
  useEffect(() => {
    const id = setInterval(() => {
      if (sending) return
      const lastActivity = Number(localStorage.getItem(ACTIVITY_KEY) ?? '0')
      if (lastActivity > 0 && Date.now() - lastActivity >= IDLE_MS && messages.some(m => !m.streaming)) {
        archiveAndClear(messages)
      }
    }, 60_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, sending])

  // Persist on every messages change. Skip the streaming flag from storage.
  useEffect(() => {
    try {
      const toStore = messages.filter(m => !m.streaming).slice(-MAX_PERSISTED_MESSAGES)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore))
    } catch { /* ignore */ }
  }, [messages])

  // Auto-scroll to bottom on new message / token.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, open])

  // Auto-focus the input when the panel opens.
  useEffect(() => {
    if (open) setTimeout(() => textareaRef.current?.focus(), 50)
  }, [open])

  const send = async () => {
    const trimmed = input.trim()
    if (!trimmed || sending) return
    setInput('')
    setError(null)
    setSending(true)
    setView('chat')   // sending always returns to the active conversation
    bumpActivity()    // reset the idle clock on every send
    // Snapshot history BEFORE adding the new user message so /api/coach gets
    // the prior turns and we don't duplicate the new turn in both places.
    const priorHistory = messages.filter(m => !m.streaming).map(({ role, content }) => ({ role, content }))
    setMessages(prev => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: '', streaming: true }])
    try {
      const res = await fetch('/api/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history: priorHistory }),
      })
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error ?? `coach failed (${res.status})`)
      }
      // Parse SSE: lines starting with "data: ", terminated by [DONE].
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // Process complete event blocks (separated by \n\n)
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.startsWith('data: ') ? part.slice(6).trim() : part.trim()
          if (!line) continue
          if (line === '[DONE]') continue
          try {
            const obj = JSON.parse(line) as { text?: string; error?: string }
            if (obj.error) throw new Error(obj.error)
            if (obj.text) {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (!last || last.role !== 'assistant') return prev
                return [...prev.slice(0, -1), { ...last, content: last.content + obj.text }]
              })
            }
          } catch (e) {
            console.warn('[coach-chat] failed to parse SSE chunk:', line, e)
          }
        }
      }
      // Clear the streaming flag on the final assistant message.
      setMessages(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.role !== 'assistant') return prev
        return [...prev.slice(0, -1), { role: 'assistant', content: last.content }]
      })
      bumpActivity()   // response landed — reset the idle clock
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'network error'
      setError(msg)
      // Drop the empty streaming placeholder so the chat isn't left with a blank assistant bubble.
      setMessages(prev => prev[prev.length - 1]?.streaming ? prev.slice(0, -1) : prev)
    } finally {
      setSending(false)
    }
  }

  const clearChat = () => {
    if (!confirm('Clear the entire coach chat history?')) return
    setMessages([])
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  /** Download the conversation as a markdown transcript. Browser-side only —
   *  builds a Blob and triggers a download via a temporary anchor. */
  const exportTranscript = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const body = messages
      .filter(m => !m.streaming && m.content.trim())
      .map(m => `### ${m.role === 'user' ? 'You' : 'Coach'}\n\n${m.content.trim()}`)
      .join('\n\n---\n\n')
    const md = `# Trade Coach conversation\n\nExported ${stamp}\n\n---\n\n${body}\n`
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `coach-chat-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  /** Manually archive the current conversation (the "stash it now" button) —
   *  same path the idle timer uses, just user-triggered. */
  const archiveNow = () => {
    archiveAndClear(messages)
    setView('chat')
  }

  const deleteArchive = (id: string) => {
    const next = loadArchives().filter(a => a.id !== id)
    saveArchives(next)
    setArchives(next)
    if (openArchiveId === id) setOpenArchiveId(null)
  }

  /** Pull an archived conversation back into the active chat (archives the
   *  current one first if it has content, so nothing is lost). */
  const restoreArchive = (id: string) => {
    const arc = loadArchives().find(a => a.id === id)
    if (!arc) return
    if (messages.some(m => !m.streaming && m.content.trim())) archiveAndClear(messages)
    setMessages(arc.messages)
    deleteArchive(id)
    setView('chat')
    setOpenArchiveId(null)
    bumpActivity()
  }

  const formatWhen = (ms: number) => {
    const d = new Date(ms)
    const today = new Date()
    const sameDay = d.toDateString() === today.toDateString()
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  // Bottom-right floating launcher
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40 flex items-center justify-center transition-colors"
        title="Trade Coach"
        aria-label="Open Trade Coach"
      >
        <Brain className="w-6 h-6" />
      </button>
    )
  }

  return (
    <div className="fixed bottom-6 right-6 z-40 w-[420px] max-w-[calc(100vw-3rem)] h-[600px] max-h-[calc(100vh-3rem)] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl shadow-black/60 flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
        {view === 'archives' ? (
          <>
            <button
              type="button"
              onClick={() => { setView('chat'); setOpenArchiveId(null) }}
              className="text-gray-400 hover:text-white transition-colors inline-flex items-center gap-1 text-sm"
              title="Back to chat"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
            <span className="font-semibold text-white text-sm ml-1">Archived chats</span>
          </>
        ) : (
          <>
            <Brain className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="font-semibold text-white text-sm">Trade Coach</span>
            <span className="ml-1 text-[10px] text-gray-500 truncate hidden sm:inline">Answers from your actual trades</span>
          </>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {view === 'chat' && (
            <>
              {archives.length > 0 && (
                <button
                  type="button"
                  onClick={() => setView('archives')}
                  className="text-gray-500 hover:text-blue-400 transition-colors relative"
                  title={`Archived conversations (${archives.length})`}
                  aria-label="View archived chats"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span className="absolute -top-1.5 -right-1.5 bg-blue-600 text-white text-[8px] leading-none rounded-full px-1 py-0.5">{archives.length}</span>
                </button>
              )}
              {messages.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={archiveNow}
                    className="text-gray-500 hover:text-blue-400 transition-colors"
                    title="Archive this conversation and start fresh"
                    aria-label="Archive conversation"
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={exportTranscript}
                    className="text-gray-500 hover:text-blue-400 transition-colors"
                    title="Download this conversation as a text file"
                    aria-label="Export transcript"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={clearChat}
                    className="text-gray-500 hover:text-red-400 transition-colors"
                    title="Delete this conversation (no archive)"
                    aria-label="Clear chat"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-gray-500 hover:text-white transition-colors"
            title="Close"
            aria-label="Close chat"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Archive browser */}
      {view === 'archives' && (
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 text-sm">
          {archives.length === 0 && (
            <p className="text-gray-500 text-xs px-1">No archived conversations yet. Chats auto-archive after 30 minutes idle.</p>
          )}
          {archives.map(arc => {
            const firstUser = arc.messages.find(m => m.role === 'user')?.content ?? '(empty)'
            const isOpen = openArchiveId === arc.id
            return (
              <div key={arc.id} className="border border-gray-800 rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenArchiveId(isOpen ? null : arc.id)}
                  className="w-full text-left px-3 py-2 hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-500 shrink-0">{formatWhen(arc.archivedAt)}</span>
                    <span className="text-[10px] text-gray-600 shrink-0">· {arc.messages.length} msgs</span>
                  </div>
                  <div className="text-xs text-gray-300 truncate mt-0.5">{firstUser}</div>
                </button>
                {isOpen && (
                  <div className="border-t border-gray-800 bg-gray-950/40">
                    <div className="max-h-48 overflow-y-auto px-3 py-2 space-y-2">
                      {arc.messages.map((m, i) => (
                        <div key={i} className={`text-[11px] leading-snug ${m.role === 'user' ? 'text-blue-300' : 'text-gray-300'}`}>
                          <span className="font-semibold">{m.role === 'user' ? 'You: ' : 'Coach: '}</span>
                          <span className="whitespace-pre-wrap break-words">{m.content}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center gap-3 px-3 py-2 border-t border-gray-800">
                      <button type="button" onClick={() => restoreArchive(arc.id)} className="text-[11px] text-blue-400 hover:text-blue-300">Restore to chat</button>
                      <button type="button" onClick={() => deleteArchive(arc.id)} className="text-[11px] text-gray-500 hover:text-red-400 ml-auto">Delete</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Messages */}
      {view === 'chat' && (
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {messages.length === 0 && (
          <div className="text-gray-500 text-xs space-y-2">
            <p>Ask me anything about your trading. I have your last 180 days — month-by-month performance, setups, mistakes, day types, orderflow, 5m structure, and your last 150 trades in detail.</p>
            <p className="text-gray-600">Try:</p>
            <ul className="list-disc pl-4 space-y-1 text-gray-600">
              <li>&ldquo;How did I do month over month?&rdquo;</li>
              <li>&ldquo;What are my patterns when I trade poorly?&rdquo;</li>
              <li>&ldquo;Am I better following or fading 5m structure?&rdquo;</li>
              <li>&ldquo;Which mistakes cost me the most money?&rdquo;</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] px-3 py-2 rounded-lg text-[13px] leading-relaxed whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-200 border border-gray-700'
              }`}
            >
              {m.content}
              {m.streaming && <span className="inline-block w-2 h-3 ml-1 bg-current opacity-60 animate-pulse" />}
            </div>
          </div>
        ))}
        {error && (
          <div className="text-xs text-red-400 bg-red-950/40 border border-red-900/60 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </div>
      )}

      {/* Input (chat view only) */}
      {view === 'chat' && (
      <div className="border-t border-gray-800 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            disabled={sending}
            placeholder="Ask about your trading…"
            rows={2}
            className="flex-1 bg-gray-950 border border-gray-700 text-gray-200 rounded-lg px-3 py-2 text-sm resize-none placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg transition-colors h-[68px] flex items-center"
            aria-label="Send"
          >
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
        <p className="text-[10px] text-gray-600 mt-1.5">Enter to send · Shift+Enter for new line · auto-archives after 30m idle</p>
      </div>
      )}
    </div>
  )
}
