// Unified Connect-ES / gRPC-Web clients and type exports
export { AuthService } from '@/gen/chat/v1/auth_connect'
export type { UserSummary, UserProfileResponse, UpdateProfileRequest } from '@/gen/chat/v1/auth_connect'
export type * from '@/gen/chat/v1/auth_pb'

export { ChannelService } from '@/gen/chat/v1/channels_connect'
export type * from '@/gen/chat/v1/channels_pb'

export { LedgerService } from '@/gen/chat/v1/ledger_connect'
export type * from '@/gen/chat/v1/ledger_pb'

export { MediaService } from '@/gen/chat/v1/media_connect'
export type * from '@/gen/chat/v1/media_pb'

export { KeyService } from '@/gen/chat/v1/keys_connect'
export type * from '@/gen/chat/v1/keys_pb'
