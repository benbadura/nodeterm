import { NodeTimestamps } from './NodeTimestamps'
import { Component, type ComponentType, type ReactNode } from 'react'
import type { NodeProps } from '@xyflow/react'

interface State {
  error: Error | null
}

/**
 * Error boundary for a single canvas node. A throw inside one node renders a small error
 * card instead of crashing the whole React tree (which would blank the entire app).
 */
class Boundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[node error]', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="node-error">
          <span className="node-error__title">This node hit an error</span>
          <span className="node-error__msg">{this.state.error.message}</span>
        </div>
      )
    }
    return this.props.children
  }
}

/** Wrap a custom node component so its errors are isolated to that node. */
export function withNodeBoundary<T extends NodeProps>(Inner: ComponentType<T>): ComponentType<T> {
  return function Wrapped(props: T) {
    return (
      <Boundary>
        <Inner {...props} />
        {props.type !== 'subagent' && props.type !== 'loop' && <NodeTimestamps id={props.id} data={props.data} />}
      </Boundary>
    )
  }
}
