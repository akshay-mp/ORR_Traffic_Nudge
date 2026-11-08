import {
  INSTALLATION_ID_STORAGE_KEY,
  OWNER_STORAGE_KEY,
  PENDING_CLEANUP_STORAGE_KEY,
  type NativePushAccount,
  type NativePushPorts,
  type NativePushResult,
} from './nativePushContract';

interface OwnerRecord {
  accountId: string;
  apiOrigin: string;
}

interface PendingCleanup {
  installationId: string;
  owner: OwnerRecord;
}

function sameOwner(left: OwnerRecord | null, right: OwnerRecord): boolean {
  return !!left && left.accountId === right.accountId && left.apiOrigin === right.apiOrigin;
}

function sameCleanup(left: PendingCleanup | null, right: PendingCleanup): boolean {
  return !!left && left.installationId === right.installationId && sameOwner(left.owner, right.owner);
}

export class NativePushCoordinator {
  private generation = 0;
  private statusGeneration = 0;
  private mutationRevision = 0;
  private mutationQueue: Promise<void> = Promise.resolve();
  private generationWaiters = new Map<number, Set<() => void>>();

  constructor(private readonly ports: NativePushPorts) {}

  invalidateInFlight(): void {
    this.advanceGeneration();
  }

  enable(
    account: NativePushAccount,
    options: { consent: boolean; previousOwnerAccount?: NativePushAccount; requestPermission?: boolean }
  ): Promise<NativePushResult> {
    const generation = this.advanceGeneration();
    return this.enqueueMutation(() => this.enableOperation(account, options, generation));
  }

  private async enableOperation(
    account: NativePushAccount,
    options: { consent: boolean; previousOwnerAccount?: NativePushAccount; requestPermission?: boolean },
    generation: number
  ): Promise<NativePushResult> {
    if (!this.isCurrent(generation)) return this.result('error', null, 'api');
    const unsupported = this.unsupportedResult();
    if (unsupported) return unsupported;
    if (!options.consent) return this.result('consent-required');

    let installationId: string;
    try {
      installationId = await this.getOrCreateInstallationId();
    } catch {
      return this.result('error', null, 'storage');
    }
    if (!this.isCurrent(generation)) return this.result('error', installationId, 'api');

    const owner = await this.readOwner();
    const pending = await this.readPending();
    if (pending) {
      if (!sameOwner(pending.owner, account)) {
        const previous = options.previousOwnerAccount;
        if (!previous || !sameOwner(pending.owner, previous)) {
          return this.result('pending-cleanup', installationId, undefined, true);
        }
        if (!(await this.removeOwnedDevice(previous, pending))) {
          return this.result('pending-cleanup', installationId, 'cleanup', true);
        }
      } else if (!(await this.removeOwnedDevice(account, pending))) {
        return this.result('pending-cleanup', installationId, 'cleanup', true);
      }
    } else if (owner && !sameOwner(owner, account)) {
      const previous = { installationId, owner };
      await this.writePending(previous);
      if (!this.isCurrent(generation)) return this.result('pending-cleanup', installationId, undefined, true);
      const previousAccount = options.previousOwnerAccount;
      if (!previousAccount || !sameOwner(owner, previousAccount)) {
        return this.result('pending-cleanup', installationId, undefined, true);
      }
      if (!(await this.removeOwnedDevice(previousAccount, previous))) {
        return this.result('pending-cleanup', installationId, 'cleanup', true);
      }
    }
    if (!this.isCurrent(generation)) return this.result('error', installationId, 'api');

    let permission: 'granted' | 'denied' | 'undetermined';
    try {
      const permissionResult = await this.cancellable(
        this.getPermissionAfterChannel(options.requestPermission !== false), generation
      );
      if (permissionResult === null) return this.result('error', installationId, 'api');
      permission = permissionResult;
    } catch {
      return this.result('error', installationId, 'permission');
    }
    if (!this.isCurrent(generation)) return this.result('error', installationId, 'api');
    if (permission === 'denied') return this.result('permission-denied', installationId, undefined, false, 'denied');
    if (permission !== 'granted') return this.result('permission-undetermined', installationId, undefined, false, permission);

    let token: string | null;
    try {
      token = await this.cancellable(
        this.ports.notifications.getExpoPushToken(this.ports.runtime.projectId!), generation
      );
    } catch {
      return this.result('error', installationId, 'api', false, 'granted');
    }
    if (token === null || !this.isCurrent(generation)) return this.result('error', installationId, 'api');
    const registrationCleanup = { installationId, owner: { accountId: account.accountId, apiOrigin: account.apiOrigin } };
    try {
      await this.ports.secureStorage.set(OWNER_STORAGE_KEY, JSON.stringify(registrationCleanup.owner));
      await this.writePending(registrationCleanup);
    } catch {
      return this.result('error', installationId, 'storage', false, 'granted');
    }
    if (!this.isCurrent(generation)) return this.result('pending-cleanup', installationId, undefined, true, 'granted');
    try {
      const response = await this.ports.api.registerDevice(account, {
        expoPushToken: token,
        platform: this.ports.runtime.platform as 'ios' | 'android',
        installationId,
      });
      if (response.status !== 201) return this.result('pending-cleanup', installationId, 'api', true, 'granted');
      if (!this.isCurrent(generation)) {
        await this.removeOwnedDevice(account, registrationCleanup);
        return this.result('error', installationId, 'api');
      }
      await this.clearPendingIfMatching(registrationCleanup);
      return this.result('registered', installationId, undefined, false, 'granted');
    } catch {
      return this.result('pending-cleanup', installationId, 'api', true, 'granted');
    }
  }

