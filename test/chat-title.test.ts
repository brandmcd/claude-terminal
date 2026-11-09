import { expect, test } from "bun:test";
import { chatTitle, providerChatTitle } from "../chat-title";

test("attachment paths never become the conversation subject", () => {
  expect(chatTitle("Attached files:\n/home/me/uploads/IMG_1034.jpeg\n/home/me/uploads/IMG_1035.jpeg\n\nmake printable FTC buttons")).toBe("Make printable FTC buttons");
  expect(chatTitle("Attached files:\n/home/me/uploads/design.pdf")).toBe("Design.pdf");
});
test("fallback titles are bounded and readable", () => {
  expect(chatTitle("fix https://example.com/very/long/path please")).toBe("Fix example.com please");
  expect(chatTitle("word ".repeat(100)).length).toBeLessThanOrEqual(72);
  expect(chatTitle("")).toBe("New chat");
});

test("stale and incoming attachment names fall back to the actual request", () => {
  const prompt = "Attached files:\n/tmp/photo.png\n\nmake a gumball meme";
  for (const title of ["Attached files", "Attached files:", "Attached files: /tmp/photo.png", "Attached files…"])
    expect(providerChatTitle(title, prompt)).toBe("Make a gumball meme");
  expect(providerChatTitle("Gumball Meme", prompt)).toBe("Gumball Meme");
  expect(providerChatTitle("Attached files keep disappearing", prompt)).toBe("Attached files keep disappearing");
});
