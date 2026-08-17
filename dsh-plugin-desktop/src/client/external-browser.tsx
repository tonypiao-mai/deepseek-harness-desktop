/** Desktop-owned embedded external browser: a right-side <webview> panel. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { DESKTOP_SETTINGS_RENDERER_PATH, EXTERNAL_BROWSER_PARTITION } from '../runtime.ts'

/** Where session http(s) links open. Mirrors the Host DesktopSettings.openLinksIn. */
export type OpenLinksIn = 'external' | 'browser'

/** Guess an absolute URL from user address input, mirroring opencode. */
function normalizeAddress(input: string): string {
  const value = input.trim()
  if (!value) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  if (/^localhost(:\d+)?(\/.*)?$/i.test(value)) return `http://${value}`
  if (/^[^\s]+\.[^\s]+$/.test(value)) return `https://${value}`
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Read the effective desktop settings from the Host bridge. */
async function readOpenLinksIn(): Promise<OpenLinksIn> {
  try {
    const res = await fetch(DESKTOP_SETTINGS_RENDERER_PATH, { headers: { accept: 'application/json' } })
    const data = await res.json() as { ok?: boolean; settings?: { openLinksIn?: OpenLinksIn } }
    if (data.ok && (data.settings?.openLinksIn === 'external' || data.settings?.openLinksIn === 'browser')) {
      return data.settings.openLinksIn
    }
  } catch {
    // Fall through to the safe default.
  }
  return 'external'
}

/** Persist a new link-open mode through the Host bridge. */
async function writeOpenLinksIn(mode: OpenLinksIn): Promise<void> {
  try {
    await fetch(DESKTOP_SETTINGS_RENDERER_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openLinksIn: mode }),
    })
  } catch {
    // Best effort; the session default still applies.
  }
}

interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  getURL(): string
}

/** Small store of the shared per-window panel state. */
interface ExternalBrowserState {
  open: boolean
  url: string
  openLinksIn: OpenLinksIn
  width: number
}

/** Default panel width in CSS pixels. */
const DEFAULT_PANEL_WIDTH = 560
/** Minimum and maximum panel widths in CSS pixels. */
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 1100

/** Module-level panel state: one per app window (not per session). */
const state: ExternalBrowserState = { open: false, url: '', openLinksIn: 'external', width: DEFAULT_PANEL_WIDTH }
const listeners = new Set<() => void>()
function notify(): void { listeners.forEach((fn) => fn()) }
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Return whether the window currently displays the external browser panel. */
export function externalBrowserOpen(): boolean {
  return state.open
}

/** Open the panel and navigate it to a URL (or show it as-is when url is empty). */
export function openExternalBrowser(url = ''): void {
  if (url) state.url = url
  state.open = true
  applyBrowserLayout()
  notify()
}

/** Close the embedded browser panel. */
export function closeExternalBrowser(): void {
  state.open = false
  applyBrowserLayout()
  notify()
}

/**
 * Reserve space for the panel by shrinking the app root, so the browser sits
 * side by side with the session instead of floating above it.
 */
function applyBrowserLayout(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.style.paddingRight = state.open ? `${state.width}px` : ''
}

/** Clamp a panel width to the allowed range. */
function clampWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width))
}

/** Current link-open behavior. */
export function openLinksIn(): OpenLinksIn {
  return state.openLinksIn
}

/** A fixed top-right toggle that opens/closes the embedded browser panel. */
export function ExternalBrowserToggle(): JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((x) => x + 1)), [])
  // Hidden while the panel is open (the panel's own ✕ re-shows it).
  if (state.open) return <></>
  return (
    <button
      type="button"
      className="dshExternalBrowserToggle"
      aria-label="网页浏览器"
      title="Open web browser"
      style={{ display: 'var(--dsh-external-browser-toggle, inline-flex)' }}
      onClick={() => openExternalBrowser()}
    >
      🌐
    </button>
  )
}

