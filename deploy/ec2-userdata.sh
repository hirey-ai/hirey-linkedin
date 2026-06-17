#!/bin/bash
# EC2 user-data that turns a fresh Amazon Linux 2023 box into a Hirey Hub demo origin.
# All the real provisioning (apps, systemd units, nginx routing, health checks) lives
# in deploy/update-demo-origin.sh — the single source of truth, also run by CI on every
# deploy. This bootstrap just installs git, clones the repo, and hands off to it.
# TLS is terminated upstream by CloudFront, so nginx only listens on :80 (lock it to the
# CloudFront origin-facing managed prefix list in the security group).
set -xe
exec > /var/log/hl-userdata.log 2>&1
dnf update -y
dnf install -y git
git clone --depth 1 https://github.com/hirey-ai/hirey-linkedin /opt/hirey-linkedin
bash /opt/hirey-linkedin/deploy/update-demo-origin.sh
echo "HL_BOOTSTRAP_DONE"
