/// <reference types="vite/client" />
// @generated Connect-ES compatible ChannelService client
// Communicates with backend ChannelService (authd / envoy)

import type {
  Channel,
  ChannelMember,
  CreateChannelRequest,
  CreateChannelResponse,
  JoinChannelRequest,
  JoinChannelResponse,
  LeaveChannelRequest,
  LeaveChannelResponse,
  ListChannelsRequest,
  ListChannelsResponse,
  GetChannelMembersRequest,
  GetChannelMembersResponse,
  CommitEpochRequest,
  CommitEpochResponse,
} from './channels_pb'

const BASE_URL = import.meta.env.VITE_AUTH_URL || ''

async function grpcUnary<TReq, TRes>(service: string, method: string, request: TReq, token?: string): Promise<TRes> {
  const body = JSON.stringify(request)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${BASE_URL}/${service}/${method}`, {
    method: 'POST',
    headers,
    body,
  })
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`gRPC call ${service}/${method} failed (${res.status}): ${errorText}`)
  }
  return res.json() as Promise<TRes>
}

export const ChannelService = {
  createChannel(req: CreateChannelRequest, token?: string): Promise<CreateChannelResponse> {
    return grpcUnary<CreateChannelRequest, CreateChannelResponse>('chat.v1.ChannelService', 'CreateChannel', req, token)
  },

  joinChannel(req: JoinChannelRequest, token?: string): Promise<JoinChannelResponse> {
    return grpcUnary<JoinChannelRequest, JoinChannelResponse>('chat.v1.ChannelService', 'JoinChannel', req, token)
  },

  leaveChannel(req: LeaveChannelRequest, token?: string): Promise<LeaveChannelResponse> {
    return grpcUnary<LeaveChannelRequest, LeaveChannelResponse>('chat.v1.ChannelService', 'LeaveChannel', req, token)
  },

  listChannels(req: ListChannelsRequest, token?: string): Promise<ListChannelsResponse> {
    return grpcUnary<ListChannelsRequest, ListChannelsResponse>('chat.v1.ChannelService', 'ListChannels', req, token)
  },

  getChannelMembers(req: GetChannelMembersRequest, token?: string): Promise<GetChannelMembersResponse> {
    return grpcUnary<GetChannelMembersRequest, GetChannelMembersResponse>('chat.v1.ChannelService', 'GetChannelMembers', req, token)
  },

  commitEpoch(req: CommitEpochRequest, token?: string): Promise<CommitEpochResponse> {
    return grpcUnary<CommitEpochRequest, CommitEpochResponse>('chat.v1.ChannelService', 'CommitEpoch', req, token)
  },
}
