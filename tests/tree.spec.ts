import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  advisorEvents,
  applyEvent,
  clearFinishedCounted,
  clearOutput,
  closeOutput,
  commandOutput,
  EMPTY_HINT,
  emptyTree,
  formatElapsed,
  hasRunning,
  isAsciiLocale,
  detailRows,
  renderLines as renderAt,
  renderPane,
  renderRows as rowsAt,
  storedTask,
  summaryLines,
  wrapText,
} from '../hooks/tree.ts'
import type { TreeEvent } from '../hooks/tree.ts'
import type { TurnStepServerToolUse } from 'claude-code'
import type { AgentNode, Role } from '../types'

const WIDE = 80
const NOW = 1_000_000
const renderLines = (tree: Parameters<typeof renderAt>[0], columns: number, now = NOW) => renderAt(tree, columns, now)

const spawned = (agentId: string, rest: Partial<Extract<TreeEvent, { type: 'agent.spawned' }>> = {}): TreeEvent => ({
  type: 'agent.spawned',
  agentId,
  ...rest,
})

const apply = (...events: TreeEvent[]) => events.reduce(applyEvent, emptyTree)

test('AC1.3 empty tree shows Main and the hint, untruncated', () => {
  assert.deepEqual(renderLines(emptyTree, 20), ['Main', EMPTY_HINT])
  assert.equal(EMPTY_HINT, 'No subagents yet. Delegated work appears here.')
})

test('AC1.4 nests by 2 columns, last sibling uses └─, earlier ones continue with │', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    spawned('c', { name: 'C' }),
  )

  assert.deepEqual(renderLines(tree, WIDE), [
    'Main',
    '├─ ● running A',
    '│ └─ ● running B',
    '└─ ● running C',
  ])
})

test('AC1.4 beneath a last sibling the continuation is blank', () => {
  const tree = apply(spawned('a', { name: 'A' }), spawned('b', { name: 'B', parentAgentId: 'a' }))

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ● running A', '  └─ ● running B'])
})

test('AC1.5 an unknown parent attaches under Main', () => {
  const tree = apply(spawned('b', { name: 'B', parentAgentId: 'missing' }))

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ● running B'])
})

test('AC1.5 the node re-parents once its parent arrives', () => {
  const tree = apply(spawned('b', { name: 'B', parentAgentId: 'p' }), spawned('p', { name: 'P' }))

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ● running P', '  └─ ● running B'])
})

test('AC1.6 label is name, falling back to type, then "agent"', () => {
  const tree = apply(
    spawned('a', { name: 'N', subagentType: 'Explore' }),
    spawned('b', { subagentType: 'Explore' }),
    spawned('c', {}),
  )

  assert.deepEqual(renderLines(tree, WIDE), [
    'Main',
    '├─ ● running N',
    '├─ ● running Explore',
    '└─ ● running agent',
  ])
})

test('AC1.6 description follows the label on the same line, whitespace collapsed', () => {
  const tree = apply(spawned('a', { name: 'N', description: 'find\nthe  bug' }))

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ● running N: find the bug'])
})

test('AC1.6 a long line is cut to the width with …, the status staying visible', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'a very long description' }))
  const [, line] = renderLines(tree, 24)

  assert.equal(line, '└─ ● running Explorer: …')
  assert.equal([...line!].length, 24)
})

test('AC1.6 a line that fits is left alone', () => {
  const tree = apply(spawned('a', { name: 'N' }))

  assert.equal(renderLines(tree, 16)[1], '└─ ● running N')
})

test('AC1.7 siblings stay in spawn order', () => {
  const tree = apply(spawned('z', { name: 'first' }), spawned('a', { name: 'second' }), spawned('m', { name: 'third' }))

  assert.deepEqual(renderLines(tree, WIDE).slice(1), [
    '├─ ● running first',
    '├─ ● running second',
    '└─ ● running third',
  ])
})

test('AC1.8 a reset clears back to the empty state', () => {
  const tree = apply(spawned('a', { name: 'A' }), { type: 'session.ended', reason: 'clear' })

  assert.deepEqual(renderLines(tree, WIDE), ['Main', EMPTY_HINT])
})

test('AC2.2 / AC2.4 answer ends done', () => {
  const tree = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', agentId: 'a', reason: 'answer' })

  assert.equal(renderLines(tree, WIDE)[1], '└─ ✓ done A')
})

test('AC2.4 aborted ends aborted', () => {
  const tree = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', agentId: 'a', reason: 'aborted' })

  assert.equal(renderLines(tree, WIDE)[1], '└─ ⊘ aborted A')
})

test('AC2.4 any other reason ends failed and shows the reason', () => {
  const error = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', agentId: 'a', reason: 'error' })
  const refusal = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', agentId: 'a', reason: 'refusal' })

  assert.equal(renderLines(error, WIDE)[1], '└─ ✗ failed (error) A')
  assert.equal(renderLines(refusal, WIDE)[1], '└─ ✗ failed (refusal) A')
})

test('AC2.2 only the completing agent changes status', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B' }),
    { type: 'turn.complete', agentId: 'b', reason: 'answer' },
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['├─ ● running A', '└─ ✓ done B'])
})

test('a main-loop turn.complete (no agentId) changes nothing', () => {
  const tree = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', reason: 'answer' })

  assert.equal(renderLines(tree, WIDE)[1], '└─ ● running A')
})

test('a turn.complete for an unknown agent changes nothing', () => {
  const tree = apply(spawned('a', { name: 'A' }), { type: 'turn.complete', agentId: 'ghost', reason: 'error' })

  assert.equal(renderLines(tree, WIDE)[1], '└─ ● running A')
})

test('a turn.complete that arrives before its spawn is applied when the spawn arrives', () => {
  const done = apply({ type: 'turn.complete', agentId: 'a', reason: 'answer' }, spawned('a', { name: 'A' }))
  const aborted = apply({ type: 'turn.complete', agentId: 'a', reason: 'aborted' }, spawned('a', { name: 'A' }))
  const failed = apply({ type: 'turn.complete', agentId: 'a', reason: 'error' }, spawned('a', { name: 'A' }))

  assert.equal(renderLines(done, WIDE)[1], '└─ ✓ done A')
  assert.equal(renderLines(aborted, WIDE)[1], '└─ ⊘ aborted A')
  assert.equal(renderLines(failed, WIDE)[1], '└─ ✗ failed (error) A')
})

test('a pending completion for one agent does not touch another', () => {
  const tree = apply(
    { type: 'turn.complete', agentId: 'x', reason: 'answer' },
    spawned('y', { name: 'Y' }),
    spawned('x', { name: 'X' }),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['├─ ● running Y', '└─ ✓ done X'])
})

test('a pending completion is applied once: a later respawn of that id starts running', () => {
  const tree = apply(
    { type: 'turn.complete', agentId: 'a', reason: 'answer' },
    spawned('a', { name: 'first' }),
    spawned('a', { name: 'second' }),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['├─ ✓ done first', '└─ ● running second'])
})

test('the last pending completion for an agent wins', () => {
  const tree = apply(
    { type: 'turn.complete', agentId: 'a', reason: 'aborted' },
    { type: 'turn.complete', agentId: 'a', reason: 'answer' },
    spawned('a', { name: 'A' }),
  )

  assert.equal(renderLines(tree, WIDE)[1], '└─ ✓ done A')
})

test('a reset drops pending completions', () => {
  const tree = apply(
    { type: 'turn.complete', agentId: 'a', reason: 'answer' },
    { type: 'session.ended', reason: 'clear' },
    spawned('a', { name: 'A' }),
  )

  assert.equal(renderLines(tree, WIDE)[1], '└─ ● running A')
})

test('/agent-tree prints nothing when the pane was placed', () => {
  assert.deepEqual(commandOutput({ isPlaced: true }), {})
})

test('/agent-tree prints why the pane waits when it was not placed', () => {
  assert.deepEqual(commandOutput({ isPlaced: false, reason: 'terminal too narrow' }), {
    text: 'Agents pane is open but not drawn: terminal too narrow',
  })
})

test('applyEvent does not mutate the tree it was given', () => {
  const before = apply(spawned('a', { name: 'A' }))
  const snapshot = structuredClone(before)

  applyEvent(before, { type: 'turn.complete', agentId: 'a', reason: 'answer' })
  applyEvent(before, spawned('b'))
  applyEvent(before, { type: 'turn.complete', agentId: 'ghost', reason: 'answer' })
  applyEvent(before, { type: 'tool.called', agentId: 'a', tool: 'Read', input: { file_path: 'x.ts' } })
  applyEvent(before, { type: 'turn.stepped', agentId: 'a' })
  applyEvent(before, { type: 'session.ended', reason: 'other', at: NOW })

  assert.deepEqual(before, snapshot)
})

const called = (agentId: string, tool: string, input: Record<string, unknown>): TreeEvent => ({
  type: 'tool.called',
  agentId,
  tool,
  input,
})

const stepped = (agentId: string): TreeEvent => ({ type: 'turn.stepped', agentId })

const finished = (agentId: string, durationMs: number, reason = 'answer'): TreeEvent => ({
  type: 'turn.complete',
  agentId,
  reason,
  durationMs,
})

const stepRow = (tree: Parameters<typeof renderAt>[0], index = 2) => renderLines(tree, WIDE)[index]

test('AC2.5 elapsed reads 12s, 1m 05s and 1h 02m', () => {
  assert.equal(formatElapsed(0), '0s')
  assert.equal(formatElapsed(12_000), '12s')
  assert.equal(formatElapsed(59_999), '59s')
  assert.equal(formatElapsed(60_000), '1m 00s')
  assert.equal(formatElapsed(65_000), '1m 05s')
  assert.equal(formatElapsed(3_720_000), '1h 02m')
  assert.equal(formatElapsed(-5_000), '0s')
})

test('AC2.5 a running node shows the time since its spawn, and it moves with now', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }))

  assert.equal(renderLines(tree, WIDE, NOW + 12_000)[1], '└─ ● running 12s A')
  assert.equal(renderLines(tree, WIDE, NOW + 65_000)[1], '└─ ● running 1m 05s A')
})

test('AC2.5 a finished node freezes at the durationMs of its event', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000))

  assert.equal(renderLines(tree, WIDE, NOW + 999_000)[1], '└─ ✓ done 5s A')
})

test('AC2.5 a failed node shows its reason and its frozen time', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000, 'error'))

  assert.equal(renderLines(tree, WIDE, NOW + 999_000)[1], '└─ ✗ failed (error) 5s A')
})

test('AC2.5 a completion that beats its spawn keeps its durationMs', () => {
  const tree = apply(finished('a', 7_000), spawned('a', { name: 'A', at: NOW }))

  assert.equal(renderLines(tree, WIDE, NOW + 999_000)[1], '└─ ✓ done 7s A')
})

test('AC2.5 Main shows the time since the session reset', () => {
  const tree = apply({ type: 'session.ended', reason: 'clear', at: NOW })

  assert.equal(renderLines(tree, WIDE, NOW + 65_000)[0], 'Main 1m 05s')
  assert.equal(renderLines(tree, WIDE, NOW + 65_000)[1], EMPTY_HINT)
})

test('AC2.5 Main stays plain when no start time is known', () => {
  assert.equal(renderLines(emptyTree, WIDE, NOW + 65_000)[0], 'Main')
})

test('AC2.5 status stays first, so a narrow cut takes the description, not the elapsed time', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text', at: NOW }))

  assert.equal(renderLines(tree, 26, NOW + 12_000)[1], '└─ ● running 12s Explorer…')
})

test('AC2.3 a tool.call shows the tool and its subject on a second line', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: 'src/app.ts' }))

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ● running A', '   ↳ Read src/app.ts'])
})

test('AC2.3 the step row lines up under a node that has later siblings and under its children', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    spawned('c', { name: 'C' }),
    called('a', 'Bash', { command: 'ls' }),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), [
    '├─ ● running A',
    '│  ↳ Bash ls',
    '│ └─ ● running B',
    '└─ ● running C',
  ])
})

test('AC2.3 the next tool.call replaces the current one', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    called('a', 'Read', { file_path: 'one.ts' }),
    called('a', 'Bash', { command: 'npm test' }),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ● running A', '   ↳ Bash npm test'])
})

test('AC2.3 a turn.step with no tool shows "thinking"', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: 'one.ts' }), stepped('a'))

  assert.equal(stepRow(tree), '   ↳ thinking')
})

test('AC2.3 a tool with no known subject shows its name alone', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'TodoWrite', { todos: [] }))

  assert.equal(stepRow(tree), '   ↳ TodoWrite')
})

test('AC2.3 / AC2.4 a finished node shows no current tool', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: 'one.ts' }), finished('a', 1_000))

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ✓ done 1s A'])
})

test('AC2.3 a tool.call or turn.step after the node finished does not bring the tool back', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    finished('a', 1_000),
    called('a', 'Read', { file_path: 'late.ts' }),
    stepped('a'),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ✓ done 1s A'])
})

test('AC2.3 a tool.call or turn.step for an unknown agent changes nothing', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('ghost', 'Read', { file_path: 'x.ts' }), stepped('ghost'))

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ● running A'])
})

test('AC2.8 three parallel siblings each keep their own tool and elapsed time', () => {
  const tree = apply(
    spawned('a', { name: 'A', at: NOW }),
    spawned('b', { name: 'B', at: NOW + 1_000 }),
    spawned('c', { name: 'C', at: NOW + 2_000 }),
    called('a', 'Read', { file_path: 'a.ts' }),
    called('b', 'Bash', { command: 'ls' }),
    stepped('c'),
    called('b', 'Bash', { command: 'pwd' }),
  )

  assert.deepEqual(renderLines(tree, WIDE, NOW + 10_000).slice(1), [
    '├─ ● running 10s A',
    '│  ↳ Read a.ts',
    '├─ ● running 9s B',
    '│  ↳ Bash pwd',
    '└─ ● running 8s C',
    '   ↳ thinking',
  ])
})

test('AC2.8 completing one sibling leaves the others running with their tools', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B' }),
    called('a', 'Read', { file_path: 'a.ts' }),
    called('b', 'Read', { file_path: 'b.ts' }),
    finished('a', 1_000),
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['├─ ✓ done 1s A', '└─ ● running B', '   ↳ Read b.ts'])
})

test('AC2.6 session.end aborts a running child, freezes its time, and leaves finished ones alone', () => {
  const tree = apply(
    spawned('a', { name: 'A', at: NOW }),
    spawned('b', { name: 'B', at: NOW }),
    called('a', 'Read', { file_path: 'a.ts' }),
    finished('b', 2_000),
    { type: 'session.ended', reason: 'prompt_input_exit', at: NOW + 9_000 },
  )

  assert.deepEqual(renderLines(tree, WIDE, NOW + 999_000).slice(1), ['├─ ⊘ aborted 9s A', '└─ ✓ done 2s B'])
})

test('AC2.6 session.end with /clear still resets the pane', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), { type: 'session.ended', reason: 'clear', at: NOW + 5_000 })

  assert.deepEqual(renderLines(tree, WIDE, NOW + 6_000), ['Main 1s', EMPTY_HINT])
})

test('AC2.6 hasRunning is true only while a node runs', () => {
  const running = apply(spawned('a'))

  assert.equal(hasRunning(emptyTree), false)
  assert.equal(hasRunning(running), true)
  assert.equal(hasRunning(applyEvent(running, finished('a', 1))), false)
  assert.equal(hasRunning(applyEvent(running, { type: 'session.ended', reason: 'other' })), false)
})

const cleared: TreeEvent = { type: 'finished.cleared' }

test('AC-C1 clear removes done, failed and aborted nodes and keeps the running one', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B' }),
    spawned('c', { name: 'C' }),
    spawned('d', { name: 'D' }),
    finished('a', 1_000),
    finished('b', 1_000, 'error'),
    finished('c', 1_000, 'aborted'),
    cleared,
  )

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ● running D'])
})

