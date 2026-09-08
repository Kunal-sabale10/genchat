package handler

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/store"
)

func platformToString(p chatv1.PushPlatform) string {
	switch p {
	case chatv1.PushPlatform_PUSH_PLATFORM_APNS:
		return "apns"
	case chatv1.PushPlatform_PUSH_PLATFORM_FCM:
		return "fcm"
	case chatv1.PushPlatform_PUSH_PLATFORM_WEBPUSH:
		return "webpush"
	default:
		return "unknown"
	}
}

func stringToPlatform(s string) chatv1.PushPlatform {
	switch strings.ToLower(s) {
	case "apns":
		return chatv1.PushPlatform_PUSH_PLATFORM_APNS
	case "fcm":
		return chatv1.PushPlatform_PUSH_PLATFORM_FCM
	case "webpush":
		return chatv1.PushPlatform_PUSH_PLATFORM_WEBPUSH
	default:
		return chatv1.PushPlatform_PUSH_PLATFORM_UNSPECIFIED
	}
}

func (h *AuthHandler) RegisterPushToken(ctx context.Context, req *chatv1.RegisterPushTokenRequest) (*chatv1.RegisterPushTokenResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id format")
	}

	userIDVal := ctx.Value("user_id")
	var userUUID uuid.UUID
	if userIDStr, ok := userIDVal.(string); ok && userIDStr != "" {
		userUUID, _ = uuid.Parse(userIDStr)
	}

	pt := &store.PushToken{
		DeviceID: devUUID,
		UserID:   userUUID,
		Platform: platformToString(req.Platform),
		Token:    req.Token,
		Endpoint: req.Endpoint,
		P256dh:   req.P256Dh,
		Auth:     req.Auth,
	}

	if err := h.store.RegisterPushToken(ctx, pt); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to register push token: %v", err)
	}

	return &chatv1.RegisterPushTokenResponse{Success: true}, nil
}

func (h *AuthHandler) UnregisterPushToken(ctx context.Context, req *chatv1.UnregisterPushTokenRequest) (*chatv1.UnregisterPushTokenResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id format")
	}

	if err := h.store.UnregisterPushToken(ctx, devUUID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to unregister push token: %v", err)
	}

	return &chatv1.UnregisterPushTokenResponse{Success: true}, nil
}

func (h *AuthHandler) GetPushTokens(ctx context.Context, req *chatv1.GetPushTokensRequest) (*chatv1.GetPushTokensResponse, error) {
	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id is required")
	}
	userUUID, err := uuid.Parse(req.UserId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid user_id format")
	}

	tokens, err := h.store.GetPushTokensForUser(ctx, userUUID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get push tokens: %v", err)
	}

	var records []*chatv1.PushTokenRecord
	for _, t := range tokens {
		records = append(records, &chatv1.PushTokenRecord{
			DeviceId: t.DeviceID.String(),
			Platform: stringToPlatform(t.Platform),
			Token:    t.Token,
			Endpoint: t.Endpoint,
			P256Dh:   t.P256dh,
			Auth:     t.Auth,
		})
	}

	return &chatv1.GetPushTokensResponse{Tokens: records}, nil
}