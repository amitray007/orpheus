import { invoke } from '@tauri-apps/api/core';

let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let spawned = false;

function getSlotRect() {
  const slot = document.getElementById('terminal-slot')!;
  const r = slot.getBoundingClientRect();
  const scale = window.devicePixelRatio ?? 1;
  return { x: r.left, y: r.top, w: r.width, h: r.height, scale };
}

async function spawnTerminal() {
  const rect = getSlotRect();
  const status = document.getElementById('status')!;
  try {
    await invoke('spawn_terminal', { rect });
    spawned = true;
    status.textContent = 'Terminal ready';
  } catch (e) {
    status.textContent = `Error: ${e}`;
    console.error('spawn_terminal failed:', e);
  }
}

async function resizeTerminal() {
  if (!spawned) return;
  const rect = getSlotRect();
  try {
    await invoke('resize_terminal', { rect });
  } catch (e) {
    console.error('resize_terminal failed:', e);
  }
}

window.addEventListener('load', () => {
  // One rAF to let layout settle before grabbing DOMRect.
  requestAnimationFrame(() => {
    spawnTerminal();
  });
});

window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resizeTerminal, 50);
});
