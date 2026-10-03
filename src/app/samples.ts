/**
 * The ten sample photographs, and the fetch that turns them into Files.
 *
 * Pure fetching and caching: nothing here touches app state. The cache stores
 * the PROMISE rather than the resolved file, so ten concurrent requests for one
 * sample make one request, and a sample that fails to prefetch is dropped from
 * the cache rather than left to replay its failure forever.
 *
 * loadSamplePhotos takes the app's intake function rather than importing it, so
 * the module does not depend on the batch pipeline - the direction is samples
 * into the app, never the other way round.
 */

import { clearProgress, setProgress, setProgressError } from "./progress";
import type { LogFn } from "./telemetry";

/**
 * What the sample loader needs from the app: its intake function and its logger.
 *
 * Both are passed rather than imported so that this module depends on nothing
 * but the progress slot - the direction is samples into the app, never the other
 * way round, and a sample fetch has no business knowing how a photo is batched.
 */
export interface Intake {
  /** Hand the loaded files to the app's own file intake. */
  processFiles: (files: File[]) => void;
  sendLog: LogFn;
}

// Sample Photos Loader
export const SAMPLE_NAMES: readonly string[] = [
  "IMG-20261002-WA0007.jpeg",
  "PXL_20261002_182523087.jpg",
  "PXL_20261002_182614990.jpg",
  "PXL_20261002_182628741.jpg",
  "PXL_20261002_182632161.jpg",
  "PXL_20261002_182639488.jpg",
  "PXL_20261002_182720758.jpg",
  "PXL_20261002_182737596.jpg",
  "PXL_20261002_182741226.jpg",
  "PXL_20261002_182754446.jpg"
];

// One sample, as a File. Kept separate so the preload below can populate the
// cache and the click below can read it, without fetching twice.
async function fetchSampleFile(name: string): Promise<File> {
  const resp = await fetch(`samples/${name}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

const sampleFileCache = new Map<string, Promise<File>>();
async function getSampleFile(name: string): Promise<File> {
  let pending = sampleFileCache.get(name);
  if (!pending) {
    // The promise is cached, not the file: two callers arriving together make
    // one request, and the second awaits the first's result.
    pending = fetchSampleFile(name);
    sampleFileCache.set(name, pending);
  }
  return pending;
}

// All ten at once, bounded so a cold cache on a phone does not open ten
// connections for images nobody asked for.
//
// The sequential version paid ten round trips back to back, and the wait was
// visible: the button did nothing until the last download landed.
const SAMPLE_PREFETCH_CONCURRENCY = 5;
export async function prefetchSamples(): Promise<void> {
  const names = SAMPLE_NAMES.slice();
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(SAMPLE_PREFETCH_CONCURRENCY, names.length) }, async () => {
    for (;;) {
      const idx = i++;
      const name = names[idx];
      if (name === undefined) return;
      try {
        await getSampleFile(name);
      } catch (e) {
        // A sample that will not prefetch must not poison the cache: drop it so
        // the click retries rather than replaying this failure forever.
        sampleFileCache.delete(name);
        console.warn("Could not prefetch sample:", name, e);
      }
    }
  }));
}

export async function loadSamplePhotos(intake: Intake): Promise<void> {
  intake.sendLog("sample_photos_clicked");
  setProgress("samples", "Fetching sample photos…", null);
  const results = await Promise.allSettled(SAMPLE_NAMES.map((n) => getSampleFile(n)));
  clearProgress("samples");
  const files = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  for (let i = 0; i < results.length; i++) {
    const name = SAMPLE_NAMES[i];
    if (results[i]!.status === "rejected" && name !== undefined) {
      sampleFileCache.delete(name);
      console.warn("Could not fetch sample:", name, (results[i] as PromiseRejectedResult).reason);
    }
  }
  if (files.length) {
    intake.processFiles(files);
  } else {
    setProgressError("Could not load the sample photos.");
  }
}
