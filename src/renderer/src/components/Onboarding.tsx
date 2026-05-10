import { useState, useId } from 'react'
import { Button } from './Button'
import { TextInput } from './TextInput'
import { FormField } from './FormField'

interface OnboardingProps {
  onKeySaved: () => void
}

const steps = [
  {
    n: 1,
    heading: 'Add your Anthropic API key',
    desc: 'One-time setup — stored securely in your macOS Keychain.'
  },
  {
    n: 2,
    heading: 'Add a repository or open an existing folder',
    desc: 'Any git project or plain directory works.'
  },
  {
    n: 3,
    heading: 'Start chatting with Claude',
    desc: 'Your sessions are saved and resumable at any time.'
  }
]

export function Onboarding({ onKeySaved }: OnboardingProps): React.JSX.Element {
  const inputId = useId()

  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [openingFolder, setOpeningFolder] = useState(false)

  async function handleSave(): Promise<void> {
    if (!apiKey.trim() || saving) return
    setSaving(true)
    setSaveError(undefined)
    try {
      await window.api.config.setApiKey(apiKey.trim())
      setKeySaved(true)
      onKeySaved()
    } catch (err) {
      setSaveError('Failed to save key. Please try again.')
      console.error('[onboarding] setApiKey error', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleOpenFolder(): Promise<void> {
    if (!keySaved || openingFolder) return
    setOpeningFolder(true)
    try {
      const path = await window.api.config.openFolder()
      if (path) {
        console.log('[onboarding] folder selected:', path)
        // Real project persistence comes later — log for now.
      }
    } finally {
      setOpeningFolder(false)
    }
  }

  return (
    <div className="flex items-center justify-center w-full h-full">
      {/* Content column — centered, constrained width */}
      <div className="flex flex-col gap-10 w-full max-w-md px-6">
        {/* Brand mark */}
        <div className="flex flex-col gap-2">
          <h1 className="text-5xl font-bold tracking-tight text-text-primary">
            Orpheus<span className="text-accent">.</span>
          </h1>
          <p className="text-sm text-text-secondary">A Mac IDE built around Claude Code.</p>
        </div>

        {/* 3-step explainer */}
        <ol className="flex flex-col gap-5">
          {steps.map(({ n, heading, desc }) => (
            <li key={n} className="flex gap-4 items-start">
              <span
                className="shrink-0 mt-0.5 flex h-6 w-6 items-center justify-center rounded-full
                           bg-accent/10 border border-accent text-accent text-xs font-semibold"
              >
                {n}
              </span>
              <div>
                <p className="text-sm font-medium text-text-primary">{heading}</p>
                <p className="text-xs text-text-muted mt-0.5">{desc}</p>
              </div>
            </li>
          ))}
        </ol>

        {/* API key form — collapses on success */}
        {!keySaved ? (
          <div className="flex flex-col gap-4 rounded-lg bg-surface-raised border border-border-default p-5">
            <FormField
              label="Anthropic API key"
              htmlFor={inputId}
              helper="Stored locally in your macOS Keychain. Get a key at console.anthropic.com."
              error={saveError}
            >
              <TextInput
                id={inputId}
                type="password"
                placeholder="sk-ant-..."
                value={apiKey}
                onChange={setApiKey}
                disabled={saving}
                error={saveError}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormField>

            <Button
              variant="primary"
              size="md"
              disabled={!apiKey.trim()}
              loading={saving}
              onClick={handleSave}
              className="self-start"
            >
              Save key
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-surface-raised border border-border-default px-5 py-3">
            <span className="text-accent text-base">✓</span>
            <p className="text-sm text-text-secondary">API key saved to Keychain.</p>
          </div>
        )}

        {/* Project CTAs */}
        <div className="flex gap-3">
          <Button
            variant="primary"
            size="md"
            disabled={!keySaved}
            onClick={handleOpenFolder}
            loading={openingFolder}
          >
            + Add repository
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={!keySaved}
            onClick={handleOpenFolder}
            loading={openingFolder}
          >
            Open folder…
          </Button>
        </div>

        {/* Keyboard hint */}
        <p className="text-xs text-text-muted">
          <kbd className="font-mono">⌘,</kbd> to open Settings
        </p>
      </div>
    </div>
  )
}
