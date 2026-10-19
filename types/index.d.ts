export type AgentStatus = 'running' | 'done' | 'failed' | 'aborted'

export type Role = AgentStatus | 'dim' | 'plain' | 'title'

export type Segment = { text: string; role: Role }

export type Row = Segment[]

export type PaneRow = { row: Row; id?: string; selected?: boolean; summaryFor?: string }

export type AgentNode = {
  agentId: string
  parentAgentId?: string
  kind?: 'advisor'
  name?: string
  subagentType?: string
  description?: string
  task?: string
  taskCut?: boolean
  status: AgentStatus
  reason?: string
  startedAt?: number
  durationMs?: number
  currentStep?: string
}

export type PendingCompletion = { agentId: string; reason: string; durationMs?: number }

export type AgentTree = { nodes: AgentNode[]; pendingCompletions: PendingCompletion[]; startedAt?: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': { tree: AgentTree; isAscii: boolean; selectedId: string | null; summaryOpen: string | null }
  }
}
