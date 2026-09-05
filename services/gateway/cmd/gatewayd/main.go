package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/metrics"
	"github.com/genchat/services/gateway/internal/ratelimit"
	"github.com/genchat/services/gateway/internal/relay"
	"github.com/genchat/services/gateway/internal/ws"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// The gateway cannot durably store messages without msgledger — refuse
	// to start rather than silently running in a mode where every "sent"
	// message is only ever held in memory.
	ledgerAddr := getEnv("LEDGER_ADDR", "localhost:50052")
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	ledger, err := ledgerclient.Dial(dialCtx, ledgerAddr)
	dialCancel()
	if err != nil {
		slog.Error("failed to connect to msgledger", "addr", ledgerAddr, "error", err)
		os.Exit(1)
	}
	defer ledger.Close()

	port := os.Getenv("PORT")
	wsAddr := os.Getenv("WS_ADDR")
	if wsAddr == "" {
		if port != "" {
			if !strings.HasPrefix(port, ":") {
				wsAddr = ":" + port
			} else {
				wsAddr = port
			}
		} else {
			wsAddr = ":8081"
		}
	}

	hub := ws.NewHub()
	go hub.Run()

	jwtSecret := getEnv("JWT_SECRET", "dev-secret-change-in-production")

	limiter := ratelimit.NewLimiter(60, 5) // 60/min, burst 5
	router := relay.NewRouter(hub, ledger)
	wsHandler := ws.NewHandler(hub, router.Handle, limiter, jwtSecret)

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", wsHandler.ServeHTTP)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/metrics", metrics.DefaultMetrics.PrometheusHandler())

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
