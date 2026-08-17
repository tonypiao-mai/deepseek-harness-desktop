import { describe, expect, it } from 'vitest'
import {
  activateTab,
  activeTab,
  closeTab,
  emptyTabs,
  isFull,
  MAX_TABS,
  openTab,
  setTabTitle,
  setTabUrl,
  type BrowserTabsState,
} from '../src/client/tab-store.ts'

function threeTabs(): BrowserTabsState {
  let state = openTab(emptyTabs(), 'https://a.example')
  state = openTab(state, 'https://b.example')
  state = openTab(state, 'https://c.example')
  return state
}

describe('tab-store', () => {
  it('opens a tab with an optional URL, appended and active', () => {
    const s1 = openTab(emptyTabs(), 'https://a.example')
    expect(s1.tabs).toHaveLength(1)
    expect(s1.activeTabId).toBe(s1.tabs[0]!!.id)
    expect(s1.tabs[0]!!.url).toBe('https://a.example')

    const s2 = openTab(s1, 'https://b.example')
    expect(s2.tabs).toHaveLength(2)
    expect(s2.activeTabId).toBe(s2.tabs[1]!!.id)
    // Original stays unchanged (immutable transitions).
    expect(s1.tabs).toHaveLength(1)
  })

  it('auto-assigns unique ids in order', () => {
    const s1 = openTab(emptyTabs())
    const s2 = openTab(s1)
    const ids = [s1.tabs[0]!!.id, s2.tabs[1]!!.id]
    expect(new Set(ids).size).toBe(2)
  })

  it('activates an existing tab and ignores unknown ids', () => {
    const s = threeTabs()
    const secondId = s.tabs[1]!!.id
    const activated = activateTab(s, secondId)
    expect(activated.activeTabId).toBe(secondId)
    expect(activateTab(s, 'nope')).toBe(s)
    expect(activateTab(activated, secondId)).toBe(activated)
  })

  it('returns the active tab or undefined', () => {
    expect(activeTab(emptyTabs())).toBeUndefined()
    const s = threeTabs()
    const active = activeTab(s)
    expect(active?.id).toBe(s.activeTabId)
  })

  it('closing the active tab activates the right neighbor, else the left', () => {
    const s = threeTabs()
    // Close the middle (active) tab: right neighbor wins.
    const middleId = s.tabs[1]!!.id
    const afterMiddle = closeTab(s, middleId)
    expect(afterMiddle.tabs).toHaveLength(2)
    expect(afterMiddle.activeTabId).toBe(s.tabs[2]!.id)

    // Close the last (active) tab: right neighbor gone, left wins.
    const last = afterMiddle.tabs[afterMiddle.tabs.length - 1]!.id
    const afterLast = closeTab(afterMiddle, last)
    expect(afterLast.tabs).toHaveLength(1)
    expect(afterLast.activeTabId).toBe(afterLast.tabs[0]!!.id)
  })

  it('closing an inactive tab keeps the active tab', () => {
    const s = threeTabs()
    const activeId = s.activeTabId!
    const firstId = s.tabs[0]!!.id
    const closed = closeTab(s, firstId)
    expect(closed.tabs).toHaveLength(2)
    expect(closed.activeTabId).toBe(activeId)
  })

  it('closing the last tab yields the empty state', () => {
    const s = openTab(emptyTabs())
    const closed = closeTab(s, s.activeTabId!)
    expect(closed.tabs).toHaveLength(0)
    expect(closed.activeTabId).toBeNull()
  })

  it('ignores closing a missing tab', () => {
    const s = threeTabs()
    expect(closeTab(s, 'nope')).toBe(s)
  })

  it('sets url and title only on the target tab', () => {
    const s = threeTabs()
    const targetId = s.tabs[0]!!.id
    const withUrl = setTabUrl(s, targetId, 'https://new.example')
    expect(withUrl.tabs[0]!!.url).toBe('https://new.example')
    expect(withUrl.tabs[1]!!.url).toBe(s.tabs[1]!!.url)

    const withTitle = setTabTitle(withUrl, targetId, 'New Title')
    expect(withTitle.tabs[0]!!.title).toBe('New Title')
    expect(withTitle.tabs[1]!!.title).toBe('')
  })

  it('enforces the max tab cap, returning the state unchanged at the limit', () => {
    let state = emptyTabs()
    for (let i = 0; i < MAX_TABS; i += 1) state = openTab(state, `https://x${i}.example`)
    expect(state.tabs).toHaveLength(MAX_TABS)
    expect(isFull(state)).toBe(true)
    const capped = openTab(state, 'https://overflow.example')
    expect(capped).toBe(state)
    expect(capped.tabs).toHaveLength(MAX_TABS)
  })
})