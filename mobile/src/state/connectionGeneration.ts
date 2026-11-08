export class ConnectionGeneration {
  private value = 0;
  private writes = Promise.resolve();

  advance(): number {
    this.value += 1;
    return this.value;
  }

  capture(): number {
    return this.value;
  }

  isCurrent(generation: number): boolean {
    return generation === this.value;
  }

  async resolve<T>(generation: number, request: Promise<T>): Promise<T | null> {
    const result = await request;
    return this.isCurrent(generation) ? result : null;
  }

  commit(generation: number, apply: () => void): boolean {
    if (!this.isCurrent(generation)) return false;
    apply();
    return true;
  }

  enqueueWrites(generation: number, steps: Array<() => Promise<void>>): Promise<void> {
    this.writes = this.writes.catch(() => undefined).then(async () => {
      for (const step of steps) {
        if (!this.isCurrent(generation)) break;
        await step();
      }
    });
    return this.writes;
  }
}

export interface AccountBindingWriters {
  saveBaseUrl: (url: string) => Promise<void>;
  saveToken: (token: string | null) => Promise<void>;
  saveOwnerId: (ownerId: string | null) => Promise<void>;
  clearLiveCache: () => Promise<void>;
}

export function persistAccountBinding(
  coordinator: ConnectionGeneration,
  generation: number,
  binding: { baseUrl: string; token: string; ownerId: string },
  writers: AccountBindingWriters,
  saveLiveCache: () => Promise<void>
): Promise<void> {
  return coordinator.enqueueWrites(generation, [
    () => writers.saveBaseUrl(binding.baseUrl),
    () => writers.saveToken(binding.token),
    () => writers.saveOwnerId(binding.ownerId),
    saveLiveCache,
  ]);
}

export function clearAccountBinding(
  coordinator: ConnectionGeneration,
  generation: number,
  writers: AccountBindingWriters,
  baseUrl?: string
): Promise<void> {
  const steps = [
    ...(baseUrl ? [() => writers.saveBaseUrl(baseUrl)] : []),
    () => writers.saveToken(null),
    () => writers.saveOwnerId(null),
    () => writers.clearLiveCache(),
  ];
  return coordinator.enqueueWrites(generation, steps);
}

export function matchesLiveCacheOwner(
  cache: { baseUrl: string; ownerId: string } | null,
  baseUrl: string,
  ownerId: string | null,
  normalizeOrigin: (url: string) => string
): boolean {
  return Boolean(
    cache && ownerId && cache.ownerId === ownerId &&
    normalizeOrigin(cache.baseUrl) === normalizeOrigin(baseUrl)
  );
}

export function shouldRefreshOnResume(previous: string, next: string): boolean {
  return previous !== 'active' && next === 'active';
}

export function shouldRefreshAfterHydration(input: {
  hydrated: boolean;
  mode: 'DEMO' | 'CONNECTED';
  token: string | null;
  generation: number;
  attemptedGeneration: number | null;
}): boolean {
  return Boolean(
    input.hydrated && input.mode === 'CONNECTED' && input.token &&
    input.attemptedGeneration !== input.generation
  );
}
