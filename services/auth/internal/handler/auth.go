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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/store"
	waconfig "github.com/genchat/services/auth/internal/webauthn"
)

type AuthHandler struct {
	chatv1.UnimplementedAuthServiceServer
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

func (h *AuthHandler) BeginRegistration(ctx context.Context, req *chatv1.BeginRegistrationRequest) (*chatv1.BeginRegistrationResponse, error) {
	tempID := make([]byte, 32)
	rand.Read(tempID)

	user := &waconfig.User{
		ID:          tempID,
		Name:        req.DisplayName,
		DisplayName: req.DisplayName,
	}

	options, sessionData, err := h.wa.WebAuthn.BeginRegistration(user)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "begin registration failed: %v", err)
	}

	sessionJSON, err := json.Marshal(sessionData)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal session data: %v", err)
	}

	sessionID := uuid.New().String()
	err = h.store.SaveCeremony(ctx, sessionID, "registration", sessionJSON, nil, req.DisplayName, time.Now().Add(5*time.Minute))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to save ceremony: %v", err)
	}

	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal options: %v", err)
	}

	return &chatv1.BeginRegistrationResponse{
		OptionsJson: optionsJSON,
		SessionId:   sessionID,
	}, nil
}

func (h *AuthHandler) FinishRegistration(ctx context.Context, req *chatv1.FinishRegistrationRequest) (*chatv1.FinishRegistrationResponse, error) {
	if len(req.IdentityKey) != 32 {
		return nil, status.Errorf(codes.InvalidArgument, "invalid identity_key length: expected 32, got %d", len(req.IdentityKey))
	}

	ceremony, err := h.store.GetCeremony(ctx, req.SessionId)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "failed to get ceremony: %v", err)
	}

	if ceremony.CeremonyType != "registration" {
		return nil, status.Errorf(codes.InvalidArgument, "invalid ceremony type")
	}

	var sessionData webauthn.SessionData
	if err := json.Unmarshal(ceremony.SessionData, &sessionData); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to unmarshal session data: %v", err)
	}

	user := &waconfig.User{
		ID:          sessionData.UserID,
		Name:        ceremony.DisplayName,
		DisplayName: ceremony.DisplayName,
	}

	parsedResponse, err := protocol.ParseCredentialCreationResponseBody(bytes.NewReader(req.CredentialJson))
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "failed to parse credential creation response: %v", err)
	}

	credential, err := h.wa.WebAuthn.CreateCredential(user, sessionData, parsedResponse)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "failed to create credential: %v", err)
	}

	credJSON, err := json.Marshal(credential)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal credential: %v", err)
	}

	userID, err := h.store.CreateUser(ctx, ceremony.DisplayName, req.IdentityKey)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create user: %v", err)
	}

	deviceLabel := req.DeviceLabel
	if deviceLabel == "" {
		deviceLabel = "Default Device"
	}

	deviceID, err := h.store.CreateDevice(ctx, userID, req.IdentityKey, deviceLabel, credJSON)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create device: %v", err)
	}

	accessToken := generateJWT(userID.String(), deviceID.String(), h.jwtSecret, 15*time.Minute)
	refreshToken := generateRefreshToken()
	refreshTokenHash := sha256.Sum256([]byte(refreshToken))

	err = h.store.CreateAuthSession(ctx, userID, deviceID, refreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create auth session: %v", err)
	}

	_ = h.store.DeleteCeremony(ctx, req.SessionId)

	return &chatv1.FinishRegistrationResponse{
		UserId:       userID.String(),
		DeviceId:     deviceID.String(),
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (h *AuthHandler) BeginLogin(ctx context.Context, req *chatv1.BeginLoginRequest) (*chatv1.BeginLoginResponse, error) {
	uid, err := uuid.Parse(req.UserId)
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "invalid user_id: %v", err)
	}

	devices, err := h.store.GetDevicesByUser(ctx, uid)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "failed to get devices: %v", err)
	}

	var creds []webauthn.Credential
	for _, dev := range devices {
		var cred webauthn.Credential
		if err := json.Unmarshal(dev.WebauthnCred, &cred); err == nil {
			creds = append(creds, cred)
		}
	}

	user := &waconfig.User{
		ID:          uid[:],
		Name:        req.UserId,
		DisplayName: req.UserId,
		Credentials: creds,
	}

	options, sessionData, err := h.wa.WebAuthn.BeginLogin(user)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "begin login failed: %v", err)
	}

	sessionJSON, err := json.Marshal(sessionData)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal session data: %v", err)
	}

	sessionID := uuid.New().String()
	userIDBytes := uid[:]
	err = h.store.SaveCeremony(ctx, sessionID, "login", sessionJSON, userIDBytes, req.UserId, time.Now().Add(5*time.Minute))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to save ceremony: %v", err)
	}

	optionsJSON, err := json.Marshal(options)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to marshal options: %v", err)
	}

	return &chatv1.BeginLoginResponse{
		OptionsJson: optionsJSON,
		SessionId:   sessionID,
	}, nil
}

