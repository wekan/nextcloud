ARG WEKAN_VERSION=12.29
# The frp stage only downloads and checks a prebuilt frpc for the TARGET
# architecture, so it runs on the build machine: no apt-get or curl under QEMU
# for the arm64 image.
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS frp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
# HaRP's documented FRP protocol version, verified against upstream checksums.
ARG FRP_VERSION=0.61.1
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) sum=bff260b68ca7b1461182a46c4f34e9709ba32764eed30a15dd94ac97f50a2c40 ;; \
      arm64) sum=af6366f2b43920ebfe6235dba6060770399ed1fb18601e5818552bd46a7621f8 ;; \
      *) echo 'Supported ExApp architectures: amd64, arm64' >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/wekan-nextcloud/build-tmp; \
    curl --fail --location --retry 3 "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${TARGETARCH}.tar.gz" -o /opt/wekan-nextcloud/build-tmp/frp.tar.gz; \
    echo "$sum  /opt/wekan-nextcloud/build-tmp/frp.tar.gz" | sha256sum -c -; \
    tar -xzf /opt/wekan-nextcloud/build-tmp/frp.tar.gz -C /opt/wekan-nextcloud/build-tmp; \
    cp "/opt/wekan-nextcloud/build-tmp/frp_${FRP_VERSION}_linux_${TARGETARCH}/frpc" /usr/local/bin/frpc; \
    rm -rf /opt/wekan-nextcloud/build-tmp
FROM ghcr.io/wekan/wekan:v${WEKAN_VERSION}
USER root
# Older images cannot securely bind Meteor login to the AppAPI identity.
RUN test -f /build/nextcloud-exapp-capability.json && test -x /build/ferretdb
COPY --from=frp /usr/local/bin/frpc /usr/local/bin/frpc
COPY ex_app /opt/wekan-nextcloud/ex_app
COPY licenses /usr/share/doc/wekan-nextcloud/licenses
COPY LICENSE /usr/share/doc/wekan-nextcloud/LICENSE
# Root initializes the AppAPI volume; start.mjs then drops to the wekan UID/GID.
ENTRYPOINT ["node", "/opt/wekan-nextcloud/ex_app/start.mjs"]
CMD []
