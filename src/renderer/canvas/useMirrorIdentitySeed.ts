import { useEffect } from 'react'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { sessionForProject } from '../session/session'
import { identitySeedSignature, planIdentitySeed } from '../lib/identitySeed'

/**
 * Seed the core's agent-status mirror with the node identities this renderer's persisted
 * agentStatus store holds (see `@shared/agent-identity-seed`): once at boot, when the projects
 * store hydrates, and whenever the status store learns a session id. The core fills only nodes it
 * has no session for, so this can never override a hook-fed id.
 *
 * Only projects whose session is THIS core (`window.nodeTerminal`): a relay tab's nodes belong to
 * another machine, and the default status store holds nothing for them anyway. Coalesced on a
 * fixed task boundary (never reset), like `useContextLinkSync`, so a hook burst costs one plan.
 */
export function useMirrorIdentitySeed(): void {
  useEffect(() => {
    const sent = new Set<string>()
    let pending: ReturnType<typeof setTimeout> | undefined
    const update = (): void => {
      const api = window.nodeTerminal
      if (!api?.seedAgentIdentity) return
      const { projects } = useProjects.getState()
      const local = projects.filter((p) => sessionForProject(p.id).api === api)
      const chunks = planIdentitySeed(local, useAgentStatus.getState().byId, sent)
      for (const chunk of chunks) {
        try {
          api.seedAgentIdentity(chunk)
        } catch {
          continue // a mirror side-channel; a failed cast is retried on the next change
        }
        for (const e of chunk) sent.add(identitySeedSignature(e))
      }
    }
    const schedule = (): void => {
      if (pending !== undefined) return
      pending = setTimeout(() => {
        pending = undefined
        update()
      }, 0)
    }
    const offProjects = useProjects.subscribe(schedule)
    const offStatus = useAgentStatus.subscribe(schedule)
    schedule()
    return () => {
      clearTimeout(pending)
      offProjects()
      offStatus()
    }
  }, [])
}
