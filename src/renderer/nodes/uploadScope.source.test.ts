import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * One definition of which ControlMaster a node's file uploads go over (`nodeUploadScope`,
 * TerminalNode.tsx). The terminal drop, the card modal's live viewer and the ⌘M composer's attach
 * each spelled it inline once; a drift between the copies would upload one file to two machines.
 * Source pins: none of the three can be mounted here.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')

describe('nodeUploadScope is the one upload-scope rule', () => {
  it('is defined once, in TerminalNode, and the node drop path uses it', () => {
    const src = read('./TerminalNode.tsx')
    expect(src).toMatch(/export function nodeUploadScope\(ssh: SshConnection \| undefined\): string/)
    expect(src).toMatch(/const dropProjectId = \(\): string => nodeUploadScope\(/)
  })

  it('the card modal viewer and the card modal composer attach use it too', () => {
    expect(read('../components/kanban/ModalTerminal.tsx')).toMatch(/const projectId = nodeUploadScope\(spawn\.ssh\)/)
    expect(read('../components/kanban/CardModal.tsx')).toMatch(/nodeUploadScope\(session\.spawn\.ssh\)/)
  })
})
