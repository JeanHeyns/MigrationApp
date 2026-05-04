import React from 'react'
import { MessageBar, MessageBarBody, MessageBarTitle, Button } from '@fluentui/react-components'

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  handleReset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px' }}>
          <MessageBar intent="error">
            <MessageBarBody>
              <MessageBarTitle>Unexpected error</MessageBarTitle>
              {this.state.error.message}
            </MessageBarBody>
          </MessageBar>
          <Button onClick={this.handleReset} style={{ marginTop: '12px' }}>
            Try again
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
