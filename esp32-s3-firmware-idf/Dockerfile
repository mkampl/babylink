# Custom ESP-IDF build image: adds mbedtls 3.6.6's DTLS ClientHello
# defragmentation (upstream Mbed-TLS PR #10603 / issue #7549) on top of the
# mbedtls 3.6.5 fork bundled in espressif/idf:v5.5.4.
#
# Why: browsers send a DTLS ClientHello fragmented across records (large modern
# ClientHello). Stock 3.6.5's DTLS server cannot reassemble it and aborts with
# MBEDTLS_ERR_SSL_FEATURE_UNAVAILABLE, so the WebRTC handshake never completes.
# The patch touches only the SSL protocol files, not Espressif's hardware-crypto
# layer, so it applies onto the fork cleanly. Drop this image once an ESP-IDF
# release bundles mbedtls >= 3.6.6.
FROM espressif/idf:v5.5.4

COPY patches/mbedtls-dtls-clienthello-defrag.patch /tmp/mbedtls-defrag.patch
RUN cd /opt/esp/idf/components/mbedtls/mbedtls \
    && git apply /tmp/mbedtls-defrag.patch \
    && grep -q "reassembl" library/ssl_msg.c \
    && echo "mbedtls DTLS ClientHello defragmentation patch applied"
