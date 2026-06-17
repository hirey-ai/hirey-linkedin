#!/bin/bash
# Update an existing Hirey Hub demo origin so each Hub app is served by its own
# node service behind nginx, while the default /{id}/demo route serves Hirey LinkedIn.
#   /1011/demo -> Hirey Tasks    (node :4174)
#   /1007/demo -> Hirey VC       (node :4175)
#   /{id}/demo -> Hirey LinkedIn (node :4173, default for every other id)
# Safe to re-run: it pulls each repo, rewrites the units + nginx.conf, and reloads.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root, for example: sudo bash deploy/update-demo-origin.sh" >&2
  exit 1
fi

# SSM/cron run this with no $HOME; git needs one for its config.
export HOME=${HOME:-/root}

dnf install -y nodejs git nginx

# git runs as root against ec2-user-owned checkouts; whitelist them (idempotent).
for d in /opt/hirey-linkedin /opt/hirey-tasks /opt/hirey-vc; do
  git config --system --get-all safe.directory 2>/dev/null | grep -qx "$d" \
    || git config --system --add safe.directory "$d"
done

clone_or_pull() {  # $1=repo-url  $2=target-dir
  if [[ ! -d "$2/.git" ]]; then
    git clone --depth 1 "$1" "$2"
  else
    git -C "$2" pull --ff-only
  fi
}

clone_or_pull https://github.com/hirey-ai/hirey-linkedin /opt/hirey-linkedin
clone_or_pull https://github.com/hirey-ai/hirey-tasks    /opt/hirey-tasks
clone_or_pull https://github.com/justfadeaway/hirey-vc   /opt/hirey-vc

chown -R ec2-user:ec2-user /opt/hirey-linkedin /opt/hirey-tasks /opt/hirey-vc

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

cat >/etc/nginx/nginx.conf <<'NGINX'
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
    # ensure a trailing slash so each SPA's relative URLs resolve under /{id}/demo/
    location ~ ^/[0-9]+/demo$ { return 301 $uri/; }
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

systemctl daemon-reload
systemctl enable --now nginx hirey-linkedin hirey-tasks hirey-vc
systemctl restart hirey-linkedin hirey-tasks hirey-vc
nginx -t
systemctl reload nginx
