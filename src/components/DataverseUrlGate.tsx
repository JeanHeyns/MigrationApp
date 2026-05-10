import { useEffect, useState } from 'react'
import {
  Button,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../app/MigrationContext'
import {
  resolveDataverseOrgUrl,
  setManualDataverseOrgUrl,
} from '../services/environmentResolver'
import { DATAVERSE_URL_VARIABLE_DISPLAY_NAME } from '../config/environmentVariableConfig'

interface DataverseUrlGateProps {
  children: React.ReactNode
}

const useStyles = makeStyles({
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: tokens.colorNeutralBackground2,
    padding: '32px',
  },
  panel: {
    width: '100%',
    maxWidth: '560px',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow16,
    padding: '28px',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
  },
  title: {
    margin: 0,
    fontSize: '20px',
    lineHeight: '28px',
    fontWeight: 600,
    color: tokens.colorNeutralForeground1,
  },
  body: {
    margin: 0,
    fontSize: '14px',
    lineHeight: '20px',
    color: tokens.colorNeutralForeground2,
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  help: {
    margin: 0,
    fontSize: '12px',
    lineHeight: '18px',
    color: tokens.colorNeutralForeground3,
  },
  loading: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    fontSize: '14px',
    color: tokens.colorNeutralForeground2,
  },
})

export function DataverseUrlGate({ children }: DataverseUrlGateProps) {
  const {
    dataverseOrgUrl,
    dataverseUrlSource,
    dataverseUrlError,
    setResolvedDataverseUrl,
    setDataverseUrlError,
  } = useMigration()
  const styles = useStyles()

  useEffect(() => {
    let cancelled = false

    resolveDataverseOrgUrl()
      .then(({ url, source }) => {
        if (!cancelled) setResolvedDataverseUrl(url, source)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDataverseUrlError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [setDataverseUrlError, setResolvedDataverseUrl])

  if (dataverseUrlSource === 'loading') {
    return (
      <div className={styles.root}>
        <div className={styles.panel}>
          <div className={styles.loading}>
            <Spinner size="small" />
            <span>Resolving environment configuration...</span>
          </div>
        </div>
      </div>
    )
  }

  if (!dataverseOrgUrl) {
    return <ManualUrlInput error={dataverseUrlError} />
  }

  return <>{children}</>
}

function ManualUrlInput({ error }: { error: string | null }) {
  const styles = useStyles()
  const { setResolvedDataverseUrl, setDataverseUrlError } = useMigration()
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSubmitting(true)

    try {
      const url = await setManualDataverseOrgUrl(input)
      setResolvedDataverseUrl(url, 'manualInput')
    } catch (submitError) {
      setDataverseUrlError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={styles.root}>
      <section className={styles.panel} aria-labelledby="dataverse-url-title">
        <div>
          <h1 id="dataverse-url-title" className={styles.title}>
            Configure Dataverse Environment
          </h1>
          <p className={styles.body}>
            The app needs the Dataverse organization URL for direct metadata and schedule API calls.
            Configure the {DATAVERSE_URL_VARIABLE_DISPLAY_NAME} solution variable, or enter the URL for this browser.
          </p>
        </div>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}

        <form className={styles.form} onSubmit={handleSubmit}>
          <Field label="Dataverse organization URL" required>
            <Input
              value={input}
              onChange={(_, data) => setInput(data.value)}
              placeholder="https://your-org.crm4.dynamics.com"
              disabled={submitting}
            />
          </Field>

          <div className={styles.actions}>
            <Button appearance="primary" type="submit" disabled={!input.trim() || submitting}>
              {submitting ? 'Validating...' : 'Validate & Continue'}
            </Button>
          </div>
        </form>

        <p className={styles.help}>
          Need help? Contact your admin to configure the solution variable.
        </p>
      </section>
    </div>
  )
}
