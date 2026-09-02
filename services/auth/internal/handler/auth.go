package handler

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"

	"github.com/genchat/services/auth/internal/store"
	waconfig "github.com/genchat/services/auth/internal/webauthn"
)

type AuthHandler struct {
	store     *store.PostgresStore
	wa        *waconfig.Config
	jwtSecret string
}

func NewAuthHandler(store *store.PostgresStore, wa *waconfig.Config, jwtSecret string) *AuthHandler {
	return &AuthHandler{
		store:     store,
		wa:        wa,
		jwtSecret: jwtSecret,
	}
}

type RegistrationResult struct {
	UserID       string
	DeviceID     string
	AccessToken  string
	RefreshToken string
}

type LoginResult struct {
	UserID       string
	DeviceID     string
	AccessToken  string
	RefreshToken string
}

func (h *AuthHandler) BeginRegistration(ctx context.Context, displayName string, identityKey []byte) (json.RawMessage, string, error) {
	if len(identityKey) != 32 {
		return nil, "", fmt.Errorf("invalid identity_key length: expected 32, got %d", len(identityKey))
	}

	user := &waconfig.User{
		ID:          identityKey, // Using identityKey as the user ID for WebAuthn
		Name:        displayName,
		DisplayName: displayName,
	}

	options, sessionData, err := h.wa.WebAuthn.BeginRegistration(user)
	if err != nil {
		return nil, "", fmt.Errorf("begin registration failed: %w", err)
	}

	sessionJSON, err := json.Marshal(sessionData)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal session data: %w", err)
	}

	sessionID := uuid.New().String()
	err = h.store.SaveCeremony(ctx, sessionID, "registration", sessionJSON, nil, displayName, time.Now().Add(5*time.Minute))
	if err != nil {
		return nil, "", fmt.Errorf("failed to save ceremony: %w", err)
	}

	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal options: %w", err)
	}

	return optionsJSON, sessionID, nil
}

func (h *AuthHandler) FinishRegistration(ctx context.Context, sessionID string, responseJSON []byte, identityKey []byte) (*RegistrationResult, error) {
	if len(identityKey) != 32 {
		return nil, fmt.Errorf("invalid identity_key length: expected 32, got %d", len(identityKey))
	}

	ceremony, err := h.store.GetCeremony(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get ceremony: %w", err)
	}

	if ceremony.CeremonyType != "registration" {
		return nil, fmt.Errorf("invalid ceremony type")
	}

	var sessionData webauthn.SessionData
	if err := json.Unmarshal(ceremony.SessionData, &sessionData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal session data: %w", err)
	}

	user := &waconfig.User{
		ID:          identityKey,
		Name:        ceremony.DisplayName,
		DisplayName: ceremony.DisplayName,
	}

	parsedResponse, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(responseJSON))
	if err != nil {
		return nil, fmt.Errorf("failed to parse credential creation response: %w", err)
	}

	credential, err := h.wa.WebAuthn.CreateCredential(user, sessionData, parsedResponse)
	if err != nil {
		return nil, fmt.Errorf("failed to create credential: %w", err)
	}

	credJSON, err := json.Marshal(credential)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal credential: %w", err)
	}

	userID, err := h.store.CreateUser(ctx, ceremony.DisplayName, identityKey)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	deviceID, err := h.store.CreateDevice(ctx, userID, identityKey, "Default Device", credJSON)
	if err != nil {
		return nil, fmt.Errorf("failed to create device: %w", err)
	}

	accessToken := generateJWT(userID.String(), deviceID.String(), h.jwtSecret, 15*time.Minute)
	refreshToken := generateRefreshToken()
	refreshTokenHash := sha256.Sum256([]byte(refreshToken))

	err = h.store.CreateAuthSession(ctx, userID, deviceID, refreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return nil, fmt.Errorf("failed to create auth session: %w", err)
	}

	_ = h.store.DeleteCeremony(ctx, sessionID)

	return &RegistrationResult{
		UserID:       userID.String(),
		DeviceID:     deviceID.String(),
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (h *AuthHandler) BeginLogin(ctx context.Context, identityKey []byte) (json.RawMessage, string, error) {
	dbUser, err := h.store.GetUserByIdentityKey(ctx, identityKey)
	if err != nil {
		return nil, "", fmt.Errorf("user not found: %w", err)
	}

	devices, err := h.store.GetDevicesByUser(ctx, dbUser.ID)
	if err != nil {
		return nil, "", fmt.Errorf("failed to get devices: %w", err)
	}

	var creds []webauthn.Credential
	for _, dev := range devices {
		var cred webauthn.Credential
		if err := json.Unmarshal(dev.WebauthnCred, &cred); err == nil {
			creds = append(creds, cred)
		}
	}

	user := &waconfig.User{
		ID:          identityKey,
		Name:        dbUser.DisplayName,
		DisplayName: dbUser.DisplayName,
		Credentials: creds,
	}

	options, sessionData, err := h.wa.WebAuthn.BeginLogin(user)
	if err != nil {
		return nil, "", fmt.Errorf("begin login failed: %w", err)
	}

	sessionJSON, err := json.Marshal(sessionData)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal session data: %w", err)
	}

	sessionID := uuid.New().String()
	userIDBytes := dbUser.ID[:]
	err = h.store.SaveCeremony(ctx, sessionID, "login", sessionJSON, userIDBytes, dbUser.DisplayName, time.Now().Add(5*time.Minute))
	if err != nil {
		return nil, "", fmt.Errorf("failed to save ceremony: %w", err)
	}

	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal options: %w", err)
	}

	return optionsJSON, sessionID, nil
}

