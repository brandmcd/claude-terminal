# Deploying this fork on claude.brandmcd.com

Everything in this directory needs **root**. As of 2026-08-27, `ctuser` has it:
`/etc/sudoers.d/91-ctuser` grants `ctuser ALL=(ALL) NOPASSWD:ALL`, so the agent in this
terminal can run every command below itself. Check before assuming otherwise:

```bash
sudo -n true && echo "sudo works"
```

> **This section used to say the opposite.** Until 2026-08-28 it stated that `ctuser` was
> "not in `sudo`, and there is no `/etc/sudoers.d` entry for it", and that the situation
> "is not something that can be fixed from inside the box." That was true when written and
> false after the grant, and an agent reading it reported having no sudo while holding
> passwordless root. Test the permission; do not trust this file's memory of it.
>
> Note that Claude Code's *bypass-permissions* mode and *OS-level sudo* remain unrelated:
> bypass mode only stops Claude Code asking you to approve each tool call, it grants no
> Unix privilege. Both happen to be on here.
>
> The grant is deliberately broad, and the consequence is worth stating plainly: anyone
> who clears Cloudflare Access, and any instruction that reaches the agent in this
> terminal, reaches root. A narrower alternative, if that ever stops being acceptable:
>
> ```bash
> cat > /etc/sudoers.d/91-ctuser <<'EOF'
> ctuser ALL=(root) NOPASSWD: /bin/systemctl restart ct-sidecar.service, \
>   /bin/systemctl restart ct-ttyd.service, /bin/systemctl reload nginx, \
>   /usr/sbin/nginx -t
> EOF
> chmod 440 /etc/sudoers.d/91-ctuser && visudo -c
> ```

**There is no Cloudflare API token on this box, by decision.** Access, DNS and tunnel
changes are made from Brandon's laptop or by Brandon. A step that needs one is a step to
hand back, not a reason to abandon the rest of the task.

---

## 1. nginx — route `/app` and `/usage`

Today the vhost has exactly two proxy blocks: `^~ /_ct/` to the sidecar, and a catch-all
`location /` to ttyd. The chat app's bundle fetches absolute `/app/api/*`, `/app/stream/*`
and `/app/assets/*`, and the dashboard lives at `/usage/` — all of which currently fall
through to ttyd and 404.

Paste the contents of `nginx-app-usage.conf` into the `server { … }` block in
`/etc/nginx/sites-enabled/claude-terminal`, **above** the catch-all `location /`.

```bash
nginx -t && systemctl reload nginx
```

The snippet has already been syntax-checked standalone (`nginx -t` against a minimal
config that includes it verbatim) — but not against the real vhost, so run `nginx -t`
before reloading.

**`/usage/` is deliberately ungated** (`auth_request off`) because you asked for it to be
public. Two things follow:

- nginx is not the only gate. **Cloudflare Access also fronts this hostname.** Removing
  `auth_request` is necessary but not sufficient. Done 2026-08-28: a second Access
  application, `Claude Usage Dashboard (public)`, covers `claude.brandmcd.com/usage` and
  `claude.brandmcd.com/usage/*` with a single bypass-everyone policy. Access matches the
  most specific path, so the `Claude Terminal` app still gates everything else.
- The vhost carries `absolute_redirect off;`. Without it, `location = /usage` builds its
  `Location` from the internal listener and 301s the browser to
  `http://claude.brandmcd.com:8080/usage/`, which does not resolve publicly.
- What that exposes is aggregate token counts, model names, session counts and last-active
  times — no transcripts, no prompts. `/usage/export` is now enabled (2026-08-28) so a peer
  can pull this instance's figures, and it sits on the public prefix with the bearer token
  as its only gate. The secret lives in `/etc/claude-terminal/export.token` (640
  root:ctuser) and is named from `exportTokenFile`, never inline — `config.json.proposed`
  is tracked in a public repo. `exportCombinePeers: true` folds the external peers into the
  owner's row, so a puller sees one figure for the VPS and the laptop together.

## 2. config.json

`config.json.proposed` is your current `/etc/claude-terminal/config.json` plus the keys the
new features read. Diff it before copying — it was generated from the live file, so it
should differ only in additions:

```bash
diff -u /etc/claude-terminal/config.json /srv/claude-terminal/deploy/config.json.proposed
install -o root -g ctuser -m 640 /srv/claude-terminal/deploy/config.json.proposed \
        /etc/claude-terminal/config.json
```

What each addition does:

| Key | Why |
|---|---|
| `usagePage: true` | was `false`, which made the sidecar skip the dashboard and never open usage.db |
| `names` / `hosts` / `colors` | single-user roster; `colors` now actually drives the chart colours |
| `collectSeconds: 60` | matches the collector timer below |
| `appModels` / `appMoreModels` | fallback only since the upstream merge: `/app/api/models` now prefers the CLI's live `supportedModels()` menu (same list as `/model` in a tab) and only falls back to these if that probe fails |
| `voice`, `sttUrl`, `ttsUrl` | enables the mic button; the routes 503 until the two services are up |

Not changed, but worth a thought: `themeColor` is still `#c8102e` (red) while the new icon
is green on `#0D1117`. That colour tints the PWA status bar and splash. Set it to
`#0D1117` if you want them to match.

## 3. Usage collector

The dashboard reads `usage.db`; nothing writes it yet. `collector.ts` is a one-shot script,
so it needs a timer.

```bash
install -m 644 /srv/claude-terminal/deploy/ct-collector.{service,timer} /etc/systemd/system/
mkdir -p /var/lib/claude-terminal && chown ctuser:ctuser /var/lib/claude-terminal
systemctl daemon-reload
systemctl enable --now ct-collector.timer
systemctl start ct-collector.service   # first run, don't wait for the timer
journalctl -u ct-collector.service -n 20 --no-pager
```

Verified working: run against a throwaway DB it ingested all 17 transcripts under
`~/.claude/projects` and produced a leaderboard showing 856k output tokens for the month.

## 4. Voice

See `../voice/README-thisbox.md` for the full procedure (uv sync, model downloads, smoke
tests). The one package install it needs:

```bash
apt install espeak-ng
```

Note the honest constraint: this box is 2 vCPU / 3.7 GB with no GPU, while upstream's
numbers ("~0.4 s per turn") come from a 5900X. Expect noticeably slower turns here, and
watch memory — the units ship with `MemoryMax=` set so a voice service cannot OOM-kill
your terminal.

## 5. Restart and verify

```bash
systemctl restart ct-sidecar.service ct-ttyd.service
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7682/usage/     # 200
curl -s -H 'Remote-User: brandon' -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:7682/app                                            # 200
```

## 6. The PWA icon — this part is on the phone, not the server

The icon files and every `?v=` cache-buster are already updated (unified at `v6`; they were
split across `v3` and `v4`, which is the actual reason the old mark kept coming back). But
**iOS bakes the home-screen icon at install time and never refreshes it in place.** No
amount of server-side cache-busting will change an already-installed icon.

So on the iPhone: delete the installed app from the home screen, open
`https://claude.brandmcd.com` in Safari, and Share → *Add to Home Screen* again.
