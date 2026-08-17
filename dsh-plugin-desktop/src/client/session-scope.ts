/**
 * Pure, DOM-free per-session scoping for the desktop external browser. Each
 * DSH session owns its own tab list and its own panel open state, so switching
 * sessions restores that session's last known browser context. Kept in its own
 * module so the scoping rules are unit-testable without Electron or React.
 */

import type { BrowserTabsState } from './tab-store.ts'
import { emptyTabs } from './tab-store.ts'

/** Upper bound on remembered sessions (each may hold tabs + guests). */
export const MAX_SESSIONS = 50

/** The full session-scoped browser state. */
export interface SessionScopedState {
  /** Per-session tab lists keyed by session id. */
  tabsBySession: Record<string, BrowserTabsState>
  /** Per-session panel open state keyed by session id. */
  openBySession: Record<string, boolean>
  /** The currently active session id, when known. */
  currentSessionId: string | null
}

/** The empty session-scoped state. */
export function emptySessionScope(): SessionScopedState {
  return { tabsBySession: {}, openBySession: {}, currentSessionId: null }
}

/** The current session's tab state, creating an empty one on first use. */
export function currentTabs(state: SessionScopedState): BrowserTabsState {
  const id = state.currentSessionId
  if (id === null) return emptyTabs()
  return state.tabsBySession[id] ?? emptyTabs()
}

/** Whether the panel is open for the current session (default closed). */
export function currentOpen(state: SessionScopedState): boolean {
  const id = state.currentSessionId
  if (id === null) return false
  return state.openBySession[id] ?? false
}

/** Record the active session and cap remembered sessions (prune oldest first). */
export function setCurrentSession(
  state: SessionScopedState,
  sessionId: string | null,
  order: readonly string[],
): SessionScopedState {
  const next: SessionScopedState = {
    tabsBySession: state.tabsBySession,
    openBySession: state.openBySession,
    currentSessionId: sessionId,
  }
  if (sessionId === null || state.tabsBySession[sessionId] !== undefined) return next
  // New session: seed empty entries and enforce the cap.
  const tabsBySession = { ...state.tabsBySession, [sessionId]: emptyTabs() }
  const openBySession = { ...state.openBySession, [sessionId]: false }
  const keys = Object.keys(tabsBySession)
  if (keys.length > MAX_SESSIONS) {
    // Keep the most recent sessions per the given order (fall back to insertion
    // order when the list is unavailable).
    const keep = new Set<string>()
    for (const id of [...order].reverse()) {
      if (tabsBySession[id] !== undefined) keep.add(id)
      if (keep.size >= MAX_SESSIONS) break
    }
    for (const id of [...keys].reverse()) {
      if (keep.size >= MAX_SESSIONS) break
      keep.add(id)
    }
    for (const id of keys) {
      if (!keep.has(id)) {
        delete tabsBySession[id]
        delete openBySession[id]
      }
    }
  }
  return { tabsBySession, openBySession, currentSessionId: sessionId }
}

/** Write the current session's tab list. */
export function commitCurrentTabs(
  state: SessionScopedState,
  tabs: BrowserTabsState,
): SessionScopedState {
  const id = state.currentSessionId
  if (id === null) return state
  return {
    tabsBySession: { ...state.tabsBySession, [id]: tabs },
    openBySession: state.openBySession,
    currentSessionId: id,
  }
}

/** Write the current session's panel open state. */
export function commitCurrentOpen(
  state: SessionScopedState,
  open: boolean,
): SessionScopedState {
  const id = state.currentSessionId
  if (id === null) return state
  return {
    tabsBySession: state.tabsBySession,
    openBySession: { ...state.openBySession, [id]: open },
    currentSessionId: id,
  }
}

/** Prune entries for sessions that no longer exist in the catalog. */
export function pruneMissingSessions(
  state: SessionScopedState,
  alive: ReadonlySet<string>,
): SessionScopedState {
  let tabsBySession = state.tabsBySession
  let openBySession = state.openBySession
  for (const id of Object.keys(tabsBySession)) {
    if (!alive.has(id)) {
      tabsBySession = { ...tabsBySession }
      openBySession = { ...openBySession }
      delete tabsBySession[id]
      delete openBySession[id]
    }
  }
  return { tabsBySession, openBySession, currentSessionId: state.currentSessionId }
}
