package handler

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

type contextKey string

const (
	UserIDContextKey   contextKey = "auth_user_id"
	DeviceIDContextKey contextKey = "auth_device_id"
)

// WithUserAndDevice attaches cryptographically verified user ID and device ID to the context.
// Both typed and string keys are set to ensure seamless compatibility with HTTP and gRPC handlers.
func WithUserAndDevice(ctx context.Context, userID, deviceID string) context.Context {
	ctx = context.WithValue(ctx, UserIDContextKey, userID)
	ctx = context.WithValue(ctx, "user_id", userID)
	if deviceID != "" {
		ctx = context.WithValue(ctx, DeviceIDContextKey, deviceID)
		ctx = context.WithValue(ctx, "device_id", deviceID)
	}
	return ctx
}

// getUserIDFromCtx extracts the cryptographically verified user ID from the context.
//
// SECURITY CRITICAL:
// This function NEVER inspects unauthenticated incoming metadata headers like "x-user-id"
// or query parameters. Identity CAN ONLY be placed into the context by:
// 1. The gRPC UnaryAuthInterceptor after verifying the cryptographic JWT signature and expiration.
// 2. The HTTP handler after VerifyJWT().
func getUserIDFromCtx(ctx context.Context) (uuid.UUID, error) {
	if val := ctx.Value(UserIDContextKey); val != nil {
		if s, ok := val.(string); ok && s != "" {
			return uuid.Parse(s)
		}
	}
	if val := ctx.Value("user_id"); val != nil {
		if s, ok := val.(string); ok && s != "" {
			return uuid.Parse(s)
		}
	}
	return uuid.Nil, status.Error(codes.Unauthenticated, "missing or invalid user authentication")
}

// getDeviceIDFromCtx extracts the cryptographically verified device ID from the context.
func getDeviceIDFromCtx(ctx context.Context) (uuid.UUID, error) {
	if val := ctx.Value(DeviceIDContextKey); val != nil {
		if s, ok := val.(string); ok && s != "" {
			return uuid.Parse(s)
		}
	}
	if val := ctx.Value("device_id"); val != nil {
		if s, ok := val.(string); ok && s != "" {
			return uuid.Parse(s)
		}
	}
	return uuid.Nil, status.Error(codes.Unauthenticated, "missing or invalid device authentication")
}

// isPublicMethod returns true if the gRPC method does not require user authentication.
func isPublicMethod(fullMethod string) bool {
	if strings.HasPrefix(fullMethod, "/grpc.reflection.") {
		return true
	}
	switch fullMethod {
	case "/chat.v1.AuthService/BeginRegistration",
		"/chat.v1.AuthService/FinishRegistration",
		"/chat.v1.AuthService/BeginLogin",
		"/chat.v1.AuthService/FinishLogin",
		"/chat.v1.AuthService/RefreshToken",
		"/chat.v1.AuthService/DevToken":
		return true
	default:
		return false
	}
}

// isInternalServiceMethod returns true for server-to-server queries (e.g. Gateway querying roster or push tokens).
// These methods do not derive caller identity from context, but operate on request payload IDs.
func isInternalServiceMethod(fullMethod string) bool {
	switch fullMethod {
	case "/chat.v1.ChannelService/GetChannelMembers",
		"/chat.v1.PushService/GetPushTokens":
		return true
	default:
		return false
	}
}

// extractToken extracts the bearer token from gRPC incoming metadata.
func extractToken(ctx context.Context) string {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	if vals := md.Get("authorization"); len(vals) > 0 && vals[0] != "" {
		token := vals[0]
		if strings.HasPrefix(strings.ToLower(token), "bearer ") {
			return strings.TrimSpace(token[7:])
		}
		return strings.TrimSpace(token)
	}
	if vals := md.Get("token"); len(vals) > 0 && vals[0] != "" {
		return strings.TrimSpace(vals[0])
	}
	return ""
}

// UnaryAuthInterceptor returns a gRPC unary server interceptor enforcing cryptographic authentication.
func (h *AuthHandler) UnaryAuthInterceptor() grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		// 1. Allow public registration / login / discovery / reflection
		if isPublicMethod(info.FullMethod) {
			return handler(ctx, req)
		}

		// 2. Extract Bearer token from incoming metadata
		token := extractToken(ctx)

		// 3. Allow internal server queries (like Gateway routing lookups), but if a token is passed, validate and attach it
		if isInternalServiceMethod(info.FullMethod) {
			if token != "" {
				if claims, err := h.VerifyJWT(token); err == nil {
					ctx = WithUserAndDevice(ctx, claims.Sub, claims.DeviceID)
				}
			}
			return handler(ctx, req)
		}

		// 4. Protected methods REQUIRE a valid cryptographic token
		if token == "" {
			return nil, status.Error(codes.Unauthenticated, "missing authorization token in gRPC metadata")
		}

		claims, err := h.VerifyJWT(token)
		if err != nil {
			return nil, status.Errorf(codes.Unauthenticated, "invalid or expired authorization token: %v", err)
		}

		ctx = WithUserAndDevice(ctx, claims.Sub, claims.DeviceID)
		return handler(ctx, req)
	}
}

// StreamAuthInterceptor returns a gRPC stream server interceptor enforcing cryptographic authentication.
func (h *AuthHandler) StreamAuthInterceptor() grpc.StreamServerInterceptor {
	return func(
		srv any,
		ss grpc.ServerStream,
		info *grpc.StreamServerInfo,
		handler grpc.StreamHandler,
	) error {
		if isPublicMethod(info.FullMethod) {
			return handler(srv, ss)
		}

		token := extractToken(ss.Context())

		if isInternalServiceMethod(info.FullMethod) {
			if token != "" {
				if claims, err := h.VerifyJWT(token); err == nil {
					wrapped := &authenticatedServerStream{
						ServerStream: ss,
						ctx:          WithUserAndDevice(ss.Context(), claims.Sub, claims.DeviceID),
					}
					return handler(srv, wrapped)
				}
			}
			return handler(srv, ss)
		}

		if token == "" {
			return status.Error(codes.Unauthenticated, "missing authorization token in gRPC metadata")
		}

		claims, err := h.VerifyJWT(token)
		if err != nil {
			return status.Errorf(codes.Unauthenticated, "invalid or expired authorization token: %v", err)
		}

		wrapped := &authenticatedServerStream{
			ServerStream: ss,
			ctx:          WithUserAndDevice(ss.Context(), claims.Sub, claims.DeviceID),
		}
		return handler(srv, wrapped)
	}
}

type authenticatedServerStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (w *authenticatedServerStream) Context() context.Context {
	return w.ctx
}