  disable(account: NativePushAccount): Promise<NativePushResult> {
    this.invalidateInFlight();
    return this.enqueueMutation(() => this.disableOperation(account));
  }

  private async disableOperation(account: NativePushAccount): Promise<NativePushResult> {
    const installationId = await this.ports.secureStorage.get(INSTALLATION_ID_STORAGE_KEY);
    if (!installationId) return this.result('consent-required');
    const owner = await this.readOwner();
    const pending = await this.readPending();
    const cleanup = pending ?? (owner ? { installationId, owner } : null);
    if (!cleanup) return this.result('consent-required', installationId);
    if (!sameOwner(cleanup.owner, account)) {
      await this.writePending(cleanup);
      return this.result('pending-cleanup', installationId, 'cleanup', true);
    }
    const removed = await this.removeOwnedDevice(account, cleanup);
    return removed
      ? this.result('consent-required', installationId)
      : this.result('pending-cleanup', installationId, 'cleanup', true);
  }

  async refreshStatus(account: NativePushAccount): Promise<NativePushResult> {
    const statusGeneration = ++this.statusGeneration;
    const unsupported = this.unsupportedResult();
    await this.mutationQueue;
    const mutationRevision = this.mutationRevision;
    try {
      const [server, devices, installationId, owner, pending] = await Promise.all([
        this.ports.api.getPushStatus(account),
        this.ports.api.getDevices(account),
        this.ports.secureStorage.get(INSTALLATION_ID_STORAGE_KEY),
        this.readOwner(),
        this.readPending(),
      ]);
      if (statusGeneration !== this.statusGeneration || mutationRevision !== this.mutationRevision) {
        return this.result('error', installationId, 'api');
      }
      const registered = !!installationId && sameOwner(owner, account) &&
        devices.some((device) => device.installationId === installationId);
      const unsupported = this.unsupportedResult();
      if (unsupported) {
        return { ...unsupported, nativePushEnabled: server.nativePushEnabled };
      }
      const permission = await this.ports.notifications.getPermissionStatus().catch(() => 'undetermined' as const);
      if (statusGeneration !== this.statusGeneration || mutationRevision !== this.mutationRevision) {
        return this.result('error', installationId, 'api');
      }
      return {
        state: pending ? 'pending-cleanup' : server.nativePushEnabled ? (registered ? 'registered' : 'consent-required') : 'server-disabled',
        installationId,
        permission,
        registered,
        nativePushEnabled: server.nativePushEnabled,
        pendingCleanup: !!pending,
      };
    } catch {
      return unsupported ?? this.result('error', null, 'api');
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    ++this.mutationRevision;
    const run = this.mutationQueue.then(operation, operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run.catch(() => this.result('error', null, 'storage') as T);
  }

  private async getPermissionAfterChannel(requestPermission: boolean): Promise<'granted' | 'denied' | 'undetermined'> {
    if (this.ports.runtime.platform === 'android') await this.ports.notifications.setAndroidChannel();
    const current = await this.ports.notifications.getPermissionStatus();
    return current === 'granted' || !requestPermission ? current : this.ports.notifications.requestPermission();
  }

  private advanceGeneration(): number {
    const previous = this.generation;
    const next = previous + 1;
    this.generation = next;
    const waiters = this.generationWaiters.get(previous);
    this.generationWaiters.delete(previous);
    waiters?.forEach((cancel) => cancel());
    return next;
  }

  private async cancellable<T>(promise: Promise<T>, generation: number): Promise<T | null> {
    let unregister = () => undefined;
    const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
      if (!this.isCurrent(generation)) {
        resolve({ kind: 'cancelled' });
        return;
      }
      const waiters = this.generationWaiters.get(generation) ?? new Set<() => void>();
      const cancel = () => resolve({ kind: 'cancelled' });
      waiters.add(cancel);
      this.generationWaiters.set(generation, waiters);
      unregister = () => {
        waiters.delete(cancel);
        if (waiters.size === 0) this.generationWaiters.delete(generation);
      };
    });
    const completed = promise.then(
      (value) => ({ kind: 'completed' as const, value }),
      (error: unknown) => ({ kind: 'failed' as const, error })
    );
    const outcome = await Promise.race([completed, cancelled]);
    unregister();
    if (outcome.kind === 'cancelled') return null;
    if (outcome.kind === 'failed') throw outcome.error;
    return outcome.value;
  }

