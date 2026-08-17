/**
 * Pure, DOM-free tab model for the desktop external browser. Kept in its own
 * module so the ordering / activation / close rules are unit-testable without
 * Electron or React. State transitions return new objects (no mutation) so the
 * panel can own a single snapshot and re-render on change.
 */

/** One browser tab: a persistent window into the shared webview partition. */
export interface BrowserTab {
  /** Stable identity within the panel lifetime. */
  id: string
  /** Current URL shown / navigated by this tab. */
  url: string
  /** Page title, defaulted to hostname by the renderer when empty. */
  title: string
}

/** The full tab panel state relevant to tab management. */
export interface BrowserTabsState {
  /** Open tabs in strip order. */
  tabs: BrowserTab[]
  /** The active tab id, null only when there are no tabs. */
  activeTabId: string | null
}

/** Upper bound on simultaneously held tabs (each holds one <webview> guest). */
export const MAX_TABS = 20

/** Monotonic id source. */
let tabSeq = 0
/** Mint a fresh, unique tab id. */
export function newTabId(): string {
  tabSeq += 1
  return `tab-${Date.now().toString(36)}-${String(tabSeq)}`
}

/** The empty tab state. */
export function emptyTabs(): BrowserTabsState {
  return { tabs: [], activeTabId: null }
}

/**
 * Append a new tab (with an optional URL) and make it active.
 * Appends are rejected when at MAX_TABS; the state is returned unchanged.
 * @param state - current tab state.
 * @param url - optional initial URL for the new tab.
 * @returns the new state with the added tab active.
 */
export function openTab(state: BrowserTabsState, url = ''): BrowserTabsState {
  if (state.tabs.length >= MAX_TABS) return state
  const id = newTabId()
  const tab: BrowserTab = { id, url, title: '' }
  return { tabs: [...state.tabs, tab], activeTabId: id }
}

/**
 * Make the given tab active, if it exists.
 * @param state - current tab state.
 * @param id - target tab id.
 * @returns the new state, or the same (new) reference if nothing changed.
 */
export function activateTab(state: BrowserTabsState, id: string): BrowserTabsState {
  if (state.activeTabId === id) return state
  const exists = state.tabs.some((tab) => tab.id === id)
  if (!exists) return state
  return { tabs: state.tabs, activeTabId: id }
}

/**
 * Close the given tab. If it was active, the neighbor to its right (else the
 * left, else none) becomes active. When the last tab closes, tab state resets
 * to empty (the caller decides whether the panel itself closes).
 * @param state - current tab state.
 * @param id - tab id to close.
 * @returns the new state.
 */
export function closeTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return emptyTabs()
  let activeTabId = state.activeTabId
  if (activeTabId === id) {
    const next = tabs[Math.min(index, tabs.length - 1)]
    activeTabId = next ? next.id : null
  }
  return { tabs, activeTabId }
}

/**
 * Set a tab's URL.
 * @param state - current tab state.
 * @param id - target tab id.
 * @param url - new URL.
 * @returns the new state.
 */
export function setTabUrl(state: BrowserTabsState, id: string, url: string): BrowserTabsState {
  const tabs = state.tabs.map((tab) => (tab.id === id ? { ...tab, url } : tab))
  return { tabs, activeTabId: state.activeTabId }
}

/**
 * Set a tab's title.
 * @param state - current tab state.
 * @param id - target tab id.
 * @param title - new title.
 * @returns the new state.
 */
export function setTabTitle(state: BrowserTabsState, id: string, title: string): BrowserTabsState {
  const tabs = state.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab))
  return { tabs, activeTabId: state.activeTabId }
}

/** Return the active tab, if any. */
export function activeTab(state: BrowserTabsState): BrowserTab | undefined {
  return state.tabs.find((tab) => tab.id === state.activeTabId)
}

/** True when tab management is at its cap. */
export function isFull(state: BrowserTabsState): boolean {
  return state.tabs.length >= MAX_TABS
}
