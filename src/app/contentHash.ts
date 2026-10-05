/**
 * A photo's identity for de-duplication: the SHA-256 of its file bytes.
 *
 * Two files with the same dimensions are not the same picture, so a fingerprint
 * built from dimensions made distinct photos collide and the pool counted them
 * as one. Hashing the bytes once at intake makes "identical" mean identical.
 *
 * Null means "no fingerprint, never de-duplicate": `crypto.subtle` is missing
 * outside a secure context, and a read can fail. Falling back to a constant
 * would make every unhashed photo a duplicate of every other.
 */
export async function contentFingerprint(file: Blob | null | undefined): Promise<string | null> {
  if (!file) return null;
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
