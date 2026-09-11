import { renderToString } from 'react-dom/server'
import { jsx } from 'react/jsx-runtime'
import { __emit, host } from '@hermes/plugin-sdk'
import plugin, { GraphView, layoutGraph, $trails } from './plugin.js'
host.request = async () => ({ messages: [] })
plugin.register({ source: 'p', register: () => () => {}, registerMany: () => {}, onDispose: () => {}, rest: async () => ({}), socket: () => () => {}, os: {}, storage: {}, i18n: { register: () => {} } })
const SID = 'long-1'
host.state.focusedSessionId.set(SID); host.state.activeSessionId.set(SID); host.state.busy.set(true)
// 30 tool calls, no note and no todo -> one implicit band, windowed
for (let i = 0; i < 30; i += 1) {
  __emit({ type: 'tool.start', session_id: SID, payload: { name: 'terminal', tool_id: `t${i}`, args: { command: `echo ${i}` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: 'terminal', tool_id: `t${i}`, result: 'ok' } })
  __emit({ type: 'tool.start', session_id: SID, payload: { name: 'read_file', tool_id: `r${i}`, args: { file_path: `/repo/f${i}.ts` } } })
  __emit({ type: 'tool.complete', session_id: SID, payload: { name: 'read_file', tool_id: `r${i}`, result: 'ok' } })
}
const trail = $trails.get()[SID]
const html = renderToString(jsx(GraphView, { trail }))
const l = layoutGraph(trail)
const text = html.replace(/<[^>]*>/g, ' ')
console.log('steps in trail:', trail.order.length, '| cards drawn:', (html.match(/class="sg-node"/g)||[]).length)
console.log('bands:', (html.match(/class="sg-task"/g)||[]).length, '| overflow note:', /earlier step/.test(text) ? text.match(/…\s*\d+\s*earlier steps?/)[0] : 'none')
console.log('halos:', (html.match(/class="sg-halo"/g)||[]).length, '| edge labels:', (html.match(/class="sg-edge-label"/g)||[]).length)
console.log('canvas:', l.width, 'x', l.height, '| NaN:', /NaN/.test(html) ? 'YES' : 'no')
