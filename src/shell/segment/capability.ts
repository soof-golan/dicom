/**
 * What this browser can do.
 *
 * Finding out touches `navigator`, so it belongs here. Deciding what to do
 * about the answer is arithmetic, and it lives in `core/segment/plan.ts`.
 *
 * Nothing in this file runs at startup. `requestAdapter` costs time, and the
 * viewer must paint before segmentation asks the machine any questions.
 */
import type { Capability } from "../../core/segment/plan.ts";

interface MaybeGpu {
  readonly gpu?: {
    requestAdapter: () => Promise<{ limits: { maxStorageBufferBindingSize: number } } | null>;
  };
  readonly userAgent?: string;
  readonly storage?: {
    persist?: () => Promise<boolean>;
    persisted?: () => Promise<boolean>;
    estimate?: () => Promise<{ usage?: number; quota?: number }>;
  };
}

function browser(): MaybeGpu {
  return navigator as unknown as MaybeGpu;
}

function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(browser().userAgent ?? "");
}

/** Ask the machine what it has. This is the only impure part of model choice. */
export async function probeCapability(): Promise<Capability> {
  const mobile = isMobile();
  const gpu = browser().gpu;
  if (!gpu) return { hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile };
    return {
      hasWebGpu: true,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      mobile,
    };
  } catch {
    return { hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile };
  }
}

export interface StorageReport {
  readonly persisted: boolean;
  readonly usage: number;
  readonly quota: number;
}

/**
 * Ask to keep the weights.
 *
 * Safari deletes storage that a script made after seven days with no visit. A
 * reader who comes back every second week would download the model again every
 * time. `persist()` stops that, and it must follow a user gesture, so it runs
 * when the user selects the load button.
 */
export async function keepStorage(): Promise<StorageReport> {
  const storage = browser().storage;
  if (!storage) return { persisted: false, usage: 0, quota: 0 };
  let persisted = false;
  try {
    persisted = (await storage.persisted?.()) ?? false;
    if (!persisted) persisted = (await storage.persist?.()) ?? false;
  } catch {
    persisted = false;
  }
  try {
    const estimate = (await storage.estimate?.()) ?? {};
    return { persisted, usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
  } catch {
    return { persisted, usage: 0, quota: 0 };
  }
}
