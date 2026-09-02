package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/genchat/services/gateway/internal/ratelimit"
	"github.com/genchat/services/gateway/internal/relay"
	"github.com/genchat/services/gateway/internal/ws"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	wsAddr := getEnv("WS_ADDR", ":8081")

	hub := ws.NewHub()
	go hub.Run()

	limiter := ratelimit.NewLimiter(60, 5) // 60/min, burst 5
	router := relay.NewRouter(hub)
	wsHandler := ws.NewHandler(hub, router.Handle, limiter)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler.ServeHTTP)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	httpServer := &http.Server{Addr: wsAddr, Handler: mux}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		slog.Info("shutting down gateway...")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		httpServer.Shutdown(ctx)
	}()

	slog.Info("gateway starting", "ws_addr", wsAddr)
	if err := httpServer.ListenAndServe(); err != http.ErrServerClosed {
		slog.Error("http server error", "error", err)
		os.Exit(1)
	}
}

func getEnv(key, fallback string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return fallback
}
