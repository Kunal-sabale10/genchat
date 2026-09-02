FROM golang:1.24-bookworm AS builder

# Install protoc, build tools and curl for Rust
RUN apt-get update && apt-get install -y protobuf-compiler curl build-essential && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# Install protoc Go plugins
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.32.0 && \
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

WORKDIR /app
COPY . .

# Generate protos
RUN make proto

# Build Rust C-FFI core
WORKDIR /app/crypto/genchat-crypto-ffi
RUN cargo build --release

# Compile Go with CGO linked to target/release
WORKDIR /app
ENV CGO_ENABLED=1
ENV CGO_LDFLAGS="-L/app/crypto/genchat-crypto-ffi/target/release -lgenchat_crypto_ffi -lm -ldl -lpthread"
ENV CGO_CFLAGS="-I/app/crypto/genchat-crypto-ffi"

RUN go build -o /bin/authd ./services/auth/cmd/authd
RUN go build -o /bin/gatewayd ./services/gateway/cmd/gatewayd
RUN go build -o /bin/ledgerd ./services/msgledger/cmd/ledgerd

FROM debian:bookworm-slim AS auth
COPY --from=builder /app/crypto/genchat-crypto-ffi/target/release/libgenchat_crypto_ffi.so /usr/local/lib/
COPY --from=builder /bin/authd /usr/local/bin/
RUN ldconfig
CMD ["authd"]

FROM debian:bookworm-slim AS gateway
COPY --from=builder /app/crypto/genchat-crypto-ffi/target/release/libgenchat_crypto_ffi.so /usr/local/lib/
COPY --from=builder /bin/gatewayd /usr/local/bin/
RUN ldconfig
CMD ["gatewayd"]

FROM debian:bookworm-slim AS ledger
COPY --from=builder /app/crypto/genchat-crypto-ffi/target/release/libgenchat_crypto_ffi.so /usr/local/lib/
COPY --from=builder /bin/ledgerd /usr/local/bin/
RUN ldconfig
CMD ["ledgerd"]
