/**
 * Which page the address bar asks for.
 *
 * The viewer is the default. The two legal pages are the only other pages, and
 * they are reachable by a plain link, so they can be shared and bookmarked.
 */
import { parseAsStringLiteral, useQueryState } from "nuqs";

export const PAGES = ["viewer", "privacy", "terms"] as const;

export type Page = (typeof PAGES)[number];

const pageParser = parseAsStringLiteral(PAGES).withDefault("viewer");

export function usePage() {
  return useQueryState("page", pageParser);
}

export function pageHref(page: Page): string {
  return page === "viewer" ? "?" : `?page=${page}`;
}
