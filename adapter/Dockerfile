FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libc6-dev make cmake git ca-certificates \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Build nats.c from source
WORKDIR /tmp/nats
RUN git clone --depth 1 https://github.com/nats-io/nats.c.git . && \
    mkdir build && cd build && \
    cmake .. -DNATS_BUILD_STREAMING=OFF -DCMAKE_INSTALL_PREFIX=/usr/local && \
    make -j$(nproc) && \
    make install

WORKDIR /build
COPY *.c *.h ./
RUN gcc -Wall -Wextra -O2 -o adapter \
    main.c decoder.c nats-pub.c tcp-listen.c \
    -I/usr/local/include -L/usr/local/lib \
    -lnats

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /usr/local/lib/libnats.so* /usr/local/lib/
RUN ldconfig

COPY --from=builder /build/adapter .

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD pgrep adapter || exit 1

CMD ["./adapter"]
