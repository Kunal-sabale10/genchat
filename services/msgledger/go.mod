module github.com/genchat/services/msgledger

go 1.24

require (
	github.com/genchat/proto/gen v0.0.0
	github.com/gocql/gocql v1.7.0
	github.com/google/uuid v1.6.0
	github.com/redis/go-redis/v9 v9.7.3
	google.golang.org/grpc v1.69.4
	google.golang.org/protobuf v1.36.3
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/golang/snappy v0.0.3 // indirect
	github.com/hailocab/go-hostpool v0.0.0-20160125115350-e80d13ce29ed // indirect
	golang.org/x/net v0.30.0 // indirect
	golang.org/x/sys v0.26.0 // indirect
	golang.org/x/text v0.19.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20241015192408-796eee8c2d53 // indirect
	gopkg.in/inf.v0 v0.9.1 // indirect
)

replace github.com/genchat/proto/gen => ../../gen
