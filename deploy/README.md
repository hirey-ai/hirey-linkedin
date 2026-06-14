# Hosting Hirey LinkedIn (the live demo)

The official hosted instance lives at **<https://hub.hirey.ai/1005/demo>** — that's the URL the
Hub's "open the web app" button points to. You don't need any of this to run the app locally
(`npm start`); this folder just documents how the public demo is deployed so it's reproducible.

## Architecture

```
visitor ──https──► CloudFront (hub.hirey.ai)
                    ├─ default behaviour ─────────► hi.hirey.ai           (the Hub SSR pages)
                    │    viewer-request function rewrites:  /→/hub,  /{id}→/hub/{id}
                    └─ behaviour  */demo  /*/demo/* ──────► EC2 origin :80 (this app, no caching)
                                                            nginx strips /{id}/demo → node :4173
```

- **CloudFront** terminates TLS for `hub.hirey.ai` and routes by path. The `*/demo` behaviours use
  a *no-cache* policy and forward all cookies/headers, so each visitor's per-session cookie
  (`hl_sid`) round-trips and their isolated Hi identity works (see [the server](../server.mjs)).
- **EC2** (a small `t4g` Amazon Linux 2023 box) runs the app via systemd in `HOSTED=1` mode behind
  nginx. nginx mounts it under `/{id}/demo`, stripping the prefix. Security group: inbound `:80`
  restricted to the CloudFront origin-facing managed prefix list.
- The app front-end uses URLs relative to `location.pathname`, so the exact same build serves at
  `/` locally and under `/{id}/demo/` when hosted.

## Provision a box

1. Launch an Amazon Linux 2023 (arm64) instance with [`ec2-userdata.sh`](ec2-userdata.sh) as
   user-data. Attach an Elastic IP. SG inbound `:80` from the CloudFront prefix list
   (`com.amazonaws.global.cloudfront.origin-facing`).
2. Point a DNS A record (the CloudFront origin, e.g. `hl-origin.<zone>`) at the EIP.
3. CloudFront distribution for `hub.hirey.ai`: ACM cert (us-east-1), two origins (`hi.hirey.ai`
   https-only; the EC2 http-only), the viewer-request rewrite function on the default behaviour,
   and `*/demo` + `*/demo/*` behaviours → EC2 origin with `CachingDisabled` + `AllViewer`.
4. Route53 alias `hub.hirey.ai` → the distribution.

## Push new app code to the live box

The box clones this repo at boot. To roll out a new commit:

```bash
ssh ec2-user@<box> 'cd /opt/hirey-linkedin && git pull && sudo systemctl restart hirey-linkedin'
```
