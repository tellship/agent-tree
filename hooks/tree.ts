import type { TurnStepServerToolUse, UiOpenResult } from 'claude-code'

import type { AgentNode, AgentStatus, AgentTree, PaneRow, PendingCompletion, Role, Row, Segment } from '../types'

export type TreeEvent =
  | { type: 'session.started'; at?: number }
  | { type: 'session.ended'; reason: string; at?: number }
  | {
      type: 'agent.spawned'
      agentId: string
      parentAgentId?: string
      subagentType?: string
      name?: string
      description?: string
      prompt?: string
      at?: number
    }
  | { type: 'turn.complete'; agentId?: string; reason: string; durationMs?: number }
  | { type: 'turn.stepped'; agentId: string }
  | { type: 'tool.called'; agentId: string; tool: string; input: Readonly<Record<string, unknown>> }
  | { type: 'advisor.consulted'; id: string; agentId?: string; startedAt: number; endedAt?: number; at: number }
  | { type: 'finished.cleared' }

export const EMPTY_HINT = 'No subagents yet. Delegated work appears here.'

export const emptyTree: AgentTree = { nodes: [], pendingCompletions: [] }

// The plugin's own drawing characters. A level is as wide as `blank`, which `trunk` and the connectors match.
type Alphabet = {
  glyph: Record<AgentStatus, string>
  branch: string
  last: string
  trunk: string
  blank: string
  step: string
  advisor: string
  ellipsis: string
  marker: string
  rule: string
}

const UNICODE: Alphabet = {
  glyph: { running: '●', done: '✓', failed: '✗', aborted: '⊘' },
  branch: '├─',
  last: '└─',
  trunk: '│ ',
  blank: '  ',
  step: '↳',
  advisor: '♛',
  ellipsis: '…',
  marker: '›',
  rule: '─',
}

const ASCII: Alphabet = {
  glyph: { running: '*', done: 'v', failed: 'x', aborted: '-' },
  branch: '|--',
  last: '`--',
  trunk: '|  ',
  blank: '   ',
  step: '->',
  advisor: '^',
  ellipsis: '...',
  marker: '>',
  rule: '-',
}

// The first of LC_ALL, LC_CTYPE, LANG that is set decides, as in a C library; none set leaves Unicode.
export const isAsciiLocale = (lcAll: string | undefined, lcCtype: string | undefined, lang: string | undefined): boolean => {
  const locale = [lcAll, lcCtype, lang].find(value => value !== undefined && value !== '')
  return locale !== undefined && !/utf-?8/i.test(locale)
}

const THINKING = 'thinking'
const ADVISOR = 'advisor'
const REDACTED = '[redacted]'
const SUBJECT_LIMIT = 60
const TASK_LIMIT = 2000

// The one field of each tool's input worth showing; any other tool, and any other field, never reaches the pane.
const SUBJECT_FIELD = new Map([
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['Bash', 'command'],
  ['WebFetch', 'url'],
  ['WebSearch', 'query'],
  ['Agent', 'description'],
])

