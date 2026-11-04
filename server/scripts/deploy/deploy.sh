#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/deploy/deploy.sh — deploys the API on the SpeedyConnect/go54 host.
#
# One script, two triggers:
#   • Cron (pull):  runs every few minutes, asks GitHub for the head of the
#                   `api-release` branch, deploys it if it's new.
#   • SSH (push):   GitHub Actions runs `deploy.sh <sha>` right after CI.
# CI only moves `api-release` after the server tests pass, so untested code
# is never deployed by either path.
#
# What a deploy does:
#   1. download that commit's tarball from GitHub and take its server/ folder
#   2. back up the current app (code only — never .env, node_modules, tmp)
#   3. copy the new code over the app (nothing is deleted, .env untouched)
#   4. `npm install --omit=dev` only if package.json dependencies changed
#   5. restart the app (tmp/restart.txt + cloudlinux-selector if present)
#   6. poll /healthz until it reports ok and this commit as its revision
#   7. on failure: restore the backup, restart again, and remember the bad
#      commit so cron doesn't retry it every 5 minutes
#
# Usage:
#   deploy.sh            deploy the head of api-release if it's new (cron)
#   deploy.sh <sha>      deploy that commit (SSH from GitHub Actions)
#   deploy.sh --check    verify paths/tools/GitHub access; changes nothing
#   deploy.sh --force    redeploy even if that commit is already live/failed
#
# Settings can be overridden in ~/.deploy/config (plain KEY=value lines).
# A GitHub token (only needed if the repo is private) goes in
# ~/.deploy/github-token — a fine-grained, read-only "Contents" token.
#
# Everything lives inside main() so bash parses the whole file before
# running it — a deploy can safely overwrite this script while it runs.
# ─────────────────────────────────────────────────────────────────────────────