test('AC-C2 a finished node with a running child stays, and its finished children and siblings go', () => {
  const tree = apply(
    spawned('p', { name: 'P' }),
    spawned('c', { name: 'C', parentAgentId: 'p' }),
    spawned('x', { name: 'X', parentAgentId: 'p' }),
    spawned('f', { name: 'F' }),
    finished('p', 1_000),
    finished('x', 1_000),
    finished('f', 1_000),
    cleared,
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ✓ done 1s P', '  └─ ● running C'])
})

test('AC-C2 every finished ancestor of a running node stays', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    spawned('c', { name: 'C', parentAgentId: 'b' }),
    finished('a', 1_000),
    finished('b', 1_000),
    cleared,
  )

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ✓ done 1s A', '  └─ ✓ done 1s B', '    └─ ● running C'])
})

test('AC-C2 a finished chain with nothing running below it is removed whole', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    finished('a', 1_000),
    finished('b', 1_000),
    cleared,
  )

  assert.deepEqual(renderLines(tree, WIDE), ['Main', EMPTY_HINT])
})

test('AC-C2 a running node whose parent is unknown keeps its place under Main', () => {
  const tree = apply(spawned('b', { name: 'B', parentAgentId: 'missing' }), spawned('f', { name: 'F' }), finished('f', 1_000), cleared)

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ● running B'])
})

test('AC-C2 a running node keeps its current tool', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: 'a.ts' }), cleared)

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['└─ ● running A', '   ↳ Read a.ts'])
})

test('AC-C3 clear with nothing finished leaves the tree unchanged', () => {
  const running = apply(spawned('a', { name: 'A', at: NOW }), spawned('b', { name: 'B', parentAgentId: 'a' }))

  assert.deepEqual(applyEvent(running, cleared), running)
  assert.deepEqual(applyEvent(emptyTree, cleared), emptyTree)
})

test('AC-C4 clear leaves held completions for agents that have not spawned', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    finished('a', 1_000),
    finished('later', 4_000, 'error'),
    cleared,
  )

  assert.deepEqual(tree.pendingCompletions, [{ agentId: 'later', reason: 'error', durationMs: 4_000 }])
  assert.equal(renderLines(applyEvent(tree, spawned('later', { name: 'L' })), WIDE)[1], '└─ ✗ failed (error) 4s L')
})

test('AC-C6 clear keeps the time Main has been running', () => {
  const tree = apply({ type: 'session.ended', reason: 'clear', at: NOW }, spawned('a'), finished('a', 1_000), cleared)

  assert.equal(renderLines(tree, WIDE, NOW + 65_000)[0], 'Main 1m 05s')
})

test('AC-C6 the clear output says how many finished agents were cleared', () => {
  assert.deepEqual(clearOutput(3), { text: 'Cleared 3 finished agents.' })
  assert.deepEqual(clearOutput(1), { text: 'Cleared 1 finished agent.' })
})

test('AC-C3 the clear output says so in one line when nothing was cleared', () => {
  assert.deepEqual(clearOutput(0), { text: 'No finished agents to clear.' })
})

test('clear does not mutate the tree it was given', () => {
  const before = apply(spawned('a', { name: 'A' }), spawned('b', { name: 'B' }), finished('a', 1_000))
  const snapshot = structuredClone(before)

  applyEvent(before, cleared)

  assert.deepEqual(before, snapshot)
})

test('AC-C6 clearFinishedCounted counts done, failed and aborted nodes and keeps the running one', () => {
  const tree = apply(
    spawned('a'),
    spawned('b'),
    spawned('c'),
    spawned('d'),
    finished('a', 1_000),
    finished('b', 1_000, 'error'),
    finished('c', 1_000, 'aborted'),
  )
  const result = clearFinishedCounted(tree)

  assert.equal(result.cleared, 3)
  assert.deepEqual(result.tree.nodes.map(node => node.agentId), ['d'])
})

test('AC-C2 clearFinishedCounted does not count a finished ancestor of a running node', () => {
  const tree = apply(
    spawned('p'),
    spawned('c', { parentAgentId: 'p' }),
    spawned('x', { parentAgentId: 'p' }),
    finished('p', 1_000),
    finished('x', 1_000),
  )
  const result = clearFinishedCounted(tree)

  assert.equal(result.cleared, 1)
  assert.deepEqual(result.tree.nodes.map(node => node.agentId), ['p', 'c'])
})

test('AC-C3 clearFinishedCounted reports zero and the same nodes when nothing is finished', () => {
  const running = apply(spawned('a'), spawned('b', { parentAgentId: 'a' }))

  assert.deepEqual(clearFinishedCounted(running), { tree: running, cleared: 0 })
  assert.deepEqual(clearFinishedCounted(emptyTree), { tree: emptyTree, cleared: 0 })
})

test('clearFinishedCounted counts exactly the nodes it removed from the snapshot it was given', () => {
  const snapshot = apply(spawned('a'), spawned('b'), finished('a', 1_000))
  const landedSpawn = applyEvent(snapshot, spawned('late'))

  for (const tree of [snapshot, landedSpawn]) {
    const result = clearFinishedCounted(tree)

    assert.equal(result.cleared, tree.nodes.length - result.tree.nodes.length)
    assert.equal(result.cleared >= 0, true)
  }
  assert.equal(clearFinishedCounted(landedSpawn).tree.nodes.some(node => node.agentId === 'late'), true)
})

test('clearFinishedCounted does not mutate the tree it was given', () => {
  const before = apply(spawned('a'), spawned('b'), finished('a', 1_000))
  const snapshot = structuredClone(before)

  clearFinishedCounted(before)

  assert.deepEqual(before, snapshot)
})

const SECRETS = [
  ['an Authorization header', 'curl -H "Authorization: Bearer abc123def456" https://x.test', 'abc123def456'],
  ['api_key=', 'run --api_key=hunter2hunter2', 'hunter2hunter2'],
  ['token=', 'fetch https://x.test?token=zzTOPsecret99', 'zzTOPsecret99'],
  ['password=', 'login password=correct-horse-battery', 'correct-horse-battery'],
  ['an sk- key', 'use sk-proj-ABCDEFGHIJKLMNOP1234', 'sk-proj-ABCDEFGHIJKLMNOP1234'],
  ['an AWS key', 'aws configure AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'],
  ['a ghp_ token', 'git clone ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['an env-style secret', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG', 'wJalrXUtnFEMIK7MDENG'],
  ['a JSON secret', '{"api_key": "s3cr3t-value-here"}', 's3cr3t-value-here'],
] as const

for (const [label, command, secret] of SECRETS) {
  test(`AC4.1 ${label} in a tool input is shown as [redacted] and never stored`, () => {
    const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command }))

    assert.match(stepRow(tree)!, /\[redacted\]/)
    assert.equal(renderLines(tree, WIDE).join('\n').includes(secret), false)
    assert.equal(JSON.stringify(tree).includes(secret), false)
  })
}

test('AC4.1 the secret is gone even when the line is cut very narrow', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command: 'x --token=abcdefghij' }))

  assert.equal(renderLines(tree, 12).join('\n').includes('abcd'), false)
})

for (const path of ['/home/u/app/.env', '/home/u/app/.env.production', '/home/u/.ssh/id_rsa', '/etc/ssl/server.pem', '/home/u/.aws/credentials']) {
  test(`AC4.2 a call on ${path} shows only the file name`, () => {
    const name = path.split('/').pop()
    const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: path }))

    assert.equal(stepRow(tree), `   ↳ Read ${name}`)
    assert.equal(JSON.stringify(tree).includes('/home/u'), false)
  })
}

test('AC4.2 a command that names a secret file shows only that file name', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command: 'cat /srv/app/.env | head' }))

  assert.equal(stepRow(tree), '   ↳ Bash .env')
})

test('AC4.2 a Write shows the file and none of its content', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Write', { file_path: '/srv/.env', content: 'DB_PASSWORD=hunter2' }))

  assert.equal(stepRow(tree), '   ↳ Write .env')
  assert.equal(JSON.stringify(tree).includes('hunter2'), false)
})

test('AC4.2 an ordinary path is shown whole', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: '/srv/app/src/environment.ts' }))

  assert.equal(stepRow(tree), '   ↳ Read /srv/app/src/environment.ts')
})

test('AC4.3 the agent description is masked', () => {
  const tree = apply(spawned('a', { name: 'N', description: 'call api with token=abcdef123456' }))

  assert.equal(renderLines(tree, WIDE)[1], '└─ ● running N: call api with token=[redacted]')
  assert.equal(JSON.stringify(tree).includes('abcdef123456'), false)
})

test('AC4.4 a long input is cut to 60 characters with …', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command: 'x'.repeat(100) }))
  const subject = stepRow(tree)!.replace('   ↳ Bash ', '')

  assert.equal([...subject].length, 60)
  assert.equal(subject.endsWith('…'), true)
})

test('AC4.4 masking runs before the cut, so a cut cannot split a secret and show its prefix', () => {
  const command = `${'x'.repeat(50)} sk-proj-ABCDEFGHIJKLMNOP1234`
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command }))

  assert.equal(stepRow(tree)!.includes('sk-'), false)
  assert.equal(JSON.stringify(tree).includes('sk-'), false)
})

test('AC4.5 a masker that throws leaves the tool name alone, never the raw input', () => {
  const input = {
    get command(): string {
      throw new Error('unknown shape')
    },
  }
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', input))

  assert.equal(stepRow(tree), '   ↳ Bash')
})

test('AC4.5 a subject that is not text leaves the tool name alone', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command: { secret: 'sk-proj-ABCDEFGHIJKLMNOP1234' } }))

  assert.equal(stepRow(tree), '   ↳ Bash')
  assert.equal(JSON.stringify(tree).includes('sk-'), false)
})

const chain = (depth: number, rest: Partial<Extract<TreeEvent, { type: 'agent.spawned' }>> = {}) =>
  Array.from({ length: depth }, (_, i) =>
    spawned(`d${i + 1}`, { name: `D${i + 1}`, parentAgentId: i === 0 ? undefined : `d${i}`, ...rest }),
  )

const flat = (count: number, prefix: string): TreeEvent[] =>
  Array.from({ length: count }, (_, i) => spawned(`${prefix}${i + 1}`, { name: `${prefix}${i + 1}` }))

const finishAll = (events: TreeEvent[], reason = 'answer'): TreeEvent[] =>
  events.flatMap(event => [event, ...(event.type === 'agent.spawned' ? [finished(event.agentId, 1_000, reason)] : [])])

const connectorColumn = (line: string) => [...line].findIndex(char => char === '└')

test('AC3.6 indentation grows 2 columns a level up to depth 4', () => {
  assert.deepEqual(renderLines(apply(...chain(4)), WIDE).slice(1), [
    '└─ ● running D1',
    '  └─ ● running D2',
    '    └─ ● running D3',
    '      └─ ● running D4',
  ])
})

test('AC3.6 below depth 4 the indent stays put and …N marks how much deeper the row is', () => {
  const lines = renderLines(apply(...chain(6)), WIDE)

  assert.equal(lines[5], '    …1└─ ● running D5')
  assert.equal(lines[6], '    …2└─ ● running D6')
})

test('AC3.6 the connector never moves past depth 4, even where …N has two digits', () => {
  const lines = renderLines(apply(...chain(14)), WIDE)

  assert.equal(lines[14], '   …10└─ ● running D14')
  for (const line of lines.slice(4)) assert.equal(connectorColumn(line), 6)
})

test('AC3.6 the …N prefix keeps the ancestors continuing stems that are still drawn', () => {
  const tree = apply(...chain(5), spawned('later', { name: 'Later' }))

  assert.equal(renderLines(tree, WIDE)[5], '│   …1└─ ● running D5')
})

test('AC3.6 a step row below depth 4 stays under its node and carries the same …N', () => {
  const tree = apply(...chain(5), called('d5', 'Read', { file_path: 'a.ts' }), called('d4', 'Read', { file_path: 'b.ts' }))
  const lines = renderLines(tree, WIDE)

  assert.equal(lines[5], '         ↳ Read b.ts')
  assert.equal(lines[7], '    …1   ↳ Read a.ts')
})

test('AC3.6 a running node with its time keeps 14 label columns at depth 4 and at depth 9 in a 40-column pane', () => {
  const events = chain(9, { at: NOW, description: 'a long description that is cut' })
  const labelAt = (depth: number) => {
    const line = renderLines(apply(...events), 40, NOW + 65_000)[depth]!

    assert.equal([...line].length, 40)
    return [...line.split('running 1m 05s ')[1]!].length
  }

  assert.equal(labelAt(4), 14)
  assert.equal(labelAt(9), 14)
})

test('AC3.7 under 30 columns a long line is cut at the label and the glyph, status and time stay', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text here', at: NOW }))

  assert.equal(renderLines(tree, 28, NOW + 65_000)[1], '└─ ● running 1m 05s Explore…')
})

test('AC3.7 when the status does not fit the reason goes first and the word stays', () => {
  const tree = apply(spawned('a', { name: 'Explorer', at: NOW }), finished('a', 5_000, 'max_tokens_exceeded'))

  assert.equal(renderLines(tree, 24)[1], '└─ ✗ failed 5s Explorer')
  assert.equal(renderLines(tree, 30)[1], '└─ ✗ failed (max_tokens_excee…')
})

test('AC3.7 when the word does not fit either it goes, and the glyph and the time stay', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text', at: NOW }))

  assert.equal(renderLines(tree, 17, NOW + 65_000)[1], '└─ ● 1m 05s Expl…')
})

test('AC3.7 at depth 4 in a 20-column pane the time still shows', () => {
  const tree = apply(...chain(4, { at: NOW }))

  assert.equal(renderLines(tree, 20, NOW + 65_000)[4], '      └─ ● 1m 05s D4')
})

test('AC3.7 where even the connectors would push the time out, the leftmost stems give way', () => {
  const tree = apply(...chain(4, { at: NOW }))
  const line = renderLines(tree, 16, NOW + 3_720_000)[4]!

  assert.equal(line, '     └─ ● 1h 02m')
})

test('AC3.7 a step row is cut with … at the width, the subject first', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: '/very/long/path.ts' }))

  assert.equal(renderLines(tree, 20)[2], '   ↳ Read /very/lon…')
})

test('AC3.7 no row is wider than the pane at any narrow width', () => {
  const tree = apply(
    ...chain(7, { at: NOW, description: 'a description that runs on' }),
    called('d7', 'Bash', { command: 'npm run build --workspaces' }),
    finished('d2', 3_000, 'max_tokens_exceeded'),
  )

  for (let columns = 16; columns < 30; columns += 1) {
    for (const line of renderLines(tree, columns, NOW + 65_000).slice(1)) {
      assert.equal([...line].length <= columns, true, `${columns}: ${line}`)
    }
  }
})

const narrowTree = apply(
  spawned('p', { name: 'planner', description: 'Draft migration plan' }),
  spawned('e', { name: 'explorer', parentAgentId: 'p' }),
  spawned('r', { name: 'reviewer', parentAgentId: 'p' }),
  spawned('t', { name: 'tester' }),
  spawned('d', { name: 'docs' }),
  finished('e', 1_000),
  finished('t', 1_000, 'error'),
  { type: 'turn.complete', agentId: 'd', reason: 'aborted' },
)

test('AC3.7 under 16 columns each row is the connector and the glyph, then a blank row and a widen hint', () => {
  assert.deepEqual(renderLines(narrowTree, 14), [
    'Main',
    '├─ ●',
    '│ ├─ ✓',
    '│ └─ ●',
    '├─ ✗',
    '└─ ⊘',
    '',
    'widen terminal',
  ])
})

test('AC3.7 glyph-only rows leave out the current tool', () => {
  const tree = applyEvent(narrowTree, called('r', 'Read', { file_path: 'a.ts' }))

  assert.deepEqual(renderLines(tree, 14), renderLines(narrowTree, 14))
})

test('AC3.7 the widen hint is cut to the width, not wrapped', () => {
  assert.equal(renderLines(narrowTree, 10).at(-1), 'widen ter…')
})

test('AC3.7 16 columns is still narrow, 15 is glyph-only', () => {
  assert.equal(renderLines(narrowTree, 16)[1], '├─ ● running pl…')
  assert.equal(renderLines(narrowTree, 15)[1], '├─ ●')
})

test('AC3.7 the empty state has no rows to shrink, so it gets no widen hint', () => {
  assert.deepEqual(renderLines(emptyTree, 10), ['Main', EMPTY_HINT])
})

