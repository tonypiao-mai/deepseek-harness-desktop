/** Desktop-owned embedded external browser: a right-side multi-tab <webview> panel. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { DESKTOP_SETTINGS_RENDERER_PATH, EXTERNAL_BROWSER_PARTITION } from '../runtime.ts'
import {
  activateTab,
  closeTab,
  emptyTabs,
  openTab,
  setTabTitle,
  setTabUrl,
  type BrowserTab,
  type BrowserTabsState,
} from './tab-store.ts'

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

/** Default panel width in CSS pixels. */
const DEFAULT_PANEL_WIDTH = 560
/** Minimum and maximum panel widths in CSS pixels. */
const MIN_PANEL_WIDTH = 280
const MAX_PANEL_WIDTH = 1100

/** Module-level panel state: one per app window (not per session). */
interface ExternalBrowserState extends BrowserTabsState {
  open: boolean
  openLinksIn: OpenLinksIn
  width: number
}

const state: ExternalBrowserState = {
  ...emptyTabs(),
  open: false,
  openLinksIn: 'external',
  width: DEFAULT_PANEL_WIDTH,
}
const listeners = new Set<() => void>()
function notify(): void { listeners.forEach((fn) => fn()) }
function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Replace tab fields and broadcast. */
function commitTabs(patch: BrowserTabsState): void {
  state.tabs = patch.tabs
  state.activeTabId = patch.activeTabId
  notify()
}

/** Reserve space for the panel by shrinking the app root. */
function applyBrowserLayout(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.style.paddingRight = state.open ? `${state.width}px` : ''
}

/** Clamp a panel width to the allowed range. */
function clampWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width))
}

/** Return whether the window currently displays the external browser panel. */
export function externalBrowserOpen(): boolean {
  return state.open
}

/** Open (creating if needed) a new tab with an optional URL, then show panel. */
export function openExternalBrowser(url = ''): void {
  commitTabs(openTab(state, url))
  state.open = true
  applyBrowserLayout()
  notify()
}

/** Close the embedded browser panel, preserving open tabs. */
export function closeExternalBrowser(): void {
  state.open = false
  applyBrowserLayout()
  notify()
}

/** Toggle panel visibility; opening with no tabs creates one. */
export function toggleExternalBrowser(): void {
  if (state.open) {
    closeExternalBrowser()
    return
  }
  if (state.tabs.length === 0) commitTabs(openTab(state))
  state.open = true
  applyBrowserLayout()
  notify()
}

/** Activate an existing tab. */
function activateById(id: string): void {
  commitTabs(activateTab(state, id))
}

/** Close a tab; when the last one closes, hide the panel. */
function closeById(id: string): void {
  const next = closeTab(state, id)
  commitTabs(next)
  if (next.tabs.length === 0) {
    state.open = false
    applyBrowserLayout()
  }
  notify()
}

/** Set a tab's URL from within a guest view. */
function setUrlById(id: string, url: string): void {
  commitTabs(setTabUrl(state, id, url))
}

/** Set a tab's title from a page-title-updated event. */
function setTitleById(id: string, title: string): void {
  commitTabs(setTabTitle(state, id, title))
}

/** Current link-open behavior. */
export function openLinksIn(): OpenLinksIn {
  return state.openLinksIn
}

/** A fixed top-right toggle that opens/closes the embedded browser panel. */
export function ExternalBrowserToggle(): JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((x) => x + 1)), [])
  // Hidden while the panel is open (⌘/Ctrl+Option+B or the panel ✕ re-shows it).
  if (state.open) return <></>
  return (
    <button
      type="button"
      className="dshExternalBrowserToggle"
      aria-label="网页浏览器"
      title="Open web browser"
      style={{ display: 'var(--dsh-external-browser-toggle, inline-flex)' }}
      onClick={() => toggleExternalBrowser()}
    >
      🌐
    </button>
  )
}

