import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { AuthService } from './grpc-client'

export interface AuthUser {
  userId: string
  deviceId: string
  displayName?: string
  avatarUrl?: string
}

export interface AuthContextValue {
  user: AuthUser | null
  accessToken: string | null
  isLoading: boolean
  login: (accessToken: string, refreshToken: string, userId: string, deviceId: string, displayName?: string, avatarUrl?: string) => void
  logout: () => void
  refreshAccessToken: () => Promise<void>
  updateUser: (updates: { displayName?: string; avatarUrl?: string }) => void
}

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

  // WebSocket is now managed by ChatPage's GatewayClient — no dual connection

  const login = useCallback((token: string, refreshToken: string, userId: string, deviceId: string, displayName?: string, avatarUrl?: string) => {
    const authUser: AuthUser = { userId, deviceId, displayName, avatarUrl }
    setUser(authUser)
    setAccessToken(token)
    sessionStorage.setItem('genchat_user', JSON.stringify(authUser))
    sessionStorage.setItem('genchat_access_token', token)
    sessionStorage.setItem('genchat_refresh_token', refreshToken)
  }, [])

  const updateUser = useCallback((updates: { displayName?: string; avatarUrl?: string }) => {
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
  }, [])

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

  // Refresh profile if displayName or avatarUrl is not populated yet
  useEffect(() => {
    if (!accessToken || !user) return
    if (!user.displayName && !user.avatarUrl) {
      AuthService.getProfile(accessToken)
        .then(profile => {
          if (profile && (profile.displayName || profile.avatarUrl)) {
            updateUser({ displayName: profile.displayName, avatarUrl: profile.avatarUrl })
          }
        })
        .catch(() => {
          // ignore silent network fallback
        })
    }
  }, [accessToken, user, updateUser])

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, logout, refreshAccessToken, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
