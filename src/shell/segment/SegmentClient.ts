/**
 * The main-thread handle on the segmentation worker.
 *
 * The worker is made here, with `new Worker(new URL(...))`. That form is what
 * makes the bundler give the worker its own chunk, so the model runtime never
 * joins the entry chunk.
 */
import type { ModelPlan, TextPlan } from "../../core/segment/plan.ts";
import type { BoxPrompt, Mask, PointPrompt } from "../../core/segment/types.ts";
import type { DetectedBox, FromWorker, Phase, ToWorker } from "./protocol.ts";

export interface LoadProgress {
  readonly phase: Phase;
  readonly loaded: number;
  readonly total: number;
  readonly fraction: number | undefined;
  readonly file: string | undefined;
}

export interface ScoredMask extends Mask {
  readonly score: number;
}

/** Thrown when the user stops a download, or when a newer prompt replaces one. */
export class SegmentCancelled extends Error {
  override readonly name = "SegmentCancelled";
}

interface Waiting {
  readonly resolve: (value: FromWorker) => void;
  readonly reject: (error: Error) => void;
}

export class SegmentClient {
  #worker: Worker | undefined;
  #waiting = new Map<number, Waiting>();
  #nextId = 1;
  /** The newest decode. An older one that lands after it is thrown away. */
  #newestDecode = 0;
  readonly #onProgress: (progress: LoadProgress) => void;

  constructor(onProgress: (progress: LoadProgress) => void) {
    this.#onProgress = onProgress;
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = new Worker(new URL("./segment.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.kind === "progress") {
        this.#onProgress(message);
        return;
      }
      const waiting = this.#waiting.get(message.id);
      if (!waiting) return;
      this.#waiting.delete(message.id);
      if (message.kind === "failed") waiting.reject(new Error(message.message));
      else waiting.resolve(message);
    });
    worker.addEventListener("error", (event) => {
      this.#failAll(new Error(event.message || "the segmentation worker stopped"));
    });
    this.#worker = worker;
    return worker;
  }

  #failAll(error: Error): void {
    for (const waiting of this.#waiting.values()) waiting.reject(error);
    this.#waiting.clear();
  }

  #send(message: ToWorker, transfer: Transferable[] = []): Promise<FromWorker> {
    const worker = this.#ensureWorker();
    return new Promise<FromWorker>((resolve, reject) => {
      this.#waiting.set(message.id, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  }

  #id(): number {
    this.#nextId += 1;
    return this.#nextId;
  }

  /** Download and compile. Returns true when the text model came up too. */
  async load(plan: ModelPlan, text: TextPlan | undefined): Promise<boolean> {
    const reply = await this.#send({ kind: "load", id: this.#id(), plan, text });
    return reply.kind === "loaded" ? reply.textReady : false;
  }

  /** Run the vision encoder for one cut. Seconds. */
  async encode(gray: Uint8Array, width: number, height: number): Promise<void> {
    const copy = gray.slice();
    await this.#send({ kind: "encode", id: this.#id(), gray: copy, width, height }, [copy.buffer]);
  }

  /**
   * Run the mask decoder. Well under a second.
   *
   * A drag makes many prompts a second. Only the newest one matters, so an
   * earlier answer that arrives late returns nothing instead of overwriting it.
   */
  async decode(
    points: readonly PointPrompt[],
    box: BoxPrompt | undefined,
  ): Promise<ScoredMask | undefined> {
    const id = this.#id();
    this.#newestDecode = id;
    const reply = await this.#send({ kind: "decode", id, points, box });
    if (id !== this.#newestDecode || reply.kind !== "mask") return undefined;
    return { width: reply.width, height: reply.height, data: reply.data, score: reply.score };
  }

  /** Turn a phrase into boxes on the cut that was encoded last. */
  async detect(text: string): Promise<readonly DetectedBox[]> {
    const reply = await this.#send({ kind: "detect", id: this.#id(), text });
    return reply.kind === "boxes" ? reply.boxes : [];
  }

  /**
   * Stop everything and free the GPU.
   *
   * Terminating is the only way to stop a download that is already running:
   * the model loader takes no abort signal. A stopped download starts again
   * from the beginning, and the UI says so.
   */
  dispose(): void {
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#failAll(new SegmentCancelled("segmentation stopped"));
  }
}