/** The tab strip: one pill per tab, active highlight, hover close, "+" new tab. */
function BrowserTabBar(props: {
  tabs: BrowserTab[]
  activeTabId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}): JSX.Element {
  const label = (tab: BrowserTab): string => tab.title || tab.url || 'New tab'
  return (
    <div className="dshExternalBrowserTabBar">
      {props.tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          className="dshExternalBrowserTab"
          data-active={tab.id === props.activeTabId ? '' : undefined}
          title={tab.url}
          onClick={() => props.onActivate(tab.id)}
        >
          <span className="dshExternalBrowserTabLabel">{label(tab)}</span>
          <span
            role="button"
            tabIndex={-1}
            className="dshExternalBrowserTabClose"
            aria-label="Close tab"
            onClick={(event) => { event.stopPropagation(); props.onClose(tab.id) }}
          >
            ✕
          </span>
        </button>
      ))}
      <button
        type="button"
        className="dshExternalBrowserTabNew"
        aria-label="New tab"
        title="New tab"
        onClick={props.onNew}
      >
        +
      </button>
    </div>
  )
}

/** One browser tab: its own toolbar + <webview> guest. Only the active one shows. */
function BrowserTabView(props: {
  tab: BrowserTab
  active: boolean
  openLinksIn: OpenLinksIn
  onUrlChange: (id: string, url: string) => void
  onTitleChange: (id: string, title: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  const { tab, active } = props
  const webviewRef = useRef<WebviewElement | null>(null)
  const domReady = useRef(false)
  const [address, setAddress] = useState(tab.url)
  const [title, setTitle] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  const refreshNav = (wv: WebviewElement): void => {
    if (!domReady.current) return
    try {
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    } catch {
      // Guest may not expose nav state yet; ignore.
    }
  }

  // Stable ref: store webview + set initial <src> once; listeners attach below.
  const webviewRefCb = useCallback((el: HTMLElement | null): void => {
    const wv = el as WebviewElement | null
    webviewRef.current = wv
    if (!wv) return
    if (wv.getAttribute('src') == null) {
      wv.setAttribute('src', tab.url || 'about:blank')
    }
    domReady.current = false
  }, [tab.id])  // eslint-disable-line react-hooks/exhaustive-deps

  // Attach guest listeners exactly once per tab mount.
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onDomReady = (): void => {
      domReady.current = true
      refreshNav(wv)
    }
    const onNavigate = (): void => {
      setAddress(wv.getURL())
      setTitle((wv.getAttribute('title') ?? ''))
      props.onUrlChange(tab.id, wv.getURL())
      refreshNav(wv)
    }
    const onTitle = (event: Event): void => {
      const t = String((event as unknown as { title?: unknown }).title ?? '')
      setTitle(t)
      props.onTitleChange(tab.id, t)
    }
    const onFail = (event: Event): void => {
      const detail = (event as unknown as { errorDescription?: unknown }).errorDescription
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
  }, [tab.id])  // eslint-disable-line react-hooks/exhaustive-deps

  const navigate = (): void => {
    const url = normalizeAddress(address)
    if (!url) return
    setAddress(url)
    props.onUrlChange(tab.id, url)
    const wv = webviewRef.current
    if (wv && domReady.current) void wv.loadURL(url).catch(() => {})
  }

  return (
    <div className="dshExternalBrowserView" data-active={active ? '' : undefined}>
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
        {active && (
          <label className="dshExternalBrowserMode">
            <input
              type="checkbox"
              checked={props.openLinksIn === 'browser'}
              onChange={(event) => {
                const mode: OpenLinksIn = event.currentTarget.checked ? 'browser' : 'external'
                state.openLinksIn = mode
                void writeOpenLinksIn(mode)
                notify()
              }}
            />
            <span>Open links in panel</span>
          </label>
        )}
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

/** The embedded browser panel: tab strip + per-tab views, side-by-side column. */
export function ExternalBrowserPanel(): JSX.Element {
  const dragState = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  const [, setTick] = useState(0)

  // Re-render on any state change (open, tabs, mode, width) so live reads stay in sync.
  useEffect(() => subscribe(() => setTick((x) => x + 1)), [])

  // Reserve right-side space on the app root whenever the panel is open.
  useEffect(() => {
    applyBrowserLayout()
    return () => {
      const root = document.getElementById('root')
      if (root) root.style.paddingRight = ''
    }
  }, [state.open, state.width])  // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragState.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: state.width }
    document.body.classList.add('dsh-desktop-browser-dragging')
  }
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragState.current
    if (!drag || event.pointerId !== drag.pointerId) return
    const next = clampWidth(drag.startWidth + (drag.startX - event.clientX))
    if (next !== state.width) {
      state.width = next
      notify()
    }
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragState.current) return
    if (event.pointerId === dragState.current.pointerId) {
      try { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* noop */ }
    }
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
      <BrowserTabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onActivate={activateById}
        onClose={closeById}
        onNew={() => openExternalBrowser()}
      />
      {state.tabs.map((tab) => (
        <BrowserTabView
          key={tab.id}
          tab={tab}
          active={tab.id === state.activeTabId}
          openLinksIn={state.openLinksIn}
          onUrlChange={setUrlById}
          onTitleChange={setTitleById}
          onClose={closeById}
        />
      ))}
      {state.tabs.length === 0 && (
        <div className="dshExternalBrowserEmpty">
          <button type="button" className="dshExternalBrowserEmptyCTA" onClick={() => openExternalBrowser()}>
            ＋ New tab
          </button>
          <button type="button" className="dshExternalBrowserEmptyCTA" onClick={closeExternalBrowser}>
            Close panel
          </button>
        </div>
      )}
    </div>
  )
}

