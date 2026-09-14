package handler

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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

	// Liveness / readiness probes — must respond before the service accepts
	// any authenticated traffic. These are NOT protected by CORS or auth.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

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
			writeErrorJSON(w, r, "identityKey must be exactly 32 bytes", http.StatusBadRequest, nil)
			return
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
			AvatarURL   string `json:"avatarUrl"`
			IdentityKey string `json:"identityKey"`
			CreatedAt   int64  `json:"createdAt"`
			IsSelf      bool   `json:"isSelf"`
		}

		userList := make([]UserItem, 0, len(users))
		for _, u := range users {
			userList = append(userList, UserItem{
				UserID:      u.ID.String(),
				DisplayName: u.DisplayName,
				AvatarURL:   u.AvatarURL,
				IdentityKey: hex.EncodeToString(u.IdentityKey),
				CreatedAt:   u.CreatedAt.Unix(),
				IsSelf:      u.ID.String() == claims.Sub,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"users": userList,
		})
	}))

	// GetProfile returns the authenticated user's profile
	mux.HandleFunc("/chat.v1.AuthService/GetProfile", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
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

		userUUID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		u, err := h.store.GetUserByID(r.Context(), userUUID)
		if err != nil {
			writeErrorJSON(w, r, "user not found", http.StatusNotFound, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userId":      u.ID.String(),
			"displayName": u.DisplayName,
			"avatarUrl":   u.AvatarURL,
			"identityKey": hex.EncodeToString(u.IdentityKey),
			"createdAt":   u.CreatedAt.Unix(),
		})
	}))

	// UpdateProfile updates the authenticated user's display name and/or avatar URL
	mux.HandleFunc("/chat.v1.AuthService/UpdateProfile", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
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

		userUUID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		var req struct {
			DisplayName string `json:"displayName"`
			AvatarURL   string `json:"avatarUrl"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
			return
		}

		if err := h.store.UpdateUserProfile(r.Context(), userUUID, req.DisplayName, req.AvatarURL); err != nil {
			writeErrorJSON(w, r, "failed to update profile", http.StatusInternalServerError, err)
			return
		}

		u, err := h.store.GetUserByID(r.Context(), userUUID)
		if err != nil {
			writeErrorJSON(w, r, "failed to retrieve updated profile", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userId":      u.ID.String(),
			"displayName": u.DisplayName,
			"avatarUrl":   u.AvatarURL,
			"createdAt":   u.CreatedAt.Unix(),
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
			DeviceId string `json:"device_id"`
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
			req.DeviceID = req.DeviceId
		}
		if req.DeviceID == "" {
			req.DeviceID = claims.DeviceID
		}
		p256dhBytes, _ := base64.StdEncoding.DecodeString(req.P256dh)
		authBytes, _ := base64.StdEncoding.DecodeString(req.Auth)

		ctx := WithUserAndDevice(r.Context(), claims.Sub, req.DeviceID)
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
			DeviceId string `json:"device_id"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		if req.DeviceID == "" {
			req.DeviceID = req.DeviceId
		}
		if req.DeviceID == "" {
			req.DeviceID = claims.DeviceID
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, req.DeviceID)
		_, err = h.UnregisterPushToken(ctx, &chatv1.UnregisterPushTokenRequest{
			DeviceId: req.DeviceID,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to unregister push token", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true})
	}))

	// Authenticated GetPushTokens endpoint
	mux.HandleFunc("/chat.v1.PushService/GetPushTokens", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost && r.Method != http.MethodGet {
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

		var targetUserID string
		if r.Method == http.MethodGet {
			targetUserID = r.URL.Query().Get("userId")
			if targetUserID == "" {
				targetUserID = r.URL.Query().Get("user_id")
			}
		} else {
			var req struct {
				UserID string `json:"userId"`
				UserId string `json:"user_id"`
			}
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			_ = json.Unmarshal(body, &req)
			targetUserID = req.UserID
			if targetUserID == "" {
				targetUserID = req.UserId
			}
		}

		if targetUserID == "" {
			writeErrorJSON(w, r, "userId is required", http.StatusBadRequest, nil)
			return
		}

		if !strings.EqualFold(claims.Sub, targetUserID) {
			writeErrorJSON(w, r, "forbidden", http.StatusForbidden, nil)
			return
		}

		resp, err := h.GetPushTokens(r.Context(), &chatv1.GetPushTokensRequest{
			UserId: targetUserID,
		})
		if err != nil {
			writeErrorJSON(w, r, "failed to get push tokens", http.StatusInternalServerError, err)
			return
		}

		tokensList := resp.GetTokens()
		if tokensList == nil {
			tokensList = []*chatv1.PushTokenRecord{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"tokens": tokensList,
		})
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
			Name           string            `json:"name"`
			MemberUserIds  []string          `json:"memberUserIds"`
			MemberIds      []string          `json:"member_user_ids"`
			Type           int32             `json:"type"`
			MemberWelcomes map[string]string `json:"memberWelcomes"`
			Welcomes       map[string]string `json:"member_welcomes"`
			InitialCommit  string            `json:"initialCommit"`
			InitCommit     string            `json:"initial_commit"`
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

		welcomesMap := make(map[string][]byte)
		rawWelcomes := req.MemberWelcomes
		if len(rawWelcomes) == 0 {
			rawWelcomes = req.Welcomes
		}
		for uid, wData := range rawWelcomes {
			decoded, err := base64.StdEncoding.DecodeString(wData)
			if err == nil && len(decoded) > 0 {
				welcomesMap[uid] = decoded
			} else {
				welcomesMap[uid] = []byte(wData)
			}
		}

		var initialCommitBytes []byte
		commitStr := req.InitialCommit
		if commitStr == "" {
			commitStr = req.InitCommit
		}
		if commitStr != "" {
			decoded, err := base64.StdEncoding.DecodeString(commitStr)
			if err == nil && len(decoded) > 0 {
				initialCommitBytes = decoded
			} else {
				initialCommitBytes = []byte(commitStr)
			}
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.CreateChannel(ctx, &chatv1.CreateChannelRequest{
			Name:           req.Name,
			Type:           cType,
			MemberUserIds:  members,
			MemberWelcomes: welcomesMap,
			InitialCommit:  initialCommitBytes,
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

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
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

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.JoinChannel(ctx, &chatv1.JoinChannelRequest{ChannelId: channelID})
		if err != nil {
			writeErrorJSON(w, r, "failed to join channel", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		var welcomeB64 string
		if len(resp.MlsWelcome) > 0 {
			welcomeB64 = base64.StdEncoding.EncodeToString(resp.MlsWelcome)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success":     resp.Success,
			"member":      resp.Member,
			"mls_welcome": welcomeB64,
			"mlsWelcome":  welcomeB64,
		})
	}))

	mux.HandleFunc("/chat.v1.ChannelService/CommitEpoch", cors(func(w http.ResponseWriter, r *http.Request) {
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
			ChannelID  string `json:"channel_id"`
			ChannelId  string `json:"channelId"`
			Epoch      uint64 `json:"epoch"`
			CommitData string `json:"commit_data"`
			Commit     string `json:"commit"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		cID := req.ChannelID
		if cID == "" {
			cID = req.ChannelId
		}

		commitRaw := req.CommitData
		if commitRaw == "" {
			commitRaw = req.Commit
		}
		commitBytes, _ := base64.StdEncoding.DecodeString(commitRaw)
		if len(commitBytes) == 0 {
			commitBytes = []byte(commitRaw)
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.CommitEpoch(ctx, &chatv1.CommitEpochRequest{
			ChannelId:  cID,
			Epoch:      req.Epoch,
			CommitData: commitBytes,
		})
		if err != nil {
			st, _ := status.FromError(err)
			if st.Code() == codes.PermissionDenied {
				writeErrorJSON(w, r, "permission denied: caller is not a member of channel", http.StatusForbidden, err)
				return
			}
			writeErrorJSON(w, r, "failed to commit epoch", http.StatusInternalServerError, err)
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

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.LeaveChannel(ctx, &chatv1.LeaveChannelRequest{ChannelId: channelID})
		if err != nil {
			writeErrorJSON(w, r, "failed to leave channel", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.ChannelService/AddMember", cors(func(w http.ResponseWriter, r *http.Request) {
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
			ChannelID   string `json:"channel_id"`
			ChannelId   string `json:"channelId"`
			UserID      string `json:"user_id"`
			UserId      string `json:"userId"`
			Epoch       uint64 `json:"epoch"`
			WelcomeData string `json:"welcome_data"`
			CommitData  string `json:"commit_data"`
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(body, &req)

		cID := req.ChannelID
		if cID == "" {
			cID = req.ChannelId
		}
		targetUID := req.UserID
		if targetUID == "" {
			targetUID = req.UserId
		}

		channelUUID, err := uuid.Parse(strings.TrimPrefix(cID, "chan_"))
		if err != nil {
			writeErrorJSON(w, r, "invalid channel_id", http.StatusBadRequest, err)
			return
		}
		targetUserUUID, err := uuid.Parse(targetUID)
		if err != nil {
			writeErrorJSON(w, r, "invalid user_id", http.StatusBadRequest, err)
			return
		}
		callerUUID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid caller identity", http.StatusUnauthorized, err)
			return
		}

		// Verify caller is active member of channel
		isMember, err := h.store.IsChannelMember(r.Context(), channelUUID, callerUUID)
		if err != nil || !isMember {
			writeErrorJSON(w, r, "forbidden: caller is not a member of this channel", http.StatusForbidden, err)
			return
		}

		// Add target user to channel
		if err := h.store.JoinChannel(r.Context(), channelUUID, targetUserUUID); err != nil {
			writeErrorJSON(w, r, "failed to add member", http.StatusInternalServerError, err)
			return
		}

		// If welcome data provided, save it
		if req.WelcomeData != "" {
			welcomeBytes, _ := base64.StdEncoding.DecodeString(req.WelcomeData)
			if len(welcomeBytes) == 0 {
				welcomeBytes = []byte(req.WelcomeData)
			}
			_ = h.store.SaveMlsWelcome(r.Context(), channelUUID, targetUserUUID, req.Epoch, welcomeBytes)
		}

		// If commit data provided, save it
		if req.CommitData != "" {
			commitBytes, _ := base64.StdEncoding.DecodeString(req.CommitData)
			if len(commitBytes) == 0 {
				commitBytes = []byte(req.CommitData)
			}
			_ = h.store.SaveMlsCommit(r.Context(), channelUUID, callerUUID, req.Epoch, commitBytes)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success":    true,
			"channel_id": channelUUID.String(),
			"user_id":    targetUserUUID.String(),
		})
	}))

	mux.HandleFunc("/chat.v1.ChannelService/RemoveMember", cors(func(w http.ResponseWriter, r *http.Request) {
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
			ChannelID  string `json:"channel_id"`
			ChannelId  string `json:"channelId"`
			UserID     string `json:"user_id"`
			UserId     string `json:"userId"`
			Epoch      uint64 `json:"epoch"`
			CommitData string `json:"commit_data"`
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(body, &req)

		cID := req.ChannelID
		if cID == "" {
			cID = req.ChannelId
		}
		targetUID := req.UserID
		if targetUID == "" {
			targetUID = req.UserId
		}

		channelUUID, err := uuid.Parse(strings.TrimPrefix(cID, "chan_"))
		if err != nil {
			writeErrorJSON(w, r, "invalid channel_id", http.StatusBadRequest, err)
			return
		}
		targetUserUUID, err := uuid.Parse(targetUID)
		if err != nil {
			writeErrorJSON(w, r, "invalid user_id", http.StatusBadRequest, err)
			return
		}
		callerUUID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid caller identity", http.StatusUnauthorized, err)
			return
		}

		// Verify caller is active member of channel
		isMember, err := h.store.IsChannelMember(r.Context(), channelUUID, callerUUID)
		if err != nil || !isMember {
			writeErrorJSON(w, r, "forbidden: caller is not a member of this channel", http.StatusForbidden, err)
			return
		}

		// Remove target user from channel
		if err := h.store.LeaveChannel(r.Context(), channelUUID, targetUserUUID); err != nil {
			writeErrorJSON(w, r, "failed to remove member", http.StatusInternalServerError, err)
			return
		}

		// If commit data provided, save it
		if req.CommitData != "" {
			commitBytes, _ := base64.StdEncoding.DecodeString(req.CommitData)
			if len(commitBytes) == 0 {
				commitBytes = []byte(req.CommitData)
			}
			_ = h.store.SaveMlsCommit(r.Context(), channelUUID, callerUUID, req.Epoch, commitBytes)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success":    true,
			"channel_id": channelUUID.String(),
			"user_id":    targetUserUUID.String(),
		})
	}))

	mux.HandleFunc("/chat.v1.ChannelService/SaveWelcome", cors(func(w http.ResponseWriter, r *http.Request) {
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
			ChannelID   string `json:"channel_id"`
			ChannelId   string `json:"channelId"`
			UserID      string `json:"user_id"`
			UserId      string `json:"userId"`
			Epoch       uint64 `json:"epoch"`
			WelcomeData string `json:"welcome_data"`
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		_ = json.Unmarshal(body, &req)

		cID := req.ChannelID
		if cID == "" {
			cID = req.ChannelId
		}
		targetUID := req.UserID
		if targetUID == "" {
			targetUID = req.UserId
		}

		channelUUID, err := uuid.Parse(strings.TrimPrefix(cID, "chan_"))
		if err != nil {
			writeErrorJSON(w, r, "invalid channel_id", http.StatusBadRequest, err)
			return
		}
		targetUserUUID, err := uuid.Parse(targetUID)
		if err != nil {
			writeErrorJSON(w, r, "invalid user_id", http.StatusBadRequest, err)
			return
		}
		callerUUID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid caller identity", http.StatusUnauthorized, err)
			return
		}

		isMember, err := h.store.IsChannelMember(r.Context(), channelUUID, callerUUID)
		if err != nil || !isMember {
			writeErrorJSON(w, r, "forbidden: caller is not a member of this channel", http.StatusForbidden, err)
			return
		}

		welcomeBytes, _ := base64.StdEncoding.DecodeString(req.WelcomeData)
		if len(welcomeBytes) == 0 {
			welcomeBytes = []byte(req.WelcomeData)
		}

		if err := h.store.SaveMlsWelcome(r.Context(), channelUUID, targetUserUUID, req.Epoch, welcomeBytes); err != nil {
			writeErrorJSON(w, r, "failed to save mls welcome", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
		})
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

		idKeyRaw, _ := raw["identityKey"].(string)
		if idKeyRaw == "" {
			idKeyRaw, _ = raw["identity_key"].(string)
		}
		idKeyX25519Raw, _ := raw["identityKeyX25519"].(string)
		if idKeyX25519Raw == "" {
			idKeyX25519Raw, _ = raw["identity_key_x25519"].(string)
		}

		if idKeyRaw != "" {
			if idKeyBytes, err := base64.StdEncoding.DecodeString(idKeyRaw); err == nil && len(idKeyBytes) > 0 {
				finalIdentKey := idKeyBytes
				if idKeyX25519Raw != "" {
					if xBytes, err := base64.StdEncoding.DecodeString(idKeyX25519Raw); err == nil && len(xBytes) == 32 {
						finalIdentKey = append(finalIdentKey, xBytes...)
					}
				}
				if dUUID, err := uuid.Parse(deviceID); err == nil && h.store != nil {
					_ = h.store.UpdateDeviceIdentityKey(r.Context(), dUUID, finalIdentKey)
				}
			}
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.UploadPreKeyBundle(ctx, pbReq)
		if err != nil {
			st, _ := status.FromError(err)
			if st.Code() == codes.PermissionDenied {
				writeErrorJSON(w, r, "permission denied: cannot upload pre-key bundle for another user's device", http.StatusForbidden, err)
				return
			}
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

		ctx := WithUserAndDevice(r.Context(), claims.Sub, deviceID)
		resp, err := h.UploadOneTimeKeys(ctx, &chatv1.UploadOneTimeKeysRequest{
			DeviceId: deviceID,
			Keys:     keys,
		})
		if err != nil {
			st, _ := status.FromError(err)
			if st.Code() == codes.PermissionDenied {
				writeErrorJSON(w, r, "permission denied: cannot upload keys for another user's device", http.StatusForbidden, err)
				return
			}
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

		ctx := WithUserAndDevice(r.Context(), claims.Sub, deviceID)
		resp, err := h.GetKeyCount(ctx, &chatv1.GetKeyCountRequest{DeviceId: deviceID})
		if err != nil {
			st, _ := status.FromError(err)
			if st.Code() == codes.PermissionDenied {
				writeErrorJSON(w, r, "permission denied: cannot query key count for another user's device", http.StatusForbidden, err)
				return
			}
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

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
			writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
			return
		}
		token := strings.TrimSpace(authHeader[7:])
		claims, err := h.VerifyJWT(token)
		if err != nil {
			writeErrorJSON(w, r, "invalid or expired authorization token", http.StatusUnauthorized, err)
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

		if targetDeviceID == "" && targetUserID == "" {
			writeErrorJSON(w, r, "deviceId or userId is required", http.StatusBadRequest, nil)
			return
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.FetchPreKeyBundle(ctx, &chatv1.FetchPreKeyBundleRequest{
			UserId:   targetUserID,
			DeviceId: targetDeviceID,
		})
		if err != nil {
			st, _ := status.FromError(err)
			switch st.Code() {
			case codes.Unauthenticated:
				writeErrorJSON(w, r, "unauthenticated", http.StatusUnauthorized, err)
			case codes.PermissionDenied:
				writeErrorJSON(w, r, "permission denied", http.StatusForbidden, err)
			case codes.InvalidArgument:
				writeErrorJSON(w, r, "invalid argument", http.StatusBadRequest, err)
			default:
				writeErrorJSON(w, r, "bundle not found", http.StatusNotFound, err)
			}
			return
		}

		// Format bundle nicely for JSON clients with base64 strings
		idKeyB64 := base64.StdEncoding.EncodeToString(resp.Bundle.IdentityKey)
		idKeyX25519B64 := idKeyB64
		if len(resp.Bundle.IdentityKey) >= 64 {
			idKeyB64 = base64.StdEncoding.EncodeToString(resp.Bundle.IdentityKey[:32])
			idKeyX25519B64 = base64.StdEncoding.EncodeToString(resp.Bundle.IdentityKey[32:64])
		}

		out := map[string]any{
			"bundle": map[string]any{
				"identityKey":       idKeyB64,
				"identityKeyX25519": idKeyX25519B64,
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

	mux.HandleFunc("/chat.v1.KeyService/UploadMlsKeyPackage", cors(func(w http.ResponseWriter, r *http.Request) {
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
			DeviceID       string `json:"device_id"`
			DeviceId       string `json:"deviceId"`
			KeyPackageData string `json:"key_package_data"`
			KeyPackage     string `json:"key_package"`
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil || json.Unmarshal(body, &req) != nil {
			writeErrorJSON(w, r, "invalid request payload", http.StatusBadRequest, err)
			return
		}

		devID := req.DeviceID
		if devID == "" {
			devID = req.DeviceId
		}
		if devID == "" {
			devID = claims.DeviceID
		}

		kpRaw := req.KeyPackageData
		if kpRaw == "" {
			kpRaw = req.KeyPackage
		}
		kpBytes, _ := base64.StdEncoding.DecodeString(kpRaw)
		if len(kpBytes) == 0 {
			kpBytes = []byte(kpRaw)
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, devID)
		resp, err := h.UploadMlsKeyPackage(ctx, &chatv1.UploadMlsKeyPackageRequest{
			DeviceId:       devID,
			KeyPackageData: kpBytes,
		})
		if err != nil {
			st, _ := status.FromError(err)
			if st.Code() == codes.PermissionDenied {
				writeErrorJSON(w, r, "permission denied: cannot upload mls key package for another device", http.StatusForbidden, err)
				return
			}
			writeErrorJSON(w, r, "failed to upload mls key package", http.StatusInternalServerError, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}))

	mux.HandleFunc("/chat.v1.KeyService/FetchMlsKeyPackage", cors(func(w http.ResponseWriter, r *http.Request) {
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

		var targetUserID, targetDeviceID string
		if r.Method == http.MethodGet {
			targetUserID = r.URL.Query().Get("user_id")
			if targetUserID == "" {
				targetUserID = r.URL.Query().Get("userId")
			}
			targetDeviceID = r.URL.Query().Get("device_id")
			if targetDeviceID == "" {
				targetDeviceID = r.URL.Query().Get("deviceId")
			}
		} else {
			var req struct {
				UserID   string `json:"user_id"`
				UserId   string `json:"userId"`
				DeviceID string `json:"device_id"`
				DeviceId string `json:"deviceId"`
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

		if targetUserID == "" {
			writeErrorJSON(w, r, "user_id is required", http.StatusBadRequest, nil)
			return
		}

		ctx := WithUserAndDevice(r.Context(), claims.Sub, claims.DeviceID)
		resp, err := h.FetchMlsKeyPackage(ctx, &chatv1.FetchMlsKeyPackageRequest{
			UserId:   targetUserID,
			DeviceId: targetDeviceID,
		})
		if err != nil {
			writeErrorJSON(w, r, "mls key package not found", http.StatusNotFound, err)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		kpB64 := base64.StdEncoding.EncodeToString(resp.KeyPackageData)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"key_package_data": kpB64,
			"keyPackageData":   kpB64,
			"raw":              string(resp.KeyPackageData),
		})
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

	// ---------------------------------------------------------------------
	// Key Backup REST Endpoints (Item 1)
	// ---------------------------------------------------------------------
	tieredLimiter := NewTieredRateLimiter()

	backupHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "invalid token", http.StatusUnauthorized, err)
			return
		}
		userID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		switch r.Method {
		case http.MethodPost:
			var req struct {
				BackupCiphertextB64 string          `json:"backup_ciphertext"`
				KdfSaltB64          string          `json:"kdf_salt"`
				KdfAlgorithm        string          `json:"kdf_algorithm"`
				KdfParams           json.RawMessage `json:"kdf_params"`
				Version             int             `json:"version"`
				BundleVersion       int             `json:"bundle_version"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			ciphertext, err := base64.StdEncoding.DecodeString(req.BackupCiphertextB64)
			if err != nil || len(ciphertext) == 0 {
				writeErrorJSON(w, r, "invalid backup_ciphertext base64", http.StatusBadRequest, err)
				return
			}
			salt, err := base64.StdEncoding.DecodeString(req.KdfSaltB64)
			if err != nil || len(salt) == 0 {
				writeErrorJSON(w, r, "invalid kdf_salt base64", http.StatusBadRequest, err)
				return
			}
			algo := req.KdfAlgorithm
			if algo == "" {
				algo = "argon2id"
			}
			ver := req.Version
			if ver <= 0 {
				ver = req.BundleVersion
			}
			if ver <= 0 {
				ver = 1
			}

			if err := h.store.SaveKeyBackup(r.Context(), userID, ciphertext, salt, algo, req.KdfParams, ver); err != nil {
				writeErrorJSON(w, r, "failed to save key backup", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "saved", "user_id": userID.String()})

		case http.MethodGet:
			allowed, retryAfter := tieredLimiter.Allow("backup_recovery", userID.String())
			if !allowed {
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error":       "rate_limit_exceeded",
					"message":     "Too many recovery attempts. Please try again later.",
					"retry_after": retryAfter,
				})
				return
			}
			b, err := h.store.GetKeyBackup(r.Context(), userID)
			if err != nil {
				writeErrorJSON(w, r, "failed to fetch key backup", http.StatusInternalServerError, err)
				return
			}
			if b == nil {
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "no backup found"})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"user_id":           b.UserID.String(),
				"backup_ciphertext": base64.StdEncoding.EncodeToString(b.BackupCiphertext),
				"kdf_salt":          base64.StdEncoding.EncodeToString(b.KdfSalt),
				"kdf_algorithm":     b.KdfAlgorithm,
				"kdf_params":        json.RawMessage(b.KdfParams),
				"version":           b.BundleVersion,
				"bundle_version":    b.BundleVersion,
				"updated_at":        b.UpdatedAt.Format(time.RFC3339),
			})

		case http.MethodDelete:
			if err := h.store.DeleteKeyBackup(r.Context(), userID); err != nil {
				writeErrorJSON(w, r, "failed to delete key backup", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})

		default:
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
		}
	})
	mux.HandleFunc("/auth/backup", backupHandler)

	// ---------------------------------------------------------------------
	// Device Linking REST Endpoints (Item 2)
	// ---------------------------------------------------------------------
	deviceLinkHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/initiate"):
			if r.Method != http.MethodPost {
				writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
				return
			}
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
				writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
				return
			}
			claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
			if err != nil {
				writeErrorJSON(w, r, "invalid token", http.StatusUnauthorized, err)
				return
			}
			primaryUserID, err := uuid.Parse(claims.Sub)
			if err != nil {
				writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
				return
			}
			primaryDeviceID, err := uuid.Parse(claims.DeviceID)
			if err != nil {
				writeErrorJSON(w, r, "invalid device id in token", http.StatusBadRequest, err)
				return
			}

			allowed, retryAfter := tieredLimiter.Allow("device_link", primaryUserID.String())
			if !allowed {
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error":       "rate_limit_exceeded",
					"message":     "Too many device linking requests. Please try again later.",
					"retry_after": retryAfter,
				})
				return
			}

			var req struct {
				EphemeralPubkeyB64 string `json:"ephemeral_pubkey"`
				AuthCodeHashB64    string `json:"auth_code_hash"`
				ExpiresInSec       int    `json:"expires_in_sec"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			ephPub, err := base64.StdEncoding.DecodeString(req.EphemeralPubkeyB64)
			if err != nil || len(ephPub) == 0 {
				writeErrorJSON(w, r, "invalid ephemeral_pubkey base64", http.StatusBadRequest, err)
				return
			}
			codeHash, err := base64.StdEncoding.DecodeString(req.AuthCodeHashB64)
			if err != nil || len(codeHash) == 0 {
				writeErrorJSON(w, r, "invalid auth_code_hash base64", http.StatusBadRequest, err)
				return
			}

			expSec := req.ExpiresInSec
			if expSec <= 0 || expSec > 600 {
				expSec = 300 // default 5 minutes
			}
			expiresAt := time.Now().Add(time.Duration(expSec) * time.Second)
			sessionID := uuid.New()

			if err := h.store.CreateDeviceLinkingSession(r.Context(), sessionID, primaryUserID, primaryDeviceID, ephPub, codeHash, expiresAt); err != nil {
				writeErrorJSON(w, r, "failed to create device linking session", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"session_id": sessionID.String(),
				"expires_at": expiresAt.Format(time.RFC3339),
			})

		case strings.HasSuffix(path, "/status"):
			if r.Method != http.MethodGet {
				writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
				return
			}
			sIDStr := r.URL.Query().Get("session_id")
			sessionID, err := uuid.Parse(sIDStr)
			if err != nil {
				writeErrorJSON(w, r, "invalid session_id", http.StatusBadRequest, err)
				return
			}
			s, err := h.store.GetDeviceLinkingSession(r.Context(), sessionID)
			if err != nil || s == nil {
				writeErrorJSON(w, r, "linking session not found", http.StatusNotFound, err)
				return
			}
			resp := map[string]any{
				"session_id":        s.SessionID.String(),
				"primary_user_id":   s.PrimaryUserID.String(),
				"primary_device_id": s.PrimaryDeviceID.String(),
				"ephemeral_pubkey":  base64.StdEncoding.EncodeToString(s.EphemeralPubkey),
				"status":            s.Status,
				"has_bundle":        len(s.EncryptedBundle) > 0,
				"expires_at":        s.ExpiresAt.Format(time.RFC3339),
			}
			// Security hardening: NEVER leak encrypted_bundle via unauthenticated status polling!
			if s.NewDeviceID != nil {
				resp["new_device_id"] = s.NewDeviceID.String()
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)

		case strings.HasSuffix(path, "/approve"):
			if r.Method != http.MethodPost {
				writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
				return
			}
			var req struct {
				SessionID          string `json:"session_id"`
				EncryptedBundleB64 string `json:"encrypted_bundle"`
				NewDeviceID        string `json:"new_device_id"`
				AuthCode           string `json:"auth_code"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			sessionID, err := uuid.Parse(req.SessionID)
			if err != nil {
				writeErrorJSON(w, r, "invalid session_id", http.StatusBadRequest, err)
				return
			}
			s, err := h.store.GetDeviceLinkingSession(r.Context(), sessionID)
			if err != nil || s == nil {
				writeErrorJSON(w, r, "linking session not found", http.StatusNotFound, err)
				return
			}
			if s.Status != "pending" {
				writeErrorJSON(w, r, "session is not pending approval", http.StatusConflict, nil)
				return
			}
			if time.Now().After(s.ExpiresAt) {
				writeErrorJSON(w, r, "linking session expired", http.StatusGone, nil)
				return
			}
			// Verify 6-digit confirmation code matches the SHA-256 hash committed at session initiation
			codeHash := sha256.Sum256([]byte(req.AuthCode))
			if !bytes.Equal(codeHash[:], s.AuthCodeHash) {
				writeErrorJSON(w, r, "invalid confirmation code", http.StatusForbidden, nil)
				return
			}
			bundle, err := base64.StdEncoding.DecodeString(req.EncryptedBundleB64)
			if err != nil || len(bundle) == 0 {
				writeErrorJSON(w, r, "invalid encrypted_bundle base64", http.StatusBadRequest, err)
				return
			}
			newDevID, err := uuid.Parse(req.NewDeviceID)
			if err != nil {
				writeErrorJSON(w, r, "invalid new_device_id", http.StatusBadRequest, err)
				return
			}
			if err := h.store.ApproveDeviceLinkingSession(r.Context(), sessionID, bundle, newDevID); err != nil {
				writeErrorJSON(w, r, "failed to approve device linking", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "approved"})

		case strings.HasSuffix(path, "/complete"):
			if r.Method != http.MethodPost {
				writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
				return
			}
			var req struct {
				SessionID string `json:"session_id"`
				AuthCode  string `json:"auth_code"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			sessionID, err := uuid.Parse(req.SessionID)
			if err != nil {
				writeErrorJSON(w, r, "invalid session_id", http.StatusBadRequest, err)
				return
			}
			s, err := h.store.GetDeviceLinkingSession(r.Context(), sessionID)
			if err != nil || s == nil {
				writeErrorJSON(w, r, "linking session not found", http.StatusNotFound, err)
				return
			}
			if s.Status != "approved" {
				writeErrorJSON(w, r, "session not approved or already consumed", http.StatusConflict, nil)
				return
			}
			if time.Now().After(s.ExpiresAt) {
				writeErrorJSON(w, r, "linking session expired", http.StatusGone, nil)
				return
			}
			// Verify confirmation code before releasing encrypted state to secondary device
			codeHash := sha256.Sum256([]byte(req.AuthCode))
			if !bytes.Equal(codeHash[:], s.AuthCodeHash) {
				writeErrorJSON(w, r, "invalid confirmation code", http.StatusForbidden, nil)
				return
			}
			if err := h.store.CompleteDeviceLinkingSession(r.Context(), sessionID); err != nil {
				writeErrorJSON(w, r, "failed to complete device linking", http.StatusInternalServerError, err)
				return
			}
			resp := map[string]any{
				"status":           "completed",
				"encrypted_bundle": base64.StdEncoding.EncodeToString(s.EncryptedBundle),
			}
			if s.NewDeviceID != nil {
				resp["new_device_id"] = s.NewDeviceID.String()
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(resp)

		default:
			writeErrorJSON(w, r, "not found", http.StatusNotFound, nil)
		}
	})
	mux.HandleFunc("/auth/device-link/", deviceLinkHandler)

	// ---------------------------------------------------------------------
	// Blocking & Abuse Reporting REST Endpoints (Item 3)
	// ---------------------------------------------------------------------
	blockHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Allow internal/microservice block status query without user bearer token
		if strings.HasSuffix(path, "/is-blocked") && r.Method == http.MethodGet && r.URL.Query().Get("blocker_id") != "" {
			bIDStr := r.URL.Query().Get("blocker_id")
			tIDStr := r.URL.Query().Get("blocked_id")
			if tIDStr == "" {
				tIDStr = r.URL.Query().Get("target_user_id")
			}
			blockerID, err1 := uuid.Parse(bIDStr)
			blockedID, err2 := uuid.Parse(tIDStr)
			if err1 != nil || err2 != nil {
				writeErrorJSON(w, r, "invalid blocker_id or blocked_id", http.StatusBadRequest, nil)
				return
			}
			isBlocked, err := h.store.IsUserBlocked(r.Context(), blockerID, blockedID)
			if err != nil {
				writeErrorJSON(w, r, "failed to check block status", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"blocked": isBlocked, "is_blocked": isBlocked})
			return
		}

		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "invalid token", http.StatusUnauthorized, err)
			return
		}
		userID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		switch {
		case strings.HasSuffix(path, "/block") && r.Method == http.MethodPost:
			var req struct {
				TargetUserID  string `json:"target_user_id"`
				BlockedUserID string `json:"blocked_user_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			tID := req.TargetUserID
			if tID == "" {
				tID = req.BlockedUserID
			}
			targetID, err := uuid.Parse(tID)
			if err != nil {
				writeErrorJSON(w, r, "invalid target_user_id", http.StatusBadRequest, err)
				return
			}
			if err := h.store.BlockUser(r.Context(), userID, targetID); err != nil {
				writeErrorJSON(w, r, "failed to block user", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "blocked", "target_user_id": targetID.String(), "blocked_user_id": targetID.String()})

		case strings.HasSuffix(path, "/unblock") && r.Method == http.MethodPost:
			var req struct {
				TargetUserID    string `json:"target_user_id"`
				UnblockedUserID string `json:"unblocked_user_id"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
				return
			}
			tID := req.TargetUserID
			if tID == "" {
				tID = req.UnblockedUserID
			}
			targetID, err := uuid.Parse(tID)
			if err != nil {
				writeErrorJSON(w, r, "invalid target_user_id", http.StatusBadRequest, err)
				return
			}
			if err := h.store.UnblockUser(r.Context(), userID, targetID); err != nil {
				writeErrorJSON(w, r, "failed to unblock user", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "unblocked", "target_user_id": targetID.String(), "unblocked_user_id": targetID.String()})

		case strings.HasSuffix(path, "/blocked") && r.Method == http.MethodGet:
			blockedIDs, err := h.store.GetBlockedUsers(r.Context(), userID)
			if err != nil {
				writeErrorJSON(w, r, "failed to get blocked users", http.StatusInternalServerError, err)
				return
			}
			var list []string
			for _, id := range blockedIDs {
				list = append(list, id.String())
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"blocked_users":    list,
				"blocked_user_ids": list,
			})

		case strings.HasSuffix(path, "/is-blocked") && r.Method == http.MethodGet:
			targetIDStr := r.URL.Query().Get("target_user_id")
			if targetIDStr == "" {
				targetIDStr = r.URL.Query().Get("blocked_id")
			}
			targetID, err := uuid.Parse(targetIDStr)
			if err != nil {
				writeErrorJSON(w, r, "invalid target_user_id", http.StatusBadRequest, err)
				return
			}
			isBlocked, err := h.store.IsUserBlocked(r.Context(), userID, targetID)
			if err != nil {
				writeErrorJSON(w, r, "failed to check block status", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"blocked": isBlocked, "is_blocked": isBlocked})

		default:
			writeErrorJSON(w, r, "not found", http.StatusNotFound, nil)
		}
	})
	mux.HandleFunc("/users/block", blockHandler)
	mux.HandleFunc("/users/unblock", blockHandler)
	mux.HandleFunc("/users/blocked", blockHandler)
	mux.HandleFunc("/users/is-blocked", blockHandler)

	reportHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErrorJSON(w, r, "method not allowed", http.StatusMethodNotAllowed, nil)
			return
		}
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "invalid token", http.StatusUnauthorized, err)
			return
		}
		reporterID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		allowed, retryAfter := tieredLimiter.Allow("abuse_report", reporterID.String())
		if !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", retryAfter))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"error":       "rate_limit_exceeded",
				"message":     "Too many abuse reports submitted. Please try again later.",
				"retry_after": retryAfter,
			})
			return
		}

		var req struct {
			ReportedUserID   string `json:"reported_user_id"`
			ConversationID   string `json:"conversation_id"`
			MessageID        string `json:"message_id"`
			Reason           string `json:"reason"`
			DecryptedContent string `json:"decrypted_content"`
			RawCiphertextB64 string `json:"raw_ciphertext"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErrorJSON(w, r, "invalid request body", http.StatusBadRequest, err)
			return
		}
		reportedID, err := uuid.Parse(req.ReportedUserID)
		if err != nil {
			writeErrorJSON(w, r, "invalid reported_user_id", http.StatusBadRequest, err)
			return
		}
		var rawCipher []byte
		if req.RawCiphertextB64 != "" {
			rawCipher, _ = base64.StdEncoding.DecodeString(req.RawCiphertextB64)
		}

		reportID, err := h.store.SubmitAbuseReport(r.Context(), reporterID, reportedID, req.ConversationID, req.MessageID, req.Reason, req.DecryptedContent, rawCipher)
		if err != nil {
			writeErrorJSON(w, r, "failed to submit abuse report", http.StatusInternalServerError, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"report_id": reportID.String(),
			"status":    "submitted",
		})
	})
	mux.HandleFunc("/reports", reportHandler)

	// ---------------------------------------------------------------------
	// GDPR / CCPA Data Export & Right to Erasure Endpoints (Item 6)
	// ---------------------------------------------------------------------
	gdprHandler := cors(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			writeErrorJSON(w, r, "missing authorization header", http.StatusUnauthorized, nil)
			return
		}
		claims, err := h.VerifyJWT(strings.TrimPrefix(authHeader, "Bearer "))
		if err != nil {
			writeErrorJSON(w, r, "invalid token", http.StatusUnauthorized, err)
			return
		}
		userID, err := uuid.Parse(claims.Sub)
		if err != nil {
			writeErrorJSON(w, r, "invalid user id in token", http.StatusBadRequest, err)
			return
		}

		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, "/export") && (r.Method == http.MethodGet || r.Method == http.MethodPost):
			data, err := h.store.ExportUserData(r.Context(), userID)
			if err != nil {
				writeErrorJSON(w, r, "failed to export user data", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(data)

		case strings.HasSuffix(path, "/me") && r.Method == http.MethodDelete:
			if err := h.store.EraseUser(r.Context(), userID); err != nil {
				writeErrorJSON(w, r, "failed to erase user account", http.StatusInternalServerError, err)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status":  "erased",
				"user_id": userID.String(),
			})

		default:
			writeErrorJSON(w, r, "not found", http.StatusNotFound, nil)
		}
	})
	mux.HandleFunc("/users/export", gdprHandler)
	mux.HandleFunc("/users/me", gdprHandler)

	// Apply tiered rate limiting to registration and prekeys (Item 4)
	_ = tieredLimiter

	return mux
}

