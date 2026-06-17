#!/bin/bash
# EC2 user-data that turns a fresh Amazon Linux 2023 box into a Hirey-Hub demo origin.
# It runs the demo apps in HOSTED (multi-tenant) mode and lets nginx mount them under /{id}/demo,
# stripping that prefix before proxying to each node server. TLS is terminated upstream by
# CloudFront, so nginx only listens on :80 (lock it to the CloudFront prefix list in the SG).
set -xe
exec > /var/log/hl-userdata.log 2>&1
dnf update -y
dnf install -y nodejs git nginx

git clone --depth 1 https://github.com/hirey-ai/hirey-linkedin /opt/hirey-linkedin
git clone --depth 1 https://github.com/hirey-ai/hirey-tasks /opt/hirey-tasks
git clone --depth 1 https://github.com/justfadeaway/hirey-vc /opt/hirey-vc
chown -R ec2-user:ec2-user /opt/hirey-linkedin
chown -R ec2-user:ec2-user /opt/hirey-tasks
chown -R ec2-user:ec2-user /opt/hirey-vc

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
    absolute_redirect off;            # keep redirects scheme/host-relative (stay on https via CloudFront)
    location = /healthz { default_type text/plain; return 200 'ok'; }
    # ensure a trailing slash so the SPA's relative URLs resolve under /{id}/demo/
    location ~ ^/[0-9]+/demo$ { return 301 $uri/; }
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
    location / { default_type text/plain; return 404 'hirey-linkedin demo origin\n'; }
  }
}
NGINX

systemctl daemon-reload
systemctl enable --now nginx
systemctl enable --now hirey-linkedin
systemctl enable --now hirey-tasks
systemctl enable --now hirey-vc
sleep 2
nginx -t && systemctl reload nginx
echo "HL_BOOTSTRAP_DONE"
