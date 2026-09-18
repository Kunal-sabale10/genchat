import { useEffect } from 'react';

export interface ShortcutBinding {
  key: string;
  meta?: boolean; // Cmd on Mac, Ctrl on Win/Linux
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: (e: KeyboardEvent) => void;
  description?: string;
}

/**
 * useKeyboardShortcuts registers global hotkey bindings with automatic
 * modifier normalization (Cmd on macOS vs Ctrl on Windows/Linux) and
 * input field suppression (unless explicit).
 */
export function useKeyboardShortcuts(shortcuts: ShortcutBinding[], enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const isModActive = isMac ? e.metaKey : e.ctrlKey;

      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      for (const shortcut of shortcuts) {
        const matchesKey = e.key.toLowerCase() === shortcut.key.toLowerCase();
        const matchesMeta = shortcut.meta ? isModActive : true;
        const matchesShift = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const matchesAlt = shortcut.alt ? e.altKey : !e.altKey;

        // Skip plain single-key shortcuts when typing in an input (e.g. '/' or '?')
        if (isInputFocused && !shortcut.meta && !shortcut.ctrl) {
          continue;
        }

        if (matchesKey && matchesMeta && matchesShift && matchesAlt) {
          e.preventDefault();
          shortcut.action(e);
          break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, enabled]);
}
