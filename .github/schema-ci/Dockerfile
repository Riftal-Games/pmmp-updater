# The validator the upgrade schema packages' upstream CI installs. Upstream installs
# ajv-cli unpinned, and 5.0.0 is the release that resolves to. The runners keep npm
# packages off their own host, so it runs here.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202

RUN set -eux; \
    npm install -g --ignore-scripts --no-fund --no-audit ajv-cli@5.0.0; \
    npm cache clean --force; \
    ajv help > /dev/null
