import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { AuthService } from './grpc-client'
import type { GenChatCrypto, SecureKeyStorage } from '@genchat/client-crypto'
import { getCryptoCore, getKeyStorage } from './crypto-core'

export interface AuthUser {
  userId: string
  deviceId: string
  displayName?: string
  avatarUrl?: string
  identityKey?: string
}

export interface AuthContextValue {
  user: AuthUser | null
  accessToken: string | null
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  crypto: GenChatCrypto | null
  storage: SecureKeyStorage
  login: (
    accessToken: string,
    refreshToken?: string,
    userId?: string,
    deviceId?: string,
    displayName?: string,
    avatarUrl?: string,
    identityKey?: string
  ) => void
  logout: () => void
  refreshAccessToken: () => Promise<void>
  updateUser: (updates: { displayName?: string; avatarUrl?: string; identityKey?: string }) => void
}

export type AuthContextType = AuthContextValue

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    const stored = sessionStorage.getItem('genchat_user')
    return stored ? JSON.parse(stored) : null
  })
  const [accessToken, setAccessToken] = useState<string | null>(
    () => sessionStorage.getItem('genchat_access_token')
  )
  const [isLoading, setIsLoading] = useState(false)
  const [cryptoCore, setCryptoCore] = useState<GenChatCrypto | null>(null)
  const keyStorage = getKeyStorage()

  // Initialize WASM crypto core on mount
  useEffect(() => {
    getCryptoCore()
      .then((c) => setCryptoCore(c))
      .catch((err) => console.warn('[AuthContext] WASM crypto initialization pending:', err))
  }, [])

  // WebSocket is now managed by ChatPage's GatewayClient — no dual connection

  const login = useCallback(
    (
      token: string,
      refreshToken: string = '',
      userId: string = 'user_' + Math.random().toString(36).substring(2, 9),
      deviceId: string = 'device_web_primary',
      displayName?: string,
      avatarUrl?: string,
      identityKey?: string
    ) => {
      const authUser: AuthUser = { userId, deviceId, displayName, avatarUrl, identityKey }
      setUser(authUser)
      setAccessToken(token)
      sessionStorage.setItem('genchat_user', JSON.stringify(authUser))
      sessionStorage.setItem('genchat_access_token', token)
      if (refreshToken) {
        sessionStorage.setItem('genchat_refresh_token', refreshToken)
      }
    },
    []
  )

  const updateUser = useCallback((updates: { displayName?: string; avatarUrl?: string; identityKey?: string }) => {
    setUser(prev => {
      if (!prev) return null
      const next = { ...prev, ...updates }
      sessionStorage.setItem('genchat_user', JSON.stringify(next))
      return next
    })
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    setAccessToken(null)
    sessionStorage.removeItem('genchat_user')
    sessionStorage.removeItem('genchat_access_token')
    sessionStorage.removeItem('genchat_refresh_token')
    keyStorage.wipeAllKeys().catch(() => {})
  }, [keyStorage])

  const refreshAccessToken = useCallback(async () => {
    const refreshToken = sessionStorage.getItem('genchat_refresh_token')
    if (!refreshToken) {
      logout()
      return
    }
    try {
      setIsLoading(true)
      const res = await AuthService.refreshToken({ refreshToken })
      setAccessToken(res.accessToken)
      sessionStorage.setItem('genchat_access_token', res.accessToken)
      sessionStorage.setItem('genchat_refresh_token', res.refreshToken)
    } catch {
      logout()
    } finally {
      setIsLoading(false)
    }
  }, [logout])

  // Always sync latest profile (displayName, avatarUrl, identityKey) from server on auth/mount
  useEffect(() => {
    if (!accessToken) return
    AuthService.getProfile(accessToken)
      .then((profile) => {
        if (profile) {
          updateUser({
            displayName: profile.displayName || user?.displayName,
            avatarUrl: profile.avatarUrl !== undefined ? profile.avatarUrl : user?.avatarUrl,
            identityKey: profile.identityKey || user?.identityKey,
          })
        }
      })
      .catch(() => {
        // silent network fallback
      })
  }, [accessToken])

  const isAuthenticated = Boolean(user && accessToken)
  const token = accessToken

  return (
    <AuthContext.Provider
      value={{
        user,
        accessToken,
        token,
        isAuthenticated,
        isLoading,
        crypto: cryptoCore,
        storage: keyStorage,
        login,
        logout,
        refreshAccessToken,
        updateUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