  private unsupportedResult(): NativePushResult | null {
    const { runtime } = this.ports;
    if (runtime.platform !== 'ios' && runtime.platform !== 'android') return this.result('unsupported-platform');
    if (runtime.isExpoGo) return this.result('expo-go-unsupported');
    if (runtime.isSimulator && !runtime.simulatorPushSupported) return this.result('simulator-unsupported');
    if (!runtime.projectId?.trim()) return this.result('missing-project-id', null, 'configuration');
    return null;
  }

  private async getOrCreateInstallationId(): Promise<string> {
    const existing = await this.ports.secureStorage.get(INSTALLATION_ID_STORAGE_KEY);
    if (existing) return existing;
    const bytes = this.ports.randomBytes(16);
    if (bytes.length !== 16) throw new Error('Secure random source returned an invalid byte count.');
    const id = `install-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    await this.ports.secureStorage.set(INSTALLATION_ID_STORAGE_KEY, id);
    return id;
  }

  private async readOwner(): Promise<OwnerRecord | null> {
    const raw = await this.ports.secureStorage.get(OWNER_STORAGE_KEY);
    return raw ? JSON.parse(raw) as OwnerRecord : null;
  }

  private async readPending(): Promise<PendingCleanup | null> {
    const raw = await this.ports.secureStorage.get(PENDING_CLEANUP_STORAGE_KEY);
    return raw ? JSON.parse(raw) as PendingCleanup : null;
  }

  private async writePending(pending: PendingCleanup): Promise<void> {
    await this.ports.secureStorage.set(PENDING_CLEANUP_STORAGE_KEY, JSON.stringify(pending));
  }

  private async clearPendingIfMatching(cleanup: PendingCleanup): Promise<void> {
    const currentPending = await this.readPending();
    if (sameCleanup(currentPending, cleanup)) await this.ports.secureStorage.remove(PENDING_CLEANUP_STORAGE_KEY);
  }

  private async removeOwnedDevice(account: NativePushAccount, cleanup: PendingCleanup): Promise<boolean> {
    if (!sameOwner(cleanup.owner, account)) return false;
    try {
      await this.writePending(cleanup);
      const response = await this.ports.api.deleteDevice(account, cleanup.installationId);
      if (response.status !== 200 && response.status !== 404) return false;
      const currentPending = await this.readPending();
      const currentOwner = await this.readOwner();
      if (sameCleanup(currentPending, cleanup)) await this.ports.secureStorage.remove(PENDING_CLEANUP_STORAGE_KEY);
      if (sameOwner(currentOwner, cleanup.owner)) await this.ports.secureStorage.remove(OWNER_STORAGE_KEY);
      return true;
    } catch {
      await this.writePending(cleanup);
      return false;
    }
  }

  private isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  private result(
    state: NativePushResult['state'],
    installationId: string | null = null,
    errorCode?: NativePushResult['errorCode'],
    pendingCleanup = false,
    permission: NativePushResult['permission'] = 'not-requested'
  ): NativePushResult {
    return {
      state,
      installationId,
      permission,
      registered: state === 'registered',
      nativePushEnabled: null,
      pendingCleanup,
      ...(errorCode ? { errorCode } : {}),
    };
  }
}
