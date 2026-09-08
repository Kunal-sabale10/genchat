/// <reference types="vite/client" />

export enum PushPlatform {
  UNSPECIFIED = 0,
  APNS = 1,
  FCM = 2,
  WEBPUSH = 3,
}

export interface RegisterPushTokenRequest {
  deviceId: string
  platform: PushPlatform
  token: string
  endpoint?: string
  p256dh?: string
  auth?: string
}

export interface RegisterPushTokenResponse {
  success: boolean
}

export interface UnregisterPushTokenRequest {
  deviceId: string
}

export interface UnregisterPushTokenResponse {
  success: boolean
}

const BASE_URL = import.meta.env.VITE_AUTH_URL || ''

async function postPush<TReq, TRes>(method: string, request: TReq, token?: string): Promise<TRes> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${BASE_URL}/chat.v1.PushService/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  })
  if (!res.ok) {
    const errorText = await res.text()
    throw new Error(`PushService error (${res.status}): ${errorText}`)
  }
  return (await res.json()) as TRes
}

export const PushClient = {
  async registerPushToken(req: RegisterPushTokenRequest, token: string): Promise<RegisterPushTokenResponse> {
    return postPush<RegisterPushTokenRequest, RegisterPushTokenResponse>('RegisterPushToken', req, token)
  },

  async unregisterPushToken(req: UnregisterPushTokenRequest, token: string): Promise<UnregisterPushTokenResponse> {
    return postPush<UnregisterPushTokenRequest, UnregisterPushTokenResponse>('UnregisterPushToken', req, token)
  },

  async registerBrowserPush(deviceId: string, token: string): Promise<boolean> {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      try {
        await this.registerPushToken({
          deviceId,
          platform: PushPlatform.WEBPUSH,
          token: `webpush-client-${deviceId.slice(0, 8)}`,
          endpoint: `https://push.genchat.local/v1/${deviceId}`,
        }, token)
        return true
      } catch (err) {
        console.warn('Failed to register mock push token:', err)
        return false
      }
    }

    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        const subJson = sub.toJSON()
        await this.registerPushToken({
          deviceId,
          platform: PushPlatform.WEBPUSH,
          token: sub.endpoint,
          endpoint: sub.endpoint,
          p256dh: subJson.keys?.p256dh,
          auth: subJson.keys?.auth,
        }, token)
        return true
      }
    } catch (err) {
      console.warn('Failed to register browser push subscription:', err)
    }
    return false
  }
}