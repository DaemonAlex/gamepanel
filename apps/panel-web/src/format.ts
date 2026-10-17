import type { ServerView } from "@gamepanel/shared";

export function gib(bytes: number): string {
  return `${(bytes / 2 ** 30).toFixed(1)} GB`;
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

export function barClass(p: number): string {
  return p >= 90 ? "bar full" : p >= 70 ? "bar hot" : "bar";
}

// The state word shown on a card, and the pin colour class.
export function stateOf(s: ServerView): string {
  if (s.error) return "unreachable";
  return s.status?.state ?? "unknown";
}

export function uptime(startedAt: string | undefined): string {
  if (!startedAt) return "";
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60_000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h} h ${mins % 60} min` : `${Math.floor(h / 24)} days`;
}

// Copy text; falls back to selecting it when the clipboard is not allowed.
export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
