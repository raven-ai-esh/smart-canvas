import { useEffect } from 'react';
import { useStore } from '../store/useStore';

export function useAuth() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch('/api/auth/me');
      if (!res.ok) return;
      const data = await res.json();
      if (cancelled) return;
      const user = data?.user;
      if (!user) {
        useStore.getState().setMe(null);
        window.dispatchEvent(new Event('auth-changed'));
        return;
      }
      useStore.getState().setMe({
        id: String(user.id ?? ''),
        email: String(user.email ?? ''),
        name: String(user.name ?? ''),
        avatarSeed: String(user.avatarSeed ?? ''),
        avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
        verified: !!user.verified,
      });
      window.dispatchEvent(new Event('auth-changed'));
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
}
