import { invoke } from '@tauri-apps/api/core';

// Workspace IDs for the two test surfaces.
const WS_A = 'workspace-a';
const WS_B = 'workspace-b';

let activeWorkspace: string | null = null;
let mounted = new Set<string>();

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function getSlotRect() {
  const slot = document.getElementById('terminal-slot')!;
  const r = slot.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

async function mountWorkspace(workspaceId: string) {
  const rect = getSlotRect();
  const scale = window.devicePixelRatio ?? 1;
  const status = document.getElementById('status')!;
  try {
    const result = await invoke<{ workspace_id: string; created: boolean }>('mount_terminal', {
      args: { workspace_id: workspaceId, rect, scale, cwd: null, command: null },
    });
    mounted.add(workspaceId);
    activeWorkspace = workspaceId;
    status.textContent = `Mounted ${workspaceId} (created=${result.created})`;
  } catch (e) {
    status.textContent = `mount error: ${e}`;
    console.error('mount_terminal failed:', e);
  }
}

async function hideWorkspace(workspaceId: string) {
  const status = document.getElementById('status')!;
  try {
    await invoke('hide_terminal', { workspaceId });
    if (activeWorkspace === workspaceId) activeWorkspace = null;
    status.textContent = `Hidden ${workspaceId}`;
  } catch (e) {
    status.textContent = `hide error: ${e}`;
  }
}

async function destroyWorkspace(workspaceId: string) {
  const status = document.getElementById('status')!;
  try {
    await invoke('destroy_terminal', { workspaceId });
    mounted.delete(workspaceId);
    if (activeWorkspace === workspaceId) activeWorkspace = null;
    status.textContent = `Destroyed ${workspaceId}`;
  } catch (e) {
    status.textContent = `destroy error: ${e}`;
  }
}

async function resizeActive() {
  if (!activeWorkspace) return;
  const rect = getSlotRect();
  const scale = window.devicePixelRatio ?? 1;
  try {
    await invoke('resize_terminal', {
      args: { workspace_id: activeWorkspace, rect, scale },
    });
  } catch (e) {
    console.error('resize_terminal failed:', e);
  }
}

window.addEventListener('load', () => {
  requestAnimationFrame(() => mountWorkspace(WS_A));

  document.getElementById('btn-mount-a')?.addEventListener('click', () => mountWorkspace(WS_A));
  document.getElementById('btn-mount-b')?.addEventListener('click', () => mountWorkspace(WS_B));
  document.getElementById('btn-hide-a')?.addEventListener('click', () => hideWorkspace(WS_A));
  document.getElementById('btn-hide-b')?.addEventListener('click', () => hideWorkspace(WS_B));
  document.getElementById('btn-destroy-a')?.addEventListener('click', () => destroyWorkspace(WS_A));
  document.getElementById('btn-destroy-b')?.addEventListener('click', () => destroyWorkspace(WS_B));
});

window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeActive, 50);
});
