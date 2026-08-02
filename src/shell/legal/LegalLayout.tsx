import type { ReactNode } from "react";

export function LegalPage({
  title,
  lastUpdated,
  summary,
  children,
}: {
  title: string;
  lastUpdated: string;
  summary: string[];
  children: ReactNode;
}) {
  return (
    <main className="min-h-full bg-void px-6 py-16 text-[#e6e8ee] sm:py-24">
      <article className="mx-auto max-w-2xl">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-4 text-sm text-[#e6e8ee]/50">Last updated: {lastUpdated}</p>
        </header>

        <section
          aria-label="Plain language summary"
          className="mt-12 rounded-xl border border-edge bg-panel p-6 sm:p-8"
        >
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[#e6e8ee]/50">
            In short
          </h2>
          <ul className="mt-5 space-y-3">
            {summary.map((point) => (
              <li key={point} className="flex gap-3 leading-7 text-[#e6e8ee]/85">
                <span
                  aria-hidden="true"
                  className="mt-3 size-1.5 shrink-0 rounded-full bg-[#e6e8ee]/40"
                />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-[#e6e8ee]/40">The formal text follows.</p>
        </section>

        <div className="mt-16 space-y-14">{children}</div>

        <footer className="mt-20 border-t border-edge pt-8 text-sm text-[#e6e8ee]/40">
          <p>MIT License. Copyright (c) 2026 Soof Golan.</p>
          <p className="mt-2">A lawyer has not reviewed this text.</p>
        </footer>
      </article>
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      {children}
    </section>
  );
}

export function Callout({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl border border-red-400/40 bg-red-500/10 p-6 sm:p-8">
      <h2 className="text-2xl font-semibold tracking-tight text-red-100">{heading}</h2>
      {children}
    </section>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className="leading-7 text-[#e6e8ee]/80">{children}</p>;
}

export function Emphasis({ children }: { children: ReactNode }) {
  return <p className="font-semibold leading-7 text-[#e6e8ee]">{children}</p>;
}

export function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item} className="flex gap-3 leading-7 text-[#e6e8ee]/80">
          <span
            aria-hidden="true"
            className="mt-3 size-1.5 shrink-0 rounded-full bg-[#e6e8ee]/30"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-3 pl-5 leading-7 text-[#e6e8ee]/80 marker:text-[#e6e8ee]/40">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

export function Code({ children }: { children: string }) {
  return (
    <code className="rounded border border-edge bg-void px-1.5 py-0.5 text-[0.9em] text-[#e6e8ee]">
      {children}
    </code>
  );
}
