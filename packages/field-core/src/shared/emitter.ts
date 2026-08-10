/**
 * 型付きの最小イベントエミッタ。
 * React の useSyncExternalStore から購読するので、購読解除が確実に効くことだけを重視した。
 */
export type Listener<T> = (payload: T) => void;

export interface Emitter<Events extends Record<string, unknown>> {
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void;
  clear(): void;
  listenerCount(event: keyof Events): number;
}

export function createEmitter<Events extends Record<string, unknown>>(options?: {
  /** リスナが例外を投げても他のリスナを止めない。既定は console.error に流す */
  onListenerError?: (error: unknown, event: keyof Events) => void;
}): Emitter<Events> {
  const map = new Map<keyof Events, Set<Listener<never>>>();
  const onListenerError =
    options?.onListenerError ??
    ((error: unknown, event: keyof Events) => {
      console.error(`[pf-field-core] リスナで例外が発生しました (event=${String(event)})`, error);
    });

  function on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = map.get(event);
    if (!set) {
      set = new Set();
      map.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => off(event, listener);
  }

  function off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    const set = map.get(event);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) map.delete(event);
  }

  function once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const wrapped: Listener<Events[K]> = (payload) => {
      off(event, wrapped);
      listener(payload);
    };
    return on(event, wrapped);
  }

  function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = map.get(event);
    if (!set) return;
    // 通知中に on/off されても壊れないようスナップショットを取る
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (error) {
        onListenerError(error, event);
      }
    }
  }

  return {
    on,
    once,
    emit,
    off,
    clear: () => map.clear(),
    listenerCount: (event) => map.get(event)?.size ?? 0,
  };
}
