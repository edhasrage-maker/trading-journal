'use client'

import { useState, useCallback } from 'react'
import { Loader2, Save, X, ScanLine } from 'lucide-react'
import PinPlacement, { type PinType, type Pin } from './PinPlacement'
// PinType / Pin still used by the legacy pin-position fields kept in FormState
// so existing trades load + save their saved pin coordinates without loss.
import TagSelector from './TagSelector'
import { deleteBlob } from '@/lib/storage'
import type { Trade, TradeTag, TradeTags } from '@/lib/supabase/types'

interface Props {
  date: string
  allTags: TradeTag[]
  trade?: Trade | null
  initialFile?: File | null
  /** day_type from trading_days for this date — used to pre-fill the
   *  day_type tag on NEW trades. Ignored when editing an existing trade
   *  (the trade's own tags_json wins). */
  prepDayType?: string | null
  onSave: (trade: Trade) => void
  onCancel: () => void
}

interface FormState {
  direction: 'long' | 'short'
  entry_time: string
  entry_price: string
  stop_price: string
  tp1_price: string
  quantity: string
  pnl: string
  notes: string
  tags: TradeTags
  suggestedTags: TradeTags
  screenshot_url: string | null
  pendingFile: File | null
  activePin: PinType | null
  entry_pin_x: number | null; entry_pin_y: number | null
  stop_pin_x: number | null;  stop_pin_y: number | null
  tp1_pin_x: number | null;   tp1_pin_y: number | null
}

const empty = (): FormState => ({
  direction: 'long',
  entry_time: new Date().toTimeString().slice(0, 5),
  entry_price: '', stop_price: '', tp1_price: '', quantity: '', pnl: '', notes: '',
  tags: {}, suggestedTags: {}, screenshot_url: null, pendingFile: null, activePin: null,
  entry_pin_x: null, entry_pin_y: null,
  stop_pin_x: null,  stop_pin_y: null,
  tp1_pin_x: null,   tp1_pin_y: null,
})

function fromTrade(t: Trade): FormState {
  const timeStr = t.entry_time ? new Date(t.entry_time).toTimeString().slice(0, 5) : ''
  return {
    direction: t.direction ?? 'long',
    entry_time: timeStr,
    entry_price: t.entry_price?.toString() ?? '',
    stop_price: t.stop_price?.toString() ?? '',
    tp1_price: t.tp1_price?.toString() ?? '',
    quantity: t.quantity?.toString() ?? '',
    pnl: t.pnl?.toString() ?? '',
    notes: t.notes ?? '',
    tags: t.tags_json ?? {},
    suggestedTags: {},
    screenshot_url: t.screenshot_url,
    pendingFile: null,
    activePin: null,
    entry_pin_x: t.entry_pin_x, entry_pin_y: t.entry_pin_y,
    stop_pin_x: t.stop_pin_x,   stop_pin_y: t.stop_pin_y,
    tp1_pin_x: t.tp1_pin_x,     tp1_pin_y: t.tp1_pin_y,
  }
}

function rMultiple(s: FormState): string | null {
  const ep = parseFloat(s.entry_price), sp = parseFloat(s.stop_price)
  const pnl = parseFloat(s.pnl), qty = parseFloat(s.quantity)
  if (isNaN(ep) || isNaN(sp) || sp === ep) return null
  const risk = Math.abs(ep - sp) * (isNaN(qty) ? 1 : qty)
  if (risk === 0) return null
  if (!isNaN(pnl)) return (pnl / risk).toFixed(2) + 'R'
  return null
}

