import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

function installViewportVars() {
  if (typeof window === 'undefined') return;
  const w = window as any;
  if (w.__livingCanvasViewportVarsInstalled) return;
  w.__livingCanvasViewportVarsInstalled = true;

  const root = document.documentElement;
  let stableW = window.innerWidth;
  let stableH = window.innerHeight;
  let lastOrientation = stableW > stableH ? 'landscape' : 'portrait';

  const isTextEntryFocused = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const setVars = () => {
    const vv = window.visualViewport;
    const layoutW = window.innerWidth;
    const layoutH = window.innerHeight;

    // iOS can briefly report 0 during rotation; avoid collapsing the UI.
    const safeLayoutW = layoutW && layoutW > 200 ? layoutW : stableW;
    const safeLayoutH = layoutH && layoutH > 200 ? layoutH : stableH;

    const orientation = safeLayoutW > safeLayoutH ? 'landscape' : 'portrait';
    const focused = isTextEntryFocused();

    if (orientation !== lastOrientation) {
      stableW = safeLayoutW;
      stableH = safeLayoutH;
      lastOrientation = orientation;
    } else {
      // Don't shrink the app viewport while typing (iOS keyboards/autofill panels),
      // otherwise fixed UI jumps around.
      if (!focused || safeLayoutH >= stableH) stableH = safeLayoutH;
      if (safeLayoutW >= stableW) stableW = safeLayoutW;
    }

    const visualH = vv?.height && vv.height > 200 ? vv.height : safeLayoutH;
    const visualW = vv?.width && vv.width > 200 ? vv.width : safeLayoutW;

    root.style.setProperty('--app-width', `${stableW}px`);
    root.style.setProperty('--app-height', `${stableH}px`);
    root.style.setProperty('--visual-width', `${visualW}px`);
    root.style.setProperty('--visual-height', `${visualH}px`);

    // Expose a stable viewport snapshot for components that need keyboard-safe sizing.
    w.__livingCanvasViewport = {
      appWidth: stableW,
      appHeight: stableH,
      visualWidth: visualW,
      visualHeight: visualH,
    };
  };

  setVars();
  window.addEventListener('resize', setVars, { passive: true });
  window.addEventListener('orientationchange', setVars, { passive: true });
  window.addEventListener('pageshow', setVars, { passive: true });
  document.addEventListener('visibilitychange', setVars, { passive: true });
  document.addEventListener('focusin', setVars, { passive: true });
  document.addEventListener('focusout', () => window.setTimeout(setVars, 60), { passive: true } as any);

  const vv = window.visualViewport;
  vv?.addEventListener?.('resize', setVars, { passive: true } as any);
  vv?.addEventListener?.('scroll', setVars, { passive: true } as any);
}

installViewportVars();

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