test('AC3.4 at 24 agents nothing is summarised and there is no footer', () => {
  const tree = apply(...finishAll(flat(24, 'a')))
  const lines = renderLines(tree, WIDE)

  assert.equal(lines.length, 25)
  assert.equal(lines.some(line => /showing|\d+ done/.test(line)), false)
})

test('AC3.4 pending completions do not count toward the 24', () => {
  const tree = apply(...flat(24, 'a'), finished('ghost', 1_000))

  assert.equal(tree.pendingCompletions.length, 1)
  assert.equal(renderLines(tree, WIDE).length, 25)
})

test('AC3.4 above 24 agents, finished siblings under one parent become one ✓ N done row and the footer counts', () => {
  const tree = apply(...finishAll(flat(25, 'a')))

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '└─ ✓ 25 done', '', 'showing 0 of 25'])
})

test('AC3.4 running and failed nodes stay, finished siblings fold at every level', () => {
  const tree = apply(
    spawned('p', { name: 'P' }),
    ...finishAll(flat(10, 'e')),
    ...finishAll(Array.from({ length: 12 }, (_, i) => spawned(`k${i}`, { name: `K${i}`, parentAgentId: 'p' }))),
    spawned('r', { name: 'R', parentAgentId: 'p' }),
    spawned('f', { name: 'F' }),
    finished('f', 1_000, 'error'),
    spawned('g', { name: 'G' }),
  )

  assert.deepEqual(renderLines(tree, WIDE), [
    'Main',
    '├─ ✓ 10 done',
    '├─ ● running P',
    '│ ├─ ✓ 12 done',
    '│ └─ ● running R',
    '├─ ✗ failed (error) 1s F',
    '└─ ● running G',
    '',
    'showing 4 of 26',
  ])
})

for (const reason of ['error', 'aborted']) {
  test(`AC3.4 a finished subtree with a ${reason} node keeps that node and the finished ancestors above it`, () => {
    const tree = apply(
      ...finishAll(flat(24, 'a')),
      ...finishAll([
        spawned('x', { name: 'X' }),
        spawned('y', { name: 'Y', parentAgentId: 'x' }),
        spawned('w', { name: 'W', parentAgentId: 'x' }),
      ]),
      spawned('z', { name: 'Z', parentAgentId: 'x' }),
      finished('z', 1_000, reason),
    )

    assert.deepEqual(renderLines(tree, WIDE), [
      'Main',
      '├─ ✓ 24 done',
      '└─ ✓ done 1s X',
      '  ├─ ✓ 2 done',
      `  └─ ${reason === 'error' ? '✗ failed (error)' : '⊘ aborted'} 1s Z`,
      '',
      'showing 2 of 28',
    ])
  })
}

test('AC3.4 a finished node with a running descendant is never folded', () => {
  const tree = apply(
    ...finishAll(flat(23, 'a')),
    spawned('p', { name: 'P' }),
    spawned('c', { name: 'C', parentAgentId: 'p' }),
    finished('p', 1_000),
  )

  assert.deepEqual(renderLines(tree, WIDE), [
    'Main',
    '├─ ✓ 23 done',
    '└─ ✓ done 1s P',
    '  └─ ● running C',
    '',
    'showing 2 of 25',
  ])
})

test('AC3.4 a folded subtree counts its descendants, and the rest are all drawn', () => {
  const tree = apply(
    ...finishAll([spawned('a', { name: 'A' }), spawned('b', { name: 'B', parentAgentId: 'a' }), spawned('c', { name: 'C', parentAgentId: 'a' })]),
    ...flat(22, 'r'),
  )
  const lines = renderLines(tree, WIDE)

  assert.equal(lines[1], '├─ ✓ 3 done')
  assert.equal(lines.length, 1 + 1 + 22 + 2)
  assert.equal(lines.at(-1), 'showing 22 of 25')
})

test('AC3.4 the summary and the footer are cut to the width, and a narrow pane still gets both', () => {
  const tree = apply(...finishAll(flat(25, 'a')))

  assert.deepEqual(renderLines(tree, 14), ['Main', '└─ ✓ 25 done', '', 'showing 0 of …', '', 'widen terminal'])
})

test('AC3.4 a summary row below the depth cap carries the same …N prefix', () => {
  const children = Array.from({ length: 20 }, (_, i) => spawned(`k${i}`, { name: `K${i}`, parentAgentId: 'd5' }))
  const tree = apply(...chain(5), ...finishAll(children))
  const lines = renderLines(tree, WIDE)

  assert.equal(lines[6], '    …2└─ ✓ 20 done')
  assert.equal(lines.at(-1), 'showing 5 of 25')
})

test('AC3.8 the same tree drawn at several widths in a row gives each width its own result', () => {
  const tree = apply(
    ...chain(6, { at: NOW, description: 'a description that runs on' }),
    ...finishAll(flat(20, 'k')),
    called('d6', 'Bash', { command: 'npm run build --workspaces' }),
  )
  const snapshot = structuredClone(tree)
  const widths = [80, 20, 12, 80, 40, 16, 29, 30, 80]

  const inSequence = widths.map(columns => renderLines(tree, columns, NOW + 65_000))
  const fresh = widths.map(columns => renderLines(structuredClone(tree), columns, NOW + 65_000))

  assert.deepEqual(inSequence, fresh)
  assert.deepEqual(inSequence[0], inSequence[3])
  assert.deepEqual(inSequence[0], inSequence[8])
  assert.notDeepEqual(inSequence[0], inSequence[1])
  assert.deepEqual(tree, snapshot)
})

const asciiLines = (tree: Parameters<typeof renderAt>[0], columns: number, now = NOW) => renderAt(tree, columns, now, true)

test('AC5.4 the rows of the ASCII drawing, at 40 columns, are exactly as drawn', () => {
  const tree = apply(
    { type: 'session.ended', reason: 'clear', at: NOW },
    spawned('p', { name: 'planner', description: 'Draft migration plan', at: NOW + 11_000 }),
    spawned('e', { name: 'explorer', description: 'Find leftovers', parentAgentId: 'p', at: NOW }),
    spawned('r', { name: 'reviewer', description: 'Check the diff', parentAgentId: 'p', at: NOW + 112_000 }),
    spawned('t', { name: 'tester', description: 'Run the test suite' }),
    spawned('d', { name: 'docs', description: 'Update README and docs' }),
    stepped('p'),
    called('r', 'Read', { file_path: 'src/app.ts' }),
    finished('e', 72_000),
    finished('t', 48_000, 'exit 1'),
    finished('d', 12_000, 'aborted'),
  )
  const lines = asciiLines(tree, 40, NOW + 242_000)

  assert.deepEqual(lines, [
    'Main 4m 02s',
    '|-- * running 3m 51s planner: Draft m...',
    '|   -> thinking',
    '|  |-- v done 1m 12s explorer: Find l...',
    '|  `-- * running 2m 10s reviewer: Che...',
    '|      -> Read src/app.ts',
    '|-- x failed (exit 1) 48s tester: Run...',
    '`-- - aborted 12s docs: Update README...',
  ])
  for (const line of lines.slice(1)) assert.equal([...line].length <= 40, true, line)
})

test('AC5.4 the done summary row and the footer in ASCII', () => {
  const alone = apply(...finishAll(flat(25, 'a')))
  const beside = apply(...finishAll(flat(20, 'a')), ...flat(5, 'r'))

  assert.deepEqual(asciiLines(alone, WIDE), ['Main', '`-- v 25 done', '', 'showing 0 of 25'])
  assert.deepEqual(asciiLines(beside, WIDE).slice(0, 3), ['Main', '|-- v 20 done', '|-- * running r1'])
  assert.equal(asciiLines(beside, WIDE).at(-1), 'showing 5 of 25')
})

test('AC5.4 each level takes 3 columns, the last sibling continues blank and the others with |', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    spawned('c', { name: 'C', parentAgentId: 'b' }),
    spawned('d', { name: 'D' }),
  )

  assert.deepEqual(asciiLines(tree, WIDE).slice(1), [
    '|-- * running A',
    '|  `-- * running B',
    '|     `-- * running C',
    '`-- * running D',
  ])
})

test('AC5.4 the depth marker is ...N in place of the last stems, and the connector stays put', () => {
  const lines = asciiLines(apply(...chain(14)), WIDE)
  const connectorColumn = (line: string) => [...line].findIndex(char => char === '`')

  assert.equal(lines[5], '     ...1`-- * running D5')
  assert.equal(lines[6], '     ...2`-- * running D6')
  assert.equal(lines[14], '    ...10`-- * running D14')
  for (const line of lines.slice(4)) assert.equal(connectorColumn(line), 9)
})

test('AC5.4 a running node with its time keeps 10 label columns at depth 4 and at depth 9 in a 40-column pane', () => {
  const events = chain(9, { at: NOW, description: 'a long description that is cut' })
  const labelAt = (depth: number) => {
    const line = asciiLines(apply(...events), 40, NOW + 65_000)[depth]!

    assert.equal([...line].length, 40)
    return [...line.split('running 1m 05s ')[1]!].length
  }

  assert.equal(labelAt(4), 10)
  assert.equal(labelAt(9), 10)
})

test('AC5.4 a long line is cut to the width with three dots, the status staying visible', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'a very long description' }))
  const [, line] = asciiLines(tree, 24)

  assert.equal(line, '`-- * running Explore...')
  assert.equal([...line!].length, 24)
})

test('AC5.4 narrow rows use the ASCII glyphs and cut with three dots', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text here', at: NOW }))

  assert.equal(asciiLines(tree, 28, NOW + 65_000)[1], '`-- * running 1m 05s Expl...')
})

test('AC5.4 under 16 columns each row is the connector and the ASCII glyph, then a blank row and a widen hint', () => {
  assert.deepEqual(asciiLines(narrowTree, 14), [
    'Main',
    '|-- *',
    '|  |-- v',
    '|  `-- *',
    '|-- x',
    '`-- -',
    '',
    'widen terminal',
  ])
  assert.equal(asciiLines(narrowTree, 10).at(-1), 'widen t...')
})

test('AC5.4 the summary and the footer are cut with three dots, and a narrow pane still gets both', () => {
  const tree = apply(...finishAll(flat(25, 'a')))

  assert.deepEqual(asciiLines(tree, 14), ['Main', '`-- v 25 done', '', 'showing 0 o...', '', 'widen terminal'])
})

test('AC5.4 a step row uses -> and is cut with three dots at the width', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: '/very/long/path.ts' }))

  assert.equal(asciiLines(tree, 20)[2], '    -> Read /very...')
})

test('AC5.4 the … that cuts a long tool input is drawn as three dots', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Bash', { command: 'x'.repeat(100) }))
  const row = asciiLines(tree, WIDE)[2]!

  assert.equal(row, `    -> Bash ${'x'.repeat(59)}...`)
})

test('AC5.4 no ASCII row is wider than the pane at any width from 3 up', () => {
  const tree = apply(
    ...chain(6, { at: NOW, description: 'a description that runs on' }),
    ...finishAll(flat(20, 'k')),
    called('d6', 'Bash', { command: 'npm run build --workspaces' }),
  )

  for (let columns = 3; columns <= 60; columns += 1) {
    for (const line of asciiLines(tree, columns, NOW + 65_000).slice(1)) {
      assert.equal([...line].length <= columns, true, `${columns}: ${line}`)
    }
  }
})

const LOCALES: [string, [string | undefined, string | undefined, string | undefined], boolean][] = [
  ['LANG=C', [undefined, undefined, 'C'], true],
  ['LANG=POSIX', [undefined, undefined, 'POSIX'], true],
  ['LC_ALL=C over LANG=en_AU.UTF-8', ['C', undefined, 'en_AU.UTF-8'], true],
  ['LC_ALL=en_US.UTF-8 over LANG=C', ['en_US.UTF-8', undefined, 'C'], false],
  ['LC_CTYPE=C over LANG=en_AU.UTF-8', [undefined, 'C', 'en_AU.UTF-8'], true],
  ['LC_CTYPE=en_AU.UTF-8 over LANG=C', [undefined, 'en_AU.UTF-8', 'C'], false],
  ['LC_ALL=C over LC_CTYPE=en_AU.UTF-8', ['C', 'en_AU.UTF-8', undefined], true],
  ['the utf8 spelling', [undefined, undefined, 'en_AU.utf8'], false],
  ['the utf-8 spelling in lower case', [undefined, undefined, 'en_AU.utf-8'], false],
  ['mixed case', [undefined, undefined, 'en_AU.Utf-8'], false],
  ['upper case UTF8', [undefined, undefined, 'EN_AU.UTF8'], false],
  ['all three unset', [undefined, undefined, undefined], false],
  ['all three empty', ['', '', ''], false],
  ['an empty LC_ALL falls through to LANG=C', ['', undefined, 'C'], true],
  ['an empty LC_ALL and LC_CTYPE fall through to a UTF-8 LANG', ['', '', 'en_AU.UTF-8'], false],
  ['an empty LANG alone', [undefined, undefined, ''], false],
]

for (const [label, [lcAll, lcCtype, lang], expected] of LOCALES) {
  test(`AC5.4 locale ${label} is ${expected ? 'ASCII' : 'Unicode'}`, () => {
    assert.equal(isAsciiLocale(lcAll, lcCtype, lang), expected)
  })
}

test('AC5.4 every plugin-drawn character is ASCII, at wide, narrow and glyph-only widths', () => {
  const tree = apply(
    ...chain(6, { at: NOW }),
    ...finishAll(flat(20, 'k')),
    spawned('f', { name: 'F' }),
    spawned('x', { name: 'X' }),
    finished('f', 1_000, 'error'),
    finished('x', 1_000, 'aborted'),
    called('d6', 'Bash', { command: 'x'.repeat(100) }),
  )

  for (const columns of [80, 40, 28, 14]) {
    assert.match(asciiLines(tree, columns, NOW + 65_000).join('\n'), /^[\x00-\x7f]*$/, `${columns}`)
  }
})

const rowsOf = (tree: Parameters<typeof renderAt>[0], columns: number, now = NOW, isAscii = false) =>
  rowsAt(tree, columns, now, isAscii)

const piece = (role: Role, text: string) => ({ role, text })

const STATUS_ROWS: [string, TreeEvent[], ReturnType<typeof piece>[]][] = [
  ['running', [spawned('a', { name: 'A' })], [piece('dim', '└─ '), piece('running', '● running'), piece('plain', ' A')]],
  [
    'done',
    [spawned('a', { name: 'A' }), finished('a', 5_000)],
    [piece('dim', '└─ '), piece('done', '✓ done'), piece('plain', ' 5s A')],
  ],
  [
    'failed',
    [spawned('a', { name: 'A' }), finished('a', 5_000, 'error')],
    [piece('dim', '└─ '), piece('failed', '✗ failed (error)'), piece('plain', ' 5s A')],
  ],
  [
    'aborted',
    [spawned('a', { name: 'A' }), finished('a', 5_000, 'aborted')],
    [piece('dim', '└─ '), piece('aborted', '⊘ aborted'), piece('plain', ' 5s A')],
  ],
]

for (const [status, events, pieces] of STATUS_ROWS) {
  test(`ROLE a ${status} row is the connector dim, the glyph and word (and reason) ${status}, the time and label plain`, () => {
    assert.deepEqual(rowsOf(apply(...events), WIDE)[1], pieces)
  })
}

test('ROLE Main and its time are plain, the empty-state hint is dim', () => {
  assert.deepEqual(rowsOf(emptyTree, WIDE), [[piece('plain', 'Main')], [piece('dim', EMPTY_HINT)]])
  assert.deepEqual(rowsOf(apply({ type: 'session.ended', reason: 'clear', at: NOW }), WIDE, NOW + 65_000)[0], [piece('plain', 'Main 1m 05s')])
})

