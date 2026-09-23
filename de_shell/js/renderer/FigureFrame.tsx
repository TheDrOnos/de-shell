/**
 * FigureFrame.tsx — an anyplotlib figure in an iframe, wired to the bridge.
 *
 * Handles the three things every host of a figure has to get right, and which
 * are easy to omit without any error appearing:
 *
 * * **Register with the bridge**, so state can be routed to this frame — and
 *   deregister on unmount, so a dead element is not held. In an EFFECT
 *   (`attachFigure`), not the ref callback alone: StrictMode's double-invoke
 *   otherwise leaves the figure registered nowhere, and everything pushed to it
 *   afterwards goes into the void.
 * * **Replay on load**, passing THIS element. State that arrived before the
 *   frame mounted was posted into the void; replay is the only thing that
 *   recovers it, and a figure mounted twice must serve itself rather than
 *   whichever mount happens to hold the registry slot.
 * * **Report its size**, so the backend can lay the figure out to fit. Without
 *   it the figure renders at anyplotlib's default size and overflows its pane.
 *
 * `srcdoc` vs `src`: a backend that inlines the figure's ESM can be mounted
 * directly from `html`. One that swaps the bundle for a shared URL (SpyDE does,
 * so Chromium reuses the V8 code cache across many figure iframes) MUST be
 * served over a real origin and passes `fileUrl` instead — a srcdoc frame
 * cannot load it. Note that a srcdoc frame INHERITS the parent page's CSP, so
 * the host page needs `script-src … blob:` for anyplotlib's ESM boot.
 */
import React, { useEffect, useRef } from 'react'
import { attachFigure, readoutListener, type FigureBridge, type ReadoutInfo } from './figureBridge'
import { createSizeReporter } from './sizeReporter'

export interface FigureFrameProps {
  bridge: FigureBridge
  figId: string
  /** Inline figure HTML (mounted via srcdoc). Ignored when `fileUrl` is set. */
  html?: string
  /** Figure URL served over the app's own scheme. Takes precedence over `html`. */
  fileUrl?: string | null
  title?: string
  /** Called with the frame's pixel size whenever it changes. */
  onResize?: (width: number, height: number) => void
  /** The hover readout, on the shown grid; null when the cursor leaves. Pair it
   *  with `FigureView.set_readout_visible(False)` to replace the on-image pill. */
  onReadout?: (info: ReadoutInfo | null) => void
  className?: string
  style?: React.CSSProperties
  'data-testid'?: string
}

export function FigureFrame({
  bridge, figId, html, fileUrl, title, onResize, onReadout, className, style,
  'data-testid': testId,
}: FigureFrameProps) {
  const ref = useRef<HTMLIFrameElement | null>(null)

  // Report size to the backend. Fires once on mount and on every OBSERVED
  // resize; `createSizeReporter` skips the frame's zero-size first layout
  // pass and any firing whose rounded size hasn't changed.
  //
  // Hardened on both axes the resize burst rode in on: the callback lives in
  // a ref and the effect deps carry `figId` ONLY, so an inline `onResize`
  // prop — a new identity on every parent render — no longer re-runs the
  // effect (which sent unconditionally per re-run; message-driven re-renders
  // then fed a loop measured at ~1,500 sends/s over constant geometry). The
  // reporter's skip-on-unchanged covers ResizeObserver refires the same way.
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const report = createSizeReporter((w, h) => onResizeRef.current?.(w, h))
    const send = () => report(el.getBoundingClientRect())
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    return () => ro.disconnect()
  }, [figId])

  // In a ref for the same reason as onResize: an inline prop must not re-run this.
  const onReadoutRef = useRef(onReadout)
  onReadoutRef.current = onReadout
  useEffect(() => {
    const listen = readoutListener(() => ref.current?.contentWindow,
                                   (info) => onReadoutRef.current?.(info))
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [figId])

  // REGISTRATION IS OWNED BY AN EFFECT, not by the ref callback alone, and it
  // re-registers on every run — see `attachFigure`, which holds the reason and
  // is where the StrictMode double-invoke is pinned by a test.
  useEffect(() => attachFigure(bridge, figId, ref.current), [bridge, figId])

  return (
    <iframe
      ref={(el) => { ref.current = el; bridge.registerIframe(figId, el) }}
      // Keyed by figId so React REUSES the element across repaints. Remounting
      // per frame would tear down the figure's WebGPU context and throw away
      // the user's zoom.
      key={figId}
      title={title ?? figId}
      {...(fileUrl ? { src: fileUrl } : { srcDoc: html })}
      className={className}
      // `display: block` FIRST, so a caller's style can still override it. An
      // iframe is inline by default, which reserves descender space under it:
      // a host sized to `height: 100%` then overflows by ~4-5 px and grows a
      // scrollbar around a figure that looks correctly sized.
      style={{ display: 'block', ...style }}
      data-testid={testId}
      // ITSELF, never whichever mount currently holds the registry slot.
      onLoad={() => bridge.replay(figId, ref.current ?? undefined)}
    />
  )
}
