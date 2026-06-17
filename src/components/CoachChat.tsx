'use client'

import { useEffect, useRef, useState } from 'react'
import { X, Send, Loader2, Brain, Trash2 } from 'lucide-react'

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Marker for the in-flight streaming message so we can append tokens to it. */
  streaming?: boolean
}

const STORAGE_KEY = 'coach-chat-history-v1'
const MAX_PERSISTED_MESSAGES = 100   // localStorage cap so the key doesn't grow unbounded

export default function CoachChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Hydrate history from localStorage on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMessage[]
        if (Array.isArray(parsed)) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot hydration from localStorage
          setMessages(parsed.filter(m => m.role && m.content).slice(-MAX_PERSISTED_MESSAGES))
        }
      }
    } catch { /* ignore */ }
  }, [])

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
        <Brain className="w-4 h-4 text-blue-400" />
        <span className="font-semibold text-white text-sm">Trade Coach</span>
        <span className="ml-2 text-[10px] text-gray-500">Asks your data — answers from your actual trades</span>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearChat}
            className="ml-auto text-gray-500 hover:text-red-400 transition-colors"
            title="Clear chat history"
            aria-label="Clear chat"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className={messages.length > 0 ? "text-gray-500 hover:text-white transition-colors" : "ml-auto text-gray-500 hover:text-white transition-colors"}
          title="Close"
          aria-label="Close chat"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-sm">
        {messages.length === 0 && (
          <div className="text-gray-500 text-xs space-y-2">
            <p>Ask me anything about your trading. I have access to your last 180 days of trades, setups, mistakes, day types, and orderflow tags.</p>
            <p className="text-gray-600">Try:</p>
            <ul className="list-disc pl-4 space-y-1 text-gray-600">
              <li>&ldquo;What setups have been working this week?&rdquo;</li>
              <li>&ldquo;What are my patterns when I trade poorly?&rdquo;</li>
              <li>&ldquo;How does my win rate compare on Range days vs Trend days?&rdquo;</li>
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

      {/* Input */}
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
        <p className="text-[10px] text-gray-600 mt-1.5">Enter to send · Shift+Enter for new line</p>
      </div>
    </div>
  )
}
