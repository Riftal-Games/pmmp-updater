# PHP for the package checks in CI. The runners have no PHP, and bedrock-protocol needs
# ext-encoding, which no stock PHP image carries. 8.2 is the PHP pmmp-core's build/php
# compiles for PocketMine-MP 5, and ext-encoding is the version that script builds.
FROM composer/composer:2.10.3-bin@sha256:016c41066558559142758092f7ef286d66ae113df23d49e086fdda0166dd5f01 AS composer

FROM php:8.2-cli-alpine@sha256:f18a17007c462eaa859be4a104c75c2240a84f390d2ff820ac19e7122dc48195

# The full commit pins the source by content, which a tag or an archive URL would not.
ADD https://github.com/pmmp/ext-encoding.git#93fb62407015c7f59bd20b95b18f2a7e93956954 /usr/src/ext-encoding

RUN set -eux; \
    apk add --no-cache --virtual .build-deps $PHPIZE_DEPS; \
    cd /usr/src/ext-encoding; \
    phpize; \
    ./configure --enable-encoding; \
    make -j"$(nproc)"; \
    make install; \
    docker-php-ext-enable encoding; \
    cd /; \
    rm -rf /usr/src/ext-encoding; \
    apk del .build-deps; \
    php -r 'exit(phpversion("encoding") === "1.0.0" ? 0 : 1);'

COPY --from=composer /composer /usr/local/bin/composer
