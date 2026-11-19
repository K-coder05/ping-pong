/** A list of listeners you emit values to. One failing listener never stops the others. */
export interface Listeners<T> {
  /** Called with each emitted value. Returns an unsubscribe function. */
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
}

export function createListeners<T>(): Listeners<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value) {
      for (const listener of listeners) {
        try {
          listener(value);
        } catch (error) {
          console.error('Listener failed', error);
        }
      }
    },
  };
}
