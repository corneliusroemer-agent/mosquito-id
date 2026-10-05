import { describe, it, expect, vi } from "vitest";
import { releaseGpuResources, type OrtLike, type ReleasableSession } from "../src/app/gpuRelease";

/**
 * What an idle release has to hand back: the onnxruntime weight buffers, not just
 * the app's references to them.
 *
 * The unit under test is the release step itself, because that is where the
 * memory actually goes. `InferenceSession.release()` in onnxruntime-web 1.30.0
 * is `async` and resolves through `gpuDataManager.onReleaseSession`, which
 * destroys every `GPUBuffer` in the weight cache once the LAST session is gone.
 * Dropping the reference without awaiting that leaves the buffers alive, which
 * is the failure a JS-level test is uniquely able to catch: the buffers are not
 * reachable from the test, only their effect on the ordering is.
 *
 * A fake `ort` stands in for the real global. The one property of the real thing
 * this pins is the shape 1.30.0 leaves behind - `env.webgpu.device` defined
 * `writable: false` - because assigning to it throws, and that throw used to
 * abort the release halfway.
 */

function fakeOrt(overrides: Record<string, unknown> = {}): OrtLike {
  return { env: { webgpu: {} }, ...overrides } as unknown as OrtLike;
}

/** A session whose `release` resolves only when the returned promise settles. */
function asyncSession(tag: string, log: string[], ms = 0): ReleasableSession {
  return {
    async release() {
      if (ms) await new Promise((r) => setTimeout(r, ms));
      log.push(tag);
    },
  };
}

describe("an idle release hands the onnxruntime weight buffers back", () => {
  it("awaits every session's release before the release is reported done", async () => {
    const log: string[] = [];
    // The slow one resolves after the fast one, so a fire-and-forget release
    // would leave `log` short when the caller looks.
    const sessions = [asyncSession("det", log, 5), asyncSession("clip-a", log), asyncSession("clip-b", log)];

    const result = await releaseGpuResources({ sessions, ort: fakeOrt() });

    expect(log.sort()).toEqual(["clip-a", "clip-b", "det"]);
    expect(result.releasedSessions).toBe(3);
  });

  it("releases a session whose release is missing or not callable without throwing", async () => {
    const log: string[] = [];
    const result = await releaseGpuResources({
      sessions: [{ release: async () => { log.push("real"); } }, {}, null, undefined] as ReleasableSession[],
      ort: fakeOrt(),
    });
    expect(log).toEqual(["real"]);
    expect(result.releasedSessions).toBe(1);
    expect(result.failedSessions).toBe(3);
  });

  it("keeps releasing the rest when one session's release throws", async () => {
    const log: string[] = [];
    const sessions: ReleasableSession[] = [
      { release: async () => { throw new Error("invalid session id"); } },
      { release: async () => { log.push("survivor"); } },
    ];
    const result = await releaseGpuResources({ sessions, ort: fakeOrt() });
    expect(log).toEqual(["survivor"]);
    expect(result.failedSessions).toBe(1);
  });

  it("clears a non-writable env.webgpu.device instead of throwing on assignment", async () => {
    const webgpu: Record<string, unknown> = {};
    // Exactly what onnxruntime-web 1.30.0 installs in
    // `WebGpuBackend.initialize`, and the reason a plain assignment throws in
    // the app's strict-mode module.
    Object.defineProperty(webgpu, "device", { value: { tag: "backend" }, writable: false, configurable: true });

    await expect(releaseGpuResources({ sessions: [], ort: { env: { webgpu } } as unknown as OrtLike }))
      .resolves.toBeDefined();
    expect(webgpu.device).toBeUndefined();
  });

  it("reports what it freed", async () => {
    const log: string[] = [];
    const result = await releaseGpuResources({
      sessions: [asyncSession("a", log), asyncSession("b", log)],
      ort: fakeOrt(),
    });
    expect(result).toMatchObject({ releasedSessions: 2, failedSessions: 0 });
  });
});

