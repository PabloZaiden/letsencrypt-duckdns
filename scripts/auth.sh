#!/bin/sh

# Make duckdns request to update the DNS record for the domain
# using the token and validation provided by Certbot.
response=$(curl -s "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN%.duckdns.org}&token=${DUCKDNS_TOKEN}&txt=${CERTBOT_VALIDATION}")

# Verify if the response is "OK"
if [[ "$response" = "OK" ]]; then
    # DNS record updated successfully, waiting 10 seconds for propagation...
    sleep 10
    exit 0
else
    # Failed to update DNS record.
    exit 1
fi
