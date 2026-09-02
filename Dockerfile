FROM golang:1.24-bookworm AS builder
RUN apt-get update && apt-get install -y protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.32.0 && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0
WORKDIR /app
COPY . .
RUN make proto
RUN go build -o /bin/authd ./services/auth/cmd/authd
RUN go build -o /bin/gatewayd ./services/gateway/cmd/gatewayd
RUN go build -o /bin/ledgerd ./services/msgledger/cmd/ledgerd

FROM debian:bookworm-slim AS auth
COPY --from=builder /bin/authd /usr/local/bin/
CMD ["authd"]

FROM debian:bookworm-slim AS gateway
COPY --from=builder /bin/gatewayd /usr/local/bin/
CMD ["gatewayd"]

FROM debian:bookworm-slim AS ledger
COPY --from=builder /bin/ledgerd /usr/local/bin/
CMD ["ledgerd"]
