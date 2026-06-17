#!/bin/bash
# Update an existing Hirey Hub demo origin: each Hub app is served by its own node
# service behind nginx; the default /{id}/demo route serves Hirey LinkedIn.
#   /1011/demo -> Hirey Tasks    (node :4174)   github.com/hirey-ai/hirey-tasks   (master)
#   /1007/demo -> Hirey VC       (node :4175)   github.com/justfadeaway/hirey-vc  (main)
#   /{id}/demo -> Hirey LinkedIn (node :4173, default for every other id)         (main)
#
# Safe to re-run. Hardening:
#  - /opt checkouts are disposable mirrors of their remotes (fetch + reset --hard),
#    so a stray local edit / force-push can't wedge future deploys; one repo failing
#    only warns, it does not abort the others.
#  - the new nginx.conf is validated with `nginx -t` BEFORE it is activated.
#  - files about to be overwritten are backed up first (last 5 kept).
#  - only apps whose code actually changed (or that are down) are restarted, so an
#    unrelated push doesn't blip every demo.
#  - after restart every app is health-checked; the script exits non-zero (failing
#    CI) if any app is not serving.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root, for example: sudo bash deploy/update-demo-origin.sh" >&2
  exit 1
fi

export HOME=${HOME:-/root}   # SSM/cron run with no $HOME; git needs one.

# name | repo-url | branch | port
APPS=(
  "hirey-linkedin|https://github.com/hirey-ai/hirey-linkedin|main|4173"
  "hirey-tasks|https://github.com/hirey-ai/hirey-tasks|master|4174"
  "hirey-vc|https://github.com/justfadeaway/hirey-vc|main|4175"
)

dnf install -y nodejs git nginx

CHANGED=()   # services whose code moved this run -> need a restart

sync_repo() {  # $1=url $2=dir $3=branch ; prints "changed" or "same"; never aborts deploy
  local url=$1 dir=$2 branch=$3 before=none after=none
  git config --system --get-all safe.directory 2>/dev/null | grep -qx "$dir" \
    || git config --system --add safe.directory "$dir"
  if [[ -d "$dir/.git" ]]; then
    before=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)
    if ! { git -C "$dir" fetch --depth 1 origin "$branch" && git -C "$dir" reset --hard "origin/$branch"; } >/dev/null 2>&1; then
      echo "WARN: could not update $dir from $url ($branch); keeping existing checkout" >&2
    fi
  else
    git clone --depth 1 -b "$branch" "$url" "$dir" >/dev/null 2>&1 \
      || echo "WARN: could not clone $url -> $dir" >&2
  fi
  after=$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo none)
  chown -R ec2-user:ec2-user "$dir" 2>/dev/null || true
  [[ "$before" != "$after" ]] && echo changed || echo same
}

# 1) Sync code
for entry in "${APPS[@]}"; do
  IFS='|' read -r name url branch port <<<"$entry"
  [[ "$(sync_repo "$url" "/opt/$name" "$branch")" == changed ]] && CHANGED+=("$name")
done

# 2) Back up what we're about to overwrite (keep last 5)
BK="/opt/_demo-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BK"
cp -a /etc/nginx/nginx.conf "$BK"/ 2>/dev/null || true
cp -a /etc/systemd/system/hirey-*.service "$BK"/ 2>/dev/null || true
ls -dt /opt/_demo-backup-* 2>/dev/null | tail -n +6 | xargs -r rm -rf

