package handler

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/google/uuid"
)

func writeErrorJSON(w http.ResponseWriter, r *http.Request, publicMsg string, statusCode int, internalErr error) {
	if internalErr != nil {
		slog.Error(publicMsg, "error", internalErr, "path", r.URL.Path, "remote_addr", r.RemoteAddr)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": publicMsg,
	})
}

func isAllowedOrigin(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	for _, a := range allowed {
		if strings.EqualFold(strings.TrimRight(a, "/"), strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

// HTTPHandler returns an http.Handler that handles WebAuthn and Auth REST requests from web clients.
func (h *AuthHandler) HTTPHandler() http.Handler {
	mux := http.NewServeMux()

	cors := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			// Security Headers
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

			origin := r.Header.Get("Origin")
			if origin != "" {
				w.Header().Set("Vary", "Origin")
				if isAllowedOrigin(origin, h.allowedOrigins) {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
					w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
					w.Header().Set("Access-Control-Allow-Credentials", "true")
				} else {
					if r.Method == http.MethodOptions {
						w.WriteHeader(http.StatusForbidden)
						return
					}
					writeErrorJSON(w, r, "forbidden origin", http.StatusForbidden, nil)
					return
				}
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("/chat.v1.AuthService/BeginRegistration", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.ceremonyLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var req struct {
			DisplayName string `json:"displayName"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MB limit
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		resp, err := h.BeginRegistration(r.Context(), &chatv1.BeginRegistrationRequest{
			DisplayName: req.DisplayName,
		})
		if err != nil {
			writeErrorJSON(w, r, "registration ceremony failed", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"optionsJson": string(resp.OptionsJson),
			"sessionId":   resp.SessionId,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/FinishRegistration", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.ceremonyLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var raw map[string]any
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &raw) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		sessionID, _ := raw["sessionId"].(string)
		deviceLabel, _ := raw["deviceLabel"].(string)

		var credBytes []byte
		if credStr, ok := raw["credentialJson"].(string); ok {
			credBytes = []byte(credStr)
		} else if credMap, ok := raw["credentialJson"].(map[string]any); ok {
			credBytes, _ = json.Marshal(credMap)
		}

		var identBytes []byte
		if idStr, ok := raw["identityKey"].(string); ok {
			if b, err := hex.DecodeString(idStr); err == nil && len(b) > 0 {
				identBytes = b
			} else if b, err := base64.StdEncoding.DecodeString(idStr); err == nil && len(b) > 0 {
				identBytes = b
			} else {
				identBytes = []byte(idStr)
			}
		} else if idArr, ok := raw["identityKey"].([]any); ok {
			identBytes = make([]byte, len(idArr))
			for i, v := range idArr {
				if num, ok := v.(float64); ok {
					identBytes[i] = byte(num)
				}
			}
		}

		if len(identBytes) != 32 {
			padded := make([]byte, 32)
			copy(padded, identBytes)
			identBytes = padded
		}

		resp, err := h.FinishRegistration(r.Context(), &chatv1.FinishRegistrationRequest{
			SessionId:      sessionID,
			CredentialJson: credBytes,
			IdentityKey:    identBytes,
			DeviceLabel:    deviceLabel,
		})
		if err != nil {
			writeErrorJSON(w, r, "registration verification failed", http.StatusUnauthorized, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userId":       resp.UserId,
			"deviceId":     resp.DeviceId,
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/BeginLogin", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.ceremonyLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var req struct {
			UserID string `json:"userId"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		resp, err := h.BeginLogin(r.Context(), &chatv1.BeginLoginRequest{
			UserId: req.UserID,
		})
		if err != nil {
			writeErrorJSON(w, r, "login ceremony failed", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"optionsJson": string(resp.OptionsJson),
			"sessionId":   resp.SessionId,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/FinishLogin", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var raw map[string]any
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &raw) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		sessionID, _ := raw["sessionId"].(string)
		var credBytes []byte
		if credStr, ok := raw["credentialJson"].(string); ok {
			credBytes = []byte(credStr)
		} else if credMap, ok := raw["credentialJson"].(map[string]any); ok {
			credBytes, _ = json.Marshal(credMap)
		}

		resp, err := h.FinishLogin(r.Context(), &chatv1.FinishLoginRequest{
			SessionId:      sessionID,
			CredentialJson: credBytes,
		})
		if err != nil {
			writeErrorJSON(w, r, "login verification failed", http.StatusUnauthorized, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userId":       resp.UserId,
			"deviceId":     resp.DeviceId,
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/RefreshToken", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		var req struct {
			RefreshToken string `json:"refreshToken"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		resp, err := h.RefreshToken(r.Context(), &chatv1.RefreshTokenRequest{
			RefreshToken: req.RefreshToken,
		})
		if err != nil {
			writeErrorJSON(w, r, "invalid or expired refresh token", http.StatusUnauthorized, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	// RFC 7635 Ephemeral TURN Credential Generator
	mux.HandleFunc("/chat.v1.AuthService/GetIceServers", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := h.VerifyJWT(token)
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		// Ephemeral credentials valid for 12 hours
		ttlSeconds := int64(12 * 3600)
		expiryTimestamp := time.Now().Unix() + ttlSeconds
		turnUsername := fmt.Sprintf("%d:%s", expiryTimestamp, claims.Sub)

		var turnPassword string
		if h.turnSharedSecret != "" {
			mac := hmac.New(sha1.New, []byte(h.turnSharedSecret))
			mac.Write([]byte(turnUsername))
			turnPassword = base64.StdEncoding.EncodeToString(mac.Sum(nil))
		}

		type IceServerConfig struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username,omitempty"`
			Credential string   `json:"credential,omitempty"`
		}

		iceServers := []IceServerConfig{
			{
				URLs: []string{
					"stun:stun.l.google.com:19302",
					"stun:stun1.l.google.com:19302",
					"stun:stun2.l.google.com:19302",
				},
			},
		}

		if h.turnSharedSecret != "" && len(h.turnURLs) > 0 {
			iceServers = append(iceServers, IceServerConfig{
				URLs:       h.turnURLs,
				Username:   turnUsername,
				Credential: turnPassword,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"iceServers": iceServers,
			"ttl":        ttlSeconds,
		})
	}))

	// List registered users for contact discovery
	mux.HandleFunc("/chat.v1.AuthService/ListUsers", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := h.VerifyJWT(token)
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		users, err := h.store.ListUsers(r.Context(), 50)
		if err != nil {
			writeErrorJSON(w, r, "failed to list users", http.StatusInternalServerError, err)
			return
		}

		type UserItem struct {
			UserID      string `json:"userId"`
			DisplayName string `json:"displayName"`
			CreatedAt   int64  `json:"createdAt"`
			IsSelf      bool   `json:"isSelf"`
		}

		userList := make([]UserItem, 0, len(users))
		for _, u := range users {
			userList = append(userList, UserItem{
				UserID:      u.ID.String(),
				DisplayName: u.DisplayName,
				CreatedAt:   u.CreatedAt.Unix(),
				IsSelf:      u.ID.String() == claims.Sub,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"users": userList,
		})
	}))

	// Push Token Registration
	mux.HandleFunc("/chat.v1.PushService/RegisterPushToken", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := h.VerifyJWT(token)
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var req struct {
			DeviceID string `json:"deviceId"`
			Platform int    `json:"platform"`
			Token    string `json:"token"`
			Endpoint string `json:"endpoint"`
			P256dh   string `json:"p256dh"`
			Auth     string `json:"auth"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		if req.DeviceID == "" {
			req.DeviceID = claims.DeviceID
		}
		p256dhBytes, _ := base64.StdEncoding.DecodeString(req.P256dh)
		authBytes, _ := base64.StdEncoding.DecodeString(req.Auth)

		ctx := context.WithValue(r.Context(), "user_id", claims.Sub)
		_, err = h.RegisterPushToken(ctx, &chatv1.RegisterPushTokenRequest{
			DeviceId: req.DeviceID,
			Platform: chatv1.PushPlatform(req.Platform),
			Token:    req.Token,
			Endpoint: req.Endpoint,
			P256Dh:   p256dhBytes,
			Auth:     authBytes,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to register push token", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	// Push Token Unregistration
	mux.HandleFunc("/chat.v1.PushService/UnregisterPushToken", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		if !h.authLimiter.Allow(GetClientIP(r)) {
			writeErrorJSON(w, r, "rate limit exceeded, please slow down", http.StatusTooManyRequests, nil)
			return
		}

		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		token := strings.TrimPrefix(authHeader, "Bearer ")
		claims, err := h.VerifyJWT(token)
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var req struct {
			DeviceID string `json:"deviceId"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		if req.DeviceID == "" {
			req.DeviceID = claims.DeviceID
		}

		_, err = h.UnregisterPushToken(r.Context(), &chatv1.UnregisterPushTokenRequest{
			DeviceId: req.DeviceID,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to unregister push token", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	// Internal/Authorized GetPushTokens for Gateway
	mux.HandleFunc("/chat.v1.PushService/GetPushTokens", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}

		var targetUserID string
		if r.Method == http.MethodGet {
			targetUserID = r.URL.Query().Get("userId")
		} else {
			var req struct {
				UserID string `json:"userId"`
			}
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(body, &req)
			targetUserID = req.UserID
		}

		if targetUserID == "" {
			writeErrorJSON(w, r, "userId is required", http.StatusBadRequest, nil)
			return
		}

		resp, err := h.GetPushTokens(r.Context(), &chatv1.GetPushTokensRequest{
			UserId: targetUserID,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to get push tokens", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	// ============================================================
	// ChannelService Endpoints (Phase 2)
	// ============================================================

	mux.HandleFunc("/chat.v1.ChannelService/CreateChannel", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var req struct {
			Name          string   `json:"name"`
			MemberUserIds []string `json:"memberUserIds"`
			MemberIds     []string `json:"member_user_ids"`
			Type          int32    `json:"type"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		members := req.MemberUserIds
		if len(members) == 0 {
			members = req.MemberIds
		}

		cType := chatv1.ChannelType_CHANNEL_TYPE_GROUP
		if req.Type != 0 {
			cType = chatv1.ChannelType(req.Type)
		}

		ctx := context.WithValue(r.Context(), "user_id", claims.Sub)
		resp, err := h.CreateChannel(ctx, &chatv1.CreateChannelRequest{
			Name:          req.Name,
			Type:          cType,
			MemberUserIds: members,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to create channel", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.ChannelService/ListChannels", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		ctx := context.WithValue(r.Context(), "user_id", claims.Sub)
		resp, err := h.ListChannels(ctx, &chatv1.ListChannelsRequest{Limit: 50})
		if err != nil {
			writeErrorJSON(w, r, "failed to list channels", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.ChannelService/GetChannelMembers", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}

		var channelID string
		if r.Method == http.MethodGet {
			channelID = r.URL.Query().Get("channel_id")
			if channelID == "" {
				channelID = r.URL.Query().Get("channelId")
			}
		} else {
			var req struct {
				ChannelID string `json:"channel_id"`
				ChannelId string `json:"channelId"`
			}
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(body, &req)
			channelID = req.ChannelID
			if channelID == "" {
				channelID = req.ChannelId
			}
		}

		if channelID == "" {
			writeErrorJSON(w, r, "channel_id is required", http.StatusBadRequest, nil)
			return
		}

		resp, err := h.GetChannelMembers(r.Context(), &chatv1.GetChannelMembersRequest{
			ChannelId: channelID,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to get channel members", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.ChannelService/JoinChannel", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var req struct {
			ChannelID string `json:"channel_id"`
			ChannelId string `json:"channelId"`
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(body, &req)
		channelID := req.ChannelID
		if channelID == "" {
			channelID = req.ChannelId
		}

		ctx := context.WithValue(r.Context(), "user_id", claims.Sub)
		resp, err := h.JoinChannel(ctx, &chatv1.JoinChannelRequest{ChannelId: channelID})
		if err != nil {
			writeErrorJSON(w, r, "failed to join channel", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.ChannelService/LeaveChannel", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var req struct {
			ChannelID string `json:"channel_id"`
			ChannelId string `json:"channelId"`
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(body, &req)
		channelID := req.ChannelID
		if channelID == "" {
			channelID = req.ChannelId
		}

		ctx := context.WithValue(r.Context(), "user_id", claims.Sub)
		resp, err := h.LeaveChannel(ctx, &chatv1.LeaveChannelRequest{ChannelId: channelID})
		if err != nil {
			writeErrorJSON(w, r, "failed to leave channel", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	// ============================================================
	// KeyService Endpoints (Phase 2: Pre-Key Replenishment)
	// ============================================================

	mux.HandleFunc("/chat.v1.KeyService/UploadPreKeyBundle", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var raw map[string]any
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20)) // 2MB limit
		if err != nil || json.Unmarshal(body, &raw) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		deviceID, _ := raw["deviceId"].(string)
		if deviceID == "" {
			deviceID, _ = raw["device_id"].(string)
		}
		if deviceID == "" {
			deviceID = claims.DeviceID
		}

		pbReq := &chatv1.UploadPreKeyBundleRequest{
			DeviceId: deviceID,
		}

		if spkMap, ok := raw["signedPreKey"].(map[string]any); ok {
			var spkID uint32
			if idNum, ok := spkMap["keyId"].(float64); ok {
				spkID = uint32(idNum)
			}
			var spkPub, spkSig []byte
			if s, ok := spkMap["publicKey"].(string); ok {
				spkPub, _ = base64.StdEncoding.DecodeString(s)
			}
			if s, ok := spkMap["signature"].(string); ok {
				spkSig, _ = base64.StdEncoding.DecodeString(s)
			}
			pbReq.SignedPreKey = &chatv1.SignedPreKey{
				KeyId:     spkID,
				PublicKey: spkPub,
				Signature: spkSig,
			}
		}

		if pqMap, ok := raw["pqPreKey"].(map[string]any); ok {
			var pqID uint32
			if idNum, ok := pqMap["keyId"].(float64); ok {
				pqID = uint32(idNum)
			}
			var pqPub, pqSig []byte
			if s, ok := pqMap["publicKey"].(string); ok {
				pqPub, _ = base64.StdEncoding.DecodeString(s)
			}
			if s, ok := pqMap["signature"].(string); ok {
				pqSig, _ = base64.StdEncoding.DecodeString(s)
			}
			pbReq.PqPreKey = &chatv1.PqPreKey{
				KeyId:     pqID,
				PublicKey: pqPub,
				Signature: pqSig,
			}
		}

		if otksArr, ok := raw["oneTimePreKeys"].([]any); ok {
			for _, item := range otksArr {
				if itemMap, ok := item.(map[string]any); ok {
					var kID uint32
					if num, ok := itemMap["keyId"].(float64); ok {
						kID = uint32(num)
					}
					var kPub []byte
					if s, ok := itemMap["publicKey"].(string); ok {
						kPub, _ = base64.StdEncoding.DecodeString(s)
					}
					pbReq.OneTimePreKeys = append(pbReq.OneTimePreKeys, &chatv1.OneTimePreKey{
						KeyId:     kID,
						PublicKey: kPub,
					})
				}
			}
		}

		resp, err := h.UploadPreKeyBundle(r.Context(), pbReq)
		if err != nil {
			writeErrorJSON(w, r, "failed to upload prekey bundle", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.KeyService/UploadOneTimeKeys", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		var raw map[string]any
		body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
		if err != nil || json.Unmarshal(body, &raw) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		deviceID, _ := raw["deviceId"].(string)
		if deviceID == "" {
			deviceID, _ = raw["device_id"].(string)
		}
		if deviceID == "" {
			deviceID = claims.DeviceID
		}

		var keys []*chatv1.OneTimePreKey
		if otksArr, ok := raw["keys"].([]any); ok {
			for _, item := range otksArr {
				if itemMap, ok := item.(map[string]any); ok {
					var kID uint32
					if num, ok := itemMap["keyId"].(float64); ok {
						kID = uint32(num)
					}
					var kPub []byte
					if s, ok := itemMap["publicKey"].(string); ok {
						kPub, _ = base64.StdEncoding.DecodeString(s)
					}
					keys = append(keys, &chatv1.OneTimePreKey{
						KeyId:     kID,
						PublicKey: kPub,
					})
				}
			}
		}

		resp, err := h.UploadOneTimeKeys(r.Context(), &chatv1.UploadOneTimeKeysRequest{
			DeviceId: deviceID,
			Keys:     keys,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to upload one-time keys", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.KeyService/GetKeyCount", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "unauthorized", http.StatusUnauthorized, err)
			return
		}

		deviceID := r.URL.Query().Get("deviceId")
		if deviceID == "" {
			deviceID = r.URL.Query().Get("device_id")
		}
		if deviceID == "" {
			deviceID = claims.DeviceID
		}

		resp, err := h.GetKeyCount(r.Context(), &chatv1.GetKeyCountRequest{DeviceId: deviceID})
		if err != nil {
			writeErrorJSON(w, r, "failed to get key count", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"oneTimeKeyCount":    resp.OneTimeKeyCount,
			"one_time_key_count": resp.OneTimeKeyCount,
		})
	}))

	mux.HandleFunc("/chat.v1.KeyService/FetchPreKeyBundle", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}

		var targetUserID, targetDeviceID string
		if r.Method == http.MethodGet {
			targetUserID = r.URL.Query().Get("userId")
			if targetUserID == "" {
				targetUserID = r.URL.Query().Get("user_id")
			}
			targetDeviceID = r.URL.Query().Get("deviceId")
			if targetDeviceID == "" {
				targetDeviceID = r.URL.Query().Get("device_id")
			}
		} else {
			var req struct {
				UserID   string `json:"userId"`
				UserId   string `json:"user_id"`
				DeviceID string `json:"deviceId"`
				DeviceId string `json:"device_id"`
			}
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(body, &req)
			targetUserID = req.UserID
			if targetUserID == "" {
				targetUserID = req.UserId
			}
			targetDeviceID = req.DeviceID
			if targetDeviceID == "" {
				targetDeviceID = req.DeviceId
			}
		}

		if targetDeviceID == "" {
			writeErrorJSON(w, r, "deviceId is required", http.StatusBadRequest, nil)
			return
		}

		resp, err := h.FetchPreKeyBundle(r.Context(), &chatv1.FetchPreKeyBundleRequest{
			UserId:   targetUserID,
			DeviceId: targetDeviceID,
		})
		if err != nil {
			writeErrorJSON(w, r, "bundle not found", http.StatusNotFound, err)
			return
		}

		// Format bundle nicely for JSON clients with base64 strings
		out := map[string]any{
			"bundle": map[string]any{
				"identityKey": base64.StdEncoding.EncodeToString(resp.Bundle.IdentityKey),
				"signedPreKey": map[string]any{
					"keyId":     resp.Bundle.SignedPreKey.KeyId,
					"publicKey": base64.StdEncoding.EncodeToString(resp.Bundle.SignedPreKey.PublicKey),
					"signature": base64.StdEncoding.EncodeToString(resp.Bundle.SignedPreKey.Signature),
				},
			},
		}
		if resp.Bundle.PqPreKey != nil {
			out["bundle"].(map[string]any)["pqPreKey"] = map[string]any{
				"keyId":     resp.Bundle.PqPreKey.KeyId,
				"publicKey": base64.StdEncoding.EncodeToString(resp.Bundle.PqPreKey.PublicKey),
				"signature": base64.StdEncoding.EncodeToString(resp.Bundle.PqPreKey.Signature),
			}
		}
		if resp.Bundle.OneTimePreKey != nil {
			out["bundle"].(map[string]any)["oneTimePreKey"] = map[string]any{
				"keyId":     resp.Bundle.OneTimePreKey.KeyId,
				"publicKey": base64.StdEncoding.EncodeToString(resp.Bundle.OneTimePreKey.PublicKey),
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(out)
	}))

	// Dev Token Issuance - ONLY active in non-production environments
	devTokenHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		env := os.Getenv("ENV")
		if env == "" {
			env = os.Getenv("ENVIRONMENT")
		}
		if strings.EqualFold(env, "production") {
			writeErrorJSON(w, r, "dev-token endpoint is disabled in production", http.StatusForbidden, nil)
			return
		}

		if r.Method != http.MethodPost && r.Method != http.MethodGet {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}

		var targetUserID, targetDeviceID, targetDisplayName string
		if r.Method == http.MethodGet {
			targetUserID = r.URL.Query().Get("user_id")
			if targetUserID == "" {
				targetUserID = r.URL.Query().Get("userId")
			}
			targetDeviceID = r.URL.Query().Get("device_id")
			if targetDeviceID == "" {
				targetDeviceID = r.URL.Query().Get("deviceId")
			}
			targetDisplayName = r.URL.Query().Get("display_name")
			if targetDisplayName == "" {
				targetDisplayName = r.URL.Query().Get("displayName")
			}
		} else {
			var req struct {
				UserID      string `json:"user_id"`
				DeviceID    string `json:"device_id"`
				UserId      string `json:"userId"`
				DeviceId    string `json:"deviceId"`
				DisplayName string `json:"display_name"`
			}
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(body, &req)
			targetUserID = req.UserID
			if targetUserID == "" {
				targetUserID = req.UserId
			}
			targetDeviceID = req.DeviceID
			if targetDeviceID == "" {
				targetDeviceID = req.DeviceId
			}
			targetDisplayName = req.DisplayName
		}

		uID, err := uuid.Parse(targetUserID)
		if err != nil {
			uID = uuid.New()
			targetUserID = uID.String()
		}
		dID, err := uuid.Parse(targetDeviceID)
		if err != nil {
			dID = uuid.New()
			targetDeviceID = dID.String()
		}
		if targetDisplayName == "" {
			targetDisplayName = "Dev User " + targetUserID[:8]
		}

		if h.store != nil {
			if err := h.store.EnsureDevUserAndDevice(r.Context(), uID, dID, targetDisplayName); err != nil {
				writeErrorJSON(w, r, "failed to provision dev user in database", http.StatusInternalServerError, err)
				return
			}
		}

		token := generateJWT(targetUserID, targetDeviceID, h.jwtSecret, 15*time.Minute)

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": token,
			"user_id":      targetUserID,
			"device_id":    targetDeviceID,
			"expires_in":   900,
		})
	})

	mux.HandleFunc("/dev-token", devTokenHandler)
	mux.HandleFunc("/chat.v1.AuthService/DevToken", devTokenHandler)

	return mux
}

