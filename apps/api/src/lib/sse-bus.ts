import { redisSub } from './redis.js';

/**
 * Shared Redis pub/sub fan-out for SSE endpoints.
 *
 * The naive pattern of `redisSub.subscribe(channel)` + `redisSub.on('message', handler)`
 * per HTTP request looks innocent but has a bug when more than one client
 * connects to the same channel: when client A disconnects and calls
 * `redisSub.unsubscribe(channel)`, the SHARED subscriber's channel is gone
 * for everyone — client B silently stops receiving messages.
 *
 * This module fixes that by:
 *   - Maintaining a refcount per channel; only actually `subscribe`/`unsubscribe`
 *     against the Redis subscriber on 0↔1 transitions.
 *   - Registering one shared `message` listener that fans out to all
 *     per-request handlers via a Map<channel, Set<Handler>>.
 *   - Returning a single `unsubscribe()` cleanup function so callers don't
 *     have to remember to both .off() and .unsubscribe().
 *
 * Used by `/api/migrations/:id/events` and `/api/bulk-migrations/:id/events`.
 */

type Handler = (data: string) => void;

const counts = new Map<string, number>();
const handlersByChannel = new Map<string, Set<Handler>>();

// One global message dispatcher — attached lazily on first subscribe.
let globalListenerAttached = false;
function attachGlobalListener(): void {
  if (globalListenerAttached) return;
  globalListenerAttached = true;
  redisSub.on('message', (channel: string, message: string) => {
    const set = handlersByChannel.get(channel);
    if (!set) return;
    // Snapshot to avoid mutation-during-iteration if a handler unsubscribes
    // itself in response to a message (rare but defensive).
    for (const fn of [...set]) {
      try {
        fn(message);
      } catch (e) {
        console.error('[sse-bus] handler threw:', e);
      }
    }
  });
}

/**
 * Subscribe an SSE request's handler to a Redis channel. Returns a function
 * that cleans up both the in-memory handler and (if last subscriber) the
 * upstream Redis subscription.
 */
export async function subscribeSSE(
  channel: string,
  handler: Handler,
): Promise<() => Promise<void>> {
  attachGlobalListener();

  // Register the per-request handler.
  let set = handlersByChannel.get(channel);
  if (!set) {
    set = new Set();
    handlersByChannel.set(channel, set);
  }
  set.add(handler);

  // First subscriber on this channel → tell Redis we want messages.
  const prev = counts.get(channel) ?? 0;
  counts.set(channel, prev + 1);
  if (prev === 0) {
    await redisSub.subscribe(channel);
  }

  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    set!.delete(handler);
    const next = (counts.get(channel) ?? 1) - 1;
    if (next <= 0) {
      counts.delete(channel);
      handlersByChannel.delete(channel);
      await redisSub.unsubscribe(channel).catch(() => {});
    } else {
      counts.set(channel, next);
    }
  };
}