# 3) systemd units (idempotent: rewritten each run, restart is decided by code change)
cat >/etc/systemd/system/hirey-linkedin.service <<'UNIT'
[Unit]
Description=Hirey LinkedIn demo (hosted, multi-tenant)
After=network-online.target
Wants=network-online.target
[Service]
Environment=HOSTED=1
Environment=PORT=4173
Environment=ALLOWED_ORIGIN=https://hub.hirey.ai
WorkingDirectory=/opt/hirey-linkedin
ExecStart=/usr/bin/node /opt/hirey-linkedin/server.mjs
Restart=always
RestartSec=3
User=ec2-user
[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/hirey-tasks.service <<'UNIT'
[Unit]
Description=Hirey Tasks demo (hosted, multi-tenant)
After=network-online.target
Wants=network-online.target
[Service]
Environment=HOSTED=1
Environment=PORT=4174
Environment=ALLOWED_ORIGIN=https://hub.hirey.ai
WorkingDirectory=/opt/hirey-tasks
ExecStart=/usr/bin/node /opt/hirey-tasks/server.mjs
Restart=always
RestartSec=3
User=ec2-user
[Install]
WantedBy=multi-user.target
UNIT

cat >/etc/systemd/system/hirey-vc.service <<'UNIT'
[Unit]
Description=Hirey VC demo
After=network-online.target
Wants=network-online.target
[Service]
Environment=PORT=4175
Environment=ALLOWED_ORIGIN=https://hub.hirey.ai
WorkingDirectory=/opt/hirey-vc
ExecStart=/usr/bin/node /opt/hirey-vc/server.mjs
Restart=always
RestartSec=3
User=ec2-user
[Install]
WantedBy=multi-user.target
UNIT

# 4) nginx config — validate BEFORE activating
cat >/etc/nginx/nginx.conf.new <<'NGINX'
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;
events { worker_connections 1024; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  sendfile on;
  keepalive_timeout 65;
  server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    absolute_redirect off;
    location = /healthz { default_type text/plain; return 200 'ok'; }
    # ensure a trailing slash so each SPA's relative URLs resolve under /{id}/demo/ (keep query string)
    location ~ ^/[0-9]+/demo$ { return 301 $uri/$is_args$args; }
    # Per-app routes MUST precede the default /{id}/demo/ block below.
    # Hirey Tasks (Hub app 1011)
    location ~ ^/1011/demo/(?<tasks_rest>.*)$ {
      proxy_pass http://127.0.0.1:4174/$tasks_rest$is_args$args;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_read_timeout 60s;
    }
    # Hirey VC (Hub app 1007)
    location ~ ^/1007/demo/(?<vc_rest>.*)$ {
      proxy_pass http://127.0.0.1:4175/$vc_rest$is_args$args;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_read_timeout 60s;
    }
    # Default demo app: Hirey LinkedIn.
    location ~ ^/[0-9]+/demo/(?<rest>.*)$ {
      proxy_pass http://127.0.0.1:4173/$rest$is_args$args;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_read_timeout 60s;
    }
    location / { default_type text/plain; return 404 'hirey hub demo origin\n'; }
  }
}
NGINX

if ! nginx -t -c /etc/nginx/nginx.conf.new; then
  echo "ERROR: new nginx config failed validation; leaving the running config untouched" >&2
  rm -f /etc/nginx/nginx.conf.new
  exit 1
fi
NGINX_CHANGED=0
if ! cmp -s /etc/nginx/nginx.conf.new /etc/nginx/nginx.conf 2>/dev/null; then
  mv /etc/nginx/nginx.conf.new /etc/nginx/nginx.conf
  NGINX_CHANGED=1
else
  rm -f /etc/nginx/nginx.conf.new
fi

# 5) Activate: enable everything, restart only what changed or is down
systemctl daemon-reload
systemctl enable nginx hirey-linkedin hirey-tasks hirey-vc >/dev/null 2>&1 || true

RESTART=("${CHANGED[@]:-}")
for entry in "${APPS[@]}"; do
  IFS='|' read -r name url branch port <<<"$entry"
  systemctl is-active --quiet "$name" || RESTART+=("$name")
done
mapfile -t RESTART < <(printf '%s\n' "${RESTART[@]:-}" | sed '/^$/d' | sort -u)
for name in "${RESTART[@]:-}"; do
  [[ -z "$name" ]] && continue
  echo "restarting $name"
  systemctl restart "$name" || echo "WARN: restart $name failed" >&2
done

systemctl is-active --quiet nginx || systemctl start nginx
[[ "$NGINX_CHANGED" == 1 ]] && systemctl reload nginx || true

# 6) Health gate — fail the deploy (and CI) if any app isn't serving
fail=0
for entry in "${APPS[@]}"; do
  IFS='|' read -r name url branch port <<<"$entry"
  ok=0
  for _ in $(seq 1 10); do
    curl -fsS -m 5 -o /dev/null "http://127.0.0.1:$port/" && { ok=1; break; }
    sleep 2
  done
  [[ "$ok" == 1 ]] && echo "OK: $name healthy on :$port" || { echo "ERROR: $name UNHEALTHY on :$port" >&2; fail=1; }
done
[[ "$fail" == 0 ]]
echo "DEPLOY_OK"