// A header, a named secret, then the well-known key shapes. Named-secret patterns start at the keyword so they stay linear on long input.
const SECRET_PATTERNS: [RegExp, string][] = [
  [/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"']+/gi, `$1${REDACTED}`],
  [/\b(bearer\s+)[\w.~+/=-]+/gi, `$1${REDACTED}`],
  [/((?:api[_-]?key|token|secret|passw(?:or)?d)[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&"']+)/gi, `$1${REDACTED}`],
  [/\bsk-[\w-]{8,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
]

const SECRET_FILE_NAME = /^(\.env(\..+)?|.+\.pem|id_rsa.*|credentials.*)$/i

const maskSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text)

const basenameOf = (token: string): string => token.replace(/^["']|["']$/g, '').split('/').pop() ?? ''

// A secret file wins over masking: its name is all that is shown, so nothing around it can leak.
const shownSubject = (subject: string): string => {
  const names = subject.split(/\s+/).map(basenameOf)
  const secretFile = names.find(name => SECRET_FILE_NAME.test(name))
  return truncate((secretFile ?? maskSecrets(subject)).replace(/\s+/g, ' ').trim(), SUBJECT_LIMIT, UNICODE.ellipsis)
}

// Failing closed: whatever goes wrong while reading or masking the input, only the tool name is shown.
const stepFor = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  try {
    const field = SUBJECT_FIELD.get(tool)
    const subject = field === undefined ? undefined : input[field]
    return typeof subject === 'string' ? `${tool} ${shownSubject(subject)}` : tool
  } catch {
    return tool
  }
}

type StoredTask = Pick<AgentNode, 'task' | 'taskCut'>

// Unlike a step, a prompt keeps its words: only the secret file's token shrinks to its name, and whitespace is untouched.
const maskedTask = (prompt: string): string =>
  maskSecrets(prompt).replace(/\S+/g, token => (SECRET_FILE_NAME.test(basenameOf(token)) ? basenameOf(token) : token))

// Masking runs before the cut so a cut cannot split a secret; the cap counts characters, so a surrogate pair is never halved.
export const storedTask = (prompt: string | undefined): StoredTask => {
  if (typeof prompt !== 'string' || prompt.trim() === '') return {}

  const chars = [...maskedTask(prompt)]
  return chars.length <= TASK_LIMIT ? { task: chars.join('') } : { task: chars.slice(0, TASK_LIMIT).join(''), taskCut: true }
}

const statusFor = (reason: string): AgentStatus => {
  if (reason === 'answer') return 'done'
  if (reason === 'aborted') return 'aborted'
  return 'failed'
}

const updateNode = (tree: AgentTree, agentId: string, change: (node: AgentNode) => AgentNode): AgentTree => ({
  ...tree,
  nodes: tree.nodes.map(node => (node.agentId === agentId ? change(node) : node)),
})

const updateRunning = (tree: AgentTree, agentId: string, patch: Partial<AgentNode>): AgentTree =>
  updateNode(tree, agentId, node => (node.status === 'running' ? { ...node, ...patch } : node))

const completeAgent = (tree: AgentTree, { agentId, reason, durationMs }: PendingCompletion): AgentTree => {
  const status = statusFor(reason)
  return updateNode(tree, agentId, node => ({
    ...node,
    status,
    reason: status === 'failed' ? reason : undefined,
    durationMs,
    currentStep: undefined,
  }))
}

// The spawn result can arrive after the agent's own turn.complete, so an unknown id waits for its spawn.
const holdCompletion = (tree: AgentTree, completion: PendingCompletion): AgentTree => ({
  ...tree,
  pendingCompletions: [...tree.pendingCompletions.filter(p => p.agentId !== completion.agentId), completion],
})

const spawnAgent = (tree: AgentTree, event: Extract<TreeEvent, { type: 'agent.spawned' }>): AgentTree => {
  const held = tree.pendingCompletions.find(p => p.agentId === event.agentId)
  const spawned: AgentTree = {
    ...tree,
    nodes: [
      ...tree.nodes,
      {
        agentId: event.agentId,
        parentAgentId: event.parentAgentId,
        subagentType: event.subagentType,
        name: event.name,
        description: event.description === undefined ? undefined : maskSecrets(event.description),
        ...storedTask(event.prompt),
        status: 'running',
        startedAt: event.at,
      },
    ],
    pendingCompletions: tree.pendingCompletions.filter(p => p.agentId !== event.agentId),
  }
  return held === undefined ? spawned : completeAgent(spawned, held)
}

// The step result lists a consult only once it is over, so it is never running: done with its time, or aborted when it has no end.
const consultAdvisor = (tree: AgentTree, event: Extract<TreeEvent, { type: 'advisor.consulted' }>): AgentTree => {
  const node: AgentNode = {
    agentId: event.id,
    parentAgentId: event.agentId,
    kind: 'advisor',
    name: ADVISOR,
    status: event.endedAt === undefined ? 'aborted' : 'done',
    startedAt: event.startedAt,
    durationMs: (event.endedAt ?? event.at) - event.startedAt,
  }
  return tree.nodes.some(existing => existing.agentId === node.agentId)
    ? updateNode(tree, node.agentId, () => node)
    : { ...tree, nodes: [...tree.nodes, node] }
}

const freshTree = (at: number | undefined): AgentTree => ({ ...emptyTree, startedAt: at })

const abortRunning = (tree: AgentTree, at: number | undefined): AgentTree => ({
  ...tree,
  nodes: tree.nodes.map(node =>
    node.status === 'running'
      ? {
          ...node,
          status: 'aborted',
          currentStep: undefined,
          durationMs: at === undefined || node.startedAt === undefined ? undefined : at - node.startedAt,
        }
      : node,
  ),
})

const ancestorIdsOfRunning = (nodes: AgentNode[]): Set<string> => {
  const parentOf = new Map(nodes.map(node => [node.agentId, node.parentAgentId]))
  const ancestors = new Set<string>()
  for (const node of nodes.filter(n => n.status === 'running')) {
    for (let id = node.parentAgentId; id !== undefined && !ancestors.has(id); id = parentOf.get(id)) {
      ancestors.add(id)
    }
  }
  return ancestors
}

// A finished node stays while anything below it runs, so a running agent never loses its place in the tree.
// The count comes from the same snapshot as the cleared tree, so a write that retries or races cannot skew it.
export const clearFinishedCounted = (tree: AgentTree): { tree: AgentTree; cleared: number } => {
  const ancestors = ancestorIdsOfRunning(tree.nodes)
  const nodes = tree.nodes.filter(node => node.status === 'running' || ancestors.has(node.agentId))
  return { tree: { ...tree, nodes }, cleared: tree.nodes.length - nodes.length }
}

export const applyEvent = (tree: AgentTree, event: TreeEvent): AgentTree => {
  switch (event.type) {
    case 'session.started':
      return tree.startedAt === undefined ? { ...tree, startedAt: event.at } : tree
    case 'session.ended':
      // /clear is the one end followed by no session.start, so only it empties the pane; any other end leaves what ran.
      return event.reason === 'clear' ? freshTree(event.at) : abortRunning(tree, event.at)
    case 'agent.spawned':
      return spawnAgent(tree, event)
    case 'turn.stepped':
      return updateRunning(tree, event.agentId, { currentStep: THINKING })
    case 'tool.called':
      return updateRunning(tree, event.agentId, { currentStep: stepFor(event.tool, event.input) })
    case 'turn.complete': {
      // Without an agentId this is the main loop's turn, which is not a node here.
      if (event.agentId === undefined) return tree
      const completion = { agentId: event.agentId, reason: event.reason, durationMs: event.durationMs }
      return tree.nodes.some(node => node.agentId === event.agentId)
        ? completeAgent(tree, completion)
        : holdCompletion(tree, completion)
    }
    case 'advisor.consulted':
      return consultAdvisor(tree, event)
    case 'finished.cleared':
      return clearFinishedCounted(tree).tree
  }
}

export const advisorEvents = (uses: readonly TurnStepServerToolUse[] | undefined, agentId: string | undefined, at: number): TreeEvent[] =>
  (uses ?? [])
    .filter(use => use.name === ADVISOR)
    .map(({ id, startedAt, endedAt }): TreeEvent => ({ type: 'advisor.consulted', id, agentId, startedAt, endedAt, at }))

export const hasRunning = (tree: AgentTree): boolean => tree.nodes.some(node => node.status === 'running')

export const commandOutput = (opened: UiOpenResult): { text?: string } =>
  opened.isPlaced ? {} : { text: `Agents pane is open but not drawn: ${opened.reason}` }

export const closeOutput = (wasOpen: boolean): { text: string } => ({
  text: wasOpen ? 'Closed the agents pane.' : 'The agents pane is not open.',
})

export const clearOutput = (cleared: number): { text: string } => {
  if (cleared === 0) return { text: 'No finished agents to clear.' }
  return { text: `Cleared ${cleared} finished ${cleared === 1 ? 'agent' : 'agents'}.` }
}

const truncate = (text: string, columns: number, ellipsis: string): string => {
  const chars = [...text]
  return chars.length <= columns ? text : `${chars.slice(0, Math.max(columns - ellipsis.length, 0)).join('')}${ellipsis}`
}

const twoDigits = (n: number): string => String(n).padStart(2, '0')

export const formatElapsed = (ms: number): string => {
  const seconds = Math.floor(Math.max(ms, 0) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${twoDigits(minutes % 60)}m`
  if (minutes > 0) return `${minutes}m ${twoDigits(seconds % 60)}s`
  return `${seconds}s`
}

const FLIGHTDECK_AGENT_CAP = 24
const DEPTH_CAP = 4
const NARROW_BELOW = 30
const GLYPH_ONLY_BELOW = 16
const WIDEN_HINT = 'widen terminal'
const GUTTER = 2
const DETAIL_LABEL_WIDTH = 9
const ADVISOR_NOTE = 'Advisor input and answer are not shown.'
const HINT_NONE = ['Click an agent to see its details.', 'Keys: ctrl+x tab, then Tab, Enter.']
const HINT_SELECTED = 'Tab next row  Enter show  esc back'
const HINT_SELECTED_NARROW = 'Tab next  Enter  esc back'
const SUMMARY_SHOW = '[ Summary ]'
const SUMMARY_HIDE = '[ Hide summary ]'
const NO_TASK_TEXT = 'No task text.'
const TASK_CUT_NOTE = 'Cut at 2,000 characters.'

type Siblings = Map<string | undefined, AgentNode[]>
type View = { columns: number; now: number; folded: ReadonlySet<string>; alphabet: Alphabet; gutter: number; selectedId?: string }
type Selection = { selectedId: string | undefined }

type Cell = { char: string; role: Role }

const cellsOf = (segments: Segment[]): Cell[] =>
  segments.flatMap(({ text, role }) => [...text].map(char => ({ char, role })))

const regroup = (cells: Cell[]): Row =>
  cells.reduce<Row>((line, { char, role }) => {
    const last = line.at(-1)
    return last?.role === role ? [...line.slice(0, -1), { role, text: last.text + char }] : [...line, { role, text: char }]
  }, [])

const segment = (role: Role, text: string): Segment => ({ role, text })

const row = (...segments: Segment[]): Row => regroup(cellsOf(segments))

const dimRow = (text: string): Row => row(segment('dim', text))

const rowText = (line: Row): string => line.map(({ text }) => text).join('')

const cut = (line: Row, columns: number, ellipsis: string): Row => {
  const cells = cellsOf(line)
  if (cells.length <= columns) return line

  const kept = cells.slice(0, Math.max(columns - ellipsis.length, 0))
  const { role: replacedRole } = cells[kept.length]!
  return regroup([...kept, ...[...ellipsis].map(char => ({ char, role: replacedRole }))])
}

const fit = (line: Row, { columns, gutter, alphabet }: View): Row => cut(line, columns - gutter, alphabet.ellipsis)

const asPaneRow = (line: Row): PaneRow => ({ row: line })

const guttered = (line: Row, { gutter }: View, marker = '  '): Row => (gutter === 0 ? line : row(segment('plain', marker), ...line))

const dimPaneRow = (text: string, view: View): PaneRow => asPaneRow(guttered(fit(dimRow(text), view), view))

const nodePaneRow = (line: Row, node: AgentNode, view: View): PaneRow => {
  if (view.gutter === 0) return asPaneRow(line)

  const selected = node.agentId === view.selectedId
  return { row: guttered(line, view, selected ? `${view.alphabet.marker} ` : '  '), id: node.agentId, selected }
}

const keepTail = (line: Row, columns: number): Row => regroup(cellsOf(line).slice(-columns))

// A running node counts up from its spawn; a finished one stays at the duration it ended with.
const elapsedMs = (node: AgentNode, now: number): number | undefined =>
  node.status === 'running' ? (node.startedAt === undefined ? undefined : now - node.startedAt) : node.durationMs

const mainLabel = (tree: AgentTree, now: number): string =>
  tree.startedAt === undefined ? 'Main' : `Main ${formatElapsed(now - tree.startedAt)}`

const titleOf = (node: AgentNode): string => node.name || node.subagentType || 'agent'

const labelOf = (node: AgentNode, { advisor }: Alphabet): string => {
  const title = titleOf(node)
  const description = node.description?.replace(/\s+/g, ' ').trim()
  const label = description ? `${title}: ${description}` : title
  return node.kind === 'advisor' ? `${advisor} ${label}` : label
}

// Status and time lead the line so a cut to the pane's width takes the description, never the status.
// Under 30 columns the reason goes next, then the status word; under 16 only the glyph is left.
// The leftmost stems give way before the glyph or the time does.
const nodeLine = (node: AgentNode, prefix: string, view: View): Row => {
  const { columns, gutter, now, alphabet } = view
  const width = columns - gutter
  const glyph = alphabet.glyph[node.status]
  const connector = segment('dim', `${prefix} `)
  const status = (text: string) => segment(node.status, text)
  if (columns < GLYPH_ONLY_BELOW) return keepTail(row(connector, status(glyph)), width)

  const reason = node.reason === undefined ? '' : ` (${node.reason})`
  const elapsed = elapsedMs(node, now)
  const time = segment('plain', elapsed === undefined ? '' : ` ${formatElapsed(elapsed)}`)
  const full = row(connector, status(`${glyph} ${node.status}${reason}`), time)
  const withoutReason = row(connector, status(`${glyph} ${node.status}`), time)
  const bare = row(connector, status(glyph), time)
  const head = columns < NARROW_BELOW ? [full, withoutReason, bare].find(line => [...rowText(line)].length < width) : full

  return head === undefined ? keepTail(bare, width) : fit(row(...head, segment('plain', ` ${labelOf(node, alphabet)}`)), view)
}

// A parent not (yet) in the list files its children under Main, so a late parent re-parents them on the next draw.
const groupByParent = (nodes: AgentNode[]): Siblings => {
  const known = new Set(nodes.map(node => node.agentId))
  const groups: Siblings = new Map()
  for (const node of nodes) {
    const parent = node.parentAgentId !== undefined && known.has(node.parentAgentId) ? node.parentAgentId : undefined
    groups.set(parent, [...(groups.get(parent) ?? []), node])
  }
  return groups
}

const subtreeSize = (groups: Siblings, node: AgentNode): number =>
  1 + (groups.get(node.agentId) ?? []).reduce((total, child) => total + subtreeSize(groups, child), 0)

const isAllDone = (groups: Siblings, node: AgentNode): boolean =>
  node.status === 'done' && (groups.get(node.agentId) ?? []).every(child => isAllDone(groups, child))

// The topmost nodes whose whole subtree is done; a failed or aborted node below keeps its ancestors out of this.
const doneSubtreeRoots = (groups: Siblings, parent: string | undefined): AgentNode[] =>
  (groups.get(parent) ?? []).flatMap(node => (isAllDone(groups, node) ? [node] : doneSubtreeRoots(groups, node.agentId)))

// Indentation stops growing at DEPTH_CAP; a deeper row says how far past it sits in place of its last stems.
const shownIndent = (indent: string, depth: number, { blank, ellipsis }: Alphabet): string => {
  if (depth <= DEPTH_CAP) return indent
  const marker = `${ellipsis}${depth - DEPTH_CAP}`
  return indent.slice(0, blank.length * (DEPTH_CAP - 1) - marker.length) + marker
}

const branchLines = (groups: Siblings, parent: string | undefined, indent: string, depth: number, view: View): PaneRow[] => {
  const siblings = groups.get(parent) ?? []
  const shown = siblings.filter(node => !view.folded.has(node.agentId))
  const foldedAgents = siblings
    .filter(node => view.folded.has(node.agentId))
    .reduce((total, node) => total + subtreeSize(groups, node), 0)
  const { alphabet } = view
  const lead = shownIndent(indent, depth, alphabet)
  const summary =
    foldedAgents === 0
      ? []
      : [dimPaneRow(`${lead}${shown.length === 0 ? alphabet.last : alphabet.branch} ${alphabet.glyph.done} ${foldedAgents} done`, view)]

  return [
    ...summary,
    ...shown.flatMap((node, index) => {
      const isLast = index === shown.length - 1
      const stem = isLast ? alphabet.blank : alphabet.trunk
      // The cut that kept a long tool input to SUBJECT_LIMIT was stored as …, whichever alphabet draws it.
      const step =
        node.currentStep !== undefined && view.columns >= GLYPH_ONLY_BELOW
          ? [dimPaneRow(`${lead}${stem} ${alphabet.step} ${node.currentStep.replaceAll(UNICODE.ellipsis, alphabet.ellipsis)}`, view)]
          : []
      return [
        nodePaneRow(nodeLine(node, `${lead}${isLast ? alphabet.last : alphabet.branch}`, view), node, view),
        ...step,
        ...branchLines(groups, node.agentId, `${indent}${stem}`, depth + 1, view),
      ]
    }),
  ]
}

// Above Flightdeck's cap, finished subtrees fold into summary rows and the footer says how many agents are still drawn.
const drawTree = (tree: AgentTree, columns: number, now: number, isAscii: boolean, selection?: Selection): PaneRow[] => {
  if (tree.nodes.length === 0) return [asPaneRow(row(segment('plain', mainLabel(tree, now)))), asPaneRow(dimRow(EMPTY_HINT))]

  const groups = groupByParent(tree.nodes)
  const overflowing = tree.nodes.length > FLIGHTDECK_AGENT_CAP
  const foldedRoots = overflowing ? doneSubtreeRoots(groups, undefined) : []
  const foldedAgents = foldedRoots.reduce((total, root) => total + subtreeSize(groups, root), 0)
  const view: View = {
    columns,
    now,
    folded: new Set(foldedRoots.map(root => root.agentId)),
    alphabet: isAscii ? ASCII : UNICODE,
    gutter: selection !== undefined && columns >= GLYPH_ONLY_BELOW ? GUTTER : 0,
    selectedId: selection?.selectedId,
  }
  const flush: View = { ...view, gutter: 0 }
  const footer = overflowing
    ? [asPaneRow(row()), dimPaneRow(`showing ${tree.nodes.length - foldedAgents} of ${tree.nodes.length}`, flush)]
    : []
  const widenHint = columns < GLYPH_ONLY_BELOW ? [asPaneRow(row()), dimPaneRow(WIDEN_HINT, flush)] : []

  return [asPaneRow(row(segment('plain', mainLabel(tree, now)))), ...branchLines(groups, undefined, '', 1, view), ...footer, ...widenHint]
}

export const renderRows = (tree: AgentTree, columns: number, now: number, isAscii = false): Row[] =>
  drawTree(tree, columns, now, isAscii).map(pane => pane.row)

export const renderLines = (tree: AgentTree, columns: number, now: number, isAscii = false): string[] =>
  renderRows(tree, columns, now, isAscii).map(rowText)

// Words are split on any whitespace, so a run of it becomes one space; a word wider than the line is cut into line-wide pieces.
export const wrapText = (text: string, width: number): string[] => {
  const room = Math.max(width, 1)
  const lines: string[] = []
  let current = ''

  for (const word of text.split(/\s+/).filter(piece => piece !== '')) {
    if (current !== '' && [...current].length + 1 + [...word].length <= room) {
      current = `${current} ${word}`
      continue
    }
    if (current !== '') lines.push(current)

    const chars = [...word]
    while (chars.length > room) lines.push(chars.splice(0, room).join(''))
    current = chars.join('')
  }

  return current === '' ? lines : [...lines, current]
}

const PARAGRAPH_BREAK = /\r?\n\s*\r?\n/
const ITEM = /^(?:([-*•–])|(\d+[.)]))\s+(.+)$/u
// A sentence ends at . ! or ? before whitespace and a capital, a digit or an opening quote.
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[\p{Lu}\d"'“‘])/u
const ABBREVIATION = /(?:^|[^\p{L}.])(?:e\.g|i\.e|etc|vs|mr)\.$/iu

// A break the split made after an abbreviation is put back.
const sentencesOf = (text: string): string[] =>
  text.split(SENTENCE_BREAK).reduce<string[]>((sentences, piece) => {
    const previous = sentences.at(-1)
    return previous !== undefined && ABBREVIATION.test(previous)
      ? [...sentences.slice(0, -1), `${previous} ${piece}`]
      : [...sentences, piece]
  }, [])

const itemLines = (marker: string, body: string, width: number): string[] =>
  wrapText(body, width - marker.length).map((line, index) => (index === 0 ? marker : ' '.repeat(marker.length)) + line)

const reflowLine = (line: string, width: number): string[] => {
  const [, bullet, number, body] = ITEM.exec(line) ?? []
  if (body !== undefined) return itemLines(bullet === undefined ? `${number} ` : '- ', body, width)

  return sentencesOf(line).flatMap(sentence => wrapText(sentence, width))
}

// One line per sentence, bullet or numbered item; a run of blank lines is one blank row. Never cut, so never an ellipsis.
export const summaryLines = (text: string, width: number): string[] =>
  text
    .trim()
    .split(PARAGRAPH_BREAK)
    .flatMap((paragraph, index) => [
      ...(index === 0 ? [] : ['']),
      ...paragraph.split(/\r?\n/).flatMap(line => reflowLine(line.trim(), width)),
    ])

const describedRows = (node: AgentNode, columns: number, isNarrow: boolean): Row[] => {
  const isAdvisor = node.kind === 'advisor'
  const text = isAdvisor ? ADVISOR_NOTE : node.description?.replace(/\s+/g, ' ').trim()
  if (!text) return []

  const heading = isNarrow || isAdvisor ? [] : [dimRow('Description')]
  return [row(), ...heading, ...wrapText(text, columns).map(line => row(segment('plain', line)))]
}

export const detailRows = (node: AgentNode, parentLabel: string, now: number, columns: number, isAscii: boolean): Row[] => {
  const alphabet = isAscii ? ASCII : UNICODE
  const isNarrow = columns < NARROW_BELOW
  const field = (label: string, value: string, role: Role = 'plain') => {
    const labelWidth = isNarrow ? label.length + 1 : DETAIL_LABEL_WIDTH
    return wrapText(value, columns - labelWidth).map((text, index) =>
      row(segment('dim', index === 0 ? label.padEnd(labelWidth) : ' '.repeat(labelWidth)), segment(role, text)),
    )
  }
  const heading = node.kind === 'advisor' ? `${alphabet.advisor} ${titleOf(node)}` : titleOf(node)
  const reason = node.reason === undefined ? '' : ` (${node.reason})`
  const elapsed = elapsedMs(node, now)
  const step = node.currentStep?.replaceAll(UNICODE.ellipsis, alphabet.ellipsis)

  return [
    ...wrapText(heading, columns).map(line => row(segment('title', line))),
    ...(isNarrow ? [] : field('Kind', node.kind === 'advisor' ? heading : 'subagent')),
    ...field('Status', `${alphabet.glyph[node.status]} ${node.status}${reason}`, node.status),
    ...(elapsed === undefined ? [] : field('Elapsed', formatElapsed(elapsed))),
    ...(step === undefined ? [] : field('Step', step)),
    ...(isNarrow ? [] : [...field('Parent', parentLabel), ...field('Id', node.agentId)]),
    ...describedRows(node, columns, isNarrow),
  ]
}

// The cap marker is joined to the last word that was kept, so it wraps with it and never stands alone.
const summaryRows = (task: string, isCut: boolean, columns: number, { ellipsis }: Alphabet): Row[] => {
  const text = isCut ? `${task.trimEnd()}${ellipsis}` : task
  const lines = summaryLines(text, columns).map(line => (line === '' ? row() : row(segment('plain', line))))

  return [row(), dimRow('Task'), ...lines, ...(isCut ? [row(), dimRow(TASK_CUT_NOTE)] : [])]
}

// The advisor has no task, so it gets neither the button nor the line.
const taskRows = (node: AgentNode, columns: number, isOpen: boolean, alphabet: Alphabet): PaneRow[] => {
  if (node.kind === 'advisor') return []
  if (node.task === undefined) return [row(), dimRow(NO_TASK_TEXT)].map(asPaneRow)

  const button: PaneRow = { row: row(segment('plain', isOpen ? SUMMARY_HIDE : SUMMARY_SHOW)), summaryFor: node.agentId }
  const opened = isOpen ? summaryRows(node.task, node.taskCut === true, columns, alphabet).map(asPaneRow) : []
  return [asPaneRow(row()), button, ...opened]
}

const hintRows = (hints: string[], columns: number): Row[] =>
  hints.flatMap(hint => ([...hint].length <= columns ? [hint] : wrapText(hint, columns))).map(dimRow)

// The selection is whatever `selectedId` finds in the tree now, so an agent that is gone leaves nothing selected.
export const renderPane = (
  tree: AgentTree,
  columns: number,
  now: number,
  isAscii: boolean,
  selectedId: string | undefined,
  openSummaryId?: string,
): PaneRow[] => {
  const treeRows = drawTree(tree, columns, now, isAscii, { selectedId })
  if (tree.nodes.length === 0 || columns < GLYPH_ONLY_BELOW) return treeRows

  const alphabet = isAscii ? ASCII : UNICODE
  const selected = tree.nodes.find(node => node.agentId === selectedId)
  const hint = columns < NARROW_BELOW ? HINT_SELECTED_NARROW : HINT_SELECTED
  // A parent that is not in the list is filed under Main, as the tree does.
  const parent = tree.nodes.find(candidate => candidate.agentId === selected?.parentAgentId)
  const below =
    selected === undefined
      ? hintRows(HINT_NONE, columns).map(asPaneRow)
      : [
          ...detailRows(selected, parent === undefined ? 'Main' : titleOf(parent), now, columns, isAscii).map(asPaneRow),
          ...taskRows(selected, columns, selected.agentId === openSummaryId, alphabet),
          asPaneRow(row()),
          ...hintRows([hint], columns).map(asPaneRow),
        ]

  return [...treeRows, ...[row(), dimRow(alphabet.rule.repeat(columns))].map(asPaneRow), ...below]
}
