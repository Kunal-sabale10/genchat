package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/genchat/services/gateway/internal/blocklist"
	"github.com/genchat/services/gateway/internal/ledgerclient"
	"github.com/genchat/services/gateway/internal/loadshed"
	"github.com/genchat/services/gateway/internal/metrics"
	"github.com/genchat/services/gateway/internal/pubsub"
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

	redisAddr := getEnv("REDIS_ADDR", "localhost:6379")
	redisPass := getEnv("REDIS_PASSWORD", "")
	podID := getEnv("POD_NAME", getEnv("HOSTNAME", "pod-"+uuid.New().String()[:8]))

	redisPubSub := pubsub.NewRedisPubSub(redisAddr, redisPass)
	defer redisPubSub.Close()

	hub := ws.NewHubWithRouter(podID, redisPubSub)
	go hub.Run()

	// Subscribe to cross-instance deliveries directed to this pod
	podSub := redisPubSub.SubscribePod(context.Background(), podID)
	go func() {
		for msg := range podSub.Channel() {
			var env pubsub.PodEnvelope
			if err := json.Unmarshal([]byte(msg.Payload), &env); err == nil {
				hub.DeliverLocal(env.TargetUserID, env.Payload)
			}
		}
	}()

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

	authHTTPURL := getEnv("AUTH_HTTP_URL", "")
	if authHTTPURL == "" {
		if strings.Contains(authAddr, "localhost") || strings.Contains(authAddr, "127.0.0.1") {
			authHTTPURL = "http://localhost:8080"
		} else {
			authHTTPURL = "http://auth:8080"
		}
	}
	blockChecker := blocklist.NewHTTPBlockChecker(authHTTPURL)

	maxConns := 10000
	if val := os.Getenv("MAX_CONNECTIONS_PER_POD"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			maxConns = n
		}
	}
	maxDevices := 5
	if val := os.Getenv("MAX_DEVICES_PER_USER"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			maxDevices = n
		}
	}
	maxGoroutines := 25000
	if val := os.Getenv("MAX_GOROUTINES"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			maxGoroutines = n
		}
	}
	maxHeapMB := 1024
	if val := os.Getenv("MAX_HEAP_MB"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			maxHeapMB = n
		}
	}
	preAuthRate := 60
	if val := os.Getenv("PREAUTH_RATE_PER_MINUTE"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			preAuthRate = n
		}
	}
	preAuthBurst := 10
	if val := os.Getenv("PREAUTH_BURST"); val != "" {
		if n, err := strconv.Atoi(val); err == nil {
			preAuthBurst = n
		}
	}

	shedder := loadshed.New(loadshed.Options{
		MaxGoroutines: maxGoroutines,
		MaxHeapMB:     int64(maxHeapMB),
	})

	router := relay.NewRouter(hub, ledger, pushClient, channelClient, dispatcher, blockChecker)
	wsHandler := ws.NewHandlerWithOptions(hub, router.Handle, limiter, jwtSecret, ws.HandlerOptions{
		MaxConnectionsPerPod: maxConns,
		MaxDevicesPerUser:    maxDevices,
		PreAuthRatePerMinute: preAuthRate,
		PreAuthBurst:         preAuthBurst,
		Shedder:              shedder,
	})

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
		slog.Info("shutting down gateway, draining connections...", "pod_id", podID)

		// Broadcast reconnect notice to clients so they cleanly re-connect to other pods
		reconnectNotice, _ := json.Marshal(map[string]interface{}{
			"type":               "reconnect",
			"reason":             "server_shutdown",
			"reconnect_after_ms": 1000,
		})

		drainCtx, drainCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer drainCancel()
		hub.Drain(drainCtx, reconnectNotice)
		_ = podSub.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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
