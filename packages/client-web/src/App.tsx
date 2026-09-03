import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-context'
import RegisterPage from '@/pages/RegisterPage'
import LoginPage from '@/pages/LoginPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/auth/register" replace />
  return <>{children}</>
}

function ChatPlaceholder() {
  const { user, logout } = useAuth()
  return (
    <div className="flex min-h-screen flex-col items-center justify-center space-y-4">
      <h1 className="text-2xl font-bold">Welcome to GenChat</h1>
      <p className="text-muted-foreground">Logged in as {user?.userId}</p>
      <p className="text-sm text-muted-foreground">Device: {user?.deviceId}</p>
      <button
        onClick={logout}
        className="rounded-md bg-destructive px-4 py-2 text-sm text-destructive-foreground hover:bg-destructive/90"
      >
        Sign Out
      </button>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/auth/register" element={<RegisterPage />} />
      <Route path="/auth/login" element={<LoginPage />} />
      <Route
        path="/chat"
        element={
          <ProtectedRoute>
            <ChatPlaceholder />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/auth/register" replace />} />
    </Routes>
  )
}
