/**
 * Minimal FileReader shim for Node (tests and scripts ONLY — never imported from src/).
 *
 * three.js' GLTFExporter builds the binary (.glb) output with `new FileReader()`,
 * `readAsArrayBuffer(blob)` / `readAsDataURL(blob)` and an `onloadend` callback that it assigns
 * *after* starting the read. Browsers provide FileReader; Node 24 provides Blob but not
 * FileReader. This shim implements exactly that subset on top of `Blob.arrayBuffer()`, always
 * completing asynchronously so late-assigned handlers are honoured.
 *
 * It is installed only when `globalThis.FileReader` is undefined, so it can never replace a real
 * browser implementation.
 */

type Handler = ((this: unknown, ev: { target: unknown }) => void) | null;

class NodeFileReaderShim {
  static readonly EMPTY = 0;
  static readonly LOADING = 1;
  static readonly DONE = 2;

  readyState = 0;
  result: ArrayBuffer | string | null = null;
  error: unknown = null;
  onload: Handler = null;
  onloadend: Handler = null;
  onerror: Handler = null;

  readAsArrayBuffer(blob: Blob): void {
    this.start(blob, (buf) => buf);
  }

  readAsDataURL(blob: Blob): void {
    this.start(blob, (buf) => `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`);
  }

  private start(blob: Blob, convert: (buf: ArrayBuffer) => ArrayBuffer | string): void {
    if (this.readyState === 1) throw new Error('FileReader shim: a read is already in progress');
    this.readyState = 1;
    this.result = null;
    blob.arrayBuffer().then(
      (buf) => {
        this.result = convert(buf);
        this.readyState = 2;
        this.fire(this.onload);
        this.fire(this.onloadend);
      },
      (err: unknown) => {
        this.error = err;
        this.readyState = 2;
        this.fire(this.onerror);
        this.fire(this.onloadend);
      },
    );
  }

  private fire(handler: Handler): void {
    if (handler) handler.call(this, { target: this });
  }
}

/** Installs the shim when (and only when) FileReader is missing. Returns true if it installed it. */
export function installFileReaderShim(): boolean {
  const g = globalThis as { FileReader?: unknown };
  if (typeof g.FileReader !== 'undefined') return false;
  g.FileReader = NodeFileReaderShim;
  return true;
}

export function isFileReaderShimInstalled(): boolean {
  return (globalThis as { FileReader?: unknown }).FileReader === NodeFileReaderShim;
}