main() {
  set -uo pipefail

  local STATE_DIR="${STATE_DIR:-$HOME/.deploy}"
  mkdir -p "$STATE_DIR"
  # shellcheck disable=SC1091
  [ -f "$STATE_DIR/config" ] && . "$STATE_DIR/config"

  local APP_DIR="${APP_DIR:-$HOME/kemchuta-api}"
  local NODE_BIN="${NODE_BIN:-$HOME/nodevenv/kemchuta-api/22/bin}"
  local REPO="${REPO:-MarkVTechnologies/kemchutahomesV2}"
  local BRANCH="${BRANCH:-api-release}"
  local HEALTH_URL="${HEALTH_URL:-https://api.kemchutahomesltd.com/healthz}"
  local KEEP_BACKUPS="${KEEP_BACKUPS:-5}"
  local LOG="$STATE_DIR/deploy.log"

  local MODE="auto" TARGET="" FORCE=0
  for arg in "$@"; do
    case "$arg" in
      --check) MODE="check" ;;
      --force) FORCE=1 ;;
      -*) echo "unknown option $arg" >&2; return 2 ;;
      *) TARGET="$arg" ;;
    esac
  done

  log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

  local AUTH=()
  if [ -s "$STATE_DIR/github-token" ]; then
    AUTH=(-H "Authorization: Bearer $(tr -d '[:space:]' < "$STATE_DIR/github-token")")
  fi
  gh_api() { curl -fsSL --max-time 60 ${AUTH[@]+"${AUTH[@]}"} -H "X-GitHub-Api-Version: 2022-11-28" "$@"; }

  health_json() { curl -fsS --max-time 15 "$HEALTH_URL" 2>/dev/null; }
  # Prints "<uptime> <revision|->" if /healthz says ok, nothing otherwise.
  health_uptime() {
    health_json | "$NODE_BIN/node" -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        try{const j=JSON.parse(s);if(j.status==="ok")console.log(Math.floor(j.uptime)+" "+(j.revision||"-"))}catch{}
      })' 2>/dev/null
  }
  # Reinstall only when the dependency list in package.json changes. The
  # lockfile isn't compared: the panel's "Run NPM Install" rewrites it on the
  # host, so it differs from git even when nothing needs installing.
  deps_sig() {
    "$NODE_BIN/node" -e '
      try{const p=require(process.argv[1]);const o={};
        for(const k of ["dependencies","optionalDependencies","overrides"])
          if(p[k])o[k]=Object.fromEntries(Object.entries(p[k]).sort());
        console.log(JSON.stringify(o))}catch{console.log("unreadable")}' "$1" 2>/dev/null
  }

  # ── --check: report on the environment, change nothing ───────────────────
  if [ "$MODE" = "check" ]; then
    local ok=1
    echo "APP_DIR     $APP_DIR"; [ -f "$APP_DIR/index.js" ] && [ -f "$APP_DIR/app.cjs" ] || { echo "  !! index.js/app.cjs not found here"; ok=0; }
    [ -f "$APP_DIR/.env" ] && echo "  .env present" || echo "  !! no .env in APP_DIR"
    echo "NODE_BIN    $NODE_BIN"; "$NODE_BIN/node" -v 2>/dev/null || { echo "  !! node not found"; ok=0; }
    "$NODE_BIN/npm" -v >/dev/null 2>&1 && echo "  npm $("$NODE_BIN/npm" -v)" || { echo "  !! npm not found"; ok=0; }
    for t in curl tar sha256sum; do command -v "$t" >/dev/null || { echo "  !! missing tool: $t"; ok=0; }; done
    command -v cloudlinux-selector >/dev/null && echo "  cloudlinux-selector available" || echo "  (no cloudlinux-selector; will restart via tmp/restart.txt)"
    local head; head=$(gh_api -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>&1) \
      && echo "GitHub      $REPO@$BRANCH = $head" || { echo "  !! cannot read $REPO@$BRANCH from GitHub: $head"; ok=0; }
    echo "Live        $(cat "$STATE_DIR/deployed-sha" 2>/dev/null || echo '(never deployed by this script)')"
    local up; up=$(health_uptime); [ -n "$up" ] && echo "Health      ok (uptime/revision: $up)" || { echo "  !! $HEALTH_URL not ok"; ok=0; }
    [ "$ok" = 1 ] && echo "CHECK PASSED" || echo "CHECK FAILED"
    [ "$ok" = 1 ]; return
  fi

  # ── one deploy at a time (mkdir is atomic; flock isn't always available) ──
  local LOCK="$STATE_DIR/lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      rm -rf "$LOCK"; mkdir "$LOCK" || return 1
    else
      return 0   # another deploy is running
    fi
  fi
  # Expanded now (double quotes): main's locals are gone when EXIT fires.
  trap "rm -rf '$LOCK' '$STATE_DIR/work'" EXIT

  # ── which commit? ──────────────────────────────────────────────────────────
  if [ -z "$TARGET" ]; then
    TARGET=$(gh_api -H "Accept: application/vnd.github.sha" \
      "https://api.github.com/repos/$REPO/commits/$BRANCH") || {
      log "WARN could not reach GitHub for $BRANCH; will retry next run"; return 1; }
  fi
  if ! [[ "$TARGET" =~ ^[0-9a-f]{40}$ ]]; then log "ERROR bad commit id '$TARGET'"; return 1; fi

  local CURRENT; CURRENT=$(cat "$STATE_DIR/deployed-sha" 2>/dev/null || true)
  if [ "$FORCE" = 0 ]; then
    [ "$TARGET" = "$CURRENT" ] && return 0
    if [ "$TARGET" = "$(cat "$STATE_DIR/failed-sha" 2>/dev/null)" ]; then
      [ "$MODE" = "auto" ] && [ $# -eq 0 ] && return 0   # cron: don't loop on a known-bad commit
    fi
  fi
  log "DEPLOY start ${TARGET:0:7} (live: ${CURRENT:0:7})"

  # ── download + unpack ──────────────────────────────────────────────────────
  local WORK="$STATE_DIR/work"; rm -rf "$WORK"; mkdir -p "$WORK"
  gh_api -o "$WORK/src.tgz" "https://api.github.com/repos/$REPO/tarball/$TARGET" || {
    log "ERROR download failed"; return 1; }
  tar -xzf "$WORK/src.tgz" -C "$WORK" || { log "ERROR unpack failed"; return 1; }
  local NEW; NEW=$(find "$WORK" -mindepth 2 -maxdepth 2 -type d -name server | head -1)
  if [ -z "$NEW" ] || [ ! -f "$NEW/index.js" ] || [ ! -f "$NEW/package.json" ]; then
    log "ERROR tarball has no server/ app"; return 1; fi

  # ── back up current code ───────────────────────────────────────────────────
  mkdir -p "$STATE_DIR/backups"
  local BACKUP="$STATE_DIR/backups/$(date +%Y%m%d-%H%M%S)-${CURRENT:0:7}.tgz"
  tar -czf "$BACKUP" -C "$APP_DIR" --exclude=./node_modules --exclude=./.env \
    --exclude=./tmp --exclude='*.log' . || { log "ERROR backup failed; nothing changed"; return 1; }
  ls -1t "$STATE_DIR"/backups/*.tgz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f

  local OLD_DEPS NEW_DEPS
  OLD_DEPS=$(deps_sig "$APP_DIR/package.json")
  NEW_DEPS=$(deps_sig "$NEW/package.json")

  local UPTIME_BEFORE; UPTIME_BEFORE=$(health_uptime)

  npm_install() {
    ( cd "$APP_DIR" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" install --omit=dev \
        --no-audit --no-fund --no-update-notifier --loglevel=error ) >>"$LOG" 2>&1
  }
  install_deps() {
    npm_install && return 0
    # npm's "reading 'edgesOut'" crash comes from a stale hidden lockfile.
    log "npm install failed; retrying without node_modules/.package-lock.json"
    rm -f "$APP_DIR/node_modules/.package-lock.json"
    npm_install
  }
  restart_app() {
    mkdir -p "$APP_DIR/tmp" && touch "$APP_DIR/tmp/restart.txt"
    if command -v cloudlinux-selector >/dev/null; then
      cloudlinux-selector restart --json --interpreter nodejs \
        --app-root "${APP_DIR#"$HOME"/}" >>"$LOG" 2>&1 || true
    fi
  }
  # Healthy = /healthz ok AND it reports this commit — or, for code that
  # predates the revision field, the process restarted (uptime went down).
  wait_healthy() {
    local i h up rev before="${UPTIME_BEFORE%% *}"
    for i in $(seq 1 36); do
      sleep 5
      h=$(health_uptime); [ -z "$h" ] && continue
      up="${h%% *}"; rev="${h##* }"
      [ "$rev" = "$TARGET" ] && return 0
      if [ "$rev" = "-" ] && { [ -z "$before" ] || [ "$up" -lt "$before" ]; }; then
        return 0; fi
    done
    return 1
  }

  # ── apply ──────────────────────────────────────────────────────────────────
  cp -R "$NEW"/. "$APP_DIR"/ || { log "ERROR copy failed"; rollback; return 1; }
  echo "$TARGET" > "$APP_DIR/REVISION"   # reported by /healthz
  if [ "$OLD_DEPS" != "$NEW_DEPS" ] || [ ! -e "$APP_DIR/node_modules" ]; then
    log "dependencies changed — installing"
    install_deps || { log "ERROR npm install failed"; rollback; return 1; }
  fi
  restart_app
  if wait_healthy; then
    echo "$TARGET" > "$STATE_DIR/deployed-sha"
    rm -f "$STATE_DIR/failed-sha"
    log "DEPLOY ok ${TARGET:0:7} (health: $(health_uptime))"
    return 0
  fi
  log "ERROR /healthz didn't report this commit (or a restart) within 3 min"
  rollback
  return 1
}

rollback() {
  log "ROLLBACK to ${CURRENT:0:7} from $BACKUP"
  rm -f "$APP_DIR/REVISION"   # the backup restores the previous one, if any
  tar -xzf "$BACKUP" -C "$APP_DIR" >>"$LOG" 2>&1
  if [ "$OLD_DEPS" != "$NEW_DEPS" ]; then install_deps || true; fi
  UPTIME_BEFORE=$(health_uptime)
  restart_app
  if wait_healthy || [ -n "$(health_uptime)" ]; then log "ROLLBACK ok"; else log "ROLLBACK done but /healthz still failing — check the app in the panel"; fi
  echo "$TARGET" > "$STATE_DIR/failed-sha"
}

main "$@"
