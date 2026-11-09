# Codex in the chat app

The owner model menu includes the Codex CLI's current model catalog alongside
Claude. Codex uses the owner's ChatGPT login. It doesn't require an OpenAI API
key. Guest instances continue to offer their configured Claude models.

Install matching `codex` and `codex-code-mode-host` binaries in
`~/.local/bin`. Sign in with `codex login --device-auth`, or use OpenAI's
documented SSH auth-cache transfer. Keep `~/.codex` mode 0700 and `auth.json`
mode 0600. Never commit authentication files.

The app starts Codex app-server over stdio. New Codex chat records live under
`~/.codex/ct-app`; native threads remain in Codex's own storage. The app maps
streaming output to the existing chat renderer. `/plan` selects planning mode;
`/default` returns to normal work. Editing earlier Codex turns with file rollback
isn't supported; use a fork instead.

Changing provider creates a separate chat with copied conversation context.
The original remains available. Transfer records and copied display history live
in `~/.local/state/ct-provider-handoffs` and `ct-provider-contexts`. Transfers
larger than 400,000 characters require a summary. Copied earlier turns must be
edited in the original chat.

The usage page displays each subscription separately. Codex quota labels follow
the reported window length. Account token activity is shown only when OpenAI
returns it. Missing data is unavailable, never an inferred zero.

Both providers receive the `shared-work` MCP server. `agent_models` lists model
IDs, `agent_spawn` launches a child chat, and `agent_status` reads its result.
Delegation is limited to three levels. For shared vault additions, `vault_read`
returns a content hash and `vault_append` checks it under a per-note lock before
writing. Authorship is recorded outside the vault in
`~/.local/state/ct-vault-authorship.jsonl`. Agents must use these tools for vault
additions; direct shell edits don't participate in their locks.

The phone bridge accepts “Use Codex,” “Use Claude,” or a model family and version.
Both providers can use the existing `claude-call` command for requested outbound
calls, including its quiet-hour checks. Phone-screen control isn't configured.
Question and approval cards still require the web app.

## Email approval

The owner installs `codex-email-hook.py` as `~/.codex/hooks/email-gate.py` and
registers it in `~/.codex/hooks.json` for `PreToolUse`, matcher `Bash|mcp__.*`,
timeout 330 seconds. Trust that exact hook definition using Codex's hooks
configuration. Verify `hooks/list` reports it enabled and trusted.

The adapter calls the existing `~/.claude/hooks/email-gate.py` detector, including
its one-use compose-card approvals. For an unapproved send it waits on a private
Unix socket supplied by `CodexConversation` and displays the full send arguments
in the existing chat approval UI. Only **Send email** releases the tool. Cancel,
interrupt, a five-minute timeout, or a bridge error denies the send. Outside the
chat app, sends without an existing compose approval are denied.

Codex does not support Claude's `permissionDecision: "ask"`; passing that through
would fail open. The adapter returns only explicit allow/deny decisions. See
[OpenAI's hook contract](https://learn.chatgpt.com/docs/hooks#pretooluse).
The detector retains the existing Claude gate's heuristic coverage; this is not
an OS-level restriction on arbitrary code or network access.

After installing backend changes, restart `ct-sidecar.service` when active chats
have finished. Already-running Codex processes must be recreated to load the hook
and the per-conversation approval socket. No frontend build is needed.
