import assert from 'node:assert/strict'
import { prepareTerminalLaunchEnv } from '../src/main/terminalLaunchEnv'

{
  const ambient: NodeJS.ProcessEnv = {
    NO_COLOR: '1',
    KEEP_ME: 'unchanged'
  }
  const explicit = { TERM: 'xterm-ghostty' }

  const prepared = prepareTerminalLaunchEnv(explicit, ambient)

  assert.equal('NO_COLOR' in ambient, false)
  assert.equal(ambient.KEEP_ME, 'unchanged')
  assert.deepEqual(prepared, explicit)
  assert.notEqual(prepared, explicit)
  console.log('✓ ambient NO_COLOR is removed without mutating the explicit surface env')
}

{
  const scopeCases = [
    {
      name: 'global only',
      global: { NO_COLOR: 'global-value', GLOBAL_ONLY: 'g' },
      project: {},
      workspace: {},
      expected: 'global-value'
    },
    {
      name: 'project over global',
      global: { NO_COLOR: 'global-value', GLOBAL_ONLY: 'g' },
      project: { NO_COLOR: 'project-value', PROJECT_ONLY: 'p' },
      workspace: {},
      expected: 'project-value'
    },
    {
      name: 'workspace over project',
      global: { NO_COLOR: 'global-value', GLOBAL_ONLY: 'g' },
      project: { NO_COLOR: 'project-value', PROJECT_ONLY: 'p' },
      workspace: { NO_COLOR: 'workspace-value', WORKSPACE_ONLY: 'w' },
      expected: 'workspace-value'
    },
    {
      name: 'explicit empty workspace value',
      global: { NO_COLOR: 'global-value', GLOBAL_ONLY: 'g' },
      project: { NO_COLOR: 'project-value', PROJECT_ONLY: 'p' },
      workspace: { NO_COLOR: '', WORKSPACE_ONLY: 'w' },
      expected: ''
    }
  ] as const

  for (const { name, global, project, workspace, expected } of scopeCases) {
    const ambient: NodeJS.ProcessEnv = { NO_COLOR: 'ambient-value' }
    const explicit = { ...global, ...project, ...workspace }
    const originalExplicit = { ...explicit }

    const prepared = prepareTerminalLaunchEnv(explicit, ambient)

    assert.equal('NO_COLOR' in ambient, false, `${name}: ambient key should be removed`)
    assert.equal(prepared.NO_COLOR, expected, `${name}: layered explicit value should remain exact`)
    assert.deepEqual(prepared, originalExplicit, `${name}: all scoped keys should survive`)
    assert.deepEqual(explicit, originalExplicit, `${name}: caller input should remain unchanged`)
  }
  console.log('✓ explicit global/project/workspace NO_COLOR values are preserved exactly')
}

console.log('\nAll terminal launch environment assertions passed.')
