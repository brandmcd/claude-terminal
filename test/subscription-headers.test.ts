import { expect, test } from "bun:test";
import { pct } from "../subscription-headers.ts";

test("subscription header fractions remain full when usage exceeds the plan limit", () => {
  expect(pct("0")).toBe(0);
  expect(pct("0.27")).toBe(27);
  expect(pct("1")).toBe(100);
  expect(pct("1.01")).toBe(100);
  expect(pct("2")).toBe(100);
});

test("missing or invalid subscription readings are not reported as unused capacity", () => {
  for (const raw of [null, "", " ", "invalid", "Infinity"]) expect(pct(raw)).toBeNull();
});
