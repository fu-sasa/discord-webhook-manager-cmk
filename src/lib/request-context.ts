import { AsyncLocalStorage } from 'node:async_hooks';
import type { CurrentUser } from './html.js';

export interface RequestContext {
  user: CurrentUser | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Carries the signed-in identity for the duration of a request so `layout()` can
 * render the header without every page renderer having to thread it through.
 * Established in an `onRequest` hook; the stored object is mutated once the
 * session is resolved.
 */
export function runWithContext(ctx: RequestContext, fn: () => void): void {
  storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setCurrentUser(user: CurrentUser | null): void {
  const ctx = storage.getStore();
  if (ctx) ctx.user = user;
}

export function currentUser(): CurrentUser | null {
  return storage.getStore()?.user ?? null;
}
