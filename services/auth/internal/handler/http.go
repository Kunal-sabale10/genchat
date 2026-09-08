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
				DeviceID string `json:"device_id"`
				UserId   string `json:"userId"`
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
			targetUserID = uuid.New().String()
		}
		if targetDeviceID == "" {
			targetDeviceID = uuid.New().String()
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

