import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '..')
const sectionSource = fs.readFileSync(
  path.join(
    repoRoot,
    'src/renderer/src/components/dashboard/settings/OrpheusAgentToolsSection.tsx'
  ),
  'utf8'
)
for (const required of [
  'window.api.controlTools.get()',
  'window.api.controlTools.update({',
  'window.api.controlTools.reset({ target:',
  'role="switch"',
  'aria-expanded={expanded}',
  'return saving || !tool.categoryEnabled',
  'settings.categories.some((category) => category.override !== null)',
  'settings.tools.some((tool) => tool.override !== null)',
  'These are exposure controls, not',
  'permission prompts.'
]) {
  assert.ok(sectionSource.includes(required), `Agent Tools section must include ${required}`)
}

const settingsViewSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/src/components/dashboard/SettingsView.tsx'),
  'utf8'
)
assert.ok(settingsViewSource.includes("id: 'orpheus-agent-tools'"))
assert.ok(settingsViewSource.includes("label: 'Agent Tools'"))

const searchIndexSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/src/components/dashboard/settings/searchIndex.ts'),
  'utf8'
)
assert.ok(searchIndexSource.includes("'orpheus-agent-tools'"))
assert.ok(searchIndexSource.includes("label: 'Individual tools'"))

console.log('agent tools settings UI verification passed')
