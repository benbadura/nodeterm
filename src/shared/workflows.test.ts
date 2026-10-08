import { describe, it, expect } from 'vitest'
import { builtinWorkflows, sanitizeProjectWorkflows, sanitizeWorkflowTemplate } from './workflows'

describe('workflow definitions', () => {
  it('ships three ordered templates with agent, instruction and gate for every stage', () => {
    const workflows = builtinWorkflows('codex')
    expect(workflows.templates.map(t => t.id)).toEqual(['fix-bug', 'add-endpoint', 'update-dependency'])
    expect(sanitizeProjectWorkflows(workflows)).toEqual(workflows)
    for (const template of workflows.templates) {
      expect(template.steps).toHaveLength(6)
      expect(template.steps.every(s => s.agentId === 'codex' && s.transition === 'success' && s.instruction)).toBe(true)
      expect(template.steps.at(-1)?.instruction).toContain('uncommitted')
    }
  })
  it('rejects empty, duplicate, oversized and executable-shaped definitions', () => {
    const template = builtinWorkflows('claude').templates[0]
    expect(sanitizeWorkflowTemplate({ ...template, steps: [] })).toBeUndefined()
    expect(sanitizeWorkflowTemplate({ ...template, steps: [template.steps[0], template.steps[0]] })).toBeUndefined()
    expect(sanitizeWorkflowTemplate({ ...template, steps: [{ ...template.steps[0], instruction: 'x'.repeat(32001) }] })).toBeUndefined()
    expect(sanitizeProjectWorkflows({ templates: [template, template] })).toBeUndefined()
    expect(sanitizeWorkflowTemplate({ ...template, command: 'evil', steps: [{ ...template.steps[0], command: 'evil' }] })).toEqual({ ...template, steps: [template.steps[0]] })
  })
})