export default function TradeForm({ date, allTags, trade, initialFile, prepDayType, onSave, onCancel }: Props) {
  const [form, setForm] = useState<FormState>(() => {
    if (trade) return fromTrade(trade)
    const base = empty()
    if (initialFile) {
      base.screenshot_url = URL.createObjectURL(initialFile)
      base.pendingFile = initialFile
    }
    if (prepDayType) {
      base.tags = { ...base.tags, day_type: [prepDayType] }
    }
    return base
  })
  const [saving, setSaving] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track the originally-saved screenshot URL so we can delete it from storage
  // if the user replaces or removes it on save.
  const [savedScreenshotUrl, setSavedScreenshotUrl] = useState<string | null>(trade?.screenshot_url ?? null)

  const set = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm(f => ({ ...f, [key]: val }))

  const handleFile = useCallback((file: File) => {
    const url = URL.createObjectURL(file)
    setForm(f => ({ ...f, screenshot_url: url, pendingFile: file }))
  }, [])

  const clearScreenshot = () =>
    setForm(f => ({ ...f, screenshot_url: null, pendingFile: null, activePin: null, entry_pin_x: null, entry_pin_y: null, stop_pin_x: null, stop_pin_y: null, tp1_pin_x: null, tp1_pin_y: null }))

  // Pin display only — placement UI was removed once /api/extract-trade
  // started auto-detecting entry/stop/TP1 prices. Legacy pin coordinates on
  // existing trades still render via the PinPlacement overlay so historical
  // screenshots keep their visual markers.
  const pins: Partial<Record<PinType, Pin>> = {}
  if (form.entry_pin_x != null && form.entry_pin_y != null) pins.entry = { x: form.entry_pin_x, y: form.entry_pin_y }
  if (form.stop_pin_x != null && form.stop_pin_y != null) pins.stop = { x: form.stop_pin_x, y: form.stop_pin_y }
  if (form.tp1_pin_x != null && form.tp1_pin_y != null) pins.tp1 = { x: form.tp1_pin_x, y: form.tp1_pin_y }

  const readScreenshot = async () => {
    // Source the image either from a freshly-dropped/pasted file or, if absent,
    // by fetching the already-saved screenshot URL.
    let fileToSend: File | Blob | null = form.pendingFile
    let filename = form.pendingFile?.name ?? 'screenshot.png'

    if (!fileToSend && form.screenshot_url && !form.screenshot_url.startsWith('blob:')) {
      try {
        const fetched = await fetch(form.screenshot_url)
        if (!fetched.ok) {
          setError(`Could not load saved screenshot: ${fetched.status} ${fetched.statusText}`)
          return
        }
        fileToSend = await fetched.blob()
        // Best-effort filename from URL path
        const urlParts = form.screenshot_url.split('/').pop() ?? 'screenshot.png'
        filename = urlParts.split('?')[0]
      } catch (e) {
        setError(`Could not load saved screenshot: ${e instanceof Error ? e.message : 'unknown error'}`)
        return
      }
    }

    if (!fileToSend) {
      setError('No screenshot to read. Upload or paste one first.')
      return
    }

    setExtracting(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', fileToSend, filename)
      const res = await fetch('/api/extract-trade', { method: 'POST', body: fd })

      let data: Record<string, unknown> = {}
      try {
        data = await res.json()
      } catch {
        const text = await res.text().catch(() => '')
        setError(`Read failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
        return
      }

      if (!res.ok) {
        const msg = typeof data.error === 'string' ? data.error : `${res.status} ${res.statusText}`
        setError(`Read failed: ${msg}`)
        return
      }

      const extractedKeys = ['direction', 'entry_price', 'stop_price', 'tp1_price', 'entry_time', 'quantity']
      const filled = extractedKeys.filter(k => data[k] != null).length
      if (filled === 0) {
        setError('Screenshot read returned no values — Claude could not extract levels from this image.')
      }

      const dirVal = data.direction as 'long' | 'short' | null | undefined
      const entryPrice = data.entry_price as number | null | undefined
      const stopPrice = data.stop_price as number | null | undefined
      const tp1Price = data.tp1_price as number | null | undefined
      const entryTime = data.entry_time as string | null | undefined
      const qty = data.quantity as number | null | undefined
      const suggested = data.suggested_tags as TradeTags | null | undefined

      setForm(f => ({
        ...f,
        ...(dirVal && { direction: dirVal }),
        ...(entryPrice != null && { entry_price: String(entryPrice) }),
        ...(stopPrice != null && { stop_price: String(stopPrice) }),
        ...(tp1Price != null && { tp1_price: String(tp1Price) }),
        ...(entryTime && { entry_time: entryTime }),
        ...(qty != null && { quantity: String(qty) }),
        ...(suggested && { suggestedTags: suggested }),
      }))
    } catch (e) {
      setError(`Read failed: ${e instanceof Error ? e.message : 'network or unknown error'}`)
    } finally {
      setExtracting(false)
    }
  }

  const uploadScreenshot = async (file: File): Promise<string | null> => {
    const fd = new FormData()
    fd.append('file', file)
    fd.append('bucket', 'screenshots')
    fd.append('path', `trades/${date}-${Date.now()}.${file.name.split('.').pop()}`)
    const res = await fetch('/api/screenshots', { method: 'POST', body: fd })
    const data = await res.json()
    return data.url ?? null
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      let screenshotUrl = form.screenshot_url
      // If it's a local blob URL (pending upload), upload it first
      if (form.pendingFile) {
        screenshotUrl = await uploadScreenshot(form.pendingFile)
        if (!screenshotUrl) { setError('Screenshot upload failed'); setSaving(false); return }
      }

      // Build ISO entry_time for today + the time the user entered
      const entryIso = form.entry_time
        ? new Date(`${date}T${form.entry_time}:00`).toISOString()
        : null

      const payload = {
        date,
        direction: form.direction,
        entry_time: entryIso,
        entry_price: parseFloat(form.entry_price) || null,
        stop_price: parseFloat(form.stop_price) || null,
        tp1_price: parseFloat(form.tp1_price) || null,
        quantity: parseFloat(form.quantity) || null,
        pnl: parseFloat(form.pnl) || null,
        notes: form.notes || null,
        tags_json: form.tags,
        screenshot_url: screenshotUrl,
        entry_pin_x: form.entry_pin_x, entry_pin_y: form.entry_pin_y,
        stop_pin_x: form.stop_pin_x,   stop_pin_y: form.stop_pin_y,
        tp1_pin_x: form.tp1_pin_x,     tp1_pin_y: form.tp1_pin_y,
      }

      const url = trade ? `/api/trades/${trade.id}` : '/api/trades'
      const method = trade ? 'PATCH' : 'POST'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await res.json()
      if (!res.ok) { setError(data.error ?? 'Save failed'); return }
      // Clean up the previously-saved screenshot blob if it was replaced or removed
      if (savedScreenshotUrl && savedScreenshotUrl !== screenshotUrl) {
        void deleteBlob(savedScreenshotUrl)
      }
      setSavedScreenshotUrl(screenshotUrl)
      onSave(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  const r = rMultiple(form)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl">
      {/* Form header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
        <h3 className="font-semibold text-white">{trade ? 'Edit Trade' : 'Log Trade'}</h3>
        <button type="button" onClick={onCancel} className="text-gray-500 hover:text-gray-300 transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-6">

        {/* Direction */}
        <div className="flex gap-2">
          {(['long', 'short'] as const).map(d => (
            <button key={d} type="button" onClick={() => set('direction', d)}
              className={`flex-1 py-2.5 rounded-lg text-sm font-bold border transition-colors ${
                form.direction === d
                  ? d === 'long' ? 'bg-green-700 border-green-600 text-white' : 'bg-red-700 border-red-600 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
            >{d === 'long' ? '▲ Long' : '▼ Short'}</button>
          ))}
        </div>

        {/* Screenshot upload */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Trade Screenshot</label>
          {form.screenshot_url ? (
            <div className="space-y-3">
              <PinPlacement
                imageUrl={form.screenshot_url}
                pins={pins}
              />
              <div className="flex items-center gap-4">
                <button type="button" onClick={readScreenshot} disabled={extracting}
                  className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 transition-colors">
                  {extracting ? <Loader2 className="w-3 h-3 animate-spin" /> : <ScanLine className="w-3 h-3" />}
                  {extracting ? 'Reading...' : 'Read Screenshot'}
                </button>
                <button type="button" onClick={clearScreenshot}
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors">
                  Remove screenshot
                </button>
              </div>
            </div>
          ) : (
            <div
              tabIndex={0}
              onClick={() => document.getElementById('trade-file-input')?.click()}
              onPaste={e => {
                const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'))
                if (item) { const f = item.getAsFile(); if (f) handleFile(f) }
              }}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
              onDragOver={e => e.preventDefault()}
              className="border-2 border-dashed border-gray-700 hover:border-gray-500 rounded-xl p-6 flex flex-col items-center gap-2 cursor-pointer transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600 bg-gray-800/30"
            >
              <p className="text-sm text-gray-400">Drop, paste, or click to upload trade screenshot</p>
              <p className="text-xs text-gray-600">PNG, JPG, WebP</p>
              <input id="trade-file-input" type="file" accept="image/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </div>
          )}
        </div>

        {/* Trade details */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Trade Details</label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              { key: 'entry_time', label: 'Entry Time', type: 'time' },
              { key: 'quantity', label: 'Qty / Contracts', type: 'number' },
              { key: 'entry_price', label: 'Entry Price', type: 'number' },
              { key: 'stop_price', label: 'Stop Price', type: 'number' },
              { key: 'tp1_price', label: 'TP1 Price', type: 'number' },
              { key: 'pnl', label: r ? `P&L (${r})` : 'P&L ($)', type: 'number' },
            ].map(({ key, label, type }) => (
              <div key={key}>
                <label className="block text-xs text-gray-400 mb-1">{label}</label>
                <input
                  type={type} step="any"
                  value={form[key as keyof FormState] as string}
                  onChange={e => set(key as keyof FormState, e.target.value as never)}
                  className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="block text-xs text-gray-400 mb-1">Notes</label>
          <textarea rows={2} spellCheck autoCorrect="on" placeholder="Execution notes, observations..."
            value={form.notes} onChange={e => set('notes', e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 text-white rounded-lg px-3 py-2 text-sm placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
          />
        </div>

        {/* Tags */}
        {allTags.length > 0 && (
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Tags</label>
            <TagSelector tags={allTags} selected={form.tags} suggested={form.suggestedTags} onChange={t => set('tags', t)} />
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={save} disabled={saving}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white font-medium px-4 py-2 rounded-lg text-sm transition-colors"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save Trade'}
          </button>
          <button type="button" onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors">
            Cancel
          </button>
        </div>

      </div>
    </div>
  )
}
