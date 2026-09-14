package tracing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"google.golang.org/grpc/metadata"
)

type contextKey string

const (
	TraceparentKey contextKey = "traceparent"
	SpanIDKey      contextKey = "span_id"
)

// TraceContext represents a parsed or generated W3C Trace Context
type TraceContext struct {
	Version  string
	TraceID  string
	ParentID string
	Flags    string
}

// GenerateTraceID generates a 16-byte random hex string (32 hex chars)
func GenerateTraceID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// GenerateSpanID generates an 8-byte random hex string (16 hex chars)
func GenerateSpanID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ParseOrNew parses an incoming W3C traceparent header or creates a new one
func ParseOrNew(raw string) TraceContext {
	parts := strings.Split(strings.TrimSpace(raw), "-")
	if len(parts) == 4 && len(parts[1]) == 32 && len(parts[2]) == 16 {
		return TraceContext{
			Version:  parts[0],
			TraceID:  parts[1],
			ParentID: parts[2],
			Flags:    parts[3],
		}
	}
	return TraceContext{
		Version:  "00",
		TraceID:  GenerateTraceID(),
		ParentID: GenerateSpanID(),
		Flags:    "01",
	}
}

func (tc TraceContext) String() string {
	return fmt.Sprintf("%s-%s-%s-%s", tc.Version, tc.TraceID, tc.ParentID, tc.Flags)
}

// WithTraceContext returns a context with traceparent metadata injected
func WithTraceContext(ctx context.Context, tc TraceContext) context.Context {
	newSpanID := GenerateSpanID()
	newTC := TraceContext{
		Version:  tc.Version,
		TraceID:  tc.TraceID,
		ParentID: newSpanID,
		Flags:    tc.Flags,
	}

	// Inject into Go context
	ctx = context.WithValue(ctx, TraceparentKey, newTC.String())
	ctx = context.WithValue(ctx, SpanIDKey, newSpanID)

	// Inject into gRPC outgoing metadata for downstream propagation
	md, ok := metadata.FromOutgoingContext(ctx)
	if !ok {
		md = metadata.New(nil)
	} else {
		md = md.Copy()
	}
	md.Set("traceparent", newTC.String())
	return metadata.NewOutgoingContext(ctx, md)
}

// StartSpan creates a child span context and logs start
func StartSpan(ctx context.Context, name string, rawTraceparent string) (context.Context, func()) {
	tc := ParseOrNew(rawTraceparent)
	childCtx := WithTraceContext(ctx, tc)
	start := time.Now()

	return childCtx, func() {
		dur := time.Since(start)
		slog.Debug("trace span finished",
			"span", name,
			"trace_id", tc.TraceID,
			"duration_ms", dur.Milliseconds(),
		)
	}
}
