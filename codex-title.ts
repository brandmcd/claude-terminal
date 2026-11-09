// Ask on the task turn so the title can use the actual image contents.
export const CODEX_TITLE_REQUEST = "<title-request>After inspecting any attachments, begin your first user-facing message with a concise 3 to 6 word conversation title in <title></title> tags on its own line, then continue with the task. Base the title on the subject of the request or image, not attachment paths, filenames, or 'Attached files'. The app hides this tag and uses it to name the chat.</title-request>";

// Buffer only a possible leading tag, including tags split across stream chunks.
export class CodexTitleStream {
  private buffer = "";
  private scanning = true;
  constructor(private onTitle: (title: string) => void) {}
  push(text: string): string {
    if (!this.scanning) return text;
    this.buffer += text;
    const lead = this.buffer.trimStart();
    const open = "<title>";
    if (open.startsWith(lead)) return "";
    if (lead.startsWith(open)) {
      const end = lead.indexOf("</title>");
      if (end < 0 && this.buffer.length <= 240) return "";
      if (end >= 0) {
        const title = lead.slice(open.length, end).replace(/\s+/g, " ").trim().slice(0, 80);
        const rest = lead.slice(end + "</title>".length).replace(/^\s*\n/, "");
        this.buffer = "";
        this.scanning = false;
        if (title) this.onTitle(title);
        return rest;
      }
    }
    return this.finish();
  }
  finish(): string {
    const text = this.buffer;
    this.buffer = "";
    this.scanning = false;
    return text;
  }
}
