module github.com/genchat/services/auth

go 1.24

require (
	github.com/genchat/proto/gen v0.0.0
	github.com/go-webauthn/webauthn v0.11.2
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.7.2
	google.golang.org/grpc v1.69.4
	google.golang.org/protobuf v1.36.3
	golang.org/x/crypto v0.32.0
)

replace github.com/genchat/proto/gen => ../../gen

