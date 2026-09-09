package handler

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
	"github.com/genchat/services/auth/internal/store"
)

func (h *AuthHandler) UploadPreKeyBundle(ctx context.Context, req *chatv1.UploadPreKeyBundleRequest) (*chatv1.UploadPreKeyBundleResponse, error) {
	if req.DeviceId == "" {
		return nil, status.Error(codes.InvalidArgument, "device_id is required")
	}
	devUUID, err := uuid.Parse(req.DeviceId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid device_id")
	}

	if callerUserID, err := getUserIDFromCtx(ctx); err == nil && callerUserID != uuid.Nil {
		devices, devErr := h.store.GetDevicesByUser(ctx, callerUserID)
		if devErr == nil && len(devices) > 0 {
			ownsDevice := false
			for _, d := range devices {
				if d.ID == devUUID {
					ownsDevice = true
					break
				}
			}
			if !ownsDevice {
				return nil, status.Error(codes.PermissionDenied, "cannot upload pre-key bundle for another user's device")
			}
		}
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

	if callerUserID, err := getUserIDFromCtx(ctx); err == nil && callerUserID != uuid.Nil {
		devices, devErr := h.store.GetDevicesByUser(ctx, callerUserID)
		if devErr == nil && len(devices) > 0 {
			ownsDevice := false
			for _, d := range devices {
				if d.ID == devUUID {
					ownsDevice = true
					break
				}
			}
			if !ownsDevice {
				return nil, status.Error(codes.PermissionDenied, "cannot query key count for another user's device")
			}
		}
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

	if callerUserID, err := getUserIDFromCtx(ctx); err == nil && callerUserID != uuid.Nil {
		devices, devErr := h.store.GetDevicesByUser(ctx, callerUserID)
		if devErr == nil && len(devices) > 0 {
			ownsDevice := false
			for _, d := range devices {
				if d.ID == devUUID {
					ownsDevice = true
					break
				}
			}
			if !ownsDevice {
				return nil, status.Error(codes.PermissionDenied, "cannot upload one-time keys for another user's device")
			}
		}
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
