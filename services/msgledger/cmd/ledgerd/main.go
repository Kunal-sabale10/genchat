package main

import (
	"context"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gocql/gocql"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	"github.com/genchat/services/msgledger/internal/handler"
	"github.com/genchat/services/msgledger/internal/sequence"
	"github.com/genchat/services/msgledger/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	scyllaHosts := getEnv("SCYLLA_HOSTS", "localhost")
	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	listenAddr := getEnv("LISTEN_ADDR", ":50052")

	// ScyllaDB
	cluster := gocql.NewCluster(strings.Split(scyllaHosts, ",")...)
	cluster.Keyspace = "genchat"
	cluster.Consistency = gocql.LocalQuorum
	session, err := cluster.CreateSession()
	if err != nil { slog.Error("scylla connect failed", "error", err); os.Exit(1) }
	defer session.Close()

	// Redis
	rdb := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer rdb.Close()

	scyllaStore := store.NewScyllaStore(session)
	seqGen := sequence.NewGenerator(rdb)

	grpcServer := grpc.NewServer()
	ledgerHandler := handler.NewLedgerHandler(scyllaStore, seqGen)
	ledgerHandler.Register(grpcServer)
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", listenAddr)
	if err != nil { slog.Error("listen failed", "error", err); os.Exit(1) }

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down ledger...")
		grpcServer.GracefulStop()
	}()

	slog.Info("message ledger starting", "addr", listenAddr)
	if err := grpcServer.Serve(lis); err != nil {
		slog.Error("grpc server error", "error", err)
		os.Exit(1)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" { return val }
	return fallback
}
