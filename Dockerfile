# Base image
FROM alpine:latest

LABEL org.opencontainers.image.source https://github.com/PabloZaiden/letsencrypt-duckdns

# Install tools required
RUN apk --no-cache add bash certbot curl

# Copy scripts
WORKDIR /scripts
COPY ./scripts /scripts
RUN curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
RUN chmod -R +x /scripts

# Image starting command
CMD ["/bin/bash", "/scripts/start.sh"]
