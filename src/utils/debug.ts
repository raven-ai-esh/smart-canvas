type DebugEvent =
  | {
      type: 'keydown';
      t: number;
      key: string;
      code?: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
      alt: boolean;
      activeTag?: string;
      activeIsContentEditable?: boolean;
      ignored?: boolean;
      ignoreReason?: string;
      selection?: { node: string | null; edge: string | null; textBox: string | null };
    }
  | {
      type: 'select';
      t: number;
      kind: 'node' | 'edge' | 'textBox' | 'stack' | 'none';
      id: string | null;
      selection: { node: string | null; edge: string | null; textBox: string | null };
    }
  | {
      type: 'sync_apply';
      t: number;
      source: 'fetch' | 'ws_sync' | 'ws_update';
      localCounts: { nodes: number; edges: number; drawings: number; textBoxes: number };
      remoteCounts: { nodes: number; edges: number; drawings: number; textBoxes: number };
      mergedCounts: { nodes: number; edges: number; drawings: number; textBoxes: number };
      tombstones: { nodes: number; edges: number; drawings: number; textBoxes: number; comments: number; layers?: number };
    }
  | {
      type: 'sync_send';
      t: number;
      requestId: string;
      counts: { nodes: number; edges: number; drawings: number; textBoxes: number };
      tombstones: { nodes: number; edges: number; drawings: number; textBoxes: number; comments: number; layers?: number };
    }
  | {
      type: 'delete_call';
      t: number;
      kind: 'node' | 'edge' | 'drawing' | 'textBox';
      id: string;
      now: number;
      updatedAt?: number;
      tombstone: number;
    }
  | {
      type: 'delete_check';
      t: number;
      kind: 'node' | 'edge' | 'drawing' | 'textBox';
      id: string;
      existsAfter: boolean;
      counts: { nodes: number; edges: number; drawings: number; textBoxes: number };
    };

declare global {
  interface Window {
    __lcDebug?: {
      enabled: boolean;
      events: DebugEvent[];
      log: (e: DebugEvent) => void;
      summary: () => any;
      clear: () => void;
    };
  }
}

function isEnabled() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('debug') === '1') return true;
  } catch {
    // ignore
  }
  try {
    return window.localStorage.getItem('lc_debug') === '1';
  } catch {
    return false;
  }
}

function init() {
  if (typeof window === 'undefined') return;
  if (window.__lcDebug) return;
  window.__lcDebug = {
    enabled: isEnabled(),
    events: [],
    log: (e) => {
      const enabledNow = isEnabled();
      window.__lcDebug!.enabled = enabledNow;
      if (!enabledNow) return;
      window.__lcDebug!.events.push(e);
      try {
        // Compact console output for quick scanning.
        // eslint-disable-next-line no-console
        console.log('[lc-debug]', e);
      } catch {
        // ignore
      }
    },
    summary: () => {
      const events = window.__lcDebug!.events;
      const keydowns = events.filter((e) => e.type === 'keydown') as Extract<DebugEvent, { type: 'keydown' }>[];
      const selects = events.filter((e) => e.type === 'select') as Extract<DebugEvent, { type: 'select' }>[];
      const deletes = events.filter((e) => e.type === 'delete_call') as Extract<DebugEvent, { type: 'delete_call' }>[];
      const checks = events.filter((e) => e.type === 'delete_check') as Extract<DebugEvent, { type: 'delete_check' }>[];

      const last = (arr: any[]) => (arr.length ? arr[arr.length - 1] : null);
      const ignored = keydowns.filter((k) => k.ignored);

      return {
        enabled: window.__lcDebug!.enabled,
        total: events.length,
        keydowns: keydowns.length,
        selects: selects.length,
        ignoredKeydowns: ignored.length,
        deleteCalls: deletes.length,
        deleteChecks: checks.length,
        lastKeydown: last(keydowns),
        lastSelect: last(selects),
        lastDeleteCall: last(deletes),
        lastDeleteCheck: last(checks),
        byKind: deletes.reduce((acc: any, d) => {
          acc[d.kind] = (acc[d.kind] ?? 0) + 1;
          return acc;
        }, {}),
        // Pair the most recent keydown with the next delete_call (rough).
        recentPairs: (() => {
          const pairs: any[] = [];
          const recentKeydowns = keydowns.slice(-30);
          for (const k of recentKeydowns) {
            const nextDelete = deletes.find((d) => d.t >= k.t);
            if (!nextDelete) continue;
            pairs.push({
              keyT: k.t,
              key: k.key,
              ignored: k.ignored ?? false,
              selection: k.selection,
              deleteT: nextDelete.t,
              dtMs: Math.round((nextDelete.t - k.t) * 10) / 10,
              kind: nextDelete.kind,
              id: nextDelete.id,
            });
          }
          return pairs.slice(-10);
        })(),
      };
    },
    clear: () => {
      window.__lcDebug!.events = [];
    },
  };
}

export function debugLog(e: DebugEvent) {
  init();
  window.__lcDebug?.log(e);
}

export function debugEnabled() {
  init();
  return !!window.__lcDebug?.enabled;
}
