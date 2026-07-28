import { Menu, type MenuItemConstructorOptions } from 'electron'

export function buildAppMenu(opts: {
  privacyMode: boolean
  onTogglePrivacyMode: (checked: boolean) => void
}): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          id: 'privacy-mode',
          label: 'Privacy Mode',
          type: 'checkbox',
          accelerator: 'CmdOrCtrl+Shift+H',
          checked: opts.privacyMode,
          click: (item) => opts.onTogglePrivacyMode(item.checked)
        }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function setPrivacyModeChecked(checked: boolean): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById('privacy-mode')
  if (item) item.checked = checked
}
