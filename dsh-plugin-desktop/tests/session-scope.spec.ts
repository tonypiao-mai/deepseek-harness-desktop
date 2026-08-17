import { describe, expect, it } from 'vitest'
import {
  commitCurrentOpen,
  commitCurrentTabs,
  currentOpen,
  currentTabs,
  emptySessionScope,
  MAX_SESSIONS,
  pruneMissingSessions,
  setCurrentSession,
  type SessionScopedState,
} from '../src/client/session-scope.ts'
import { openTab, emptyTabs } from '../src/client/tab-store.ts'

/** Build a persistent scope with two sessions: 'a' (2 tabs, open) then 'b' (1 tab). */
function twoSessionScope(): SessionScopedState {
  let scope = setCurrentSession(emptySessionScope(), 'a', ['a'])
  let tabs = currentTabs(scope)
  tabs = openTab(tabs, 'https://x0.example')
  tabs = openTab(tabs, 'https://x1.example')
  scope = commitCurrentTabs(scope, tabs)
  scope = commitCurrentOpen(scope, true)
  scope = setCurrentSession(scope, 'b', ['a', 'b'])
  let bTabs = currentTabs(scope)
  bTabs = openTab(bTabs, 'https://b0.example')
  return commitCurrentTabs(scope, bTabs)
}

describe('session-scope', () => {
  it('defaults to an empty scope with no session', () => {
    const scope = emptySessionScope()
    expect(scope.currentSessionId).toBeNull()
    expect(currentTabs(scope).tabs).toHaveLength(0)
    expect(currentOpen(scope)).toBe(false)
  })

  it('seeds a fresh session as empty + closed on first use', () => {
    const scope = twoSessionScope()
    const fresh = setCurrentSession(scope, 'c', ['a', 'b', 'c'])
    expect(currentTabs(fresh).tabs).toHaveLength(0)
    expect(currentOpen(fresh)).toBe(false)
  })

  it('keeps tabs and open state per session, isolated from other sessions', () => {
    const scope = twoSessionScope()

    // Back to A: tabs + open state restored; B's tabs not visible.
    const backToA = setCurrentSession(scope, 'a', ['a', 'b'])
    expect(currentTabs(backToA).tabs).toHaveLength(2)
    expect(currentOpen(backToA)).toBe(true)
    expect(currentTabs(backToA).tabs[0]!.url).toBe('https://x0.example')

    // B keeps its own single tab and closed state.
    const backToB = setCurrentSession(backToA, 'b', ['a', 'b'])
    expect(currentTabs(backToB).tabs).toHaveLength(1)
    expect(currentOpen(backToB)).toBe(false)
  })

  it('writes only to the current session', () => {
    const scope = twoSessionScope()
    const stillB = commitCurrentOpen(scope, true)
    expect(currentOpen(stillB)).toBe(true)
    const backToA = setCurrentSession(stillB, 'a', ['a', 'b'])
    expect(currentTabs(backToA).tabs).toHaveLength(2)
    expect(currentOpen(backToA)).toBe(true)
  })

  it('no-ops commits when there is no current session', () => {
    const scope = emptySessionScope()
    expect(commitCurrentTabs(scope, openTab(emptyTabs(), 'x'))).toBe(scope)
    expect(commitCurrentOpen(scope, true)).toBe(scope)
  })

  it('prunes sessions that no longer exist', () => {
    let scope = twoSessionScope()
    const pruned = pruneMissingSessions(scope, new Set(['a']))
    expect(pruned.tabsBySession['b']).toBeUndefined()
    expect(pruned.openBySession['b']).toBeUndefined()
    expect(pruned.tabsBySession['a']).toBeDefined()
    expect(pruned.currentSessionId).toBe('b')
  })

  it('enforces the session cap, dropping the oldest sessions', () => {
    let scope = emptySessionScope()
    const order: string[] = []
    for (let i = 0; i < MAX_SESSIONS + 10; i += 1) {
      order.push(`s${i}`)
      scope = setCurrentSession(scope, `s${i}`, order)
    }
    const keys = Object.keys(scope.tabsBySession)
    expect(keys.length).toBe(MAX_SESSIONS)
    expect(keys).toContain(`s${MAX_SESSIONS + 9}`)
    expect(scope.tabsBySession['s0']).toBeUndefined()
  })
})