/** The embedded browser panel: a right-side column with a resizable divider. */
export function ExternalBrowserPanel(): JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null)
  const domReady = useRef(false)
  const pendingURL = useRef<string | undefined>(undefined)
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null)
  const [, setTick] = useState(0)
  const [address, setAddress] = useState(state.url)
  const [title, setTitle] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  // Re-render on any state change (open, url, mode, width) so live reads like
  // the checkbox stay in sync immediately.
  useEffect(() => subscribe(() => {
    setTick((x) => x + 1)
    if (state.url) setAddress(state.url)
  }), [])

  const refreshNav = (wv: WebviewElement): void => {
    if (!domReady.current) return
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    } catch {
      // The guest may not expose navigation state yet; ignore.
    }
  }

  // Stable ref: store the element and set its initial <src> once. React calls
  // ref callbacks on mount and re-runs them on every render when the callback
  // identity changes, so keep this callback stable and do NOT add listeners
  // here — listener wiring lives in the effect below to avoid duplicates.
  const webviewRefCb = useCallback((el: HTMLElement | null): void => {
    const wv = el as WebviewElement | null
    webviewRef.current = wv
    if (!wv) return
    if (wv.getAttribute('src') == null) {
      wv.setAttribute('src', state.url || 'about:blank')
    }
    domReady.current = false
  }, [state.url])  // eslint-disable-line react-hooks/exhaustive-deps

  // Attach guest listeners exactly once while the panel is open.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = (): void => {
      domReady.current = true
      refreshNav(wv)
      setTitle((wv.getAttribute('title') ?? ''))
      if (pendingURL.current) {
        void wv.loadURL(pendingURL.current).catch(() => {})
        pendingURL.current = undefined
      }
    }
    const onNavigate = (): void => {
      setAddress(wv.getURL())
      refreshNav(wv)
      setTitle((wv.getAttribute('title') ?? ''))
    }
    const onTitle = (event: Event): void => {
      setTitle(String((event as unknown as { title?: unknown }).title ?? ''))
    }
    const onFail = (event: Event): void => {
      const detail = (event as unknown as { errorCode?: unknown; errorDescription?: unknown }).errorDescription
      setTitle(String(detail ?? 'Page failed to load'))
    }
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [state.open])  // eslint-disable-line react-hooks/exhaustive-deps

  // Reserve right-side space on the app root whenever the panel is open.
  useEffect(() => {
    applyBrowserLayout()
    return () => {
      const root = document.getElementById('root')
      if (root) root.style.paddingRight = ''
    }
  }, [state.open, state.width])  // eslint-disable-line react-hooks/exhaustive-deps

  const loadURL = (url: string): void => {
    const wv = webviewRef.current
    if (!wv) {
      state.url = url
      return
    }
    if (!domReady.current) {
      pendingURL.current = url
      return
    }
    void wv.loadURL(url).catch(() => {})
  }

  const navigate = (): void => {
    const url = normalizeAddress(address)
    if (!url) return
    setAddress(url)
    loadURL(url)
  }

  const startDrag = (event: React.PointerEvent): void => {
    event.preventDefault()
    dragState.current = { startX: event.clientX, startWidth: state.width }
    document.body.classList.add('dsh-desktop-browser-dragging')
  }
  const moveDrag = (event: React.PointerEvent): void => {
    const drag = dragState.current
    if (!drag) return
    // Dragging left increases panel width (handle sits on the panel's left edge).
    const next = clampWidth(drag.startWidth + (drag.startX - event.clientX))
    if (next !== state.width) {
      state.width = next
      notify()
    }
  }
  const endDrag = (): void => {
    dragState.current = null
    document.body.classList.remove('dsh-desktop-browser-dragging')
  }

  if (!state.open) return <></>

  return (
    <div className="dshExternalBrowser" data-open="true" style={{ width: `${state.width}px` }}>
      <div
        className="dshExternalBrowserHandle"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="separator"
        aria-orientation="vertical"
      />
      <div className="dshExternalBrowserToolbar">
        <button type="button" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}>←</button>
        <button type="button" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}>→</button>
        <button type="button" onClick={() => webviewRef.current?.reload()}>⟳</button>
        <input
          className="dshExternalBrowserAddress"
          value={address}
          placeholder="Address"
          onChange={(event) => setAddress(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') navigate() }}
        />
        <span className="dshExternalBrowserTitle">{title}</span>
        <label className="dshExternalBrowserMode">
          <input
            type="checkbox"
            checked={state.openLinksIn === 'browser'}
            onChange={(event) => {
              const mode: OpenLinksIn = event.currentTarget.checked ? 'browser' : 'external'
              state.openLinksIn = mode
              void writeOpenLinksIn(mode)
              notify()
            }}
          />
          <span>Open links in panel</span>
        </label>
        <button type="button" onClick={closeExternalBrowser}>✕</button>
      </div>
      <div className="dshExternalBrowserBody">
        <webview
          ref={webviewRefCb as unknown as (el: HTMLElement | null) => void}
          partition={EXTERNAL_BROWSER_PARTITION}
          className="dshExternalBrowserGuest"
        />
      </div>
    </div>
  )
}

