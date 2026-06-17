#!/bin/bash
# Update an existing Hirey Hub demo origin so /1007/demo serves Hirey VC while
# the default /{id}/demo route continues to serve Hirey LinkedIn.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root, for example: sudo bash deploy/update-demo-origin.sh" >&2
  exit 1
fi

dnf install -y nodejs git nginx

if [[ ! -d /opt/hirey-linkedin/.git ]]; then
  git clone --depth 1 https://github.com/hirey-ai/hirey-linkedin /opt/hirey-linkedin
else
  git -C /opt/hirey-linkedin pull --ff-only
fi

if [[ ! -d /opt/hirey-vc/.git ]]; then
  git clone --depth 1 https://github.com/justfadeaway/hirey-vc /opt/hirey-vc
else
  git -C /opt/hirey-vc pull --ff-only
fi

chown -R ec2-user:ec2-user /opt/hirey-linkedin /opt/hirey-vc

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
    location ~ ^/[0-9]+/demo$ { return 301 $uri/; }
    location ~ ^/1007/demo/(?<vc_rest>.*)$ {
      proxy_pass http://127.0.0.1:4175/$vc_rest$is_args$args;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto https;
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_read_timeout 60s;
    }
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
systemctl enable --now nginx hirey-linkedin hirey-vc
systemctl restart hirey-linkedin hirey-vc
nginx -t
systemctl reload nginx