test('ROLE stems and step rows are dim, the status piece sits between the connector and the label', () => {
  const tree = apply(
    spawned('a', { name: 'A' }),
    spawned('b', { name: 'B', parentAgentId: 'a' }),
    spawned('c', { name: 'C' }),
    called('a', 'Read', { file_path: 'a.ts' }),
  )

  assert.deepEqual(rowsOf(tree, WIDE).slice(1), [
    [piece('dim', '├─ '), piece('running', '● running'), piece('plain', ' A')],
    [piece('dim', '│  ↳ Read a.ts')],
    [piece('dim', '│ └─ '), piece('running', '● running'), piece('plain', ' B')],
    [piece('dim', '└─ '), piece('running', '● running'), piece('plain', ' C')],
  ])
})

test('ROLE the …N depth marker is dim with the connector', () => {
  assert.deepEqual(rowsOf(apply(...chain(5)), WIDE)[5], [
    piece('dim', '    …1└─ '),
    piece('running', '● running'),
    piece('plain', ' D5'),
  ])
})

test('ROLE the done summary row and the footer are dim, the blank row between has no pieces', () => {
  assert.deepEqual(rowsOf(apply(...finishAll(flat(25, 'a'))), WIDE), [
    [piece('plain', 'Main')],
    [piece('dim', '└─ ✓ 25 done')],
    [],
    [piece('dim', 'showing 0 of 25')],
  ])
})

test('ROLE a failed row stays failed beside a summary row once the tree overflows', () => {
  const tree = apply(...finishAll(flat(24, 'e')), spawned('f', { name: 'F' }), finished('f', 1_000, 'error'))

  assert.deepEqual(rowsOf(tree, WIDE).slice(1), [
    [piece('dim', '├─ ✓ 24 done')],
    [piece('dim', '└─ '), piece('failed', '✗ failed (error)'), piece('plain', ' 1s F')],
    [],
    [piece('dim', 'showing 1 of 25')],
  ])
})

test('ROLE a cut inside the reason keeps the … in the status colour', () => {
  const tree = apply(spawned('a', { name: 'Explorer' }), finished('a', 5_000, 'max_tokens_exceeded'))

  assert.deepEqual(rowsOf(tree, 30)[1], [piece('dim', '└─ '), piece('failed', '✗ failed (max_tokens_excee…')])
})

test('ROLE a cut inside the label keeps the … plain, and narrow drops the reason out of the status piece', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text', at: NOW }), finished('a', 5_000, 'max_tokens_exceeded'))

  assert.deepEqual(rowsOf(tree, 24)[1], [piece('dim', '└─ '), piece('failed', '✗ failed'), piece('plain', ' 5s Explorer…')])
  assert.deepEqual(rowsOf(apply(spawned('a', { name: 'Explorer', description: 'a very long description' })), 24)[1], [
    piece('dim', '└─ '),
    piece('running', '● running'),
    piece('plain', ' Explorer: …'),
  ])
})

test('ROLE when the word is dropped the glyph keeps the status colour', () => {
  const tree = apply(spawned('a', { name: 'Explorer', description: 'long text', at: NOW }))

  assert.deepEqual(rowsOf(tree, 17, NOW + 65_000)[1], [piece('dim', '└─ '), piece('running', '●'), piece('plain', ' 1m 05s Expl…')])
})

test('ROLE a step row cut with … stays dim', () => {
  const tree = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: '/very/long/path.ts' }))

  assert.deepEqual(rowsOf(tree, 20)[2], [piece('dim', '   ↳ Read /very/lon…')])
})

test('ROLE glyph-only rows are a dim connector and a glyph in its status colour, then a blank row and a dim hint', () => {
  assert.deepEqual(rowsOf(narrowTree, 14), [
    [piece('plain', 'Main')],
    [piece('dim', '├─ '), piece('running', '●')],
    [piece('dim', '│ ├─ '), piece('done', '✓')],
    [piece('dim', '│ └─ '), piece('running', '●')],
    [piece('dim', '├─ '), piece('failed', '✗')],
    [piece('dim', '└─ '), piece('aborted', '⊘')],
    [],
    [piece('dim', 'widen terminal')],
  ])
  assert.deepEqual(rowsOf(narrowTree, 10).at(-1), [piece('dim', 'widen ter…')])
})

test('ROLE a glyph-only row cut through its connector keeps the glyph coloured', () => {
  const tree = apply(spawned('a', { name: 'A' }))

  assert.deepEqual(rowsOf(tree, 3)[1], [piece('dim', '─ '), piece('running', '●')])
})

test('ROLE where the leftmost stems give way the stems stay dim and the time plain', () => {
  const tree = apply(...chain(4, { at: NOW }))

  assert.deepEqual(rowsOf(tree, 16, NOW + 3_720_000)[4], [
    piece('dim', '     └─ '),
    piece('running', '●'),
    piece('plain', ' 1h 02m'),
  ])
})

test('ROLE the ASCII drawing carries the same roles through a cut with three dots', () => {
  const failed = apply(spawned('t', { name: 'tester', description: 'Run the test suite' }), finished('t', 48_000, 'exit 1'))
  const stepping = apply(spawned('a', { name: 'A' }), called('a', 'Read', { file_path: '/very/long/path.ts' }))

  assert.deepEqual(rowsOf(failed, 40, NOW, true)[1], [
    piece('dim', '`-- '),
    piece('failed', 'x failed (exit 1)'),
    piece('plain', ' 48s tester: Run...'),
  ])
  assert.deepEqual(rowsOf(stepping, 20, NOW, true)[2], [piece('dim', '    -> Read /very...')])
  assert.deepEqual(rowsOf(narrowTree, 14, NOW, true)[2], [piece('dim', '|  |-- '), piece('done', 'v')])
})

test('ROLE every row at every width has no empty piece and no two neighbours of one role, and joins to the plain line', () => {
  const tree = apply(
    ...chain(6, { at: NOW, description: 'a description that runs on' }),
    ...finishAll(flat(20, 'k')),
    spawned('f', { name: 'F', at: NOW }),
    spawned('x', { name: 'X' }),
    finished('f', 1_000, 'max_tokens_exceeded'),
    finished('x', 1_000, 'aborted'),
    called('d6', 'Bash', { command: 'npm run build --workspaces' }),
  )

  for (const isAscii of [false, true]) {
    for (let columns = 3; columns <= 80; columns += 1) {
      const rows = rowsOf(tree, columns, NOW + 65_000, isAscii)

      assert.deepEqual(
        rows.map(row => row.map(({ text }) => text).join('')),
        renderAt(tree, columns, NOW + 65_000, isAscii),
        `${columns}`,
      )
      for (const row of rows) {
        row.forEach((segment, index) => {
          assert.notEqual(segment.text, '', `${columns}: empty piece`)
          assert.notEqual(segment.role, row[index - 1]?.role, `${columns}: ${segment.text}`)
        })
      }
    }
  }
})

test('AC-X1 close says the pane was closed when it was open', () => {
  assert.deepEqual(closeOutput(true), { text: 'Closed the agents pane.' })
})

test('AC-X2 close says the pane is not open when it was not', () => {
  assert.deepEqual(closeOutput(false), { text: 'The agents pane is not open.' })
})

const ADVISOR_INPUT = 'SECRET-PROMPT-hunter2-do-not-show'
const AT = NOW + 13_000

const serverUse = (id: string, rest: Partial<TurnStepServerToolUse> = {}): TurnStepServerToolUse => ({
  id,
  name: 'advisor',
  input: { question: ADVISOR_INPUT },
  startedAt: NOW,
  endedAt: NOW + 12_000,
  ...rest,
})

const consulted = (id: string, rest: Partial<Extract<TreeEvent, { type: 'advisor.consulted' }>> = {}): TreeEvent => ({
  type: 'advisor.consulted',
  id,
  agentId: undefined,
  startedAt: NOW,
  endedAt: NOW + 12_000,
  at: AT,
  ...rest,
})

test('AC-A1 a main-loop advisor call becomes one event with no agent', () => {
  assert.deepEqual(advisorEvents([serverUse('s1')], undefined, AT), [consulted('s1')])
})

test('AC-A1 a subagent loop is named on the event', () => {
  assert.deepEqual(advisorEvents([serverUse('s1')], 'sub1', AT), [consulted('s1', { agentId: 'sub1' })])
})

test('AC-A1 only the advisor is taken from the server tool uses', () => {
  assert.deepEqual(advisorEvents([serverUse('w1', { name: 'web_search' }), serverUse('s1')], undefined, AT), [consulted('s1')])
})

test('AC-A1 a step with no server tool uses gives no events', () => {
  assert.deepEqual(advisorEvents(undefined, undefined, AT), [])
  assert.deepEqual(advisorEvents([], 'sub1', AT), [])
})

test('AC-A1 several consults give one event each, in order, with their own times', () => {
  const second = { startedAt: NOW + 20_000, endedAt: NOW + 25_000 }

  assert.deepEqual(advisorEvents([serverUse('s1'), serverUse('s2', second)], undefined, AT), [consulted('s1'), consulted('s2', second)])
})

test('AC-A1 a call the response ended before the result of has no end on its event', () => {
  assert.deepEqual(advisorEvents([serverUse('s1', { endedAt: undefined })], undefined, AT), [consulted('s1', { endedAt: undefined })])
})

test('AC-A2 the advisor input is in no event, no tree and no drawn row', () => {
  const events = advisorEvents([serverUse('s1')], 'sub1', AT)
  const tree = apply(spawned('sub1', { name: 'A' }), ...events)

  assert.equal(events.length, 1)
  assert.equal(tree.nodes.length, 2)
  for (const shown of [JSON.stringify(events), JSON.stringify(tree), renderLines(tree, WIDE).join('\n'), asciiLines(tree, WIDE).join('\n')]) {
    assert.equal(shown.includes(ADVISOR_INPUT), false)
    assert.equal(shown.includes('question'), false)
  }
})

test('AC-A3 a main-loop advisor call is a done node under Main, frozen at its own duration', () => {
  const tree = apply(consulted('s1'))

  assert.deepEqual(renderLines(tree, WIDE, NOW + 999_000), ['Main', '└─ ✓ done 12s ♛ advisor'])
  assert.deepEqual(renderLines(tree, WIDE, NOW + 5_000), ['Main', '└─ ✓ done 12s ♛ advisor'])
})

test('AC-A3 a subagent advisor call is a node under that subagent', () => {
  const tree = apply(
    spawned('a', { name: 'A', at: NOW }),
    spawned('b', { name: 'B' }),
    consulted('s1', { agentId: 'a', startedAt: NOW + 1_000, endedAt: NOW + 4_000 }),
  )

  assert.deepEqual(renderLines(tree, WIDE, NOW + 5_000).slice(1), [
    '├─ ● running 5s A',
    '│ └─ ✓ done 3s ♛ advisor',
    '└─ ● running B',
  ])
})

test('AC-A3 a call with no end is an aborted node, timed to when the step reported it', () => {
  const tree = apply(consulted('s1', { endedAt: undefined, startedAt: NOW, at: NOW + 7_000 }))

  assert.deepEqual(renderLines(tree, WIDE, NOW + 999_000), ['Main', '└─ ⊘ aborted 7s ♛ advisor'])
})

test('AC-A4 the same id seen again replaces its node in place, so a node is never doubled', () => {
  const tree = apply(
    consulted('s1', { endedAt: undefined, at: NOW + 7_000 }),
    consulted('s2', { startedAt: NOW + 20_000, endedAt: NOW + 25_000 }),
    consulted('s1'),
  )

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '├─ ✓ done 12s ♛ advisor', '└─ ✓ done 5s ♛ advisor'])
})

test('AC-A4 several consults in one loop each get their own node', () => {
  const tree = apply(consulted('s1'), consulted('s2', { startedAt: NOW + 20_000, endedAt: NOW + 25_000 }))

  assert.deepEqual(renderLines(tree, WIDE).slice(1), ['├─ ✓ done 12s ♛ advisor', '└─ ✓ done 5s ♛ advisor'])
})

test('AC-A5 clear removes finished advisor nodes and keeps the running subagent they sat under', () => {
  const before = apply(spawned('a', { name: 'A' }), consulted('s1', { agentId: 'a' }), consulted('s2'))
  const after = applyEvent(before, cleared)

  assert.equal(before.nodes.length, 3)
  assert.equal(clearFinishedCounted(before).cleared, 2)
  assert.deepEqual(renderLines(after, WIDE), ['Main', '└─ ● running A'])
})

test('AC-A6 an advisor node never runs, so it alone keeps no ticker going', () => {
  const done = apply(consulted('s1'))
  const aborted = apply(consulted('s1', { endedAt: undefined }))

  assert.equal(done.nodes.length, 1)
  assert.equal(aborted.nodes.length, 1)
  assert.equal(hasRunning(done), false)
  assert.equal(hasRunning(aborted), false)
})

test('AC-A6 the ticker follows the running subagent, not the advisor node under it', () => {
  const running = apply(spawned('a', { name: 'A' }), consulted('s1', { agentId: 'a' }))

  assert.equal(running.nodes.length, 2)
  assert.equal(hasRunning(running), true)
  assert.equal(hasRunning(applyEvent(running, finished('a', 1_000))), false)
})

test('AC-A7 an advisor row takes the status colours, and ASCII glyphs in an ASCII locale', () => {
  const done = apply(consulted('s1'))
  const aborted = apply(consulted('s1', { endedAt: undefined, at: NOW + 7_000 }))

  assert.deepEqual(rowsOf(done, WIDE)[1], [piece('dim', '└─ '), piece('done', '✓ done'), piece('plain', ' 12s ♛ advisor')])
  assert.deepEqual(rowsOf(aborted, WIDE)[1], [piece('dim', '└─ '), piece('aborted', '⊘ aborted'), piece('plain', ' 7s ♛ advisor')])
  assert.deepEqual(asciiLines(done, WIDE), ['Main', '`-- v done 12s ^ advisor'])
})

test('AC-A7 an advisor node narrows and folds like any other node', () => {
  const many = apply(...Array.from({ length: 25 }, (_, i) => consulted(`s${i}`)))

  assert.deepEqual(renderLines(apply(consulted('s1')), 14), ['Main', '└─ ✓', '', 'widen terminal'])
  assert.deepEqual(renderLines(many, WIDE), ['Main', '└─ ✓ 25 done', '', 'showing 0 of 25'])
})

test('applying an advisor event does not mutate the tree it was given', () => {
  const before = apply(spawned('a', { name: 'A' }))
  const snapshot = structuredClone(before)
  const after = applyEvent(before, consulted('s1', { agentId: 'a' }))

  assert.equal(after.nodes.length, 2)
  assert.deepEqual(before, snapshot)
})

const started = (at?: number): TreeEvent => ({ type: 'session.started', at })

test('AC-S1 session.started sets the Main start time when it is unset', () => {
  assert.equal(apply(started(NOW)).startedAt, NOW)
})

test('AC-S1 session.started keeps the Main start time it already has', () => {
  assert.equal(apply(started(NOW), started(NOW + 30_000)).startedAt, NOW)
})

test('AC-S2 session.started keeps the nodes', () => {
  const before = apply(spawned('a', { name: 'A', at: NOW }), spawned('b', { name: 'B', parentAgentId: 'a' }), finished('b', 1_000))

  assert.deepEqual(applyEvent(before, started(NOW + 5_000)).nodes, before.nodes)
})

test('AC-S2 session.started keeps the held completions', () => {
  const before = apply(finished('later', 4_000, 'error'))
  const after = applyEvent(before, started(NOW))

  assert.deepEqual(after.pendingCompletions, [{ agentId: 'later', reason: 'error', durationMs: 4_000 }])
  assert.equal(renderLines(applyEvent(after, spawned('later', { name: 'L' })), WIDE)[1], '└─ ✗ failed (error) 4s L')
})

test('AC-S3 applying session.started twice leaves what the first left', () => {
  const once = applyEvent(apply(spawned('a', { name: 'A', at: NOW })), started(NOW + 1_000))

  assert.equal(once.nodes.length, 1)
  assert.deepEqual(applyEvent(once, started(NOW + 9_000)), once)
})

test('AC-S4 a running node survives session.started with its own clock, and the Main clock keeps counting', () => {
  const tree = apply(started(NOW), spawned('a', { name: 'A', at: NOW + 2_000 }), started(NOW + 30_000))

  assert.deepEqual(renderLines(tree, WIDE, NOW + 65_000), ['Main 1m 05s', '└─ ● running 1m 03s A'])
})

