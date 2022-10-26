# Let's Encrypt for duckdns

# Usage
Loot at the `docker-compose.yml` file for an example of how to use this image.

If `TESTING` is set to `true`, the certificate will be issued by the Let's Encrypt staging server. This is useful for testing, but you should not use it in production.

if `LETSENCRYPT_WILDCARD` is set to `true`, the certificate will be issued for the wildcard domain `*.yourdomain.duckdns.org`. This is useful if you want to use the same certificate for multiple subdomains **but not** for the base domain.

Heavily inspired by https://github.com/maksimstojkovic/docker-letsencrypt