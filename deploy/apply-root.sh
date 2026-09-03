#!/usr/bin/env bash
# Apply the root half of the claude-terminal rollout. Run once, as root:
#
#     sudo /srv/claude-terminal/deploy/apply-root.sh
#
# Idempotent: re-running it changes nothing that is already in place. Everything it edits
# is backed up next to the original with a .bak-<timestamp> suffix first, and it refuses to
# reload nginx unless `nginx -t` passes, so a bad edit cannot take the site down.
#
# It does NOT touch Cloudflare. /usage is served ungated by nginx after this, but the
# hostname is still behind Cloudflare Access until a Bypass policy exists for
# claude.brandmcd.com/usage* in the Zero Trust dashboard. That part is a browser job.
#
# It does NOT install espeak-ng. Upstream's README asks for it, but misaki loads the
# libespeak-ng bundled in the espeakng_loader wheel; verified on this box.
set -euo pipefail

REPO=/srv/claude-terminal
CFG=/etc/claude-terminal/config.json
VHOST=/etc/nginx/sites-enabled/claude-terminal
STAMP=$(date +%Y%m%d-%H%M%S)
MARKER='# >>> claude-terminal: /app + /usage (managed by deploy/apply-root.sh) >>>'
ENDMARK='# <<< claude-terminal: /app + /usage <<<'
CODE_MARKER='# >>> claude-terminal: /code + /p (managed by deploy/apply-root.sh) >>>'
CODE_ENDMARK='# <<< claude-terminal: /code + /p <<<'
CODE_SERVER_VERSION=4.135.0   # the .deb apply-root installs when code-server is absent

[ "$(id -u)" -eq 0 ] || { echo "must run as root: sudo $0" >&2; exit 1; }
say() { printf '\n== %s\n' "$*"; }
backup() { [ -f "$1" ] && cp -a "$1" "$1.bak-$STAMP" && echo "  backed up -> $1.bak-$STAMP"; }
# insert_block <snippet> <marker> <endmark>: paste a managed block into the vhost, inside
# server{}, before the catch-all `location / {`, which must stay last (`^~` beats a prefix
# match, but only if nginx sees these blocks at all).
insert_block() {
  python3 - "$VHOST" "$1" "$2" "$3" <<'PY'
import re, sys
vhost, snippet, marker, endmark = sys.argv[1:5]
src = open(vhost).read()
block = marker + "\n" + open(snippet).read().rstrip() + "\n" + endmark + "\n"
# indent to match the surrounding server{} body
block = "".join(("    " + l if l.strip() else l) for l in block.splitlines(True))
m = re.search(r'^([ \t]*)location / \{', src, re.M)
if not m:
    sys.exit("could not find the catch-all `location / {` to insert before")
out = src[:m.start()] + block + "\n" + src[m.start():]
open(vhost, "w").write(out)
print("  inserted %d lines before the catch-all location /" % block.count("\n"))
PY
}

# ---------------------------------------------------------------- 1. nginx
say "nginx: /app and /usage routing"
if grep -qF "$MARKER" "$VHOST"; then
  echo "  already present, leaving alone"
else
  [ -f "$VHOST" ] || { echo "  $VHOST not found" >&2; exit 1; }
  # NOT `backup` here: sites-enabled/ is an include glob, so a .bak-* left in that
  # directory is parsed as a second vhost and nginx -t fails on a duplicate server.
  mkdir -p /etc/nginx/vhost-backups
  cp -aL "$VHOST" "/etc/nginx/vhost-backups/claude-terminal.bak-$STAMP"
  echo "  backed up -> /etc/nginx/vhost-backups/claude-terminal.bak-$STAMP"
  insert_block "$REPO/deploy/nginx-app-usage.conf" "$MARKER" "$ENDMARK"
fi

# code-server + preview proxy: a second managed block, same shape, plus the conf.d maps
# its owner-only routing needs (nginx maps must live outside server{}).
say "nginx: /code and /p routing"
install -m 644 "$REPO/deploy/nginx-code-map.conf" /etc/nginx/conf.d/20-ct-code.conf
if grep -qF "$CODE_MARKER" "$VHOST"; then
  echo "  already present, leaving alone"
else
  insert_block "$REPO/deploy/nginx-code.conf" "$CODE_MARKER" "$CODE_ENDMARK"
fi

say "nginx: config test"
nginx -t
say "nginx: reload"
systemctl reload nginx
echo "  reloaded"