test('AC-S4 a finished row stays through session.started', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000), started(NOW + 30_000))

  assert.equal(renderLines(tree, WIDE, NOW + 65_000)[1], '└─ ✓ done 5s A')
})

test('AC-S4 hasRunning is still true after session.started', () => {
  assert.equal(hasRunning(apply(spawned('a', { name: 'A' }), started(NOW))), true)
})

const advisorUnderA = apply(spawned('a', { name: 'A' }), consulted('s1', { agentId: 'a' }))
const advisorNamed = apply(spawned('x', { name: 'advisor', at: NOW }), finished('x', 12_000))

test('AC-K1 an advisor row carries ♛ between the time and the label', () => {
  assert.deepEqual(renderLines(advisorUnderA, WIDE), ['Main', '└─ ● running A', '  └─ ✓ done 12s ♛ advisor'])
})

test('AC-K2 in ASCII the advisor mark is ^', () => {
  assert.deepEqual(asciiLines(advisorUnderA, WIDE), ['Main', '`-- * running A', '   `-- v done 12s ^ advisor'])
})

test('AC-K3 a subagent row carries no mark in either alphabet', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 12_000))

  assert.equal(renderLines(tree, WIDE)[1], '└─ ✓ done 12s A')
  assert.equal(asciiLines(tree, WIDE)[1], '`-- v done 12s A')
})

test('AC-K4 a subagent that happens to be named advisor gets no mark', () => {
  assert.equal(renderLines(advisorNamed, WIDE)[1], '└─ ✓ done 12s advisor')
  assert.equal(asciiLines(advisorNamed, WIDE)[1], '`-- v done 12s advisor')
})

test('AC-K5 the advisor is told by an explicit kind on its node, not by its name', () => {
  assert.equal(advisorUnderA.nodes.find(node => node.agentId === 's1')?.kind, 'advisor')
  assert.equal(advisorNamed.nodes[0]!.kind, undefined)
})

test('AC-K6 the mark is plain, with the time and the label, in both alphabets', () => {
  const done = apply(consulted('s1'))

  assert.deepEqual(rowsOf(done, WIDE)[1], [piece('dim', '└─ '), piece('done', '✓ done'), piece('plain', ' 12s ♛ advisor')])
  assert.deepEqual(rowsOf(done, WIDE, NOW, true)[1], [piece('dim', '`-- '), piece('done', 'v done'), piece('plain', ' 12s ^ advisor')])
})

test('AC-K7 a narrow cut takes the mark with the label, and glyph-only rows have neither', () => {
  const tree = apply(consulted('s1'))

  assert.equal(renderLines(tree, 20)[1], '└─ ✓ done 12s ♛ adv…')
  assert.equal(renderLines(tree, 16)[1], '└─ ✓ done 12s ♛…')
  assert.equal(asciiLines(tree, 20)[1], '`-- v done 12s ^ ...')
  assert.equal(renderLines(tree, 15)[1], '└─ ✓')
})

test('AC-K8 no row with a mark is wider than the pane at any width from 3 up, and ASCII stays ASCII', () => {
  const tree = apply(
    ...chain(4, { at: NOW }),
    consulted('s1', { agentId: 'd4' }),
    consulted('s2', { agentId: 'd2', endedAt: undefined, at: NOW + 7_000 }),
  )

  assert.equal(renderLines(tree, WIDE).filter(line => line.includes('♛')).length, 2)
  assert.equal(asciiLines(tree, WIDE).filter(line => line.includes('^')).length, 2)
  for (let columns = 3; columns <= WIDE; columns += 1) {
    for (const line of [...renderLines(tree, columns, NOW + 65_000).slice(1), ...asciiLines(tree, columns, NOW + 65_000).slice(1)]) {
      assert.equal([...line].length <= columns, true, `${columns}: ${line}`)
    }
    assert.match(asciiLines(tree, columns, NOW + 65_000).join('\n'), /^[\x00-\x7f]*$/, `${columns}`)
  }
})

test('AC-K9 an advisor row that is not done stays through the overflow fold with its mark', () => {
  const tree = apply(
    ...Array.from({ length: 24 }, (_, i) => consulted(`s${i}`)),
    consulted('late', { endedAt: undefined, at: NOW + 7_000 }),
  )

  assert.deepEqual(renderLines(tree, WIDE), ['Main', '├─ ✓ 24 done', '└─ ⊘ aborted 7s ♛ advisor', '', 'showing 1 of 25'])
  assert.deepEqual(asciiLines(tree, WIDE), ['Main', '|-- v 24 done', '`-- - aborted 7s ^ advisor', '', 'showing 1 of 25'])
})

test('session.started does not mutate the tree it was given', () => {
  const before = apply(spawned('a', { name: 'A' }))
  const snapshot = structuredClone(before)

  applyEvent(before, started(NOW))

  assert.deepEqual(before, snapshot)
})

const PLANNER = 'agent_planner'
const EXPLORER = 'agent_explorer'
const REVIEWER = 'agent_7f3a9c21'
const LINT = 'agent_b410e5d2'
const ADVISOR_NODE = 'srvtoolu_01Ab9xKq'
const REVIEWER_DESCRIPTION = 'Check the migration plan against the current schema and list breaking changes.'
const LINT_DESCRIPTION = 'Fix style errors across the project and report what changed.'
const BOARD_NOW = NOW + 242_000
const CLEARED_AT_NOW: TreeEvent = { type: 'session.ended', reason: 'clear', at: NOW }

const board = apply(
  CLEARED_AT_NOW,
  spawned(PLANNER, { name: 'planner', description: 'Draft migration plan', at: NOW + 11_000 }),
  spawned(EXPLORER, { name: 'explorer', description: 'Find logging calls', parentAgentId: PLANNER, at: NOW }),
  spawned(REVIEWER, { name: 'reviewer', description: REVIEWER_DESCRIPTION, parentAgentId: PLANNER, at: NOW + 112_000 }),
  spawned(LINT, { name: 'lint', description: LINT_DESCRIPTION, at: NOW }),
  stepped(PLANNER),
  called(REVIEWER, 'Read', { file_path: 'src/app.ts' }),
  finished(EXPLORER, 72_000),
  finished(LINT, 48_000, 'exit 1'),
  consulted(ADVISOR_NODE),
)

const narrowBoard = apply(
  CLEARED_AT_NOW,
  spawned('agent_api', { name: 'api', description: 'Draft migration plan', at: NOW + 191_000 }),
  spawned(LINT, { name: 'lint', description: LINT_DESCRIPTION, at: NOW }),
  stepped('agent_api'),
  finished(LINT, 48_000, 'exit 1'),
  consulted(ADVISOR_NODE),
)

type Tree = Parameters<typeof renderAt>[0]

const textOfRow = (line: { text: string }[]) => line.map(({ text }) => text).join('')

const paneAt = (tree: Tree, columns: number, selectedId: string | undefined, now = BOARD_NOW, ascii = false) =>
  renderPane(tree, columns, now, ascii, selectedId)

const paneLines = (tree: Tree, columns: number, selectedId: string | undefined, now = BOARD_NOW, ascii = false) =>
  paneAt(tree, columns, selectedId, now, ascii).map(({ row }) => textOfRow(row))

const nodeOf = (tree: Tree, agentId: string): AgentNode => tree.nodes.find(node => node.agentId === agentId)!

const detailLines = (node: AgentNode, parentLabel: string, columns: number, now = BOARD_NOW, ascii = false) =>
  detailRows(node, parentLabel, now, columns, ascii).map(textOfRow)

const RULE_40 = '─'.repeat(40)
const HINT_NONE = ['Click an agent to see its details.', 'Keys: ctrl+x tab, then Tab, Enter.']
const HINT_SELECTED = 'Tab next row  Enter show  esc back'

const BOARD_TREE_UNSELECTED = [
  'Main 4m 02s',
  '  ├─ ● running 3m 51s planner: Draft mi…',
  '  │  ↳ thinking',
  '  │ ├─ ✓ done 1m 12s explorer: Find log…',
  '  │ └─ ● running 2m 10s reviewer: Check…',
  '  │    ↳ Read src/app.ts',
  '  ├─ ✗ failed (exit 1) 48s lint: Fix st…',
  '  └─ ✓ done 12s ♛ advisor',
]

const withMarkerOn = (lines: string[], index: number) =>
  lines.map((line, i) => (i === index ? `› ${line.slice(2)}` : line))

test('SEL wrapText wraps at word boundaries, the way the description in the drawing breaks', () => {
  assert.deepEqual(wrapText(REVIEWER_DESCRIPTION, 40), [
    'Check the migration plan against the',
    'current schema and list breaking',
    'changes.',
  ])
})

test('SEL wrapText leaves a text that fits as one line, and gives no line for no text', () => {
  assert.deepEqual(wrapText('Fix the build', 40), ['Fix the build'])
  assert.deepEqual(wrapText('', 40), [])
  assert.deepEqual(wrapText('   ', 40), [])
})

test('SEL wrapText fills a line up to the width exactly', () => {
  assert.deepEqual(wrapText('abcd efgh ij', 9), ['abcd efgh', 'ij'])
  assert.deepEqual(wrapText('abcd efgh ij', 8), ['abcd', 'efgh ij'])
})

test('SEL wrapText hard-wraps a word longer than the width, and the rest of it can share a line', () => {
  assert.deepEqual(wrapText('abcdefghij', 4), ['abcd', 'efgh', 'ij'])
  assert.deepEqual(wrapText('ab abcdefghij c', 4), ['ab', 'abcd', 'efgh', 'ij c'])
})

test('SEL wrapText collapses whitespace runs and newlines into one space', () => {
  assert.deepEqual(wrapText('find\nthe  bug', 40), ['find the bug'])
})

test('SEL wrapText never adds an ellipsis, loses a letter, or leaves a line wider than the width', () => {
  const text = 'Run npm run build --workspaces, then check supercalifragilisticexpialidocious output'

  for (let width = 1; width <= 30; width += 1) {
    const lines = wrapText(text, width)

    assert.notEqual(lines.length, 0, `${width}`)
    assert.equal(lines.join('').replaceAll(' ', ''), text.replaceAll(' ', ''), `${width}`)
    for (const line of lines) {
      assert.equal([...line].length <= width, true, `${width}: ${line}`)
      assert.match(line, /^[\x00-\x7f]*$/, `${width}: ${line}`)
    }
  }
})

test('SEL wrapText counts characters, not UTF-16 units', () => {
  assert.deepEqual(wrapText('♛♛♛♛♛', 2), ['♛♛', '♛♛', '♛'])
})

test('SEL wrapText with a width of zero still ends, one character a line', () => {
  assert.deepEqual(wrapText('abc', 0), ['a', 'b', 'c'])
})

test('SEL detailRows lays out the running reviewer as drawn in 8b, from the name to the description', () => {
  assert.deepEqual(detailLines(nodeOf(board, REVIEWER), 'planner', 40), [
    'reviewer',
    'Kind     subagent',
    'Status   ● running',
    'Elapsed  2m 10s',
    'Step     Read src/app.ts',
    'Parent   planner',
    'Id       agent_7f3a9c21',
    '',
    'Description',
    'Check the migration plan against the',
    'current schema and list breaking',
    'changes.',
  ])
})

test('SEL detailRows leaves out Step when the agent has none, and Description when it has none', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000))

  assert.deepEqual(detailLines(nodeOf(tree, 'a'), 'Main', 40), [
    'A',
    'Kind     subagent',
    'Status   ✓ done',
    'Elapsed  5s',
    'Parent   Main',
    'Id       a',
  ])
})

test('SEL detailRows names the agent by its name, then its type, then "agent"', () => {
  const tree = apply(spawned('a', { subagentType: 'Explore' }), spawned('b', {}))

  assert.equal(detailLines(nodeOf(tree, 'a'), 'Main', 40)[0], 'Explore')
  assert.equal(detailLines(nodeOf(tree, 'b'), 'Main', 40)[0], 'agent')
})

test('SEL detailRows takes Parent from the label it is given', () => {
  assert.equal(detailLines(nodeOf(board, EXPLORER), 'a parent label', 40).at(4), 'Parent   a parent label')
})

test('SEL detailRows draws the failed reason in the status line, in the error role, with the time frozen', () => {
  const rows = detailRows(nodeOf(board, LINT), 'Main', BOARD_NOW + 999_000, 40, false)

  assert.deepEqual(rows.map(textOfRow).slice(0, 4), ['lint', 'Kind     subagent', 'Status   ✗ failed (exit 1)', 'Elapsed  48s'])
  assert.deepEqual(rows[2], [piece('dim', 'Status   '), piece('failed', '✗ failed (exit 1)')])
})

test('SEL detailRows roles: the name is a title, field names are dim, values plain, description plain', () => {
  const rows = detailRows(nodeOf(board, REVIEWER), 'planner', BOARD_NOW, 40, false)

  assert.deepEqual(rows[0], [piece('title', 'reviewer')])
  assert.deepEqual(rows[1], [piece('dim', 'Kind     '), piece('plain', 'subagent')])
  assert.deepEqual(rows[2], [piece('dim', 'Status   '), piece('running', '● running')])
  assert.deepEqual(rows[8], [piece('dim', 'Description')])
  assert.deepEqual(rows[9], [piece('plain', 'Check the migration plan against the')])
})

test('SEL detailRows wraps a long reason onto the next line under the value and never cuts it', () => {
  const reason = 'max_tokens_exceeded_while_writing_the_report'
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000, reason))
  const lines = detailLines(nodeOf(tree, 'a'), 'Main', 40)

  assert.equal(lines.length > 6, true)
  assert.equal(lines.join('\n').includes('…'), false)
  assert.equal(lines.slice(2, 5).map(line => line.slice(9)).join('').replaceAll(' ', '').includes(`(${reason})`), true)
  for (const line of lines) assert.equal([...line].length <= 40, true, line)
})

test('SEL detailRows wraps a long id by hard-wrapping it under the value column', () => {
  const id = 'srvtoolu_01Ab9xKq0123456789abcdefghijklmnopqrstuvwxyz'
  const tree = apply(consulted(id))
  const lines = detailLines(nodeOf(tree, id), 'Main', 40)
  const first = lines.findIndex(line => line.startsWith('Id '))

  assert.equal(first > 0, true)
  assert.deepEqual(lines.slice(first, first + 2), ['Id       srvtoolu_01Ab9xKq0123456789abcd', '         efghijklmnopqrstuvwxyz'])
})

test('SEL detailRows wraps a long description at word boundaries to the width and never cuts it', () => {
  const words = Array.from({ length: 30 }, (_, i) => `word${i}`)
  const tree = apply(spawned('a', { name: 'A', description: words.join(' ') }))
  const lines = detailLines(nodeOf(tree, 'a'), 'Main', 40)
  const description = lines.slice(lines.indexOf('Description') + 1)

  assert.equal(lines.indexOf('Description') > 0, true)
  assert.equal(description.length > 2, true)
  assert.equal(description.join(' '), words.join(' '))
  for (const line of description) assert.equal([...line].length <= 40, true, line)
})

test('SEL detailRows draws the advisor with its crown, no Step or Description, and the note instead', () => {
  assert.deepEqual(detailLines(nodeOf(board, ADVISOR_NODE), 'Main', 40), [
    '♛ advisor',
    'Kind     ♛ advisor',
    'Status   ✓ done',
    'Elapsed  12s',
    'Parent   Main',
    'Id       srvtoolu_01Ab9xKq',
    '',
    'Advisor input and answer are not shown.',
  ])
})

test('SEL detailRows draws an aborted advisor from the ASCII alphabet with the ^ crown', () => {
  const tree = apply(consulted('s1', { endedAt: undefined, at: NOW + 7_000 }))

  assert.deepEqual(detailLines(nodeOf(tree, 's1'), 'Main', 40, BOARD_NOW, true).slice(0, 4), [
    '^ advisor',
    'Kind     ^ advisor',
    'Status   - aborted',
    'Elapsed  7s',
  ])
})

