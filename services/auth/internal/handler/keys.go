package handler

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/store"
)

// verifyDeviceOwnership verifies that the authenticated caller in ctx owns the specified devUUID.
//
// SECURITY CRITICAL:
// In PQXDH, allowing an attacker to upload pre-keys for another user's device enables
// pre-key substitution / MITM: the attacker plants their own signed pre-key and can
// decrypt initial session establishment messages intended for the victim.
func (h *AuthHandler) verifyDeviceOwnership(ctx context.Context, devUUID uuid.UUID) (uuid.UUID, error) {
	callerUserID, err := getUserIDFromCtx(ctx)
	if err != nil || callerUserID == uuid.Nil {
		return uuid.Nil, status.Error(codes.Unauthenticated, "missing or invalid user authentication")
	}

	if h.store != nil {
		device, err := h.store.GetDeviceByID(ctx, devUUID)
		if err != nil {
			return uuid.Nil, status.Errorf(codes.NotFound, "device not found: %v", err)
		}
		if device.UserID != callerUserID {
			return uuid.Nil, status.Error(codes.PermissionDenied, "permission denied: caller does not own target device")
		}
	}
	return callerUserID, nil
}

func (h *AuthHandler) UploadPreKeyBundle(ctx context.Context, req *chatv1.UploadPreKeyBundleRequest) (*chatv1.UploadPreKeyBundleResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}

	if _, err := h.verifyDeviceOwnership(ctx, devUUID); err != nil {
		return nil, err
	}

	if req.SignedPreKey == nil {
		return nil, status.Error(codes.InvalidArgument, "signed_pre_key is required")
	}

	var pqpk, pqpkSig []byte
	var pqpkID uint32
	if req.PqPreKey != nil {
		pqpk = req.PqPreKey.PublicKey
		pqpkSig = req.PqPreKey.Signature
		pqpkID = req.PqPreKey.KeyId
	}

	err = h.store.UploadPreKeyBundle(
		ctx,
		devUUID,
		req.SignedPreKey.PublicKey,
		req.SignedPreKey.Signature,
		req.SignedPreKey.KeyId,
		pqpk,
		pqpkSig,
		pqpkID,
	)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to upload pre-key bundle: %v", err)
	}

	if len(req.OneTimePreKeys) > 0 {
		otks := make([]store.OTK, 0, len(req.OneTimePreKeys))
		for _, k := range req.OneTimePreKeys {
			otks = append(otks, store.OTK{
				KeyID:     k.KeyId,
				PublicKey: k.PublicKey,
			})
		}
		if err := h.store.UploadOneTimeKeys(ctx, devUUID, otks); err != nil {
			return nil, status.Errorf(codes.Internal, "failed to upload one-time keys: %v", err)
		}
	}

	return &chatv1.UploadPreKeyBundleResponse{}, nil
}

func (h *AuthHandler) FetchPreKeyBundle(ctx context.Context, req *chatv1.FetchPreKeyBundleRequest) (*chatv1.FetchPreKeyBundleResponse, error) {
	// SECURITY: Pre-key bundle discovery is open to any authenticated peer to establish
	// PQXDH ratchet sessions, but unauthenticated/anonymous callers are strictly rejected.
	if _, err := getUserIDFromCtx(ctx); err != nil {
		return nil, status.Error(codes.Unauthenticated, "missing or invalid user authentication")
	}

	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}

	var userUUID uuid.UUID
	if req.UserId != "" {
		userUUID, err = uuid.Parse(req.UserId)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid user_id")
		}
	}

	bundle, err := h.store.FetchPreKeyBundle(ctx, userUUID, devUUID)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "pre-key bundle not found: %v", err)
	}

	pbBundle := &chatv1.PreKeyBundle{
		IdentityKey: bundle.IdentityKey,
		SignedPreKey: &chatv1.SignedPreKey{
			KeyId:     bundle.SPKID,
			PublicKey: bundle.SPK,
			Signature: bundle.SPKSig,
		},
	}

	if len(bundle.PQPK) > 0 {
		pbBundle.PqPreKey = &chatv1.PqPreKey{
			KeyId:     bundle.PQPKID,
			PublicKey: bundle.PQPK,
			Signature: bundle.PQPKSig,
		}
	}

	if bundle.OneTimeKeyID != nil && len(bundle.OneTimeKey) > 0 {
		pbBundle.OneTimePreKey = &chatv1.OneTimePreKey{
			KeyId:     *bundle.OneTimeKeyID,
			PublicKey: bundle.OneTimeKey,
		}
	}

	return &chatv1.FetchPreKeyBundleResponse{Bundle: pbBundle}, nil
}

