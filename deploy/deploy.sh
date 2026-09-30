#!/usr/bin/env bash
# Deploy the committed HEAD to the minipc. Never ships .env, node_modules or data/.
# Usage: deploy/deploy.sh [--no-restart]
set -euo pipefail

cd "$(dirname "$0")/.."
# Host/port/key live in deploy/local.env (git-ignored; the repo is public).
[ -f deploy/local.env ] && set -a && . deploy/local.env && set +a
: "${DEPLOY_HOST:?set DEPLOY_HOST in deploy/local.env (see deploy/local.env.example)}"
HOST="$DEPLOY_HOST"
PORT="${DEPLOY_PORT:-22}"
KEY="${DEPLOY_KEY:?set DEPLOY_KEY in deploy/local.env}"
KEY="${KEY/#\$HOME/$HOME}"
DEST="${DEPLOY_DIR:-elon-sniper-bot}"     # relative to remote $HOME
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -p "$PORT")

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes; deploy ships committed HEAD only." >&2
  echo "Commit first (or stash) so what runs on the minipc matches git." >&2
  exit 1
fi

REV="$(git rev-parse --short HEAD)"
echo "▶ Shipping $REV to $HOST:~/$DEST"
"${SSH[@]}" "$HOST" "mkdir -p ~/$DEST"
git archive HEAD | "${SSH[@]}" "$HOST" "tar -x -C ~/$DEST"
echo "$REV" | "${SSH[@]}" "$HOST" "cat > ~/$DEST/.deployed-rev"

echo "▶ Install, build, register service"
"${SSH[@]}" "$HOST" "DEST=$DEST bash -s" <<'REMOTE'
set -euo pipefail
cd ~/"$DEST"
[ -f .env ] || { echo "Missing ~/$DEST/.env — copy it first (see deploy/README.md)" >&2; exit 1; }
if ! command -v pnpm >/dev/null; then
  mkdir -p ~/bin && corepack enable --install-directory ~/bin && export PATH="$HOME/bin:$PATH"
fi
pnpm install --frozen-lockfile
pnpm -C dashboard install --frozen-lockfile
pnpm build
mkdir -p ~/.config/systemd/user
install -m 644 deploy/elon-sniper.service ~/.config/systemd/user/elon-sniper.service
systemctl --user daemon-reload
systemctl --user enable elon-sniper >/dev/null
REMOTE

if [ "${1:-}" != "--no-restart" ]; then
  "${SSH[@]}" "$HOST" "systemctl --user restart elon-sniper && sleep 3 && systemctl --user --no-pager status elon-sniper | head -12"
fi