test('SEL detailRows ticks the running Elapsed with now and freezes the finished one', () => {
  const running = nodeOf(apply(spawned('a', { name: 'A', at: NOW })), 'a')
  const done = nodeOf(apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000)), 'a')

  assert.equal(detailLines(running, 'Main', 40, NOW + 12_000)[3], 'Elapsed  12s')
  assert.equal(detailLines(running, 'Main', 40, NOW + 65_000)[3], 'Elapsed  1m 05s')
  assert.equal(detailLines(done, 'Main', 40, NOW + 12_000)[3], 'Elapsed  5s')
  assert.equal(detailLines(done, 'Main', 40, NOW + 999_000)[3], 'Elapsed  5s')
})

test('SEL detailRows leaves out Elapsed for a running agent with no start time', () => {
  const lines = detailLines(nodeOf(apply(spawned('a', { name: 'A' })), 'a'), 'Main', 40)

  assert.deepEqual(lines, ['A', 'Kind     subagent', 'Status   ● running', 'Parent   Main', 'Id       a'])
})

test('SEL detailRows under 30 columns drops Kind, Parent and Id, and writes Field value with one space', () => {
  assert.deepEqual(detailLines(nodeOf(board, REVIEWER), 'planner', 29), [
    'reviewer',
    'Status ● running',
    'Elapsed 2m 10s',
    'Step Read src/app.ts',
    '',
    'Check the migration plan',
    'against the current schema',
    'and list breaking changes.',
  ])
})

test('SEL detailRows is the full layout at 30 columns and the short one at 29', () => {
  assert.equal(detailLines(nodeOf(board, LINT), 'Main', 30).includes('Kind     subagent'), true)
  assert.equal(detailLines(nodeOf(board, LINT), 'Main', 29).includes('Status ✗ failed (exit 1)'), true)
  assert.equal(detailLines(nodeOf(board, LINT), 'Main', 29).includes('Kind     subagent'), false)
})

test('SEL detailRows under 30 columns wraps the status reason under its value', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000, 'max_tokens_exceeded_here'))
  const lines = detailLines(nodeOf(tree, 'a'), 'Main', 20)

  assert.equal(lines[1], 'Status ✗ failed')
  assert.equal(lines.slice(1, 4).map(line => line.slice(7)).join('').replaceAll(' ', '').includes('(max_tokens_exceeded_here)'), true)
  for (const line of lines) assert.equal([...line].length <= 20, true, line)
})

test('SEL detailRows draws the 8b agent from the ASCII alphabet', () => {
  assert.deepEqual(detailLines(nodeOf(board, REVIEWER), 'planner', 40, BOARD_NOW, true).slice(0, 8), [
    'reviewer',
    'Kind     subagent',
    'Status   * running',
    'Elapsed  2m 10s',
    'Step     Read src/app.ts',
    'Parent   planner',
    'Id       agent_7f3a9c21',
    '',
  ])
})

test('SEL detailRows draws the ellipsis stored in a long step as three dots in ASCII', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), called('a', 'Bash', { command: 'x'.repeat(100) }))
  const stepLines = (ascii: boolean) => detailLines(nodeOf(tree, 'a'), 'Main', 80, NOW, ascii).filter(line => line.includes('xxx'))

  assert.equal(stepLines(false).join('').includes('…'), true)
  assert.equal(stepLines(true).join('').includes('...'), true)
  assert.equal(stepLines(true).join('').includes('…'), false)
})

test('SEL detailRows shows a masked description as [redacted] and never the secret', () => {
  const tree = apply(spawned('a', { name: 'A', description: 'call the api with token=abcdef123456' }))
  const shown = detailLines(nodeOf(tree, 'a'), 'Main', 40).join('\n')

  assert.equal(shown.includes('token=[redacted]'), true)
  assert.equal(shown.includes('abcdef123456'), false)
})

test('SEL detailRows shows neither an advisor input nor an agent answer', () => {
  const ANSWER = 'SECRET-ANSWER-do-not-show'
  const answered = { ...finished('a', 1_000), text: ANSWER, answer: ANSWER }
  const tree = apply(
    spawned('a', { name: 'A', at: NOW }),
    answered,
    ...advisorEvents([serverUse('s1')], 'a', AT),
  )
  const shown = tree.nodes.flatMap(node => detailLines(node, 'Main', 40)).join('\n')

  assert.equal(tree.nodes.length, 2)
  assert.equal(shown.includes('Kind     ♛ advisor'), true)
  assert.equal(shown.includes('Advisor input and answer are not shown.'), true)
  assert.equal(shown.includes(ADVISOR_INPUT), false)
  assert.equal(shown.includes('question'), false)
  assert.equal(shown.includes(ANSWER), false)
})

test('SEL renderPane 8a: nothing selected, no row has the marker and the hint stands under a rule', () => {
  assert.deepEqual(paneLines(board, 40, undefined), [...BOARD_TREE_UNSELECTED, '', RULE_40, ...HINT_NONE])
})

test('SEL renderPane 8b: the running reviewer is selected, with the full detail block', () => {
  assert.deepEqual(paneLines(board, 40, REVIEWER), [
    ...withMarkerOn(BOARD_TREE_UNSELECTED, 4),
    '',
    RULE_40,
    'reviewer',
    'Kind     subagent',
    'Status   ● running',
    'Elapsed  2m 10s',
    'Step     Read src/app.ts',
    'Parent   planner',
    'Id       agent_7f3a9c21',
    '',
    'Description',
    'Check the migration plan against the',
    'current schema and list breaking',
    'changes.',
    '',
    'No task text.',
    '',
    HINT_SELECTED,
  ])
})

test('SEL renderPane 8c: the failed lint is selected, with its reason in the status line', () => {
  assert.deepEqual(paneLines(board, 40, LINT), [
    ...withMarkerOn(BOARD_TREE_UNSELECTED, 6),
    '',
    RULE_40,
    'lint',
    'Kind     subagent',
    'Status   ✗ failed (exit 1)',
    'Elapsed  48s',
    'Parent   Main',
    'Id       agent_b410e5d2',
    '',
    'Description',
    'Fix style errors across the project and',
    'report what changed.',
    '',
    'No task text.',
    '',
    HINT_SELECTED,
  ])
})

test('SEL renderPane 8d: the advisor is selected, with the note in place of a description', () => {
  assert.deepEqual(paneLines(board, 40, ADVISOR_NODE), [
    ...withMarkerOn(BOARD_TREE_UNSELECTED, 7),
    '',
    RULE_40,
    '♛ advisor',
    'Kind     ♛ advisor',
    'Status   ✓ done',
    'Elapsed  12s',
    'Parent   Main',
    'Id       srvtoolu_01Ab9xKq',
    '',
    'Advisor input and answer are not shown.',
    '',
    HINT_SELECTED,
  ])
})

test('SEL renderPane 8e: a 26-column body keeps name, status, elapsed and description, and the short hint', () => {
  assert.deepEqual(paneLines(narrowBoard, 26, LINT), [
    'Main 4m 02s',
    '  ├─ ● running 51s api: D…',
    '  │  ↳ thinking',
    '› ├─ ✗ failed 48s lint: F…',
    '  └─ ✓ done 12s ♛ advisor',
    '',
    '─'.repeat(26),
    'lint',
    'Status ✗ failed (exit 1)',
    'Elapsed 48s',
    '',
    'Fix style errors across',
    'the project and report',
    'what changed.',
    '',
    'No task text.',
    '',
    'Tab next  Enter  esc back',
  ])
})

test('SEL renderPane 8f: the ASCII alphabet draws > for the marker, hyphens for the rule and ^ for the crown', () => {
  assert.deepEqual(paneLines(board, 40, REVIEWER, BOARD_NOW, true), [
    'Main 4m 02s',
    '  |-- * running 3m 51s planner: Draft...',
    '  |   -> thinking',
    '  |  |-- v done 1m 12s explorer: Find...',
    '> |  `-- * running 2m 10s reviewer: C...',
    '  |      -> Read src/app.ts',
    '  |-- x failed (exit 1) 48s lint: Fix...',
    '  `-- v done 12s ^ advisor',
    '',
    '-'.repeat(40),
    'reviewer',
    'Kind     subagent',
    'Status   * running',
    'Elapsed  2m 10s',
    'Step     Read src/app.ts',
    'Parent   planner',
    'Id       agent_7f3a9c21',
    '',
    'Description',
    'Check the migration plan against the',
    'current schema and list breaking',
    'changes.',
    '',
    'No task text.',
    '',
    HINT_SELECTED,
  ])
})

test('SEL renderPane gives an id to each node row and to nothing else, and flags only the selected one', () => {
  const rows = paneAt(board, 40, REVIEWER)

  assert.deepEqual(rows.map(({ id }) => id), [
    undefined, PLANNER, undefined, EXPLORER, REVIEWER, undefined, LINT, ADVISOR_NODE,
    ...Array(rows.length - 8).fill(undefined),
  ])
  assert.deepEqual(rows.flatMap(({ selected, id }) => (selected ? [id] : [])), [REVIEWER])
  assert.equal(rows.length > 8, true)
})

test('SEL renderPane flags no row when nothing is selected, and the rows still carry their ids', () => {
  const rows = paneAt(board, 40, undefined)

  assert.deepEqual(rows.flatMap(({ id }) => (id === undefined ? [] : [id])), [PLANNER, EXPLORER, REVIEWER, LINT, ADVISOR_NODE])
  assert.equal(rows.some(({ selected }) => selected), false)
  assert.equal(rows.some(({ row }) => textOfRow(row).includes('›')), false)
})

test('SEL renderPane selects the clicked row and moves the marker and the detail when another is clicked', () => {
  const first = paneLines(board, 40, REVIEWER)
  const second = paneLines(board, 40, LINT)

  assert.equal(first[4]!.startsWith('› '), true)
  assert.equal(first[6]!.startsWith('  '), true)
  assert.equal(second[4]!.startsWith('  '), true)
  assert.equal(second[6]!.startsWith('› '), true)
  assert.equal(first.includes('Id       agent_7f3a9c21'), true)
  assert.equal(second.includes('Id       agent_b410e5d2'), true)
  assert.equal(second.includes('Id       agent_7f3a9c21'), false)
})

test('SEL renderPane gives the selected row the same text as without a selection, shifted only by the gutter', () => {
  const plain = paneLines(board, 40, undefined)
  const selected = paneLines(board, 40, REVIEWER)

  assert.equal(selected.length > plain.length, true)
  assert.deepEqual(selected.slice(0, 8).map((line, i) => (i === 4 ? line.slice(2) : line)), plain.slice(0, 8).map((line, i) => (i === 4 ? line.slice(2) : line)))
  assert.equal(selected[4]!.slice(0, 2), '› ')
})

test('SEL renderPane draws the node rows as the plain rows at two columns less, from 32 columns up', () => {
  for (const isAscii of [false, true]) {
    for (let columns = 32; columns <= 80; columns += 1) {
      const pane = paneLines(board, columns, undefined, BOARD_NOW, isAscii).slice(1, 8)
      const plain = renderAt(board, columns - 2, BOARD_NOW, isAscii).slice(1)

      assert.equal(pane.length, 7, `${columns}`)
      assert.deepEqual(pane.map(line => line.slice(2)), plain, `${columns}`)
    }
  }
})

test('SEL renderPane pieces: the marker and gutter are plain, the rest keep their roles', () => {
  const rows = paneAt(board, 40, REVIEWER)

  assert.deepEqual(rows[4]!.row.slice(0, 2), [piece('plain', '› '), piece('dim', '│ └─ ')])
  assert.deepEqual(rows[1]!.row.slice(0, 2), [piece('plain', '  '), piece('dim', '├─ ')])
  assert.deepEqual(rows[2]!.row, [piece('plain', '  '), piece('dim', '│  ↳ thinking')])
})

test('SEL renderPane draws the blank row, the rule, the hint and Main without a gutter or an id', () => {
  const rows = paneAt(board, 40, undefined)

  assert.equal(rows.length, 12)
  assert.deepEqual(rows[0]!, { row: [piece('plain', 'Main 4m 02s')] })
  assert.deepEqual(rows[8]!, { row: [] })
  assert.deepEqual(rows[9]!, { row: [piece('dim', RULE_40)] })
  assert.deepEqual(rows[10]!, { row: [piece('dim', HINT_NONE[0]!)] })
  assert.deepEqual(rows[11]!, { row: [piece('dim', HINT_NONE[1]!)] })
})

test('SEL renderPane draws the selected hint dim, in the short form under 30 columns', () => {
  const wide = paneAt(board, 40, LINT)
  const narrow = paneAt(narrowBoard, 29, LINT)

  assert.deepEqual(wide.at(-1), { row: [piece('dim', HINT_SELECTED)] })
  assert.deepEqual(narrow.at(-1), { row: [piece('dim', 'Tab next  Enter  esc back')] })
})

test('SEL renderPane draws the detail from the selected node, and its failed status in the error role', () => {
  const rows = paneAt(board, 40, LINT)
  const status = rows.find(({ row }) => textOfRow(row).startsWith('Status'))

  assert.deepEqual(status, { row: [piece('dim', 'Status   '), piece('failed', '✗ failed (exit 1)')] })
})

test('SEL renderPane ticks the detail Elapsed with the row, and both freeze when the agent finishes', () => {
  const running = apply(spawned('a', { name: 'A', at: NOW }))
  const finishedAt = applyEvent(running, finished('a', 5_000))
  const elapsedLine = (tree: Tree, now: number) => paneLines(tree, 40, 'a', now).find(line => line.startsWith('Elapsed'))

  assert.deepEqual(paneLines(running, 40, 'a', NOW + 12_000).slice(0, 2), ['Main', '› └─ ● running 12s A'])
  assert.equal(elapsedLine(running, NOW + 12_000), 'Elapsed  12s')
  assert.deepEqual(paneLines(running, 40, 'a', NOW + 65_000).slice(0, 2), ['Main', '› └─ ● running 1m 05s A'])
  assert.equal(elapsedLine(running, NOW + 65_000), 'Elapsed  1m 05s')
  assert.deepEqual(paneLines(finishedAt, 40, 'a', NOW + 999_000).slice(0, 2), ['Main', '› └─ ✓ done 5s A'])
  assert.equal(elapsedLine(finishedAt, NOW + 12_000), 'Elapsed  5s')
  assert.equal(elapsedLine(finishedAt, NOW + 999_000), 'Elapsed  5s')
})

test('SEL renderPane keeps the selection when the status changes, and the detail shows the new status, glyph and reason', () => {
  const running = apply(spawned('a', { name: 'A', at: NOW }))
  const failed = applyEvent(running, finished('a', 5_000, 'error'))
  const aborted = applyEvent(running, finished('a', 5_000, 'aborted'))

  assert.equal(paneLines(running, 40, 'a')[1]!.startsWith('› '), true)
  assert.equal(paneLines(running, 40, 'a').includes('Status   ● running'), true)
  assert.equal(paneLines(failed, 40, 'a')[1]!.startsWith('› '), true)
  assert.equal(paneLines(failed, 40, 'a').includes('Status   ✗ failed (error)'), true)
  assert.equal(paneLines(aborted, 40, 'a')[1]!.startsWith('› '), true)
  assert.equal(paneLines(aborted, 40, 'a').includes('Status   ⊘ aborted'), true)
})

test('SEL renderPane wraps a long failed reason in the detail instead of cutting it', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW }), finished('a', 5_000, 'max_tokens_exceeded_while_writing_the_report'))
  const lines = paneLines(tree, 40, 'a')

  const detail = lines.slice(lines.findIndex(line => line.startsWith('─')))

  assert.equal(lines.length > 12, true)
  assert.equal(detail.join('\n').includes('…'), false)
  assert.equal(detail.some(line => line.startsWith('Status   ✗ failed')), true)
})

test('SEL renderPane shows neither the advisor input nor an agent answer anywhere in the pane', () => {
  const ANSWER = 'SECRET-ANSWER-do-not-show'
  const answered = { ...finished('a', 1_000), text: ANSWER, answer: ANSWER }
  const tree = apply(spawned('a', { name: 'A', at: NOW }), answered, ...advisorEvents([serverUse('s1')], 'a', AT))

  for (const selectedId of ['a', 's1']) {
    for (const isAscii of [false, true]) {
      const shown = paneLines(tree, 40, selectedId, NOW + 5_000, isAscii).join('\n')

      assert.equal(shown.includes(selectedId === 's1' ? 'Advisor input and answer are not shown.' : 'Kind'), true)
      assert.equal(shown.includes(ADVISOR_INPUT), false)
      assert.equal(shown.includes('question'), false)
      assert.equal(shown.includes(ANSWER), false)
    }
  }
})

