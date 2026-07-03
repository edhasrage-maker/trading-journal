'use client'

import { useRef, useEffect } from 'react'

/**
 * A textarea that grows to fit its content instead of clipping/scrolling inside
 * a fixed height. `rows` acts as the minimum height. Essential on mobile, where
 * a fixed 2-row box with `resize-none` hides everything past two lines and has
 * no drag handle to expand.
 *
 * Drop-in for `<textarea>` — forwards all props (value, onChange, className, …).
 */
export default function AutoGrowTextarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null)

  const resize = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  // Re-fit whenever the controlled value changes (covers typing, programmatic
  // fills like spell-check, and the first paint of loaded notes).
  useEffect(() => {
    resize()
  }, [props.value])

  return (
    <textarea
      {...props}
      ref={ref}
      onInput={e => {
        resize()
        props.onInput?.(e)
      }}
    />
  )
}
