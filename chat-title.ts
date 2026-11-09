// A readable fallback when the provider hasn't supplied a conversation name.
// Upload scaffolding is context, not the subject of a chat.
export function chatTitle(prompt: string): string {
  const attachments = prompt.match(/^Attached files:\s*\n([\s\S]*?)(?:\n\s*\n|$)/i);
  let text = attachments ? prompt.slice(attachments[0].length) : prompt;
  text = text.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/https?:\/\/\S+/g, url => { try { return new URL(url).hostname; } catch { return url; } })
    .replace(/\s+/g, " ").trim();
  if (!text && attachments) text = attachments[1].trim().split("\n").map(p => p.split("/").pop()).join(", ");
  if (!text) return "New chat";
  if (text.length > 72) text = text.slice(0, 69).replace(/\s+\S*$/, "") + "…";
  return text[0].toUpperCase() + text.slice(1);
}

// Reject provider-generated upload scaffolding, including old cached names.
export function isAttachmentTitle(title: string): boolean {
  return /^attached files(?:\s*[:.…]|$)/i.test(title.trim());
}

export function providerChatTitle(title: string | null | undefined, prompt: string): string {
  return title && !isAttachmentTitle(title) ? title : chatTitle(prompt);
}
