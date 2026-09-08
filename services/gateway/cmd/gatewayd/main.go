package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/metrics"
	"github.com/genchat/services/gateway/internal/push"
	"github.com/genchat/services/gateway/internal/ratelimit"
	"github.com/genchat/services/gateway/internal/relay"
	"github.com/genchat/services/gateway/internal/ws"
	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
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

	// Sane production/dev rate limit: 1200/min (20/sec), burst 100 to easily accommodate typing events and message bursts
	ratePerMin := 1200
	burst := 100
	if val := os.Getenv("WS_RATE_PER_MINUTE"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			ratePerMin = n
		}
	}
	if val := os.Getenv("WS_RATE_BURST"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			burst = n
		}
	}
	limiter := ratelimit.NewLimiter(ratePerMin, burst)

	authAddr := getEnv("AUTH_ADDR", "auth:50051")
	var pushClient chatv1.PushServiceClient
	var channelClient chatv1.ChannelServiceClient
	authConn, err := grpc.Dial(authAddr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		slog.Warn("could not connect to auth service for push/channels", "addr", authAddr, "error", err)
	} else {
		pushClient = chatv1.NewPushServiceClient(authConn)
		channelClient = chatv1.NewChannelServiceClient(authConn)
		defer authConn.Close()
	}

	dispatcher := push.NewDispatcher(4, 1024)
	dispatcher.Start(context.Background())

	router := relay.NewRouter(hub, ledger, pushClient, channelClient, dispatcher)
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