/** Intercept http(s) link clicks in captured phase and route to a new browser tab. */
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
 * Install keyboard shortcuts:
 * - Cmd/Ctrl+T  => new tab
 * - Cmd/Ctrl+W  => close active tab (or close the panel when no tabs)
 * - Cmd/Ctrl+Option+B => toggle the browser panel
 * Returns a disposer.
 */
export function installBrowserShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    const mod = event.metaKey || event.ctrlKey
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 't') {
      event.preventDefault()
      openExternalBrowser()
      return
    }
    if (key === 'w') {
      event.preventDefault()
      if (state.activeTabId) closeById(state.activeTabId)
      else if (state.open) closeExternalBrowser()
      return
    }
    if (key === 'b' && event.altKey) {
      event.preventDefault()
      toggleExternalBrowser()
      return
    }
  }
  document.addEventListener('keydown', onKeyDown, true)
  return () => document.removeEventListener('keydown', onKeyDown, true)
}

/**
 * Apply the desktop-owned external browser surface (works in every mode).
 * @param ctx - active browser Cordis context.
 * @returns effect disposer wiring together panel, toggle, shortcuts, interception.
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
    installBrowserShortcuts(),
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
/* Side-by-side right column: the app root's padding-right reserves the space. */
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
/* Tab strip */
.dshExternalBrowserTabBar { display: flex; align-items: center; gap: 4px; padding: 6px 8px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #333); overflow-x: auto; flex: none; }
.dshExternalBrowserTab { display: inline-flex; align-items: center; gap: 6px; max-width: 180px; min-width: 0;
  height: 26px; padding: 0 8px; border-radius: 7px; border: 1px solid transparent;
  background: transparent; color: var(--dsw-alias-label-secondary, #9aa0a6); cursor: pointer; font-size: 12px; }
.dshExternalBrowserTab:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.15)); }
.dshExternalBrowserTab[data-active] { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.2));
  color: var(--dsw-alias-label-primary, #e6e6e6); border-color: var(--dsw-alias-border-l2, #333); }
.dshExternalBrowserTabLabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.dshExternalBrowserTabClose { display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; border-radius: 4px; opacity: 0; flex: none; font-size: 10px; }
.dshExternalBrowserTab:hover .dshExternalBrowserTabClose,
.dshExternalBrowserTab[data-active] .dshExternalBrowserTabClose { opacity: .7; }
.dshExternalBrowserTabClose:hover { opacity: 1 !important; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.25)); }
.dshExternalBrowserTabNew { display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; border-radius: 7px; border: none; background: transparent;
  color: var(--dsw-alias-label-secondary, #9aa0a6); cursor: pointer; font-size: 15px; flex: none; }
.dshExternalBrowserTabNew:hover { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.15)); }
/* Each tab's view; only active visible */
.dshExternalBrowserView { display: none; flex: 1; min-height: 0; flex-direction: column; }
.dshExternalBrowserView[data-active] { display: flex; }
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
.dshExternalBrowserEmpty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.dshExternalBrowserEmptyCTA { padding: 6px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #333);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; font-size: 13px; }
.dshExternalBrowserEmptyCTA:hover { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
`
  document.head.appendChild(style)
  return () => { style.remove() }
}
