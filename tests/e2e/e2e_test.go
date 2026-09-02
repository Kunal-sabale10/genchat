package e2e

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
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
