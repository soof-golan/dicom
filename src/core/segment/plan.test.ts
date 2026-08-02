import { describe, expect, it } from "vite-plus/test";
import {
  combineProgress,
  formatBytes,
  MIN_STORAGE_BUFFER,
  planFor,
  textPlanFor,
  type Capability,
} from "./plan.ts";

const DESKTOP_GPU: Capability = {
  hasWebGpu: true,
  maxStorageBufferBindingSize: 2_147_483_648,
  mobile: false,
};

describe("planFor", () => {
  it("picks SAM 3 on a machine with WebGPU and room to spare", () => {
    const plan = planFor(DESKTOP_GPU);
    expect(plan?.id).toBe("sam3-tracker");
    expect(plan?.backend).toBe("webgpu");
    expect(plan?.reduced).toBe(false);
  });

  it("picks SAM 3 exactly at the guaranteed WebGPU minimum", () => {
    const plan = planFor({ ...DESKTOP_GPU, maxStorageBufferBindingSize: MIN_STORAGE_BUFFER });
    expect(plan?.id).toBe("sam3-tracker");
  });

  it("drops to SAM 2.1 tiny when the buffer limit is below the minimum", () => {
    const plan = planFor({ ...DESKTOP_GPU, maxStorageBufferBindingSize: MIN_STORAGE_BUFFER - 1 });
    expect(plan?.id).toBe("sam2.1-hiera-tiny");
    expect(plan?.reduced).toBe(true);
  });

  it("drops to SlimSAM on a desktop with no WebGPU", () => {
    const plan = planFor({ hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile: false });
    expect(plan?.id).toBe("slimsam-77");
    expect(plan?.backend).toBe("wasm");
  });

  it("offers nothing on a phone with no WebGPU", () => {
    expect(planFor({ hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile: true })).toBe(
      undefined,
    );
  });

  it("never quantizes the decoder", () => {
    for (const capability of [
      DESKTOP_GPU,
      { ...DESKTOP_GPU, maxStorageBufferBindingSize: 1000 },
      { hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile: false },
    ]) {
      expect(planFor(capability)?.decoderDtype).toBe("fp32");
    }
  });

  it("makes every fallback smaller than the one above it", () => {
    const best = planFor(DESKTOP_GPU)!;
    const middle = planFor({ ...DESKTOP_GPU, maxStorageBufferBindingSize: 1000 })!;
    const last = planFor({ hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile: false })!;
    expect(best.bytes).toBeGreaterThan(middle.bytes);
    expect(middle.bytes).toBeGreaterThan(last.bytes);
  });
});

describe("textPlanFor", () => {
  it("offers CLIPSeg on the WebGPU path", () => {
    // The OWL detectors were the first choice. No export of either one loads:
    // they all stop at Cast(13) in the class head. CLIPSeg has no such head.
    expect(textPlanFor(planFor(DESKTOP_GPU))?.repo).toBe("Xenova/clipseg-rd64-refined");
    expect(textPlanFor(planFor(DESKTOP_GPU))?.backend).toBe("webgpu");
  });

  it("keeps the text model far smaller than the mask model", () => {
    const plan = planFor(DESKTOP_GPU)!;
    expect(textPlanFor(plan)!.bytes).toBeLessThan(plan.bytes / 2);
  });

  it("offers nothing on the WebAssembly path, where it would take minutes", () => {
    const wasmPlan = planFor({ hasWebGpu: false, maxStorageBufferBindingSize: 0, mobile: false });
    expect(textPlanFor(wasmPlan)).toBe(undefined);
  });

  it("offers nothing when there is no plan at all", () => {
    expect(textPlanFor(undefined)).toBe(undefined);
  });
});

describe("formatBytes", () => {
  it("uses kilobytes below a megabyte", () => {
    expect(formatBytes(213_114)).toBe("213 kB");
  });

  it("uses megabytes up to a gigabyte", () => {
    expect(formatBytes(392_560_198)).toBe("393 MB");
  });

  it("uses gigabytes above that", () => {
    expect(formatBytes(1_893_027_362)).toBe("1.89 GB");
  });
});

describe("combineProgress", () => {
  it("adds the parts of every file together", () => {
    const files = new Map([
      ["encoder", { loaded: 50, total: 100 }],
      ["decoder", { loaded: 25, total: 100 }],
    ]);
    expect(combineProgress(files)).toEqual({ loaded: 75, total: 200, fraction: 0.375 });
  });

  it("reports no fraction while any total is unknown", () => {
    const files = new Map([
      ["encoder", { loaded: 50, total: 100 }],
      ["decoder", { loaded: 25, total: 0 }],
    ]);
    expect(combineProgress(files).fraction).toBe(undefined);
  });

  it("reports no fraction before any file starts", () => {
    expect(combineProgress(new Map()).fraction).toBe(undefined);
  });

  it("never goes above one when a server sends more than it promised", () => {
    const files = new Map([["encoder", { loaded: 120, total: 100 }]]);
    expect(combineProgress(files).fraction).toBe(1);
  });
});