# ---------------------------------------------------------------- 2. sidecar config
say "config.json"
if [ -f "$CFG" ] && cmp -s "$CFG" "$REPO/deploy/config.json.proposed"; then
  echo "  already current"
else
  backup "$CFG"
  install -o root -g ctuser -m 640 "$REPO/deploy/config.json.proposed" "$CFG"
  echo "  installed (usagePage, names/hosts/colors, appModels, voice)"
fi

# ---------------------------------------------------------------- 3. usage collector
say "usage collector"
install -d -o ctuser -g ctuser /var/lib/claude-terminal
install -m 644 "$REPO/deploy/ct-collector.service" "$REPO/deploy/ct-collector.timer" /etc/systemd/system/
echo "  units installed"

# ---------------------------------------------------------------- 4. voice services
say "voice services"
for f in claude-voice.slice claude-stt.local.service claude-tts.local.service; do
  install -m 644 "$REPO/voice/systemd/$f" /etc/systemd/system/
done
echo "  slice + 2 units installed"

# ---------------------------------------------------------------- 4b. code-server
say "code-server (VS Code at /code/)"
if ! command -v code-server >/dev/null; then
  deb=/tmp/code-server_${CODE_SERVER_VERSION}_amd64.deb
  curl -fsSL -o "$deb" "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb"
  dpkg -i "$deb" && rm -f "$deb"
  echo "  installed code-server $CODE_SERVER_VERSION"
else
  echo "  code-server $(code-server --version | head -1 | cut -d' ' -f1) present"
fi
install -m 644 "$REPO/deploy/ct-code.service" /etc/systemd/system/
# Listener, auth and workspace live in ctuser's home (config.yaml, settings.json, the
# .code-workspace file); see deploy/README.md section 7. Per-user files, not tracked here.
echo "  unit installed"

systemctl daemon-reload

# ---------------------------------------------------------------- 5. start
say "enable and start"
systemctl enable --now ct-collector.timer
systemctl start ct-collector.service || echo "  (first collector run reported an error; see journalctl -u ct-collector)"
systemctl enable --now claude-stt.local.service
systemctl enable --now claude-tts.local.service
systemctl enable --now ct-code.service
systemctl restart ct-sidecar.service ct-ttyd.service
echo "  services up"

# ---------------------------------------------------------------- 6. verify
say "verify"
sleep 4
ok=0; bad=0
check() { # check <label> <expected-code> <curl args...>
  local label=$1 want=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || echo 000)
  if [ "$got" = "$want" ]; then echo "  ok   $got  $label"; ok=$((ok+1))
  else echo "  FAIL $got (want $want)  $label"; bad=$((bad+1)); fi
}
check "sidecar /usage/"            200 http://127.0.0.1:7682/usage/
check "sidecar /usage/api"         200 http://127.0.0.1:7682/usage/api
check "sidecar /app (owner)"       200 -H 'remote-user: brandon' http://127.0.0.1:7682/app
check "STT /health"                200 http://127.0.0.1:7801/health
check "TTS /health"                200 http://127.0.0.1:7802/health
check "code-server /"              302 http://127.0.0.1:8443/
check "nginx /code/ (no CF token)" 401 -H 'Host: claude.brandmcd.com' http://127.0.0.1:8080/code/

echo
echo "  voice advertised to the app:"
curl -s -H 'remote-user: brandon' http://127.0.0.1:7682/app/api/models \
  | python3 -c 'import json,sys; print("    voice:", json.load(sys.stdin).get("voice"))' 2>/dev/null \
  || echo "    (could not read /app/api/models)"

echo
free -h | head -2 | sed 's/^/  /'

echo
if [ "$bad" -eq 0 ]; then
  echo "All $ok checks passed."
else
  echo "$bad check(s) failed - see: journalctl -u ct-sidecar -u ct-code -u claude-stt.local -u claude-tts.local -n 50"
fi

cat <<'NEXT'

Two things this script cannot do for you:

 1. Cloudflare Access. /usage is ungated at nginx now, but the hostname is still behind
    the CF login. Add a Bypass policy for claude.brandmcd.com/usage* in Zero Trust.
 2. The iPhone icon. iOS bakes the home-screen icon at install and never refreshes it.
    Delete the app, open https://claude.brandmcd.com in Safari, Add to Home Screen.

To undo: the .bak-* files next to config.json and the nginx vhost are this run's originals.
NEXT
