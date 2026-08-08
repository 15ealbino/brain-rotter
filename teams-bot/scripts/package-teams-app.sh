#!/usr/bin/env bash
# Builds the sideloadable Teams app package. POSIX-shell equivalent of Package-TeamsApp.ps1,
# for developing on Linux/macOS. Needs `zip` and `python3`.
set -euo pipefail

BOT_APP_ID=""
BOT_HOSTNAME=""
TEAMS_APP_ID=""
APP_VERSION="1.0.0"

usage() {
  cat <<'EOF'
Usage: package-teams-app.sh --bot-app-id <guid> --hostname <host> [--teams-app-id <guid>] [--version <x.y.z>]

  --bot-app-id    Entra ID application (client) id of the bot (same as Bot:AppId).
  --hostname      Hostname of Bot:BotBaseUrl, without the scheme. e.g. bot.contoso.com
  --teams-app-id  GUID identifying the Teams app itself. Generated if omitted - but SAVE IT and
                  reuse it, or Teams treats every upload as a brand-new app instead of an upgrade.
  --version       Manifest version string. Default 1.0.0

Writes teams-bot/dist/brain-rotter-recorder.zip
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-app-id)   BOT_APP_ID="$2"; shift 2 ;;
    --hostname)     BOT_HOSTNAME="$2"; shift 2 ;;
    --teams-app-id) TEAMS_APP_ID="$2"; shift 2 ;;
    --version)      APP_VERSION="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$BOT_APP_ID"   ]] || { echo "error: --bot-app-id is required" >&2; usage; exit 2; }
[[ -n "$BOT_HOSTNAME" ]] || { echo "error: --hostname is required" >&2; usage; exit 2; }

command -v zip     >/dev/null || { echo "error: 'zip' is not installed." >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: 'python3' is not installed." >&2; exit 1; }

GUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
[[ "$BOT_APP_ID" =~ $GUID_RE ]] || { echo "error: --bot-app-id '$BOT_APP_ID' is not a GUID." >&2; exit 2; }

if [[ -z "$TEAMS_APP_ID" ]]; then
  TEAMS_APP_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  echo "No --teams-app-id given; generated $TEAMS_APP_ID"
  echo "SAVE THIS and pass it on every rebuild."
fi
[[ "$TEAMS_APP_ID" =~ $GUID_RE ]] || { echo "error: --teams-app-id '$TEAMS_APP_ID' is not a GUID." >&2; exit 2; }

# Strip any scheme/path the user pasted in.
BOT_HOSTNAME="${BOT_HOSTNAME#http://}"
BOT_HOSTNAME="${BOT_HOSTNAME#https://}"
BOT_HOSTNAME="${BOT_HOSTNAME%%/*}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/appPackage"
DIST="$ROOT/dist"
ZIP="$DIST/brain-rotter-recorder.zip"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$DIST"

python3 - "$SRC/manifest.json" "$STAGING/manifest.json" \
  "$TEAMS_APP_ID" "$BOT_APP_ID" "$BOT_HOSTNAME" "$APP_VERSION" <<'PY'
import json, re, sys
src, dst, teams_app_id, bot_app_id, hostname, version = sys.argv[1:7]

text = open(src, encoding='utf-8').read()
text = (text
        .replace('REPLACE-WITH-TEAMS-APP-GUID', teams_app_id)
        .replace('REPLACE-WITH-ENTRA-APP-ID', bot_app_id)
        .replace('REPLACE-WITH-BOT-HOSTNAME', hostname))
text = re.sub(r'"version":\s*"[^"]*"', f'"version": "{version}"', text, count=1)

if 'REPLACE-WITH-' in text:
    sys.exit('error: manifest still contains REPLACE-WITH- placeholders after substitution.')

# Fail here rather than at upload time - Teams' manifest errors are not helpful.
json.loads(text)

open(dst, 'w', encoding='utf-8').write(text)
PY

cp "$SRC/color.png" "$SRC/outline.png" "$STAGING/"

rm -f "$ZIP"
( cd "$STAGING" && zip -q -9 "$ZIP" manifest.json color.png outline.png )

cat <<EOF

Built $ZIP
  Teams app id : $TEAMS_APP_ID
  Bot app id   : $BOT_APP_ID
  Valid domain : $BOT_HOSTNAME
  Version      : $APP_VERSION

Upload it: Teams -> Apps -> Manage your apps -> Upload an app -> Upload a custom app.
If that option is missing, custom app upload is off for your tenant - see teams-bot/README.md.
EOF
