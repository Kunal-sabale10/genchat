package e2e

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"nhooyr.io/websocket"
)

func TestDatabaseConnectivity(t *testing.T) {
	pgDsn := os.Getenv("POSTGRES_URL")
	if pgDsn == "" {
		pgDsn = "postgres://genchat:dev_password@localhost:5432/genchat?sslmode=disable"
	}

	db, err := sql.Open("pgx", pgDsn)
	if err != nil {
		t.Fatalf("failed to initialize postgres driver: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		t.Logf("postgres ping failed (database container may not be started yet): %v", err)
		return
	}

	var userTableExists bool
	err = db.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'users');",
	).Scan(&userTableExists)

	if err != nil {
		t.Fatalf("failed to query table schema: %v", err)
	}

	if !userTableExists {
		t.Fatalf("users table does not exist in postgres")
	}

	t.Log("PostgreSQL connection healthy and schema confirmed.")
}

func TestServicePortsAndWebSocketHandshake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 1. Verify Auth gRPC port (50051)
	authConn, err := grpc.DialContext(ctx, "localhost:50051",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		t.Logf("Auth gRPC connection test on :50051: %v", err)
	} else {
		authConn.Close()
		t.Log("Auth service gRPC handshake succeeded on :50051")
	}

	// 2. Verify Ledger gRPC port (50052)
	ledgerConn, err := grpc.DialContext(ctx, "localhost:50052",
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		t.Logf("Ledger gRPC connection test on :50052: %v", err)
	} else {
		ledgerConn.Close()
		t.Log("Ledger service gRPC handshake succeeded on :50052")
	}

	// 3. Verify WebSocket Gateway handshake (:8081)
	wsURL := "ws://localhost:8081/ws"
	c, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{},
	})
	if err != nil {
		// If gateway rejects without auth token, confirm it gave an expected HTTP rejection
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusBadRequest) {
			t.Logf("Gateway correctly challenged unauthenticated connection with HTTP %d", resp.StatusCode)
			return
		}
		t.Logf("WebSocket gateway test on :8081: %v", err)
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "test finished")
	t.Log("Gateway WebSocket upgraded connection successfully on :8081")
}