func (h *AuthHandler) FinishLogin(ctx context.Context, req *chatv1.FinishLoginRequest) (*chatv1.FinishLoginResponse, error) {
	ceremony, err := h.store.GetCeremony(ctx, req.SessionId)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "failed to get ceremony: %v", err)
	}

	if ceremony.CeremonyType != "login" {
		return nil, status.Errorf(codes.InvalidArgument, "invalid ceremony type")
	}

	uid, err := uuid.FromBytes(ceremony.UserID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "invalid user id in ceremony: %v", err)
	}

	devices, err := h.store.GetDevicesByUser(ctx, uid)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "failed to get devices: %v", err)
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
		ID:          uid[:],
		Name:        ceremony.DisplayName,
		DisplayName: ceremony.DisplayName,
		Credentials: creds,
	}

	var sessionData webauthn.SessionData
	if err := json.Unmarshal(ceremony.SessionData, &sessionData); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to unmarshal session data: %v", err)
	}

	parsedResponse, err := protocol.ParseCredentialRequestResponseBody(bytes.NewReader(req.CredentialJson))
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "failed to parse credential request response: %v", err)
	}

	credential, err := h.wa.WebAuthn.ValidateLogin(user, sessionData, parsedResponse)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "failed to validate login: %v", err)
	}

	deviceID, ok := credToDevice[string(credential.ID)]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "device not found for credential")
	}

	if err := h.store.UpdateDeviceLastSeen(ctx, deviceID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to update device last seen: %v", err)
	}

	accessToken := generateJWT(uid.String(), deviceID.String(), h.jwtSecret, 15*time.Minute)
	refreshToken := generateRefreshToken()
	refreshTokenHash := sha256.Sum256([]byte(refreshToken))

	err = h.store.CreateAuthSession(ctx, uid, deviceID, refreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create auth session: %v", err)
	}

	_ = h.store.DeleteCeremony(ctx, req.SessionId)

	return &chatv1.FinishLoginResponse{
		UserId:       uid.String(),
		DeviceId:     deviceID.String(),
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (h *AuthHandler) RefreshToken(ctx context.Context, req *chatv1.RefreshTokenRequest) (*chatv1.RefreshTokenResponse, error) {
	hash := sha256.Sum256([]byte(req.RefreshToken))
	session, err := h.store.GetAuthSession(ctx, hash[:])
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "invalid refresh token: %v", err)
	}

	if session.RevokedAt != nil {
		return nil, status.Errorf(codes.Unauthenticated, "refresh token revoked")
	}
	if session.ExpiresAt.Before(time.Now()) {
		return nil, status.Errorf(codes.Unauthenticated, "refresh token expired")
	}

	if err := h.store.RevokeAuthSession(ctx, session.ID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to revoke old session: %v", err)
	}

	newAccessToken := generateJWT(session.UserID.String(), session.DeviceID.String(), h.jwtSecret, 15*time.Minute)
	newRefreshToken := generateRefreshToken()
	newRefreshTokenHash := sha256.Sum256([]byte(newRefreshToken))

	err = h.store.CreateAuthSession(ctx, session.UserID, session.DeviceID, newRefreshTokenHash[:], time.Now().Add(30*24*time.Hour))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create new auth session: %v", err)
	}

	return &chatv1.RefreshTokenResponse{
		AccessToken:  newAccessToken,
		RefreshToken: newRefreshToken,
	}, nil
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
