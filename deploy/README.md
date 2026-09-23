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

The same file also makes this one site: `location = /` redirects to `/app` and ttyd is served
under `/tty/`. That needs ttyd started with `--base-path /tty`; on this box the flag is in the
`ExecStart` of `/etc/systemd/system/ct-ttyd.service`, which is not in the repo:

```
ExecStart=/usr/local/bin/ttyd --port 7681 --interface 127.0.0.1 --base-path /tty --url-arg --writable …
```

Restarting ct-ttyd drops open terminal connections (tmux sessions survive), so reload those tabs.

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

## 7. VS Code in the browser — `/code/` — and dev-site preview — `/p/<port>/`

`code-server` (the real VS Code, served by a node process) runs as `ct-code.service` on
`127.0.0.1:8443` with **auth off**. nginx is its only gate: `auth_request` identifies the
user and the `$ct_code_backend` map in `/etc/nginx/conf.d/20-ct-code.conf` sends anyone
who is not the owner to a dead port (502). Cloudflare Access in front sees `/code/` as part
of the `Claude Terminal` app, so no Cloudflare change was needed.

`apply-root.sh` installs the `.deb` if `code-server` is missing (pinned to
`CODE_SERVER_VERSION`), the unit, the conf.d maps and the `/code + /p` vhost block. It
does **not** write the per-user files, which live in ctuser's home and are not tracked:

| File | What it holds |
|---|---|
| `~/.config/code-server/config.yaml` | `bind-addr 127.0.0.1:8443`, `auth: none`, telemetry and update checks off |
| `~/.local/share/code-server/User/settings.json` | dark theme, autosave after 1 s, no minimap, word wrap |
| `~/claude.code-workspace` | the folders VS Code opens: `~/work`, `~/vault`, `/srv/claude-terminal`, `/etc/claude-terminal` |

The unit passes the workspace file as code-server's argument, so a fresh browser lands on
those four folders. `/etc/claude-terminal` is readable but root-owned; edit it from a
terminal with sudo, not from the editor.

Upgrade: download the new `.deb` from github.com/coder/code-server/releases, `sudo dpkg -i`,
`sudo systemctl restart ct-code`, bump `CODE_SERVER_VERSION` here. Extensions come from
Open VSX: `code-server --install-extension <id>` as ctuser, then reload the page.

Images and GIFs open in VS Code's built-in viewer, Markdown has a preview, and the
integrated terminal has `~/.local/bin/claude` on its PATH (the same self-updating CLI the
ttyd tabs use).

**Preview a site**: anything listening on this box is reachable at
`https://claude.brandmcd.com/p/<port>/`, owner-only, same gate. Servers that emit
absolute asset URLs break under a subpath, so give them a base:

```
vite --base /p/5173/                   # Vite / SvelteKit dev servers
python3 -m http.server 8000 -d out/    # static output works unchanged
```

code-server's own `/code/proxy/<port>/` does the same thing with the same limitation. A
subdomain-per-port scheme would avoid it but needs a wildcard DNS record, a tunnel ingress
rule and an Access policy in Cloudflare, which is not managed from this box.

Memory note: this box has 3.7 GiB and the TTS service alone holds ~1.5 GiB. code-server
idles around 300 MB and grows with open extensions; if the box starts swapping hard,
`systemctl stop claude-tts.local` is the cheapest relief.

## 8. SSH from a laptop (VS Code Remote-SSH)

sshd listens on the Tailscale address only (`/etc/ssh/sshd_config.d/98-listen.conf`),
key auth only, no root. Two ways in, both over the tailnet:

1. **Plain OpenSSH** (in use): the laptop's public key is in `~ctuser/.ssh/authorized_keys`.
2. **Tailscale SSH** is deliberately OFF (`tailscale set --ssh=false`). When it was on,
   tailscaled intercepted every port-22 connection from the tailnet and, under the
   default `check` policy, waited on a browser prompt that the laptop never saw, so
   `ssh` and Remote-SSH both timed out and sshd logged nothing
   (journalctl -u tailscaled shows `handling conn: ... ctuser@100.114.64.51:22`). Turn it
   back on only after changing the tailnet ssh rule to `"action": "accept"`.

Laptop `~/.ssh/config`:

```
Host claude-vps
    HostName claude-vps.tail8db408.ts.net   # or 100.114.64.51
    User ctuser
```

Then in VS Code: Remote-SSH: Connect to Host → `claude-vps`, open `/home/ctuser/claude.code-workspace`.

## Terminal launch files

Copies of the files that run each terminal tab, which live outside the repo on the box:

| Repo copy | Installed at | What it does |
|---|---|---|
| `deploy/ct-ttyd.service` | `/etc/systemd/system/ct-ttyd.service` | ttyd under `/tty` (`--base-path /tty`); `KillMode=process` so a restart keeps tmux and its sessions |
| `deploy/terminal/rt-entry` | `/usr/local/bin/rt-entry` | what ttyd runs per connection: validates `?arg=`, attaches or creates the tmux session |
| `deploy/terminal/rt-launch` | `/usr/local/bin/rt-launch` | what runs inside the tmux pane: `claude`, or `claude --resume <id>` |
| `deploy/terminal/ct-hook` | `/usr/local/bin/ct-hook` | Claude Code hook that records each tab's state (thinking / waiting / done) for the tab dots and timers |

Install with `sudo install -m 755 deploy/terminal/* /usr/local/bin/` and
`sudo install -m 644 deploy/ct-ttyd.service /etc/systemd/system/ && sudo systemctl daemon-reload`.
