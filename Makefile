.PHONY: all proto build-rust build-go test lint clean docker-up docker-down migrate

PROTO_DIR := proto
GEN_DIR := gen
RUST_CRYPTO_DIR := crypto/genchat-crypto
RUST_FFI_DIR := crypto/genchat-crypto-ffi

# Generate Go code from proto files  
proto:
	@echo "Generating protobuf code..."
	mkdir -p $(GEN_DIR)/chat/v1
	protoc --proto_path=$(PROTO_DIR) \
		--go_out=$(GEN_DIR) --go_opt=paths=source_relative \
		--go-grpc_out=$(GEN_DIR) --go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/chat/v1/*.proto

# Build Rust crypto core
build-rust:
	@echo "Building Rust crypto core..."
	cd $(RUST_CRYPTO_DIR) && cargo build --release
	cd $(RUST_FFI_DIR) && cargo build --release

# Build Go services
build-go: proto
	@echo "Building Go services..."
	cd services/auth && go build -o ../../bin/authd ./cmd/authd
	cd services/gateway && go build -o ../../bin/gatewayd ./cmd/gatewayd
	cd services/msgledger && go build -o ../../bin/ledgerd ./cmd/ledgerd

# Run all tests
test: test-rust test-go

test-rust:
	cd $(RUST_CRYPTO_DIR) && cargo test
	cd $(RUST_FFI_DIR) && cargo test

test-go:
	cd services/auth && go test ./...
	cd services/gateway && go test ./...
	cd services/msgledger && go test ./...

# Lint
lint:
	cd $(RUST_CRYPTO_DIR) && cargo clippy -- -D warnings
	cd services/auth && golangci-lint run
	cd services/gateway && golangci-lint run
	cd services/msgledger && golangci-lint run

# Docker
docker-up:
	docker compose -f deploy/docker-compose.yaml up -d

docker-down:
	docker compose -f deploy/docker-compose.yaml down

# Database migrations
migrate-up:
	migrate -path schema/postgres/migrations -database "postgres://genchat:dev_password@localhost:5432/genchat?sslmode=disable" up

migrate-down:
	migrate -path schema/postgres/migrations -database "postgres://genchat:dev_password@localhost:5432/genchat?sslmode=disable" down

scylla-migrate:
	cqlsh localhost 9042 -f schema/scylla/001_messages.cql

clean:
	rm -rf bin/ $(GEN_DIR)/
	cd $(RUST_CRYPTO_DIR) && cargo clean
	cd $(RUST_FFI_DIR) && cargo clean

all: proto build-rust build-go
