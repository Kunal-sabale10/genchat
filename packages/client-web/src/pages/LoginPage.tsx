import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { get as webauthnGet } from '@github/webauthn-json'
import { Fingerprint, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { AuthService } from '@/lib/grpc-client'
import { useAuth } from '@/lib/auth-context'

type LoginStep = 'form' | 'passkey' | 'done' | 'error'

export default function LoginPage() {
  const [userId, setUserId] = useState('')
  const [step, setStep] = useState<LoginStep>('form')
  const [error, setError] = useState<string | null>(null)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleLogin = async () => {
    if (!userId.trim()) return
    setError(null)

    try {
      // Step 1: Begin login ceremony
      setStep('passkey')
      const beginRes = await AuthService.beginLogin({ userId: userId.trim() })

      // Step 2: Trigger WebAuthn assertion (FaceID / TouchID / YubiKey)
      const optionsJson = typeof beginRes.optionsJson === 'string'
        ? beginRes.optionsJson
        : new TextDecoder().decode(beginRes.optionsJson)
      const publicKeyOptions = JSON.parse(optionsJson)
      const getOpts = publicKeyOptions.publicKey ? { publicKey: publicKeyOptions.publicKey } : { publicKey: publicKeyOptions }
      const assertion = await webauthnGet(getOpts)

      // Step 3: Finish login with authd
      const finishRes = await AuthService.finishLogin({
        sessionId: beginRes.sessionId,
        credentialJson: JSON.stringify(assertion),
      })

      // Step 4: Store auth tokens and navigate
      setStep('done')
      login(finishRes.accessToken, finishRes.refreshToken, finishRes.userId, finishRes.deviceId)
      navigate('/chat')
    } catch (err) {
      setStep('error')
      setError(err instanceof Error ? err.message : 'Login failed')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-8 w-8 text-primary" />
          </div>
          <CardTitle>Welcome Back</CardTitle>
          <CardDescription>
            Sign in with your passkey — no passwords needed.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {step === 'form' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="userId">User ID</Label>
                <Input
                  id="userId"
                  placeholder="Enter your user ID"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  autoFocus
                />
              </div>
              <Button className="w-full" size="lg" onClick={handleLogin} disabled={!userId.trim()}>
                <Fingerprint className="mr-2 h-5 w-5" />
                Sign in with Passkey
              </Button>
            </div>
          )}

          {step === 'passkey' && (
            <div className="flex flex-col items-center space-y-4 py-8">
              <Spinner size="lg" />
              <p className="text-sm text-muted-foreground">Waiting for passkey verification…</p>
              <p className="text-xs text-muted-foreground">Use FaceID, TouchID, or your security key</p>
            </div>
          )}

          {step === 'error' && (
            <div className="space-y-4">
              <div className="rounded-md bg-destructive/10 p-4 text-center">
                <p className="text-sm text-destructive">{error}</p>
              </div>
              <Button className="w-full" variant="outline" onClick={() => setStep('form')}>
                Try Again
              </Button>
            </div>
          )}
        </CardContent>

        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            Don't have an account?{' '}
            <Link to="/auth/register" className="font-medium text-primary hover:underline">
              Create one
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
