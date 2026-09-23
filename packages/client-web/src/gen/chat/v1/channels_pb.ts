// @generated from protobuf file chat/v1/channels.proto
// Connect-ES compatible stubs matching proto/chat/v1/channels.proto

export enum ChannelType {
  CHANNEL_TYPE_UNSPECIFIED = 0,
  CHANNEL_TYPE_DM = 1,
  CHANNEL_TYPE_GROUP = 2,
  CHANNEL_TYPE_BROADCAST = 3,
}

export enum ChannelRole {
  CHANNEL_ROLE_UNSPECIFIED = 0,
  CHANNEL_ROLE_OWNER = 1,
  CHANNEL_ROLE_ADMIN = 2,
  CHANNEL_ROLE_MEMBER = 3,
}

export interface Channel {
  id: string
  type: ChannelType
  name: string
  creatorId: string
  createdAt?: string | number
  updatedAt?: string | number
}

export interface ChannelMember {
  channelId: string
  userId: string
  role: ChannelRole
  joinedAt?: string | number
  lastReadSeq?: number | string
}

export interface CreateChannelRequest {
  type: ChannelType
  name: string
  memberUserIds: string[]
  memberWelcomes?: Record<string, Uint8Array | string>
  initialCommit?: Uint8Array | string
}

export interface CreateChannelResponse {
  channel: Channel
  members: ChannelMember[]
}

export interface JoinChannelRequest {
  channelId: string
  keyPackage: Uint8Array | string
}

export interface JoinChannelResponse {
  success: boolean
  member?: ChannelMember
}

export interface LeaveChannelRequest {
  channelId: string
}

export interface LeaveChannelResponse {
  success: boolean
}

export interface ListChannelsRequest {
  userId?: string
  limit?: number
  cursor?: string
}

export interface ListChannelsResponse {
  channels: Channel[]
  nextCursor?: string
}

export interface GetChannelMembersRequest {
  channelId: string
}

export interface GetChannelMembersResponse {
  members: ChannelMember[]
}

export interface CommitEpochRequest {
  channelId: string
  epoch: number | string
  commitData: Uint8Array | string
}

export interface CommitEpochResponse {
  success: boolean
  currentEpoch: number | string
}
