package handler

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	chatv1 "github.com/genchat/proto/gen/chat/v1"
)

func (h *AuthHandler) CreateChannel(ctx context.Context, req *chatv1.CreateChannelRequest) (*chatv1.CreateChannelResponse, error) {
	creatorID, err := getUserIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	if req.Name == "" {
		return nil, status.Error(codes.InvalidArgument, "channel name is required")
	}

	// Always include creator in member list
	memberMap := make(map[uuid.UUID]bool)
	memberMap[creatorID] = true
	for _, m := range req.MemberUserIds {
		if uid, err := uuid.Parse(m); err == nil {
			memberMap[uid] = true
		}
	}

	memberIDs := make([]uuid.UUID, 0, len(memberMap))
	for uid := range memberMap {
		memberIDs = append(memberIDs, uid)
	}

	channelType := "group"
	if req.Type == chatv1.ChannelType_CHANNEL_TYPE_DM {
		channelType = "dm"
	} else if req.Type == chatv1.ChannelType_CHANNEL_TYPE_BROADCAST {
		channelType = "broadcast"
	}

	ch, err := h.store.CreateChannel(ctx, channelType, req.Name, &creatorID, memberIDs)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to create channel: %v", err)
	}

	members, err := h.store.GetChannelMembers(ctx, ch.ID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to load channel members: %v", err)
	}

	protoMembers := make([]*chatv1.ChannelMember, 0, len(members))
	for _, m := range members {
		role := chatv1.ChannelRole_CHANNEL_ROLE_MEMBER
		if m.Role == "owner" {
			role = chatv1.ChannelRole_CHANNEL_ROLE_OWNER
		} else if m.Role == "admin" {
			role = chatv1.ChannelRole_CHANNEL_ROLE_ADMIN
		}
		protoMembers = append(protoMembers, &chatv1.ChannelMember{
			ChannelId:   m.ChannelID.String(),
			UserId:      m.UserID.String(),
			Role:        role,
			JoinedAt:    timestamppb.New(m.JoinedAt),
			LastReadSeq: uint64(m.LastReadSeq),
		})
	}

	return &chatv1.CreateChannelResponse{
		Channel: &chatv1.Channel{
			Id:        ch.ID.String(),
			Type:      req.Type,
			Name:      ch.Name,
			CreatorId: creatorID.String(),
			CreatedAt: timestamppb.New(ch.CreatedAt),
			UpdatedAt: timestamppb.New(ch.UpdatedAt),
		},
		Members: protoMembers,
	}, nil
}

func (h *AuthHandler) JoinChannel(ctx context.Context, req *chatv1.JoinChannelRequest) (*chatv1.JoinChannelResponse, error) {
	userID, err := getUserIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	channelID, err := uuid.Parse(req.ChannelId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid channel_id")
	}

	if err := h.store.JoinChannel(ctx, channelID, userID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to join channel: %v", err)
	}

	return &chatv1.JoinChannelResponse{
		Success: true,
		Member: &chatv1.ChannelMember{
			ChannelId: channelID.String(),
			UserId:    userID.String(),
			Role:      chatv1.ChannelRole_CHANNEL_ROLE_MEMBER,
			JoinedAt:  timestamppb.Now(),
		},
	}, nil
}

func (h *AuthHandler) LeaveChannel(ctx context.Context, req *chatv1.LeaveChannelRequest) (*chatv1.LeaveChannelResponse, error) {
	userID, err := getUserIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	channelID, err := uuid.Parse(req.ChannelId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid channel_id")
	}

	if err := h.store.LeaveChannel(ctx, channelID, userID); err != nil {
		return nil, status.Errorf(codes.Internal, "failed to leave channel: %v", err)
	}

	return &chatv1.LeaveChannelResponse{Success: true}, nil
}

func (h *AuthHandler) ListChannels(ctx context.Context, req *chatv1.ListChannelsRequest) (*chatv1.ListChannelsResponse, error) {
	userID, err := getUserIDFromCtx(ctx)
	if err != nil {
		return nil, err
	}

	channels, err := h.store.ListUserChannels(ctx, userID, int(req.Limit))
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to list channels: %v", err)
	}

	protoChannels := make([]*chatv1.Channel, 0, len(channels))
	for _, c := range channels {
		cType := chatv1.ChannelType_CHANNEL_TYPE_GROUP
		if c.ChannelType == "dm" {
			cType = chatv1.ChannelType_CHANNEL_TYPE_DM
		} else if c.ChannelType == "broadcast" {
			cType = chatv1.ChannelType_CHANNEL_TYPE_BROADCAST
		}
		creatorStr := ""
		if c.CreatorID != nil {
			creatorStr = c.CreatorID.String()
		}
		protoChannels = append(protoChannels, &chatv1.Channel{
			Id:        c.ID.String(),
			Type:      cType,
			Name:      c.Name,
			CreatorId: creatorStr,
			CreatedAt: timestamppb.New(c.CreatedAt),
			UpdatedAt: timestamppb.New(c.UpdatedAt),
		})
	}

	return &chatv1.ListChannelsResponse{
		Channels: protoChannels,
	}, nil
}

func (h *AuthHandler) GetChannelMembers(ctx context.Context, req *chatv1.GetChannelMembersRequest) (*chatv1.GetChannelMembersResponse, error) {
	if req.ChannelId == "" {
		return nil, status.Error(codes.InvalidArgument, "channel_id is required")
	}
	channelID, err := uuid.Parse(req.ChannelId)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid channel_id")
	}

	members, err := h.store.GetChannelMembers(ctx, channelID)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "failed to get channel members: %v", err)
	}

	protoMembers := make([]*chatv1.ChannelMember, 0, len(members))
	for _, m := range members {
		role := chatv1.ChannelRole_CHANNEL_ROLE_MEMBER
		if m.Role == "owner" {
			role = chatv1.ChannelRole_CHANNEL_ROLE_OWNER
		} else if m.Role == "admin" {
			role = chatv1.ChannelRole_CHANNEL_ROLE_ADMIN
		}
		protoMembers = append(protoMembers, &chatv1.ChannelMember{
			ChannelId:   m.ChannelID.String(),
			UserId:      m.UserID.String(),
			Role:        role,
			JoinedAt:    timestamppb.New(m.JoinedAt),
			LastReadSeq: uint64(m.LastReadSeq),
		})
	}

	return &chatv1.GetChannelMembersResponse{
		Members: protoMembers,
	}, nil
}
