/**
 * Handing GPU memory back, rather than only dropping the app's references to it.
 *
 * The companion to `idleRelease.ts`. That module decides WHEN a hidden tab
 * releases; this one is what the release actually does to the device, and the
 * distinction matters because dropping a reference and freeing a buffer are
 * different acts.
 *
 * ## What onnxruntime-web 1.30.0 actually does
 *
 * The runtime is a UMD bundle from a CDN (`index.html`), pinned to 1.30.0, not a
 * dependency - so its API was read out of the published package rather than
 * assumed. Three facts from `dist/ort.all.js` drive everything here:
 *
 * 1. **`InferenceSession.release()` is `async`** (line 1159) and resolves
 *    through `gpuDataManager.onReleaseSession` (28327), which calls
 *    `buffer.destroy()` on every `GPUBuffer` in the weight cache — but **only
 *    when the last session is released** (`sessionCount` reaching 0). So a
 *    release that is not awaited frees nothing yet, and a release that skips a
 *    session frees nothing at all.
 * 2. **The weight buffers are the memory that matters** — the classifier alone
 *    is 1.26 GB. They live in `gpuDataManager.storageCache` as `GPUBuffer`s.
 *    Awaiting `release()` is what actually reclaims them.
 * 3. **`env.webgpu.device` is defined `writable: false`** by
 *    `WebGpuBackend.initialize` (40433), the moment the first session is created
 *    on the webgpu EP. Assigning `undefined` to it throws a TypeError in a
 *    strict-mode module, which is what `main.js` is. `delete` works, because the
 *    property is `configurable: true`.
 *
 * ## Why this does not call `device.destroy()`
 *
 * Destroying the backend's device would free nothing extra — the weight buffers
 * are already gone once every session's `release()` has resolved — and it would
 * **wedge the page permanently**. `WebGpuBackend` is a page-lifetime singleton:
 * its `init()` runs once, behind `tryResolveAndInitializeBackend`'s
 * `backendInfo.initialized` latch (95), and there is no re-init path. Destroy the
 * device and the next `InferenceSession.create` gets the same cached backend
 * allocating through a lost device, so the webgpu EP never works again — and
 * `env.webgpu.device` is non-writable, so it cannot even be replaced.
 *
 * So the device the app obtains itself in `loadWebGPUModels` is tracked and
 * destroyed: onnxruntime overwrites that reference with its own device on first
 * use, leaving the app's orphaned, and an orphaned `GPUDevice` is worth
 * reclaiming. The backend's device is left alone. This is why `release()` and
 * not `destroy()` is the thing that frees memory here.
 */

/** The slice of an onnxruntime `InferenceSession` this module touches. */
export interface ReleasableSession {
  release?: () => unknown;
}

/**
 * The slice of the onnxruntime `env` global this module touches. `main.js` is a
 * `.js` file with no types for the CDN bundle, so this is declared rather than
 * imported, exactly as `src/app/ort.ts` declares `ort.Tensor`.
 */
export interface OrtLike {
  env?: {
    webgpu?: {
      /** Non-writable and non-assignable once a webgpu session exists. */
      device?: unknown;
      [key: string]: unknown;
    };
  };
}

export interface ReleaseOptions {
  /**
   * Every session to release. Order is irrelevant to the caller and irrelevant
   * to onnxruntime, but ALL of them must be here: the weight cache is only
   * emptied when the last session goes.
   */
  sessions: readonly (ReleasableSession | null | undefined)[];
  /** The onnxruntime global, or undefined if it never loaded. */
  ort?: OrtLike;
  /**
   * A device the APP obtained and still owns — the pre-init one from
   * `loadWebGPUModels`, which onnxruntime orphans on first use. Its
   * `destroy()` is safe to call, and idempotently so. Never pass the backend's
   * own device here; see the module comment for why that one must be left.
   */
  ownedDevice?: { destroy?: () => void } | null;
}

export interface ReleaseResult {
  /** Sessions whose `release()` resolved. This is what frees the buffers. */
  releasedSessions: number;
  /** Sessions that had no `release`, or whose `release` threw. */
  failedSessions: number;
  /** True when the app's own device was destroyed. */
  deviceDestroyed: boolean;
}

/** Devices already destroyed by this module, so a repeat release cannot re-destroy. */
const destroyedDevices = new WeakSet<object>();

/**
 * Clear `env.webgpu.device`.
 *
 * Assignment is what the previous code did and it throws: onnxruntime-web 1.30.0
 * defines the property `writable: false` in `WebGpuBackend.initialize`, and
 * `main.js` is a module, so it is strict mode. The throw aborted the release
 * halfway — the bitmaps below it in `releaseIdleMemory` were never closed and the
 * release was never logged.
 *
 * `delete` is the supported operation: the property is `configurable: true`, and
 * onnxruntime's own `WebGpuBackend.dispose` deletes it the same way when the
 * device is lost.
 */
function clearOrtDevice(ort: OrtLike | undefined): void {
  const webgpu = ort?.env?.webgpu;
  if (!webgpu || !("device" in webgpu)) return;
  try {
    delete webgpu.device;
  } catch {
    // Non-configurable in some other build: fall back to the assignment, which
    // is harmless when the property is still writable.
    try {
      webgpu.device = undefined;
    } catch {
      // Unreachable and harmless - the slot is not the memory.
    }
  }
}

/**
 * Destroy the device the app obtained itself, once.
 *
 * The `WeakSet` is what makes a repeated release safe: the release path can fire
 * more than once (the 60 s timer, then `releaseNow` at teardown), and this is
 * the guard the caller cannot supply.
 */
function destroyOwnedDevice(owned: ReleaseOptions["ownedDevice"]): boolean {
  if (!owned || typeof owned.destroy !== "function") return false;
  if (typeof owned === "object" && destroyedDevices.has(owned)) return false;
  if (typeof owned === "object") destroyedDevices.add(owned);
  try {
    owned.destroy();
    return true;
  } catch {
    // A device that is already lost rejects `destroy()`. Its buffers are gone
    // either way, so there is nothing left to reclaim and nothing to report.
    return false;
  }
}

/**
 * Free an idle tab's GPU memory.
 *
 * Never throws: a provider that cannot release, a device that rejects
 * `destroy()`, or an `ort` that never loaded must not stop the rest from being
 * freed. Returns what was freed, for the caller's log line.
 */
export async function releaseGpuResources(opts: ReleaseOptions): Promise<ReleaseResult> {
  const { sessions, ort, ownedDevice } = opts;
  let releasedSessions = 0;
  let failedSessions = 0;

  for (const session of sessions) {
    if (!session || typeof session.release !== "function") {
      failedSessions++;
      continue;
    }
    try {
      // Awaited, and this is the load-bearing line. `release()` is async and
      // the GPUBuffer.destroy() calls happen when it resolves; a
      // fire-and-forget release leaves the weights on the device while the app
      // reports itself released.
      await session.release();
      releasedSessions++;
    } catch {
      // One session that will not release is not a reason to keep the others
      // pinned - which is the state this whole path exists to avoid.
      failedSessions++;
    }
  }

  // Sessions first, device second: the weight buffers are freed by the releases
  // above, so there is nothing left to lose by ordering it this way, and doing
  // it the other way would free against a dead device.
  clearOrtDevice(ort);
  const deviceDestroyed = destroyOwnedDevice(ownedDevice);

  return { releasedSessions, failedSessions, deviceDestroyed };
}