func (h *AuthHandler) GetKeyCount(ctx context.Context, req *chatv1.GetKeyCountRequest) (*chatv1.GetKeyCountResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}

	if _, err := h.verifyDeviceOwnership(ctx, devUUID); err != nil {
		return nil, err
	}

	count, err := h.store.GetRemainingOneTimeKeyCount(ctx, devUUID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get one-time key count: %v", err)
	}

	return &chatv1.GetKeyCountResponse{
		OneTimeKeyCount: uint32(count),
	}, nil
}

func (h *AuthHandler) UploadOneTimeKeys(ctx context.Context, req *chatv1.UploadOneTimeKeysRequest) (*chatv1.UploadOneTimeKeysResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}

	if _, err := h.verifyDeviceOwnership(ctx, devUUID); err != nil {
		return nil, err
	}

	if len(req.Keys) == 0 {
		return &chatv1.UploadOneTimeKeysResponse{}, nil
	}

	otks := make([]store.OTK, 0, len(req.Keys))
	for _, k := range req.Keys {
		otks = append(otks, store.OTK{
			KeyID:     k.KeyId,
			PublicKey: k.PublicKey,
		})
	}

	if err := h.store.UploadOneTimeKeys(ctx, devUUID, otks); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to upload one-time keys: %v", err)
	}

	return &chatv1.UploadOneTimeKeysResponse{}, nil
}

func (h *AuthHandler) UploadMlsKeyPackage(ctx context.Context, req *chatv1.UploadMlsKeyPackageRequest) (*chatv1.UploadMlsKeyPackageResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}
	if len(req.KeyPackageData) == 0 {
		return nil, status.Error(codes.InvalidArgument, "key_package_data is required")
	}

	callerUserID, err := h.verifyDeviceOwnership(ctx, devUUID)
	if err != nil {
		return nil, err
	}

	if err := h.store.SaveMlsKeyPackage(ctx, callerUserID, devUUID, req.KeyPackageData); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to save mls key package: %v", err)
	}

	return &chatv1.UploadMlsKeyPackageResponse{}, nil
}

func (h *AuthHandler) FetchMlsKeyPackage(ctx context.Context, req *chatv1.FetchMlsKeyPackageRequest) (*chatv1.FetchMlsKeyPackageResponse, error) {
	// SECURITY: Pre-key discovery requires authenticated caller
	if _, err := getUserIDFromCtx(ctx); err != nil {
		return nil, status.Error(codes.Unauthenticated, "missing or invalid user authentication")
	}

	if req.UserId == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id is required")
	}
	targetUserID, err := uuid.Parse(req.UserId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid user_id")
	}

	var targetDevID *uuid.UUID
	if req.DeviceId != "" {
		devUUID, err := uuid.Parse(req.DeviceId)
		if err != nil {
			return nil, status.Error(codes.InvalidArgument, "invalid device_id")
		}
		targetDevID = &devUUID
	}

	kpData, err := h.store.GetActiveMlsKeyPackage(ctx, targetUserID, targetDevID)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "failed to fetch mls key package: %v", err)
	}

	return &chatv1.FetchMlsKeyPackageResponse{
		KeyPackageData: kpData,
	}, nil
}

