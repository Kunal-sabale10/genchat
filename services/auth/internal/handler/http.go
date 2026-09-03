package handler

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
)

// HTTPHandler returns an http.Handler that handles WebAuthn REST requests from web clients.
func (h *AuthHandler) HTTPHandler() http.Handler {
	mux := http.NewServeMux()

	cors := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == "OPTIONS" {
				w.WriteHeader(http.StatusOK)
				return
			}
			next(w, r)
		}
	}

	mux.HandleFunc("/chat.v1.AuthService/BeginRegistration", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			DisplayName string `json:"displayName"`
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := h.BeginRegistration(r.Context(), &chatv1.BeginRegistrationRequest{
			DisplayName: req.DisplayName,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"optionsJson": string(resp.OptionsJson),
			"sessionId":   resp.SessionId,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/FinishRegistration", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var raw map[string]any
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &raw); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
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
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"userId":       resp.UserId,
			"deviceId":     resp.DeviceId,
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/BeginLogin", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			UserID string `json:"userId"`
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := h.BeginLogin(r.Context(), &chatv1.BeginLoginRequest{
			UserId: req.UserID,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"optionsJson": string(resp.OptionsJson),
			"sessionId":   resp.SessionId,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/FinishLogin", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var raw map[string]any
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &raw); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
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
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"userId":       resp.UserId,
			"deviceId":     resp.DeviceId,
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	mux.HandleFunc("/chat.v1.AuthService/RefreshToken", cors(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			RefreshToken string `json:"refreshToken"`
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		resp, err := h.RefreshToken(r.Context(), &chatv1.RefreshTokenRequest{
			RefreshToken: req.RefreshToken,
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"accessToken":  resp.AccessToken,
			"refreshToken": resp.RefreshToken,
		})
	}))

	return mux
}
