import { expect, test } from "bun:test";
import { continuedChatIds, saveLaunchContext, deleteLaunchContext } from "../provider-handoff";

test("provider continuations hide earlier copies transitively without hiding explicit forks", () => {
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
  const [original, middle, latest, fork] = ids;
  const options = (source: string) => ({ cwd: "/tmp", handoffContext: `The original chat remains available as ${source}.\n[]` });
  try {
    saveLaunchContext(middle, options(original));
    saveLaunchContext(latest, options(middle));
    saveLaunchContext(fork, { ...options(latest), handoffFork: true });
    const hidden = continuedChatIds(new Set([latest, fork]));
    expect(hidden.has(original)).toBe(true);
    expect(hidden.has(middle)).toBe(true);
    expect(hidden.has(latest)).toBe(false);
    expect(hidden.has(fork)).toBe(false);
  } finally { for (const id of ids) deleteLaunchContext(id); }
});
