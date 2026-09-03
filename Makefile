.PHONY: all proto install-tools build-rust build-go test lint clean docker-up docker-down migrate

PROTO_DIR := proto
GEN_DIR := gen
RUST_CRYPTO_DIR := crypto/genchat-crypto
RUST_FFI_DIR := crypto/genchat-crypto-ffi
RUST_WASM_DIR := crypto/genchat-crypto-wasm

# Install required Go tools for code generation
install-tools:
	@echo "Installing protobuf Go plugins..."
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.32.0
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.3.0

# Generate Go code from proto files  
proto: install-tools
	@echo "Generating protobuf code..."
	mkdir -p $(GEN_DIR)/chat/v1
	@test -f $(GEN_DIR)/go.mod || printf 'module github.com/genchat/proto/gen\n\ngo 1.24\n\nrequire (\n\tgoogle.golang.org/grpc v1.69.4\n\tgoogle.golang.org/protobuf v1.36.3\n)\n' > $(GEN_DIR)/go.mod
	protoc --proto_path=$(PROTO_DIR) \
		--go_out=$(GEN_DIR) --go_opt=paths=source_relative \
		--go-grpc_out=$(GEN_DIR) --go-grpc_opt=paths=source_relative \
		$(PROTO_DIR)/chat/v1/*.proto

# Build Rust crypto core
build-rust:
	@echo "Building Rust crypto core..."
	cd $(RUST_CRYPTO_DIR) && cargo build --release
	cd $(RUST_FFI_DIR) && cargo build --release

# Build WebAssembly crypto core
build-wasm:
	@echo "Building Rust WebAssembly crypto core..."
	cd $(RUST_WASM_DIR) && wasm-pack build --target web --out-dir ../../packages/client-crypto/wasm


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

# Web frontend
dev-web:
	cd packages/client-web && npx vite

build-web:
	cd packages/client-web && npx tsc --noEmit && npx vite build

all: proto build-rust build-go
