import { describe, expect, it } from "vite-plus/test";
import {
  nextStep,
  parseSaved,
  previousStep,
  progress,
  serialize,
  skip,
  stepAt,
  TUTORIAL_START,
  TUTORIAL_STEPS,
} from "./steps.ts";

describe("TUTORIAL_STEPS", () => {
  it("has a unique id for every step", () => {
    expect(new Set(TUTORIAL_STEPS.map((step) => step.id)).size).toBe(TUTORIAL_STEPS.length);
  });

  it("starts by telling the reader that nothing is uploaded", () => {
    expect(TUTORIAL_STEPS[0]!.body).toMatch(/sends nothing anywhere/i);
  });

  it("keeps every step short enough to read at a glance", () => {
    for (const step of TUTORIAL_STEPS) {
      expect(step.title.length).toBeLessThanOrEqual(40);
      // Simplified Technical English allows 25 words in a descriptive sentence.
      for (const sentence of step.body.split(". ")) {
        expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(25);
      }
    }
  });

  it("uses no banned modal verb", () => {
    for (const step of TUTORIAL_STEPS) {
      expect(`${step.title} ${step.body}`).not.toMatch(/\b(should|may|might|could)\b/i);
    }
  });
});

describe("moving through the tutorial", () => {
  it("starts on the first step", () => {
    expect(progress(TUTORIAL_START)).toEqual({ current: 1, total: TUTORIAL_STEPS.length });
    expect(TUTORIAL_START.finished).toBe(false);
  });

  it("advances one step at a time", () => {
    expect(nextStep(TUTORIAL_START).step).toBe(1);
    expect(nextStep(nextStep(TUTORIAL_START)).step).toBe(2);
  });

  it("finishes on the last step", () => {
    let state = TUTORIAL_START;
    for (let i = 0; i < TUTORIAL_STEPS.length; i += 1) state = nextStep(state);
    expect(state.finished).toBe(true);
    expect(state.step).toBe(TUTORIAL_STEPS.length - 1);
  });

  it("goes back but never before the first step", () => {
    expect(previousStep(nextStep(TUTORIAL_START)).step).toBe(0);
    expect(previousStep(TUTORIAL_START).step).toBe(0);
  });

  it("finishes at once when the reader skips", () => {
    expect(skip().finished).toBe(true);
  });

  it("never reads outside the list", () => {
    expect(stepAt({ step: -5, finished: false })).toBe(TUTORIAL_STEPS[0]);
    expect(stepAt({ step: 999, finished: false })).toBe(TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1]);
  });
});

describe("saved state", () => {
  it("treats a missing value as a first visit", () => {
    expect(parseSaved(null)).toEqual(TUTORIAL_START);
  });

  it("round-trips through storage", () => {
    const state = { step: 3, finished: false };
    expect(parseSaved(serialize(state))).toEqual(state);
  });

  it("remembers that the reader finished", () => {
    expect(parseSaved(serialize(skip())).finished).toBe(true);
  });

  it.each(["", "not json", "[]", "null", "42", '{"step":"x"}'])(
    "survives the corrupt value %j",
    (raw) => {
      expect(() => parseSaved(raw)).not.toThrow();
      expect(parseSaved(raw).step).toBe(0);
    },
  );
});
