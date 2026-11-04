# Let's Encrypt for DuckDNS and Cloudflare

Issue and automatically renew certificates with Certbot, optionally publishing them
to a Kubernetes TLS Secret. The image remains
`ghcr.io/pablozaiden/letsencrypt-duckdns:main` for backward compatibility.

## DuckDNS (existing deployments)

`DNS_PROVIDER` defaults to `duckdns`. Existing environment variables and
`docker-compose.yml` continue to work. `LETSENCRYPT_WILDCARD=true` requests
`*.yourdomain.duckdns.org`, not the base name.

## Cloudflare

Set `DNS_PROVIDER=cloudflare`, `CLOUDFLARE_API_TOKEN`, `LETSENCRYPT_DOMAIN` and
`LETSENCRYPT_EMAIL`. `LETSENCRYPT_WILDCARD=true` requests both the wildcard and the
base domain. Your domain's authoritative DNS must be hosted by Cloudflare.

Use an API Token restricted to the required zone, with **Zone / DNS / Edit** and
**Zone / Zone / Read** permissions. Do not use the Global API Key.
The same token can also be used by a separate Cloudflare DDNS container.
This image manages ACME TXT records only, not public IP address records.

The token is written to a mode-600 Certbot credentials file on the persistent
volume and is never logged. Protect that volume and its backups, which also
contain certificate private keys. The credentials file is refreshed at startup,
so restart the container after rotating the token.

| Variable | Default | Description |
| --- | --- | --- |
| `DNS_PROVIDER` | `duckdns` | `duckdns` or `cloudflare` |
| `LETSENCRYPT_DOMAIN` | `DUCKDNS_DOMAIN` for DuckDNS | Base domain, without `*.` |
| `LETSENCRYPT_WILDCARD` | `false` | Request a wildcard certificate |
| `LETSENCRYPT_EMAIL` | unset | ACME account contact email |
| `CLOUDFLARE_API_TOKEN` | required for Cloudflare | Zone-scoped API Token |
| `CLOUDFLARE_PROPAGATION_SECONDS` | `60` | DNS-01 propagation wait |
| `TESTING` | `false` | Use Let's Encrypt staging |
| `KUBERNETES_SECRET` | unset | TLS Secret to create/update in the current namespace |
| `LETSENCRYPT_CONFIG_DIR` | `/etc/letsencrypt` | Persistent certificate storage |
| `UID`, `GID` | `0`, `0` | Certificate file ownership |
| `LETSENCRYPT_CHAIN` | `default` | Optional preferred certificate chain |

### Test without changing Kubernetes

Provide the three required Cloudflare/domain/email environment variables securely,
then run:

```bash
docker compose -f docker-compose.cloudflare.yml up --build
```

This example uses staging (certificates are not browser-trusted), stores files in
`./certs-cloudflare/staging`, and does not publish a Kubernetes Secret. To issue a
production certificate, change `TESTING` to `'false'`; production storage is kept
separate. If publishing staging certificates to Kubernetes, the Secret name must
end in `-staging` to prevent accidentally replacing the production TLS Secret.

### Kubernetes / homeserver-kubernetes

Keep `serviceAccount: secret-updater`, a persistent `/etc/letsencrypt` mount and
`KUBERNETES_SECRET` equal to your ingress domain. Provide the token using a
Kubernetes Secret, not a literal environment variable in Git. Use separate storage
from an old DuckDNS deployment so its renewal configuration is preserved for
rollback. Initial issuance, renewal and Secret publication failures stop the
container with a non-zero status; Kubernetes can restart it.

Certificates are published immediately after issuance and after each renewal
check (randomized within the next twelve hours). Only the configured domain's
certificate lineage is renewed.

## Tests

```bash
node --test tests/*.test.mjs
```

The tests mock Certbot, kubectl and sleep; they do not contact an ACME server or
require credentials. Pull requests also build the container without publishing it.

Originally inspired by https://github.com/maksimstojkovic/docker-letsencrypt.