/** Intercept http(s) link clicks in captured phase and route to the panel. */
export function installLinkInterception(): () => void {
  const onClick = (event: MouseEvent): void => {
    if (state.openLinksIn !== 'browser') return
    if (event.defaultPrevented) return
    if (event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('.dshExternalBrowser')) return
    const anchor = target.closest('a')
    if (!(anchor instanceof HTMLAnchorElement)) return
    const href = anchor.href
    if (!/^https?:\/\//i.test(href)) return
    event.preventDefault()
    event.stopPropagation()
    openExternalBrowser(href)
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

/**
 * Apply the desktop-owned external browser surface (works in every mode).
 * @param ctx - active browser Cordis context.
 * @returns effect disposer wiring together panel, toggle, and link interception.
 */
export function applyExternalBrowser(ctx: ClientContext): () => void {
  const bootstrap = (): void => {
    void readOpenLinksIn().then((mode) => {
      state.openLinksIn = mode
      notify()
    })
  }
  bootstrap()

  const disposers: Array<() => void> = [
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-desktop-external-browser', order: 50 },
      () => <ExternalBrowserPanel />,
    )),
    ctx.slots.inject('shell.overlay', () => ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-desktop-external-browser-toggle', order: 45 },
      () => <ExternalBrowserToggle />,
    )),
    installLinkInterception(),
    installExternalBrowserCss(),
  ]
  return () => {
    disposers.forEach((dispose) => dispose())
  }
}

/** Inject the panel/toggle stylesheet (self-contained string like styles.ts). */
function installExternalBrowserCss(): () => void {
  const style = document.createElement('style')
  style.id = 'dsh-desktop-external-browser-styles'
  style.textContent = `
.dshExternalBrowserToggle {
  position: fixed; top: 12px; right: 14px; z-index: 1049;
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #333);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #e6e6e6);
  cursor: pointer; font-size: 15px; line-height: 1;
}
.dshExternalBrowserToggle:hover { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
/* Side-by-side right column: the app root's padding-right reserves the space,
   so this column sits beside the session instead of floating above it. */
.dshExternalBrowser { position: fixed; top: 0; right: 0; bottom: 0; z-index: 1050;
  display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base, #0d1117);
  border-left: 1px solid var(--dsw-alias-border-l2, #333);
}
.dshExternalBrowserHandle { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; margin-left: -3px;
  cursor: col-resize; touch-action: none; z-index: 5; }
.dshExternalBrowserHandle::after { content: ""; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
  width: 4px; height: 44px; border-radius: 4px; background: var(--dsw-alias-brand-primary, #4f8cff); opacity: 0; transition: opacity .15s; }
body.dsh-desktop-browser-dragging { cursor: col-resize; user-select: none; }
.dsh-desktop-browser-dragging .dshExternalBrowserHandle::after,
.dshExternalBrowserHandle:hover::after { opacity: 1; }
.dshExternalBrowserToolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #333); flex: none; }
.dshExternalBrowserToolbar button { width: 26px; height: 26px; border-radius: 6px; border: none;
  background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; }
.dshExternalBrowserToolbar button:disabled { opacity: .35; cursor: default; }
.dshExternalBrowserToolbar button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.15)); }
.dshExternalBrowserAddress { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; outline: none; }
.dshExternalBrowserTitle { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 12px; }
.dshExternalBrowserMode { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 12px; white-space: nowrap; }
.dshExternalBrowserBody { flex: 1; min-height: 0; position: relative; }
.dshExternalBrowserGuest { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
`
  document.head.appendChild(style)
  return () => { style.remove() }
}
