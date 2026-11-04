# VPS agent instructions

The owner's projects are under ~/work. The shared Obsidian vault is ~/vault.
Read ~/CLAUDE.md for this server's paths and synchronization rules. Those rules
apply to Codex too. Read the vault's AGENTS.md and _System/AI Rules.md before
working on notes.

In the chat app, use the shared-work MCP vault_read and vault_append tools for
note additions. Supply the hash returned by vault_read. A conflict means the
note changed; read it again before deciding what to append. Preserve Brandon's
writing and every other agent's existing contribution. The tool records the
provider, model, session, timestamp and hashes outside the vault, in
~/.local/state/ct-vault-authorship.jsonl. Keep the vault's existing ai metadata.

Do not reset, stash, rebase, commit or push another session's uncommitted work.
For a requested replacement that cannot use the append tool, work in an isolated
Git worktree and reconcile changes without overwriting the shared checkout.

The shared-work agent_models, agent_spawn and agent_status tools support
explicit model choices across Claude and Codex. Assign distinct tasks and files
to concurrent children. Read their results before reporting completion.

The existing phone-call command is /usr/local/bin/claude-call. Both providers
can use it when the owner asks for a call. It preserves the existing quiet-hour
and calendar checks. Don't expose or copy the Twilio credentials. The incoming
phone bridge accepts 'Use Codex', 'Use Claude', or a model family such as Astra.
