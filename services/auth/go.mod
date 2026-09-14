module github.com/genchat/services/auth

go 1.24

require (
	github.com/genchat/proto/gen v0.0.0
	github.com/go-webauthn/webauthn v0.11.2
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.7.2
	google.golang.org/grpc v1.69.4
	google.golang.org/protobuf v1.36.3
)

require (
	github.com/fxamacker/cbor/v2 v2.7.0 // indirect
	github.com/go-webauthn/x v0.1.14 // indirect
	github.com/golang-jwt/jwt/v5 v5.2.2 // indirect
	github.com/google/go-tpm v0.9.1 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/mitchellh/mapstructure v1.5.0 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	golang.org/x/crypto v0.32.0 // indirect
	golang.org/x/net v0.30.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/sys v0.29.0 // indirect
	golang.org/x/text v0.21.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20241015192408-796eee8c2d53 // indirect
)

replace github.com/genchat/proto/gen => ../../gen