func (h *AuthHandler) FinishLogin(ctx context.Context, sessionID string, responseJSON []byte, identityKey []byte) (*LoginResult, error) {
	ceremony, err := h.store.GetCeremony(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get ceremony: %w", err)
	}

	if ceremony.CeremonyType != "login" {
		return nil, fmt.Errorf("invalid ceremony type")
	}

	dbUser, err := h.store.GetUserByIdentityKey(ctx, identityKey)
	if err != nil {
		return nil, fmt.Errorf("user not found: %w", err)
	}

	devices, err := h.store.GetDevicesByUser(ctx, dbUser.ID)
	if err != nil {
		return nil, fmt.Errorf("failed to get devices: %w", err)
	}

	var creds []webauthn.Credential
	credToDevice := make(map[string]uuid.UUID)
	for _, dev := range devices {
		var cred webauthn.Credential
		if err := json.Unmarshal(dev.WebauthnCred, &cred); err == nil {
			creds = append(creds, cred)
			credToDevice[string(cred.ID)] = dev.ID
		}
	}

	user := &waconfig.User{
		ID:          identityKey,
		Name:        dbUser.DisplayName,
		DisplayName: dbUser.DisplayName,
		Credentials: creds,
	}

	var sessionData webauthn.SessionData
	if err := json.Unmarshal(ceremony.SessionData, &sessionData); err != nil {
		return nil, fmt.Errorf("failed to unmarshal session data: %w", err)
	}

	parsedResponse, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(responseJSON))
	if err != nil {
		return nil, fmt.Errorf("failed to parse credential request response: %w", err)
	}

	credential, err := h.wa.WebAuthn.ValidateLogin(user, sessionData, parsedResponse)
	if err != nil {
		return nil, fmt.Errorf("failed to validate login: %w", err)
	}

	deviceID, ok := credToDevice[string(credential.ID)]
	if !ok {
		return nil, fmt.Errorf("device not found for credential")
	}

	if err := h.store.UpdateDeviceLastSeen(ctx, deviceID); err != nil {
		return nil, fmt.Errorf("failed to update device last seen: %w", err)
	}

	accessToken := generateJWT(dbUser.ID.String(), deviceID.String(), h.jwtSecret, 15*time.Minute)
	refreshToken := generateRefreshToken()
	refreshTokenHash := sha256.Sum256([]byte(refreshToken))

	err = h.store.CreateAuthSession(ctx, dbUser.ID, deviceID, refreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return nil, fmt.Errorf("failed to create auth session: %w", err)
	}

	_ = h.store.DeleteCeremony(ctx, sessionID)

	return &LoginResult{
		UserID:       dbUser.ID.String(),
		DeviceID:     deviceID.String(),
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (h *AuthHandler) RefreshToken(ctx context.Context, refreshToken string) (string, string, error) {
	hash := sha256.Sum256([]byte(refreshToken))
	session, err := h.store.GetAuthSession(ctx, hash[:])
	if err != nil {
		return "", "", fmt.Errorf("invalid refresh token: %w", err)
	}

	if session.RevokedAt != nil {
		return "", "", fmt.Errorf("refresh token revoked")
	}
	if session.ExpiresAt.Before(time.Now()) {
		return "", "", fmt.Errorf("refresh token expired")
	}

	if err := h.store.RevokeAuthSession(ctx, session.ID); err != nil {
		return "", "", fmt.Errorf("failed to revoke old session: %w", err)
	}

	newAccessToken := generateJWT(session.UserID.String(), session.DeviceID.String(), h.jwtSecret, 15*time.Minute)
	newRefreshToken := generateRefreshToken()
	newRefreshTokenHash := sha256.Sum256([]byte(newRefreshToken))

	err = h.store.CreateAuthSession(ctx, session.UserID, session.DeviceID, newRefreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return "", "", fmt.Errorf("failed to create new auth session: %w", err)
	}

	return newAccessToken, newRefreshToken, nil
}

func generateJWT(userID, deviceID, secret string, expiry time.Duration) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payloadStr := fmt.Sprintf(`{"sub":"%s","device_id":"%s","exp":%d}`, userID, deviceID, time.Now().Add(expiry).Unix())
	payload := base64.RawURLEncoding.EncodeToString([]byte(payloadStr))

	sigBase := header + "." + payload
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(sigBase))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	return sigBase + "." + signature
}

func generateRefreshToken() string {
	b := make([]byte, 32)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
