import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { ContextMenuNativeItem } from '../shared/types'

export async function showContextMenu(
  items: ContextMenuNativeItem[],
  window: BrowserWindow
): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null
    const template: MenuItemConstructorOptions[] = items.map((item) => {
      if ('divider' in item) return { type: 'separator' }
      return {
        label: item.label,
        enabled: item.enabled ?? true,
        click: () => {
          chosen = item.action
        }
      }
    })
    const menu = Menu.buildFromTemplate(template)
    menu.popup({
      window,
      callback: () => resolve(chosen)
    })
  })
}
