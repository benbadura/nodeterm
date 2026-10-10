import type { CanvasNodeState, GitResult, NodeTerminalApi } from '@shared/types'
import { cleanNodeName, EMPTY_NAMING_OUTPUT, NAMING_NODE_KINDS, type NodeNamingContext } from '@shared/node-naming'
import { sessionNameUnchanged } from './sessionRename'

export interface BulkNamingProgress {
  total: number
  completed: number
  changed: number
  skipped: number
  failed: number
  errors: string[]
}

interface BulkNamingIo {
  pty: Pick<NodeTerminalApi['pty'], 'generateName' | 'generateGroupName' | 'generateNodeName'>
  /** Always resolve from the original project, including after a project switch. */
  current(id: string): CanvasNodeState | undefined
  rename(id: string, title: string): void
  tryStart(id: string): boolean
  finish(id: string): void
  progress?(progress: BulkNamingProgress): void
}

export function namingDescendants(nodes: readonly CanvasNodeState[], groupId: string): CanvasNodeState[] {
  const found = new Set<string>([groupId])
  const descendants: CanvasNodeState[] = []
  const visit = (id: string) => {
    for (const node of nodes) {
      if (node.parentId !== id || found.has(node.id)) continue
      found.add(node.id)
      descendants.push(node)
      if (node.kind === 'group') visit(node.id)
    }
  }
  visit(groupId)
  return descendants
}

export function namingContext(node: CanvasNodeState, nodes: readonly CanvasNodeState[]): NodeNamingContext {
  const details = [
    node.text,
    node.cwd && `Folder: ${node.cwd}`,
    node.filePath && `File: ${node.filePath}`,
    node.url && `URL: ${node.url}`,
    node.agentId && `Agent: ${node.agentId}`,
    node.worktree && `Worktree: ${node.worktree.branch}`,
    node.runConfig && `Run: ${JSON.stringify(node.runConfig)}`,
    node.trigger && `Schedule: ${JSON.stringify(node.trigger)}`,
    node.kind === 'group' && `Members: ${namingDescendants(nodes, node.id).map((n) => `${n.kind}: ${n.title}`).join('\n')}`
  ].filter(Boolean).join('\n').slice(0, 8000)
  return { kind: node.kind as NodeNamingContext['kind'], title: node.title, details }
}

async function generate(node: CanvasNodeState, nodes: readonly CanvasNodeState[], io: BulkNamingIo): Promise<GitResult> {
  let result: GitResult | undefined
  if (node.kind === 'terminal') {
    result = await io.pty.generateName(node.id, node.cwd ?? '', node.accountId)
  } else if (node.kind === 'group') {
    const keys = namingDescendants(nodes, node.id).filter((n) => n.kind === 'terminal').map((n) => n.id)
    if (keys.length) result = await io.pty.generateGroupName(keys, node.cwd ?? '')
  }
  if (result && (result.ok || result.message !== EMPTY_NAMING_OUTPUT)) return result
  // The generic request runs locally; a remote folder is display context, never its spawn cwd.
  return io.pty.generateNodeName(namingContext(node, nodes), node.ssh ? '' : node.cwd ?? '', node.accountId)
}

/** Snapshot all persistent kinds, bound concurrency, and retain manual edits made while AI runs. */
export async function nameAllNodes(nodes: readonly CanvasNodeState[], io: BulkNamingIo): Promise<BulkNamingProgress> {
  const targets = nodes.filter((n) => NAMING_NODE_KINDS.has(n.kind))
  const progress: BulkNamingProgress = {
    total: targets.length, completed: 0, changed: 0, skipped: 0, failed: 0, errors: []
  }
  const report = () => io.progress?.({ ...progress, errors: [...progress.errors] })
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const node = targets[next++]
      let locked = false
      try {
        const before = io.current(node.id)
        if (!before || before.title !== node.title || !io.tryStart(node.id)) {
          progress.skipped++
          continue
        }
        locked = true
        const result = await generate(node, nodes, io)
        const current = io.current(node.id)
        if (!current || current.title !== node.title || current.titleAuto !== node.titleAuto) {
          progress.skipped++
        } else if (!result.ok) {
          progress.failed++
          if (progress.errors.length < 3) progress.errors.push(`${node.title}: ${result.message}`)
        } else {
          const name = cleanNodeName(result.message)
          if (!name || sessionNameUnchanged(name, current.title)) progress.skipped++
          else {
            io.rename(node.id, name)
            progress.changed++
          }
        }
      } catch (error) {
        progress.failed++
        if (progress.errors.length < 3) progress.errors.push(`${node.title}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (locked) io.finish(node.id)
        progress.completed++
        report()
      }
    }
  }
  report()
  await Promise.all([worker(), worker()])
  return progress
}

export function summarizeBulkNaming(progress: BulkNamingProgress): string {
  const counts = `AI naming: ${progress.changed} renamed, ${progress.skipped} skipped, ${progress.failed} failed.`
  return progress.errors.length ? `${counts} ${progress.errors.join('; ')}` : counts
}
