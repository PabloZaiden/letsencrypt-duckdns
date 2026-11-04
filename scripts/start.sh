#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DNS_PROVIDER="${DNS_PROVIDER:-duckdns}"
CONFIG_DIR="${LETSENCRYPT_CONFIG_DIR:-/etc/letsencrypt}"
if [ "${TESTING:-false}" = true ]; then
  # Staging must never replace a production certificate in persisted storage.
  CONFIG_DIR="$CONFIG_DIR/staging"
fi
KUBECTL="${KUBECTL:-$SCRIPT_DIR/kubectl}"
OWNER_UID="$(printenv UID || printf '0')"
OWNER_GID="${GID:-0}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

case "$DNS_PROVIDER" in
  duckdns)
    [ -n "${DUCKDNS_TOKEN:-}" ] &&
      [ "$DUCKDNS_TOKEN" != "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" ] ||
      fail "DUCKDNS_TOKEN is required"
    [ -n "${DUCKDNS_DOMAIN:-}" ] || fail "DUCKDNS_DOMAIN is required"
    DOMAIN="${LETSENCRYPT_DOMAIN:-$DUCKDNS_DOMAIN}"
    AUTH_ARGS=(--manual --preferred-challenges dns
      --manual-auth-hook "$SCRIPT_DIR/auth.sh"
      --manual-cleanup-hook "$SCRIPT_DIR/cleanup.sh")
    ;;
  cloudflare)
    [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is required"
    [ -n "${LETSENCRYPT_DOMAIN:-}" ] || fail "LETSENCRYPT_DOMAIN is required"
    DOMAIN="$LETSENCRYPT_DOMAIN"
    PROPAGATION_SECONDS="${CLOUDFLARE_PROPAGATION_SECONDS:-60}"
    [[ "$PROPAGATION_SECONDS" =~ ^[0-9]+$ ]] ||
      fail "CLOUDFLARE_PROPAGATION_SECONDS must be a non-negative integer"
    AUTH_ARGS=(--dns-cloudflare
      --dns-cloudflare-credentials "$CONFIG_DIR/cloudflare.ini"
      --dns-cloudflare-propagation-seconds "$PROPAGATION_SECONDS")
    ;;
  *)
    fail "Unsupported DNS_PROVIDER: $DNS_PROVIDER"
    ;;
esac

[[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$ ]] ||
  fail "LETSENCRYPT_DOMAIN must be a base domain without wildcards"
if [ "$DNS_PROVIDER" = cloudflare ] &&
   [[ "$DOMAIN" = duckdns.org || "$DOMAIN" = *.duckdns.org ]]; then
  fail "Cloudflare cannot manage a DuckDNS domain"
fi

mkdir -p "$CONFIG_DIR"

if [ "$DNS_PROVIDER" = cloudflare ]; then
  (
    umask 077
    printf 'dns_cloudflare_api_token = %s\n' "$CLOUDFLARE_API_TOKEN" > "$CONFIG_DIR/cloudflare.ini"
    chmod 600 "$CONFIG_DIR/cloudflare.ini"
  )
fi

CERTBOT_ARGS=(--config-dir "$CONFIG_DIR" --non-interactive)
DOMAIN_ARGS=(-d "$DOMAIN")
if [ "${LETSENCRYPT_WILDCARD:-false}" = true ]; then
  DOMAIN_ARGS=(-d "*.$DOMAIN")
  # Preserve DuckDNS's wildcard-only behavior; Cloudflare also covers the base name.
  if [ "$DNS_PROVIDER" = cloudflare ]; then
    DOMAIN_ARGS+=(-d "$DOMAIN")
  fi
fi

ISSUE_ARGS=(--cert-name "$DOMAIN" --agree-tos --keep-until-expiring)
if [ -n "${LETSENCRYPT_EMAIL:-}" ]; then
  ISSUE_ARGS+=(--email "$LETSENCRYPT_EMAIL")
else
  echo "WARNING: LETSENCRYPT_EMAIL is not set" >&2
  ISSUE_ARGS+=(--register-unsafely-without-email)
fi
if [ -n "${LETSENCRYPT_CHAIN:-}" ] && [ "$LETSENCRYPT_CHAIN" != default ]; then
  ISSUE_ARGS+=(--preferred-chain "$LETSENCRYPT_CHAIN")
fi
if [ "${TESTING:-false}" = true ]; then
  ISSUE_ARGS+=(--test-cert)
  if [ -n "${KUBERNETES_SECRET:-}" ] && [[ "$KUBERNETES_SECRET" != *-staging ]]; then
    fail "TESTING=true requires a KUBERNETES_SECRET ending in -staging (or no Kubernetes Secret)"
  fi
fi

echo "INFO: Issuing certificate for $DOMAIN using $DNS_PROVIDER (staging=${TESTING:-false})"
certbot certonly "${CERTBOT_ARGS[@]}" "${AUTH_ARGS[@]}" "${ISSUE_ARGS[@]}" "${DOMAIN_ARGS[@]}"

CERT_DIR="$CONFIG_DIR/live/$DOMAIN"
publish_certificate() {
  [ -s "$CERT_DIR/fullchain.pem" ] && [ -s "$CERT_DIR/privkey.pem" ] ||
    fail "Certificate files are missing in $CERT_DIR"
  chown -R "$OWNER_UID:$OWNER_GID" "$CONFIG_DIR"
  if [ -n "${KUBERNETES_SECRET:-}" ]; then
    echo "INFO: Updating Kubernetes Secret $KUBERNETES_SECRET"
    "$KUBECTL" create secret tls "$KUBERNETES_SECRET" \
      --save-config \
      --cert="$CERT_DIR/fullchain.pem" \
      --key="$CERT_DIR/privkey.pem" \
      --dry-run=client -o yaml | "$KUBECTL" apply -f -
  fi
}

publish_certificate
while :; do
  DELAY_SECONDS="$(($(shuf -i 1-720 -n 1) * 60))"
  echo "INFO: Checking renewal in $DELAY_SECONDS seconds"
  sleep "$DELAY_SECONDS"
  # Only renew this lineage, never other providers or old domains on the volume.
  certbot renew "${CERTBOT_ARGS[@]}" --cert-name "$DOMAIN"
  publish_certificate
done
