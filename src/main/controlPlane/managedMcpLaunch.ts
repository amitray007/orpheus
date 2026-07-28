import * as path from 'node:path'
import { FLAG_DELIMITER } from '../../shared/cliFlags'

const MANAGED_SERVER_NAME = 'orpheus-control'

export function buildManagedMcpFlagTokens(resourcesPath: string): ['--mcp-config', string] {
  if (!path.isAbsolute(resourcesPath)) {
    throw new Error('Orpheus resources path must be absolute')
  }

  const command = path.join(resourcesPath, 'bin', 'orpheus-mcp')
  const config = {
    mcpServers: {
      [MANAGED_SERVER_NAME]: {
        type: 'stdio',
        command,
        args: []
      }
    }
  }

  return ['--mcp-config', JSON.stringify(config)]
}

export function buildManagedMcpFlagsString(resourcesPath: string): string {
  return buildManagedMcpFlagTokens(resourcesPath).join(FLAG_DELIMITER)
}
