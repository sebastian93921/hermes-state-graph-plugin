/**
 * Local stand-in for `@hermes/plugin-sdk` used ONLY by the offline smoke test.
 * Mirrors the real contract: the real nanostores `atom`, the real
 * @nanostores/react `useStore` as `useValue`, and light stubs for the UI kit
 * (the app's kit can't resolve outside the Vite build — stubs still prove the
 * plugin's own tree renders, its hooks are legal, and its store plumbing works).
 */
import { useStore } from '@nanostores/react'
import { atom, computed } from 'nanostores'
import { jsx } from 'react/jsx-runtime'

export { atom, computed }

export const useValue = useStore

export const cn = (...parts) => parts.filter(Boolean).join(' ')

// ── gateway event tap + host stub ──────────────────────────────────────────
const listeners = new Map()

export function __emit(event) {
  for (const fn of listeners.get(event.type) ?? []) {
    fn(event)
  }

  for (const fn of listeners.get('*') ?? []) {
    fn(event)
  }
}

export function __resetHost(seed) {
  if (seed) {
    host.request = async () => seed
  }
}

export const host = {
  state: {
    activeSessionId: atom(null),
    awaitingResponse: atom(false),
    busy: atom(false),
    busyBySession: atom({}),
    connectionId: atom(null),
    cwd: atom('/home/parrot/workspace'),
    focusedSessionId: atom(null),
    focusedSessionOwner: atom(null),
    focusedSessionProfile: atom('default'),
    focusedStoredSessionId: atom(null),
    focusedUsage: atom(null),
    gateway: atom('open'),
    model: atom('test-model'),
    profile: atom('default'),
    viewport: atom({ width: 1600, height: 900, narrow: false })
  },
  notify: input => {
    console.log('[notify]', input?.kind, input?.message)
    return 'id-1'
  },
  notifyError: () => 'id-2',
  navigate: path => console.log('[navigate]', path),
  onEvent: (type, fn) => {
    const set = listeners.get(type) ?? new Set()

    set.add(fn)
    listeners.set(type, set)

    return () => set.delete(fn)
  },
  request: async method => {
    console.log('[request]', method)
    return { messages: [] }
  },
  logs: async () => '',
  status: async () => ({}),
  openWorkspace: async () => {},
  paneVisibility: () => atom(true),
  listPersistedSessions: async () => []
}

// ── UI kit stubs (children-preserving, so the tree still renders) ──────────
const passthrough = name => {
  const Component = ({ children, ...props }) =>
    jsx('div', { 'data-stub': name, ...props, children })

  Component.displayName = `Stub(${name})`

  return Component
}

export const Badge = ({ children }) => jsx('span', { 'data-stub': 'Badge', children })
export const Button = ({ children, onClick, ...rest }) => jsx('button', { onClick, ...rest, children: children })
export const Codicon = () => jsx('i', { 'data-stub': 'Codicon' })
export const CopyButton = ({ appearance, label, text }) =>
  jsx('span', {
    'data-stub': 'CopyButton',
    'data-appearance': appearance ?? 'button',
    children: `${label ?? 'copy'}:${String(text).length}`
  })
export const EmptyState = ({ title, description }) =>
  jsx('div', { 'data-stub': 'EmptyState', children: [title, description] })
export const GlyphSpinner = () => jsx('i', { 'data-stub': 'GlyphSpinner' })
export const ScrollArea = passthrough('ScrollArea')
export const StatusDot = ({ tone }) => jsx('i', { 'data-stub': `StatusDot:${tone}` })
export const Tip = ({ children, label }) =>
  jsx('span', { 'data-stub': 'Tip', 'data-tip': label ?? '', children })
