package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/handler"
	"github.com/genchat/services/auth/internal/store"
	waconfig "github.com/genchat/services/auth/internal/webauthn"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	postgresURL := getEnv("POSTGRES_URL", "postgres://genchat:dev_password@localhost:5432/genchat?sslmode=disable")
	listenAddr := getEnv("LISTEN_ADDR", ":50051")
	jwtSecret := getEnv("JWT_SECRET", "dev-secret-change-in-production")
	rpID := getEnv("WEBAUTHN_RP_ID", "localhost")
	rpOrigin := getEnv("WEBAUTHN_RP_ORIGIN", "http://localhost:3000")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := pgxpool.New(ctx, postgresURL)
	if err != nil {
		slog.Error("failed to connect to postgres", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	pgStore := store.NewPostgresStore(pool)
	waConf := waconfig.NewConfig(rpID, rpOrigin, "GenChat")

	grpcServer := grpc.NewServer()
	authHandler := handler.NewAuthHandler(pgStore, waConf, jwtSecret)
	chatv1.RegisterAuthServiceServer(grpcServer, authHandler)
	reflection.Register(grpcServer)

	lis, err := net.Listen("tcp", listenAddr)
	if err != nil {
		slog.Error("failed to listen", "error", err)
		os.Exit(1)
	}

	httpAddr := getEnv("HTTP_ADDR", ":8080")
	httpServer := &http.Server{Addr: httpAddr, Handler: authHandler.HTTPHandler()}
	go func() {
		slog.Info("auth http service starting", "addr", httpAddr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("auth http server error", "error", err)
		}
	}()

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down auth service...")
		grpcServer.GracefulStop()
		httpServer.Shutdown(context.Background())
		cancel()
	}()

	slog.Info("auth grpc service starting", "addr", listenAddr)
	if err := grpcServer.Serve(lis); err != nil {
		slog.Error("grpc server error", "error", err)
		os.Exit(1)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
