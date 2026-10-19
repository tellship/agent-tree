import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TextProps, Timer } from 'claude-code'

import type { AgentTree, PaneRow, Role, Segment } from '../types'
import type { TreeEvent } from './tree'
import {
  advisorEvents,
  applyEvent,
  clearFinishedCounted,
  clearOutput,
  closeOutput,
  commandOutput,
  emptyTree,
  hasRunning,
  isAsciiLocale,
  renderPane,
} from './tree'

const PANE_ID = 'agent-tree'
const PANE = { id: PANE_ID, title: 'Agents', columns: 40 }
const COMMAND = 'agent-tree'
const TICK_MS = 1000

// Theme keys, so the person's theme decides the colours.
const ROLE_PROPS: Record<Role, TextProps> = {
  running: { color: 'suggestion' },
  done: { color: 'success' },
  failed: { color: 'error' },
  aborted: { color: 'inactive' },
  dim: { dimColor: true },
  plain: {},
  title: { bold: true },
}

const SELECTED_PROPS: TextProps = { bold: true, inverse: true }

// A Text with no children may be given no height, which would close up the blank row before the footer.
const BLANK_ROW = ' '
const tree = atom({ plugin: 'agent-tree', key: 'tree' } as const, emptyTree)
const isAscii = atom({ plugin: 'agent-tree', key: 'isAscii' } as const, false)
const selectedId = atom({ plugin: 'agent-tree', key: 'selectedId' } as const, null)
// The id whose summary is open, so another selection reads closed and a removed agent matches nothing.
const summaryOpen = atom({ plugin: 'agent-tree', key: 'summaryOpen' } as const, null)

let ticker: Timer | undefined

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
}

// A write already redraws the pane; the tick only moves the clocks, so it lives while a node runs.
const recordChange = async ($: EngineInterface, change: (t: AgentTree) => AgentTree) => {
  const written = await update($, tree, change)

  if (!hasRunning(written)) {
    stopTicker()
  } else if (ticker === undefined) {
    ticker = $.clock.every(TICK_MS, () => $.ui.invalidate('ui.render'))
  }

  return written
}

const record = ($: EngineInterface, event: TreeEvent) => recordChange($, t => applyEvent(t, event))

// update may run the callback again on a version clash, so the count is overwritten each run and the last run is the one written.
const clearAndCount = async ($: EngineInterface): Promise<number> => {
  let cleared = 0
  await recordChange($, t => {
    const result = clearFinishedCounted(t)
    cleared = result.cleared
    return result.tree
  })
  return cleared
}

// A hook that fails must not break the session or the Agent call it observes: next(e) replays what already ran.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await record($, { type: 'session.started', at: await $.clock.now() })

    // Before ui.open: below 144 columns the open can wait undrawn, and code after it never ran.
    const ascii = isAsciiLocale(await $.env.get('LC_ALL'), await $.env.get('LC_CTYPE'), await $.env.get('LANG'))
    await update($, isAscii, () => ascii)

    await $.command.register({ name: COMMAND, description: 'Open the agents pane.', argumentHint: 'clear | close' })
    await $.ui.open(PANE)

    return started
  }).catch(($, e, next) => next(e))

  // Opened from the person's own command, so the engine places the pane at any width.
  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const args = e.args.trim()
    if (args === 'clear') return clearOutput(await clearAndCount($))

    if (args === 'close') {
      const wasOpen = (await $.ui.panes()).some(pane => pane.id === PANE_ID)
      if (wasOpen) await $.ui.close({ id: PANE_ID })
      return closeOutput(wasOpen)
    }

    return commandOutput(await $.ui.open(PANE))
  }).catch(($, e, next) => next(e))

  // /clear fires session.end with no session.start after it.
  on('session.end', async ($, e, next) => {
    stopTicker()
    await record($, { type: 'session.ended', reason: e.reason, at: await $.clock.now() })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The id of the started subagent is only on the result; a refused spawn has none.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const { agentId } = started

    if (agentId !== undefined) {
      await record($, {
        type: 'agent.spawned',
        agentId,
        parentAgentId: e.parentAgentId,
        subagentType: e.subagentType,
        name: e.name,
        description: e.description,
        prompt: e.prompt,
        at: await $.clock.now(),
      })
    }

    return started
  }).catch(($, e, next) => next(e))

  // The tool is shown while it runs, so it is recorded before next(e); the input is masked on entry to the tree.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await record($, { type: 'tool.called', agentId: e.agentId, tool: e.tool, input: e })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      await record($, { type: 'turn.stepped', agentId: e.agentId })
    }

    const response = yield* next(e)

    // The API runs the advisor inside the request and the engine streams it as opaque chunks, so it is known only here, once over.
    const consults = advisorEvents(response.serverToolUses, e.agentId, await $.clock.now())
    if (consults.length > 0) await recordChange($, t => consults.reduce(applyEvent, t))

    return response
  })

  on('turn.complete', async ($, e, next) => {
    await record($, { type: 'turn.complete', agentId: e.agentId, reason: e.reason, durationMs: e.durationMs })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const rows = renderPane(
      await read($, tree),
      e.props.bodyColumns,
      await $.clock.now(),
      await read($, isAscii),
      (await read($, selectedId)) ?? undefined,
      (await read($, summaryOpen)) ?? undefined,
    )
    const { Box, Button, Text } = $.ui.resolve(e)
    const drawPiece = (isSelected: boolean) => ({ role, text }: Segment) => (
      <Text {...ROLE_PROPS[role]} {...(isSelected ? SELECTED_PROPS : {})}>
        {text}
      </Text>
    )
    // The write to selectedId runs in the press closure, since a ui.render hook may not set state while it draws.
    const drawRow = ({ row, id, selected, summaryFor }: PaneRow, index: number) => {
      const pieces = row.map(drawPiece(selected === true))
      if (summaryFor !== undefined) {
        return (
          <Button plain key={`summary:${summaryFor}:${index}`} onPress={() => update($, summaryOpen, open => (open === summaryFor ? null : summaryFor))}>
            {pieces}
          </Button>
        )
      }
      if (id === undefined) return <Text>{row.length === 0 ? BLANK_ROW : pieces}</Text>

      return (
        <Button plain key={`${id}:${index}`} onPress={() => update($, selectedId, () => id)}>
          {pieces}
        </Button>
      )
    }

    return <Box flexDirection="column">{rows.map(drawRow)}</Box>
  })
}
