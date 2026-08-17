/** Desktop-owned embedded external browser: a right-side <webview> panel. */

import { useEffect, useRef, useState } from 'react'
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
}

/** Module-level panel state: one per app window (not per session). */
const state: ExternalBrowserState = { open: false, url: '', openLinksIn: 'external' }
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
  notify()
}

/** Close the embedded browser panel. */
export function closeExternalBrowser(): void {
  state.open = false
  notify()
}

/** Current link-open behavior. */
export function openLinksIn(): OpenLinksIn {
  return state.openLinksIn
}

/** A fixed top-right toggle that opens/closes the embedded browser panel. */
export function ExternalBrowserToggle(): JSX.Element {
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((x) => x + 1)), [])
  return (
    <button
      type="button"
      className="dshExternalBrowserToggle"
      aria-label="网页浏览器"
      title={state.open ? '关闭网页浏览器' : '打开网页浏览器'}
      style={{ display: 'var(--dsh-external-browser-toggle, inline-flex)' }}
      onClick={() => (state.open ? closeExternalBrowser() : openExternalBrowser())}
    >
      {state.open ? '✕' : '🌐'}
    </button>
  )
}

/** The embedded browser panel: toolbar + <webview> guest. */
export function ExternalBrowserPanel(): JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null)
  const domReady = useRef(false)
  const pendingURL = useRef<string | undefined>(undefined)
  const [address, setAddress] = useState(state.url)
  const [title, setTitle] = useState('')
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [open, setOpen] = useState(state.open)

  useEffect(() => subscribe(() => {
    setOpen(state.open)
    if (state.url) setAddress(state.url)
  }), [])

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv || wv.getAttribute('src') !== undefined) return
    wv.setAttribute('src', state.url || 'about:blank')
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  const refreshNav = (wv: WebviewElement): void => {
    setCanBack(wv.canGoBack())
    setCanForward(wv.canGoForward())
  }

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

  const attach = (el: WebviewElement | null): void => {
    webviewRef.current = el
    if (!el) return
    el.addEventListener('dom-ready', () => {
      domReady.current = true
      refreshNav(el)
      setTitle((el.getAttribute('title') ?? ''))
      const pending = pendingURL.current
      if (pending) {
        pendingURL.current = undefined
        void el.loadURL(pending).catch(() => {})
      }
    })
    const onNavigate = (): void => {
      setAddress(el.getURL())
      refreshNav(el)
      setTitle((el.getAttribute('title') ?? ''))
    }
    el.addEventListener('did-navigate', onNavigate)
    el.addEventListener('did-navigate-in-page', onNavigate)
    el.addEventListener('page-title-updated', (event: Event) => {
      setTitle(String((event as unknown as { title?: unknown }).title ?? ''))
    })
  }

  if (!open) return <></>

  return (
    <div className="dshExternalBrowser" data-open={open ? 'true' : 'false'}>
      <div className="dshExternalBrowserToolbar">
        <button type="button" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}>←</button>
        <button type="button" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}>→</button>
        <button type="button" onClick={() => webviewRef.current?.reload()}>⟳</button>
        <input
          className="dshExternalBrowserAddress"
          value={address}
          placeholder="地址"
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
          <span>链接在面板打开</span>
        </label>
        <button type="button" onClick={closeExternalBrowser}>✕</button>
      </div>
      <div className="dshExternalBrowserBody">
        <webview
          ref={attach as unknown as (el: HTMLElement | null) => void}
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
  position: fixed; top: 12px; right: 12px; z-index: 1049;
  --dsw-btn-bg: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12));
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #333);
  background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #e6e6e6);
  cursor: pointer; font-size: 15px; line-height: 1;
}
.dshExternalBrowserToggle:hover { border-color: var(--dsw-alias-brand-primary, #4f8cff); }
.dshExternalBrowser { position: fixed; top: 10px; right: 10px; bottom: 10px; width: 560px; max-width: 70vw;
  z-index: 1050; display: flex; flex-direction: column; overflow: hidden;
  background: var(--dsw-alias-bg-overlay, #171a21); border: 1px solid var(--dsw-alias-border-l2, #333);
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25);
}
.dshExternalBrowserToolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #333); flex: none; }
.dshExternalBrowserToolbar button { width: 26px; height: 26px; border-radius: 6px; border: none;
  background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); cursor: pointer; }
.dshExternalBrowserToolbar button:disabled { opacity: .35; cursor: default; }
.dshExternalBrowserToolbar button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.15)); }
.dshExternalBrowserAddress { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l2, #333); background: var(--dsw-alias-bg-base, #0d1117);
  color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; outline: none; }
.dshExternalBrowserTitle { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 12px; }
.dshExternalBrowserMode { display: inline-flex; align-items: center; gap: 4px; color: var(--dsw-alias-label-secondary, #9aa0a6); font-size: 12px; white-space: nowrap; }
.dshExternalBrowserBody { flex: 1; min-height: 0; position: relative; }
.dshExternalBrowserGuest { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
`
  document.head.appendChild(style)
  return () => { style.remove() }
}
