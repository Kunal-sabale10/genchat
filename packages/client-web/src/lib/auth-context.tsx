import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import { AuthService } from './grpc-client'
import { wsTransport } from './ws-transport'

interface AuthUser {
  userId: string
  deviceId: string
}

interface AuthContextValue {
  user: AuthUser | null
  accessToken: string | null
  isLoading: boolean
  login: (accessToken: string, refreshToken: string, userId: string, deviceId: string) => void
  logout: () => void
  refreshAccessToken: () => Promise<void>
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

  // Reconnect WebSocket on page refresh if already logged in
  useEffect(() => {
    const token = sessionStorage.getItem('genchat_access_token')
    if (token) wsTransport.connect(token)
    return () => wsTransport.disconnect()
  }, [])

  const login = useCallback((token: string, refreshToken: string, userId: string, deviceId: string) => {
    const authUser = { userId, deviceId }
    setUser(authUser)
    setAccessToken(token)
    sessionStorage.setItem('genchat_user', JSON.stringify(authUser))
    sessionStorage.setItem('genchat_access_token', token)
    sessionStorage.setItem('genchat_refresh_token', refreshToken)
    // Connect WebSocket with JWT
    wsTransport.connect(token)
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    setAccessToken(null)
    sessionStorage.removeItem('genchat_user')
    sessionStorage.removeItem('genchat_access_token')
    sessionStorage.removeItem('genchat_refresh_token')
    wsTransport.disconnect()
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

  return (
    <AuthContext.Provider value={{ user, accessToken, isLoading, login, logout, refreshAccessToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
