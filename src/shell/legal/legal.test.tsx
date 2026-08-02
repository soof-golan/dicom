// @vitest-environment jsdom
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { PrivacyPolicy } from "./PrivacyPolicy.tsx";
import { Terms } from "./Terms.tsx";

afterEach(cleanup);

function textOf(ui: ReactElement) {
  const { container } = render(ui);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function headings(level: number) {
  return screen.getAllByRole("heading", { level }).map((node) => node.textContent);
}

test("the privacy policy has one title and the last updated date", () => {
  render(<PrivacyPolicy />);

  expect(headings(1)).toEqual(["Privacy Policy"]);
  expect(screen.getByText("Last updated: 2026-08-02")).toBeDefined();
});

test("the privacy policy opens with a plain language summary", () => {
  render(<PrivacyPolicy />);

  const summary = screen.getByLabelText("Plain language summary");
  const points = summary.querySelectorAll("li");

  expect(points.length).toBeGreaterThanOrEqual(3);
  expect(points.length).toBeLessThanOrEqual(5);
  expect(summary.textContent).toContain("The viewer collects nothing about you.");
});

test("the privacy policy states that the viewer collects nothing", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain("The viewer has no backend server.");
  expect(text).toContain(
    "There are no analytics, no telemetry, no cookies, no tracking pixels, and no third-party embeds.",
  );
  expect(text).toContain("The viewer sends no information about you to anybody.");
  expect(text).toContain("Your files never leave your device.");
  expect(text).toContain("The viewer does not upload them.");
});

test("the privacy policy states what localStorage holds and that it stays local", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain(
    "The viewer writes a small amount of state to localStorage in your browser. This state stays on your device. It never travels to a server.",
  );
  expect(text).toContain("Tutorial progress.");
  expect(text).toContain("View preferences.");
  expect(text).toContain("No DICOM data goes into localStorage.");
});

test("the privacy policy is honest about the model download and the Cloudflare logs", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain("downloads the model file from a Cloudflare R2 bucket");
  expect(text).toContain("The download moves in one direction only.");
  expect(text).toContain("Cloudflare receives and logs standard request metadata.");
  expect(text).toContain("This metadata includes your IP address and your user agent string.");
});

test("the privacy policy explains how to delete the local state", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain("Select the control that deletes the local data.");
  expect(text).toContain("Delete the site data for dicom.soofgolan.com.");
});

test("the privacy policy covers children and contact", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain("It is not directed at children.");
  expect(text).toContain("it collects no personal data from a child");
  expect(text).toContain("Open an issue at github.com/soof-golan/dicom");
});

test("the privacy policy carries the MIT copyright line and the lawyer note", () => {
  const text = textOf(<PrivacyPolicy />);

  expect(text).toContain("MIT License. Copyright (c) 2026 Soof Golan.");
  expect(text).toContain("A lawyer has not reviewed this text.");
});

test("the terms have one title and the last updated date", () => {
  render(<Terms />);

  expect(headings(1)).toEqual(["Terms and Conditions"]);
  expect(screen.getByText("Last updated: 2026-08-02")).toBeDefined();
});

test("the terms put the medical disclaimer first, after the summary", () => {
  render(<Terms />);

  expect(headings(2).slice(0, 2)).toEqual(["In short", "1. The viewer is not a medical device"]);
});

test("the terms state that the viewer is not a medical device", () => {
  const text = textOf(<Terms />);

  expect(text).toContain("The viewer is not a medical device.");
  expect(text).toContain("No regulator certified, cleared, or approved it.");
  expect(text).toContain("the FDA of the United States, the authorities under the EU MDR");
  expect(text).toContain(
    "Do not use the viewer for diagnosis. Do not use it for treatment, for screening, or for any clinical decision.",
  );
  expect(text).toContain(
    "A qualified doctor with certified equipment must read your medical images.",
  );
});

test("the terms disclaim warranty and limit liability", () => {
  const text = textOf(<Terms />);

  expect(text).toContain("It comes with no warranty of any kind, express or implied.");
  expect(text).toContain("There is no warranty of merchantability.");
  expect(text).toContain("You use the viewer at your own risk.");
  expect(text).toContain("Soof Golan is not liable for any damage that comes from the viewer");
});

test("the terms make the user responsible for their own data and laws", () => {
  const text = textOf(<Terms />);

  expect(text).toContain("Your files stay on your device.");
  expect(text).toContain("you hold all responsibility for the files that you open");
  expect(text).toContain("HIPAA, GDPR, and similar laws are your duty, not mine.");
});

test("the terms cover the license, the demo dataset, availability, and changes", () => {
  const text = textOf(<Terms />);

  expect(text).toContain("The source code of the viewer is under the MIT License.");
  expect(text).toContain("Copyright (c) 2026 Soof Golan.");
  expect(text).toContain(
    "The demo dataset is under the MIT License, the same license as the code.",
  );
  expect(text).toContain("I make no promise that the viewer stays online.");
  expect(text).toContain("I make no promise that the output of the viewer is accurate.");
  expect(text).toContain("These terms can change.");
});

test("the terms carry the MIT copyright line and the lawyer note", () => {
  const text = textOf(<Terms />);

  expect(text).toContain("MIT License. Copyright (c) 2026 Soof Golan.");
  expect(text).toContain("A lawyer has not reviewed this text.");
});