test('SEL renderPane shows a masked description as [redacted] in the detail', () => {
  const tree = apply(spawned('a', { name: 'A', description: 'call the api with token=abcdef123456' }))
  const shown = paneLines(tree, 40, 'a').join('\n')

  assert.equal(shown.includes('token=[redacted]'), true)
  assert.equal(shown.includes('abcdef123456'), false)
})

test('SEL renderPane gives a ✓ N done row two blank gutter columns and no id to press', () => {
  const folded = apply(...finishAll(flat(25, 'a')))
  const rows = paneAt(folded, 40, undefined)

  assert.deepEqual(rows.map(({ row }) => textOfRow(row)).slice(0, 2), ['Main', '  └─ ✓ 25 done'])
  assert.deepEqual(rows.slice(0, 2).map(({ id }) => id), [undefined, undefined])
  assert.equal(rows.length > 4, true)
  assert.deepEqual(rows.slice(1, 2)[0]!.row, [piece('plain', '  '), piece('dim', '└─ ✓ 25 done')])
})

test('SEL renderPane keeps the footer flush left with no id, between the tree and the detail', () => {
  const tree = apply(...finishAll(flat(24, 'e')), spawned('r', { name: 'R', at: NOW }))
  const rows = paneAt(tree, 40, 'r', NOW + 5_000)
  const lines = rows.map(({ row }) => textOfRow(row))

  assert.deepEqual(lines.slice(0, 7), ['Main', '  ├─ ✓ 24 done', '› └─ ● running 5s R', '', 'showing 1 of 25', '', RULE_40])
  assert.deepEqual(rows.slice(0, 7).map(({ id }) => id), [undefined, undefined, 'r', undefined, undefined, undefined, undefined])
})

test('SEL renderPane shows the detail of a selected agent that a ✓ N done row stands for, with no row selected', () => {
  const folded = apply(...finishAll(flat(25, 'a')))
  const rows = paneAt(folded, 40, 'a3')

  assert.equal(rows.some(({ selected }) => selected), false)
  assert.equal(rows.some(({ row }) => textOfRow(row) === 'Id       a3'), true)
})

test('SEL renderPane with a selection that /agent-tree clear removed shows no selection and the hint', () => {
  const before = apply(spawned('a', { name: 'A' }), spawned('b', { name: 'B' }), finished('a', 1_000))
  const after = applyEvent(before, cleared)

  assert.equal(paneLines(before, 40, 'a').includes('Id       a'), true)
  assert.deepEqual(paneLines(after, 40, 'a', NOW), ['Main', '  └─ ● running B', '', RULE_40, ...HINT_NONE])
  assert.equal(paneAt(after, 40, 'a').some(({ selected }) => selected), false)
})

test('SEL renderPane keeps a selection that /agent-tree clear keeps, because the agent is still there', () => {
  const before = apply(spawned('a', { name: 'A', at: NOW }), spawned('b', { name: 'B', at: NOW }), finished('a', 1_000))
  const after = applyEvent(before, cleared)

  assert.deepEqual(paneLines(after, 40, 'b', NOW + 5_000).slice(0, 2), ['Main', '› └─ ● running 5s B'])
  assert.equal(paneLines(after, 40, 'b', NOW + 5_000).includes('Id       b'), true)
})

test('SEL renderPane after /clear is the empty pane, with nothing selected and no detail area', () => {
  const emptied = applyEvent(board, { type: 'session.ended', reason: 'clear', at: NOW })

  assert.deepEqual(paneLines(emptied, 40, REVIEWER, NOW + 5_000), ['Main 5s', EMPTY_HINT])
  assert.deepEqual(paneAt(emptied, 40, REVIEWER).map(({ id, selected }) => [id, selected]), [[undefined, undefined], [undefined, undefined]])
})

test('SEL renderPane under 16 columns is the glyph-only rows and the widen hint, with no detail and nothing to press', () => {
  const rows = paneAt(narrowTree, 14, 'r')

  assert.deepEqual(rows.map(({ row }) => textOfRow(row)), renderLines(narrowTree, 14))
  assert.deepEqual(rows.flatMap(({ id, selected }) => [id, selected]).filter(value => value !== undefined), [])
  assert.equal(rows.length, 8)
})

test('SEL renderPane remembers the selection under 16 columns, and it returns when the pane is wide enough', () => {
  const glyphOnly = paneLines(narrowTree, 15, 'r')
  const widened = paneLines(narrowTree, 16, 'r')

  assert.deepEqual(glyphOnly, renderLines(narrowTree, 15))
  assert.equal(widened.some(line => line.startsWith('› ')), true)
  assert.equal(widened.some(line => line.startsWith('Status ')), true)
  assert.equal(paneLines(narrowTree, 40, 'r').some(line => line.startsWith('› ')), true)
})

test('SEL renderPane never draws a row wider than the body, at any width from 3 up, in either alphabet', () => {
  const tree = apply(
    ...chain(5, { at: NOW, description: 'a description that runs on and on and on and on' }),
    ...finishAll(flat(20, 'k')),
    consulted('s1', { agentId: 'd3' }),
    called('d5', 'Bash', { command: 'npm run build --workspaces' }),
    finished('d2', 3_000, 'max_tokens_exceeded_while_writing_the_report'),
  )

  for (const isAscii of [false, true]) {
    for (const selectedId of ['d1', 'd2', 'd5', 's1', 'k3', undefined]) {
      for (let columns = 3; columns <= 80; columns += 1) {
        const lines = paneLines(tree, columns, selectedId, NOW + 65_000, isAscii)

        assert.notEqual(lines.length, 0, `${columns}`)
        for (const line of lines.slice(1)) {
          assert.equal([...line].length <= columns, true, `${columns} ${selectedId}: ${line}`)
          if (isAscii) assert.match(line, /^[\x00-\x7f]*$/, `${columns}: ${line}`)
        }
      }
    }
  }
})

test('SEL renderPane gives a pressable row only to a node row, at every width of 16 and up', () => {
  for (let columns = 16; columns <= 80; columns += 1) {
    const rows = paneAt(board, columns, REVIEWER)
    const pressable = rows.filter(({ id }) => id !== undefined)

    assert.deepEqual(pressable.map(({ id }) => id), [PLANNER, EXPLORER, REVIEWER, LINT, ADVISOR_NODE], `${columns}`)
    for (const { row } of pressable) assert.equal(textOfRow(row).startsWith('› ') || textOfRow(row).startsWith('  '), true, `${columns}`)
    assert.deepEqual(rows.filter(({ selected }) => selected).map(({ id }) => id), [REVIEWER], `${columns}`)
  }
})

test('SEL renderPane under 30 columns without a selection hints in wrapped lines, never cut', () => {
  const lines = paneLines(board, 26, undefined)
  const hint = lines.slice(lines.findIndex(line => line.startsWith('─')) + 1)

  assert.equal(hint.length > 2, true)
  assert.equal(hint.join(' '), HINT_NONE.join(' '))
  for (const line of hint) assert.equal([...line].length <= 26, true, line)
})

test('SEL renderPane draws the ASCII marker only on the selected row and leaves the plain Unicode out', () => {
  const lines = paneLines(board, 40, LINT, BOARD_NOW, true)

  assert.equal(lines[6]!.startsWith('> '), true)
  assert.equal(lines.filter(line => line.startsWith('>')).length, 1)
  assert.equal(lines.join('\n').includes('›'), false)
  assert.equal(lines.join('\n').includes('─'), false)
})

test('SEL renderPane does not mutate the tree and gives the same answer twice', () => {
  const snapshot = structuredClone(board)

  assert.deepEqual(paneAt(board, 40, REVIEWER), paneAt(board, 40, REVIEWER))
  assert.equal(paneAt(board, 40, REVIEWER).length > 8, true)
  assert.deepEqual(board, snapshot)
})

const NINE_B_PROMPT = [
  'Review docs/migrate.md and list every risk before we ship.',
  '- Each column rename needs a backfill.',
  '- Each step needs a rollback.',
  '- Table locks must stay under 5 s.',
  '',
  'Report breaking changes first. Do not edit any files.',
].join('\n')

const NINE_B_LINES_40 = [
  'Review docs/migrate.md and list every',
  'risk before we ship.',
  '- Each column rename needs a backfill.',
  '- Each step needs a rollback.',
  '- Table locks must stay under 5 s.',
  '',
  'Report breaking changes first.',
  'Do not edit any files.',
]

const NINE_B_LINES_26 = [
  'Review docs/migrate.md and',
  'list every risk before we',
  'ship.',
  '- Each column rename needs',
  '  a backfill.',
  '- Each step needs a',
  '  rollback.',
  '- Table locks must stay',
  '  under 5 s.',
  '',
  'Report breaking changes',
  'first.',
  'Do not edit any files.',
]

test('SUM summaryLines example A: each sentence is its own line, none split inside parser.ts or after e.g.', () => {
  assert.deepEqual(summaryLines('Find the bug in parser.ts. Then fix it, e.g. by adding a guard. Run the tests!', 80), [
    'Find the bug in parser.ts.',
    'Then fix it, e.g. by adding a guard.',
    'Run the tests!',
  ])
})

test('SUM summaryLines example B: bullets are lines, a version stays whole, a blank line is one blank row', () => {
  assert.deepEqual(summaryLines('Check:\n- auth flow\n- token expiry (see v1.2 notes)\n\nThen report.', 80), [
    'Check:',
    '- auth flow',
    '- token expiry (see v1.2 notes)',
    '',
    'Then report.',
  ])
})

test('SUM summaryLines example C: numbered markers keep their style and a wrapped line hangs by the marker width', () => {
  assert.deepEqual(summaryLines('1. Read src/config/loader.ts and note every env var\n2) Compare with .env.example', 40), [
    '1. Read src/config/loader.ts and note',
    '   every env var',
    '2) Compare with .env.example',
  ])
})

test('SUM summaryLines reproduces the 9b lines at 40 columns and the 9d lines at 26', () => {
  assert.deepEqual(summaryLines(NINE_B_PROMPT, 40), NINE_B_LINES_40)
  assert.deepEqual(summaryLines(NINE_B_PROMPT, 26), NINE_B_LINES_26)
})

for (const abbreviation of ['e.g.', 'i.e.', 'etc.', 'vs.', 'Mr.', 'MR.', 'E.G.']) {
  test(`SUM summaryLines does not end a sentence after ${abbreviation}`, () => {
    assert.deepEqual(summaryLines(`Do it ${abbreviation} Then stop.`, 80), [`Do it ${abbreviation} Then stop.`])
  })
}

test('SUM summaryLines does end a sentence after a word that only ends like an abbreviation', () => {
  assert.deepEqual(summaryLines('Check the setvs. Then stop.', 80), ['Check the setvs.', 'Then stop.'])
  assert.deepEqual(summaryLines('Done now. Then stop.', 80), ['Done now.', 'Then stop.'])
})

test('SUM summaryLines ends a sentence before a capital, a digit or an opening quote, and not before a lower-case word', () => {
  assert.deepEqual(summaryLines('Why? Because! Yes.', 80), ['Why?', 'Because!', 'Yes.'])
  assert.deepEqual(summaryLines('Done. 2 more follow.', 80), ['Done.', '2 more follow.'])
  assert.deepEqual(summaryLines('He said so. "Go" now.', 80), ['He said so.', '"Go" now.'])
  assert.deepEqual(summaryLines('It ended. “Go” then.', 80), ['It ended.', '“Go” then.'])
  assert.deepEqual(summaryLines('Use a.b. then c.', 80), ['Use a.b. then c.'])
})

test('SUM summaryLines wraps a long sentence at spaces and breaks one over-long word at the width', () => {
  assert.deepEqual(summaryLines('a'.repeat(50), 20), ['a'.repeat(20), 'a'.repeat(20), 'a'.repeat(10)])
  assert.deepEqual(summaryLines('abcd efgh ij', 9), ['abcd efgh', 'ij'])
})

test('SUM summaryLines keeps one blank row for any run of blank lines and none at either end', () => {
  assert.deepEqual(summaryLines('A.\n\n\n\nB.', 40), ['A.', '', 'B.'])
  assert.deepEqual(summaryLines('A.\n  \nB.', 40), ['A.', '', 'B.'])
  assert.deepEqual(summaryLines('A.\r\n\r\nB.', 40), ['A.', '', 'B.'])
  assert.deepEqual(summaryLines('\n\n  A.  \n\n', 40), ['A.'])
})

test('SUM summaryLines gives no line for no text', () => {
  assert.deepEqual(summaryLines('', 40), [])
  assert.deepEqual(summaryLines('  \n \n', 40), [])
})

test('SUM summaryLines draws -, * and • bullets as "- " and hangs a wrapped bullet by 2', () => {
  assert.deepEqual(summaryLines('- a\n* b\n• c', 40), ['- a', '- b', '- c'])
  assert.deepEqual(summaryLines('- aaa bbb ccc', 9), ['- aaa bbb', '  ccc'])
})

test('SUM summaryLines hangs a numbered item by the width of its own marker', () => {
  assert.deepEqual(summaryLines('10. alpha beta gamma', 12), ['10. alpha', '    beta', '    gamma'])
})

test('SUM summaryLines keeps a bullet with two sentences as one item', () => {
  assert.deepEqual(summaryLines('- Do A. Then B.', 40), ['- Do A. Then B.'])
})

test('SUM summaryLines does not take a dash, a star or a number glued to a word for a marker', () => {
  assert.deepEqual(summaryLines('-fast and *bold* and 2024.5 items', 80), ['-fast and *bold* and 2024.5 items'])
})

test('SUM summaryLines never adds an ellipsis, loses a letter, or leaves a line wider than the width', () => {
  const prose = 'Run npm run build --workspaces, then check supercalifragilisticexpialidocious output. Then report!\n\nDone.'

  for (let width = 4; width <= 40; width += 1) {
    const lines = summaryLines(prose, width)

    assert.equal(lines.join('').replaceAll(' ', ''), prose.replaceAll(/\s/g, ''), `${width}`)
    for (const line of lines) {
      assert.equal([...line].length <= width, true, `${width}: ${line}`)
      assert.equal(line.includes('…'), false, `${width}: ${line}`)
    }
  }
})

test('SUM summaryLines keeps every line of bullets and numbered items inside the width', () => {
  for (let width = 6; width <= 40; width += 1) {
    for (const line of summaryLines(`${NINE_B_PROMPT}\n10. a very long numbered item that wraps\n2) another one`, width)) {
      assert.equal([...line].length <= width, true, `${width}: ${line}`)
    }
  }
})

test('SUM summaryLines adds no non-ASCII character of its own', () => {
  assert.match(summaryLines('• a\n– b\n* c', 40).join('\n'), /^[\x00-\x7f]*$/)
})

test('SUM storedTask stores nothing for an absent, empty or blank prompt', () => {
  assert.deepEqual(storedTask(undefined), {})
  assert.deepEqual(storedTask(''), {})
  assert.deepEqual(storedTask('  \n\t '), {})
})

test('SUM storedTask keeps a short prompt as given, with no cut flag', () => {
  assert.deepEqual(storedTask('Fix the build.\n- then test'), { task: 'Fix the build.\n- then test' })
})

test('SUM storedTask masks secrets as the description is masked', () => {
  const { task } = storedTask('Deploy with token=abcdef123456 and sk-proj-ABCDEFGHIJKLMNOP1234 now')

  assert.equal(task, 'Deploy with token=[redacted] and [redacted] now')
})

test('SUM storedTask reduces a secret file to its name, drops its directory and keeps the rest of the prompt', () => {
  assert.equal(
    storedTask('Read /srv/app/.env and /home/u/.ssh/id_rsa, then src/a.ts').task,
    'Read .env and id_rsa, then src/a.ts',
  )
  assert.equal(storedTask('Check /etc/ssl/server.pem\nthen /home/u/.aws/credentials\nand stop').task, 'Check server.pem\nthen credentials\nand stop')
  assert.equal(storedTask("cat '/srv/.env.production' now").task, 'cat .env.production now')
})