describe("a restore after a release leaves nothing pointing at a dead device", () => {
  it("the device slot is empty afterwards, so the next load can install its own", async () => {
    const webgpu: Record<string, unknown> = { device: { tag: "old" } };
    await releaseGpuResources({ sessions: [], ort: { env: { webgpu } } as unknown as OrtLike });
    expect(webgpu.device).toBeUndefined();
    // Writable again is not required - onnxruntime re-defines the property - but
    // the slot must be free, which is what `configurable: true` buys.
    expect(Object.getOwnPropertyDescriptor(webgpu, "device")).toBeUndefined();
  });

  it("survives an ort that has no webgpu env at all", async () => {
    await expect(releaseGpuResources({ sessions: [], ort: {} as OrtLike })).resolves.toBeDefined();
  });

  it("survives ort being absent entirely", async () => {
    await expect(releaseGpuResources({ sessions: [], ort: undefined })).resolves.toBeDefined();
  });
});

describe("repeated release and restore cycles do not leak or wedge", () => {
  it("ten cycles free every session each time and never throw", async () => {
    const log: string[] = [];
    const webgpu: Record<string, unknown> = {};
    let cycles = 0;

    for (let i = 0; i < 10; i++) {
      const before = log.length;
      const result = await releaseGpuResources({
        sessions: [asyncSession(`det-${i}`, log), asyncSession(`clip-${i}`, log)],
        ort: { env: { webgpu } } as unknown as OrtLike,
      });
      // Every cycle frees exactly its own two sessions: a cycle that skipped one
      // is the leak, because onnxruntime only empties the weight cache when the
      // last session goes.
      expect(result.releasedSessions).toBe(2);
      expect(log.length - before).toBe(2);
      // The device slot is free again, so the restore below has somewhere to put
      // the next one. A cycle that left the old device behind is what pins the
      // previous device to a restored tab for good.
      expect(webgpu.device).toBeUndefined();
      cycles++;
      // Restore stands in for `loadWebGPUModels`: it installs a fresh device,
      // and the next release must clear that one too.
      webgpu.device = { tag: `device-${i}` };
      expect(webgpu.device).toEqual({ tag: `device-${i}` });
    }

    expect(cycles).toBe(10);
    // Ten releases, ten clears, and the tenth device is the one still installed.
    expect(log).toHaveLength(20);
    expect(webgpu.device).toEqual({ tag: "device-9" });
  });

  it("a device whose destroy throws does not stop the release", async () => {
    // See `destroyOwnedDevice` below: the app's OWN pre-init device is the only
    // one whose destroy() is safe to call, and a provider that rejects it must
    // not take the weight buffers down with it.
    const webgpu: Record<string, unknown> = {
      device: { destroy() { throw new Error("device already lost"); } },
    };
    const log: string[] = [];
    const result = await releaseGpuResources({
      sessions: [asyncSession("clip", log)],
      ort: { env: { webgpu } } as unknown as OrtLike,
      ownedDevice: webgpu.device as { destroy(): void },
    });
    expect(log).toEqual(["clip"]);
    expect(result.releasedSessions).toBe(1);
    expect(webgpu.device).toBeUndefined();
  });
});

describe("destroying the app's own pre-init device", () => {
  it("is idempotent: a second release does not throw on the same device", async () => {
    const destroy = vi.fn();
    const ownedDevice = { destroy };
    const ort = fakeOrt();
    const sessions: ReleasableSession[] = [];

    await releaseGpuResources({ sessions, ort, ownedDevice });
    await releaseGpuResources({ sessions, ort, ownedDevice });

    // Once is the contract. A GPUDevice.destroy() on an already-destroyed
    // device resolves its `lost` promise again rather than throwing, but calling
    // it twice is still a sign the release ran twice against one device, and the
    // release path can fire more than once (timer, then releaseNow on teardown).
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does not destroy a device it does not own", async () => {
    const destroy = vi.fn();
    const webgpu: Record<string, unknown> = { device: { destroy } };
    await releaseGpuResources({ sessions: [], ort: { env: { webgpu } } as unknown as OrtLike });
    expect(destroy).not.toHaveBeenCalled();
  });
});
