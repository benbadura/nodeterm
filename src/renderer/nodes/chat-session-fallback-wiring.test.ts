// The ⌘M Chat view (and the context meter) on a node whose hooks never reached this app.
//
// The RULE is pure and tested in `lib/transcriptSession.test.ts`, and ChatPanel's honesty half in
// `ChatPanel.sessionFallback.test.tsx`. What only the source can show is that every place that
// picks "the session to read this node's transcript by" asks that ONE rule — the canvas node, the
// kanban card, the card modal and its live viewer — and hands the panel the `sessionFallback` flag.
// Before this, the canvas node gated Chat on `!!status?.sessionId` alone, so a node whose hook
// events never arrived (an SSH session pinned to a dead hook tunnel) could never open Chat or show
// a meter, while the session id it was launched with sat in `data.agentSessionId`.

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { toKanbanSession } from '../canvas/toKanbanSession'
import { toKanbanSessionState } from '../canvas/toKanbanSessionState'
import type { CanvasNode } from '../state/workspace'
import type { CanvasNodeState } from '@shared/types'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

const terminalNode = read('TerminalNode.tsx')
const cardModal = read('../components/kanban/CardModal.tsx')
const modalTerminal = read('../components/kanban/ModalTerminal.tsx')
const sessionCard = read('../components/kanban/SessionCard.tsx')

describe('chat view session fallback wiring', () => {
  it('the canvas node gates Chat, the ⌘M hint and the meter on the shared rule', () => {
    expect(terminalNode).toContain('transcriptSessionFor({')
    expect(terminalNode).toContain('persisted: data.agentSessionId')
    expect(terminalNode).toMatch(/const chatAvailable = showChat && !!transcript\.sessionId/)
    expect(terminalNode).not.toMatch(/chatAvailable = showChat && !!status\?\.sessionId/)
    expect(terminalNode).toMatch(/useContextEnsure\([^)]*transcript\.sessionId, transcript\.cwd/)
    expect(terminalNode).toMatch(/sessionId=\{transcript\.sessionId\}\s*\n\s*sessionFallback=\{transcript\.fallback\}/)
    expect(terminalNode).toMatch(/sessionId=\{transcript\.sessionId \?\? null\}/)
  })

  it('the card modal uses the same rule for Chat and its meter', () => {
    expect(cardModal).toContain('transcriptSessionFor({')
    expect(cardModal).toContain('persisted: session.spawn.agentSessionId')
    expect(cardModal).toMatch(/canChat\(createdAgent\) && !!transcript\.sessionId/)
    expect(cardModal).toMatch(/sessionId=\{transcript\.sessionId\}\s*\n\s*sessionFallback=\{transcript\.fallback\}/)
    expect(cardModal).toMatch(/<ContextMeter sessionId=\{transcript\.sessionId \?\? null\}/)
  })

  it('the modal viewer and the board card ask it too', () => {
    expect(modalTerminal).toMatch(/transcriptSessionFor\(\{ live: agentSessionId, persisted: spawn\.agentSessionId/)
    expect(sessionCard).toMatch(/transcriptSessionFor\(\{ live: status\?\.sessionId, persisted: session\.spawn\.agentSessionId/)
  })

  it('both card projections carry the persisted id to the board', () => {
    const live = {
      id: 't1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      data: { title: 'x', agentId: 'claude', agentSessionId: 'sess-1' }
    } as unknown as CanvasNode
    expect(toKanbanSession(live)?.spawn.agentSessionId).toBe('sess-1')
    const stored = { id: 't1', kind: 'terminal', agentId: 'claude', agentSessionId: 'sess-1' } as unknown as CanvasNodeState
    expect(toKanbanSessionState(stored)?.spawn.agentSessionId).toBe('sess-1')
  })
})