test('SUM storedTask leaves an ordinary path whole', () => {
  assert.equal(storedTask('Read /srv/app/src/environment.ts and docs/.envrc-notes.md').task, 'Read /srv/app/src/environment.ts and docs/.envrc-notes.md')
})

test('SUM storedTask keeps exactly 2,000 characters whole and cuts the 2,001st', () => {
  assert.deepEqual(storedTask('a'.repeat(2000)), { task: 'a'.repeat(2000) })
  assert.deepEqual(storedTask('a'.repeat(2001)), { task: 'a'.repeat(2000), taskCut: true })
})

test('SUM storedTask counts characters, never UTF-16 units, and never splits a surrogate pair', () => {
  assert.deepEqual(storedTask('\u{1F600}'.repeat(2000)), { task: '\u{1F600}'.repeat(2000) })
  assert.deepEqual(storedTask('\u{1F600}'.repeat(2001)), { task: '\u{1F600}'.repeat(2000), taskCut: true })
})

test('SUM storedTask masks before it counts, so [redacted] is 10 characters whatever it hid', () => {
  const secret = `sk-${'b'.repeat(100)}`
  const atCap = `${'a'.repeat(1989)} ${secret}`
  const overCap = `${'a'.repeat(1990)} ${secret}`

  assert.deepEqual(storedTask(atCap), { task: `${'a'.repeat(1989)} [redacted]` })
  assert.equal([...storedTask(atCap).task!].length, 2000)
  assert.equal(storedTask(overCap).taskCut, true)
  assert.equal(storedTask(overCap).task!.endsWith(' [redacted'), true)
  assert.equal(JSON.stringify(storedTask(overCap)).includes('bbbb'), false)
})

test('SUM a spawn stores the masked, capped task on its node and never the prompt itself', () => {
  const SECRET = 'sk-proj-ABCDEFGHIJKLMNOP1234'
  const tree = apply(spawned('a', { name: 'A', at: NOW, prompt: `Deploy with ${SECRET} and read /srv/app/.env` }))
  const node = nodeOf(tree, 'a')

  assert.equal(node.task, 'Deploy with [redacted] and read .env')
  assert.equal('prompt' in node, false)
  assert.equal(JSON.stringify(tree).includes(SECRET), false)
  assert.equal(JSON.stringify(tree).includes('/srv/app'), false)
})

test('SUM a spawn with no prompt stores no task field, and so does the advisor', () => {
  const tree = apply(spawned('a', { name: 'A' }), spawned('b', { name: 'B', prompt: '' }), spawned('c', { name: 'C', prompt: 'Do it.' }), consulted('s1'))

  assert.equal('task' in nodeOf(tree, 'a'), false)
  assert.equal('task' in nodeOf(tree, 'b'), false)
  assert.equal(nodeOf(tree, 'c').task, 'Do it.')
  assert.equal('task' in nodeOf(tree, 's1'), false)
})

test('SUM a completion that beat its spawn leaves the task on the node', () => {
  const tree = apply(finished('a', 7_000), spawned('a', { name: 'A', prompt: 'Do it.' }))

  assert.equal(nodeOf(tree, 'a').task, 'Do it.')
  assert.equal(nodeOf(tree, 'a').status, 'done')
})

const withTask = (tree: Tree, agentId: string, prompt: string): Tree => ({
  ...tree,
  nodes: tree.nodes.map(node => (node.agentId === agentId ? { ...node, ...storedTask(prompt) } : node)),
})

const taskBoard = withTask(board, REVIEWER, NINE_B_PROMPT)

const openPane = (tree: Tree, columns: number, selectedId: string | undefined, openId: string | undefined, ascii = false, now = BOARD_NOW) =>
  renderPane(tree, columns, now, ascii, selectedId, openId)

const openLines = (...args: Parameters<typeof openPane>) => openPane(...args).map(({ row }) => textOfRow(row))

const REVIEWER_HEAD_40 = [
  'reviewer',
  'Kind     subagent',
  'Status   ● running',
  'Elapsed  2m 10s',
  'Step     Read src/app.ts',
  'Parent   planner',
  'Id       agent_7f3a9c21',
  '',
  'Description',
  'Check the migration plan against the',
  'current schema and list breaking',
  'changes.',
  '',
]

test('SUM renderPane 9a: a selected agent with task text gets [ Summary ] under its description and one blank row before the hint', () => {
  assert.deepEqual(openLines(taskBoard, 40, REVIEWER, undefined), [
    ...withMarkerOn(BOARD_TREE_UNSELECTED, 4),
    '',
    RULE_40,
    ...REVIEWER_HEAD_40,
    '[ Summary ]',
    '',
    HINT_SELECTED,
  ])
})

test('SUM renderPane 9b: open, the button reads [ Hide summary ] and the Task block follows it, the hint stays last', () => {
  assert.deepEqual(openLines(taskBoard, 40, REVIEWER, REVIEWER), [
    ...withMarkerOn(BOARD_TREE_UNSELECTED, 4),
    '',
    RULE_40,
    ...REVIEWER_HEAD_40,
    '[ Hide summary ]',
    '',
    'Task',
    ...NINE_B_LINES_40,
    '',
    HINT_SELECTED,
  ])
})

test('SUM renderPane 9c: an agent with no task text gets the line No task text. and no button', () => {
  const lines = openLines(taskBoard, 40, EXPLORER, EXPLORER)

  assert.deepEqual(lines.slice(lines.indexOf('Description')), [
    'Description',
    'Find logging calls',
    '',
    'No task text.',
    '',
    HINT_SELECTED,
  ])
  assert.equal(lines.some(line => line.includes('Summary')), false)
})

const narrowTask = apply(
  CLEARED_AT_NOW,
  spawned(REVIEWER, { name: 'reviewer', description: REVIEWER_DESCRIPTION, prompt: NINE_B_PROMPT, at: NOW + 112_000 }),
  called(REVIEWER, 'Read', { file_path: 'src/app.ts' }),
)

test('SUM renderPane 9d: at 26 columns Kind, Parent and Id go, the button, Task and the wrapped summary stay', () => {
  assert.deepEqual(openLines(narrowTask, 26, REVIEWER, REVIEWER), [
    'Main 4m 02s',
    '› └─ ● running 2m 10s rev…',
    '     ↳ Read src/app.ts',
    '',
    '─'.repeat(26),
    'reviewer',
    'Status ● running',
    'Elapsed 2m 10s',
    'Step Read src/app.ts',
    '',
    'Check the migration plan',
    'against the current schema',
    'and list breaking changes.',
    '',
    '[ Hide summary ]',
    '',
    'Task',
    ...NINE_B_LINES_26,
    '',
    'Tab next  Enter  esc back',
  ])
})

test('SUM renderPane 9e: in ASCII the tree, the rule and the cut marker change, the button and the summary are the same', () => {
  assert.deepEqual(openLines(taskBoard, 40, REVIEWER, REVIEWER, true), [
    'Main 4m 02s',
    '  |-- * running 3m 51s planner: Draft...',
    '  |   -> thinking',
    '  |  |-- v done 1m 12s explorer: Find...',
    '> |  `-- * running 2m 10s reviewer: C...',
    '  |      -> Read src/app.ts',
    '  |-- x failed (exit 1) 48s lint: Fix...',
    '  `-- v done 12s ^ advisor',
    '',
    '-'.repeat(40),
    ...REVIEWER_HEAD_40.map(line => line.replace('●', '*')),
    '[ Hide summary ]',
    '',
    'Task',
    ...NINE_B_LINES_40,
    '',
    HINT_SELECTED,
  ])
})

test('SUM renderPane 9e: a bullet that arrives as • or * is drawn as "- " and no non-ASCII character reaches the ASCII summary', () => {
  const tree = apply(spawned('a', { name: 'A', at: NOW, prompt: 'Check:\n• auth flow\n* token expiry\n– retries' }))
  const lines = openLines(tree, 40, 'a', 'a', true, NOW + 5_000)

  assert.deepEqual(lines.slice(lines.indexOf('Task'), -2), ['Task', 'Check:', '- auth flow', '- token expiry', '- retries'])
  assert.match(lines.join('\n'), /^[\x00-\x7f]*$/)
})

const CUT_TAIL = '\n- Compare every route in src/api with'
const AT_CAP = `${'a'.repeat(2000 - CUT_TAIL.length)}${CUT_TAIL}`
const OVER_CAP = `${AT_CAP} the docs.`
const oneAgent = (prompt: string) => apply(spawned('a', { name: 'A', at: NOW, prompt }))

test('SUM renderPane 9f: a cut prompt ends its last line with … and a dim note says it was cut at 2,000 characters', () => {
  const lines = openLines(oneAgent(OVER_CAP), 40, 'a', 'a', false, NOW + 5_000)

  assert.deepEqual(lines.slice(-5), ['- Compare every route in src/api with…', '', 'Cut at 2,000 characters.', '', HINT_SELECTED])
  assert.deepEqual(openPane(oneAgent(OVER_CAP), 40, 'a', 'a', false, NOW + 5_000).at(-3)?.row, [piece('dim', 'Cut at 2,000 characters.')])
})

test('SUM renderPane 9f: in ASCII the cut marker is three dots', () => {
  const lines = openLines(oneAgent(OVER_CAP), 40, 'a', 'a', true, NOW + 5_000)

  assert.deepEqual(lines.slice(-5), ['- Compare every route in src/api with...', '', 'Cut at 2,000 characters.', '', HINT_SELECTED])
  assert.equal(lines.join('\n').includes('…'), false)
})

test('SUM renderPane exactly 2,000 characters draws no marker and no cut note', () => {
  const lines = openLines(oneAgent(AT_CAP), 40, 'a', 'a', false, NOW + 5_000)

  assert.deepEqual(lines.slice(-3), ['- Compare every route in src/api with', '', HINT_SELECTED])
  assert.equal(lines.some(line => line.startsWith('Cut at')), false)
  assert.equal(lines.some(line => line.includes('with…')), false)
})

test('SUM renderPane draws the button as a pressable row that names its agent, and no other row', () => {
  const rows = openPane(taskBoard, 40, REVIEWER, undefined)
  const buttons = rows.filter(({ summaryFor }) => summaryFor !== undefined)

  assert.deepEqual(buttons, [{ row: [piece('plain', '[ Summary ]')], summaryFor: REVIEWER }])
  assert.deepEqual(
    openPane(taskBoard, 40, REVIEWER, REVIEWER).filter(({ summaryFor }) => summaryFor !== undefined),
    [{ row: [piece('plain', '[ Hide summary ]')], summaryFor: REVIEWER }],
  )
  assert.deepEqual(rows.flatMap(({ id }) => (id === undefined ? [] : [id])), [PLANNER, EXPLORER, REVIEWER, LINT, ADVISOR_NODE])
})

test('SUM renderPane gives the advisor neither a button nor the No task text. line, and an agent without task text no button', () => {
  const advisorRows = openPane(taskBoard, 40, ADVISOR_NODE, ADVISOR_NODE)
  const explorerRows = openPane(taskBoard, 40, EXPLORER, undefined)

  assert.equal(advisorRows.some(({ summaryFor }) => summaryFor !== undefined), false)
  assert.equal(advisorRows.some(({ row }) => textOfRow(row) === 'No task text.'), false)
  assert.equal(explorerRows.some(({ summaryFor }) => summaryFor !== undefined), false)
  assert.equal(explorerRows.some(({ row }) => textOfRow(row) === 'No task text.'), true)
  assert.equal(openPane(taskBoard, 40, undefined, REVIEWER).some(({ summaryFor }) => summaryFor !== undefined), false)
})

test('SUM renderPane shows a summary only for the agent whose id is open, so another selection reads closed', () => {
  const both = withTask(taskBoard, LINT, 'Fix lint.')

  assert.equal(openLines(both, 40, REVIEWER, LINT).includes('[ Summary ]'), true)
  assert.equal(openLines(both, 40, REVIEWER, LINT).includes('Task'), false)
  assert.equal(openLines(both, 40, LINT, LINT).includes('[ Hide summary ]'), true)
  assert.deepEqual(openLines(both, 40, LINT, LINT).slice(-4), ['Task', 'Fix lint.', '', HINT_SELECTED])
  assert.equal(openLines(both, 40, REVIEWER, 'agent_gone').includes('[ Summary ]'), true)
})

test('SUM renderPane after /clear is the empty pane whatever summary id was open', () => {
  const emptied = applyEvent(taskBoard, { type: 'session.ended', reason: 'clear', at: NOW })

  assert.deepEqual(openLines(emptied, 40, REVIEWER, REVIEWER, false, NOW + 5_000), ['Main 5s', EMPTY_HINT])
})

test('SUM renderPane hides the button and the summary under 16 columns and keeps them at 16', () => {
  assert.deepEqual(openLines(taskBoard, 15, REVIEWER, REVIEWER), renderLines(taskBoard, 15, BOARD_NOW))
  assert.equal(openLines(taskBoard, 16, REVIEWER, REVIEWER).includes('[ Hide summary ]'), true)
  assert.equal(openLines(taskBoard, 16, REVIEWER, REVIEWER).includes('Task'), true)
})

test('SUM renderPane roles: the button and the summary are plain, Task and the notes are dim', () => {
  const cut = openPane(oneAgent(OVER_CAP), 40, 'a', 'a', false, NOW + 5_000)
  const none = openPane(taskBoard, 40, EXPLORER, undefined)
  const roleOf = (rows: ReturnType<typeof openPane>, text: string) => rows.find(({ row }) => textOfRow(row) === text)?.row

  assert.deepEqual(roleOf(cut, 'Task'), [piece('dim', 'Task')])
  assert.deepEqual(roleOf(cut, '- Compare every route in src/api with…'), [piece('plain', '- Compare every route in src/api with…')])
  assert.deepEqual(roleOf(none, 'No task text.'), [piece('dim', 'No task text.')])
})

test('SUM renderPane never draws a summary row wider than the body, from 16 up, in either alphabet, and ends with the hint', () => {
  const tree = withTask(taskBoard, LINT, `${NINE_B_PROMPT}\n10. a very long numbered item that wraps\n${'w'.repeat(60)}`)

  for (const ascii of [false, true]) {
    for (const selectedId of [REVIEWER, LINT]) {
      for (let columns = 16; columns <= 80; columns += 1) {
        const lines = openLines(tree, columns, selectedId, selectedId, ascii)
        const block = lines.slice(lines.indexOf('Task'))

        assert.equal(block.length > 4, true, `${columns}`)
        assert.equal(block.at(-1)!.length > 0, true, `${columns}`)
        assert.equal(block.join('\n').includes('…'), false, `${columns}`)
        for (const line of lines.slice(1)) assert.equal([...line].length <= columns, true, `${columns} ${selectedId}: ${line}`)
        if (ascii) assert.match(lines.join('\n'), /^[\x00-\x7f]*$/, `${columns}`)
      }
    }
  }
})

test('SUM renderPane with a summary open does not mutate the tree and gives the same answer twice', () => {
  const snapshot = structuredClone(taskBoard)

  assert.deepEqual(openPane(taskBoard, 40, REVIEWER, REVIEWER), openPane(taskBoard, 40, REVIEWER, REVIEWER))
  assert.deepEqual(taskBoard, snapshot)
})

test('SUM no drawn row of an open summary holds the raw secret, and a secret file shows its name only', () => {
  const SECRET = 'sk-proj-ABCDEFGHIJKLMNOP1234'
  const tree = oneAgent(`Deploy with ${SECRET}.\nRead /srv/app/.env first.`)

  for (const ascii of [false, true]) {
    const shown = openLines(tree, 40, 'a', 'a', ascii, NOW + 5_000).join('\n')

    assert.equal(shown.includes('Deploy with [redacted].'), true)
    assert.equal(shown.includes('Read .env first.'), true)
    assert.equal(shown.includes(SECRET), false)
    assert.equal(shown.includes('/srv/app'), false)
  }
})
