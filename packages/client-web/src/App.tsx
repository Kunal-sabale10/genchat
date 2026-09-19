import React, { Suspense } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/lib/auth-context'

const RegisterPage = React.lazy(() => import('@/pages/RegisterPage'))
const LoginPage = React.lazy(() => import('@/pages/LoginPage'))
const ChatPage = React.lazy(() => import('@/pages/ChatPage'))

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/auth/register" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen w-screen items-center justify-center bg-background text-muted-foreground text-sm">
          Loading GenChat...
        </div>
      }
    >
      <Routes>
        <Route path="/auth/register" element={<RegisterPage />} />
        <Route path="/auth/login" element={<LoginPage />} />
        <Route
          path="/chat"
          element={
            <ProtectedRoute>
              <ChatPage />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/auth/register" replace />} />
      </Routes>
    </Suspense>
  )
}
