import type { ControlToolsReset, ControlToolsUpdate } from '../../shared/types'
import type { ControlToolExposureStore } from '../controlPlane/controlToolExposure'
import { handle } from './handle'

function isUpdate(value: ControlToolsUpdate): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    Object.keys(value).length === 3 &&
    Object.keys(value).every((key) => key === 'target' || key === 'id' || key === 'enabled') &&
    typeof value.id === 'string' &&
    typeof value.enabled === 'boolean' &&
    (value.target === 'category' || value.target === 'tool')
  )
}

function isReset(value: ControlToolsReset): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    ((value.target === 'all' && Object.keys(value).length === 1) ||
      ((value.target === 'category' || value.target === 'tool') &&
        Object.keys(value).length === 2 &&
        Object.keys(value).every((key) => key === 'target' || key === 'id') &&
        typeof value.id === 'string'))
  )
}

export function registerControlToolsIpc(store: ControlToolExposureStore): void {
  handle('controlTools:get', () => store.get())
  handle('controlTools:update', (_event, update) => {
    if (!isUpdate(update)) throw new Error('Invalid control tool update.')
    return store.update(update)
  })
  handle('controlTools:reset', (_event, reset) => {
    if (!isReset(reset)) throw new Error('Invalid control tool reset.')
    return store.reset(reset)
  })
}
