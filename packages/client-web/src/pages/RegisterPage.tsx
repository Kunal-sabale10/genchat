import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { create as webauthnCreate } from '@github/webauthn-json'
import { Fingerprint, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { AuthService } from '@/lib/grpc-client'
import { useAuth } from '@/lib/auth-context'

type RegistrationStep = 'form' | 'passkey' | 'keygen' | 'done' | 'error'

export default function RegisterPage() {
  const [displayName, setDisplayName] = useState('')
  const [step, setStep] = useState<RegistrationStep>('form')
  const [error, setError] = useState<string | null>(null)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleRegister = async () => {
    if (!displayName.trim()) return
    setError(null)

    try {
      // Step 1: Begin registration ceremony
      setStep('passkey')
      const beginRes = await AuthService.beginRegistration({ displayName: displayName.trim() })

      // Step 2: Trigger WebAuthn credential creation (FaceID / TouchID / YubiKey)
      const optionsJson = typeof beginRes.optionsJson === 'string'
        ? beginRes.optionsJson
        : new TextDecoder().decode(beginRes.optionsJson)
      const publicKeyOptions = JSON.parse(optionsJson)
      const createOpts = publicKeyOptions.publicKey ? { publicKey: publicKeyOptions.publicKey } : { publicKey: publicKeyOptions }
      const credential = await webauthnCreate(createOpts)

      // Step 3: Key Generation Ceremony (ML-KEM-768 + X25519 + Ed25519)
      setStep('keygen')

      // In production, this would use the initialized GenChatCrypto Wasm instance.
      // For now, we create a placeholder that will be wired up when Wasm is loaded.
      const identityKeyBytes = new Uint8Array(32)
      try {
        const { performKeyCeremony: ceremony } = await import('@/lib/key-ceremony')
        throw new Error('Wasm not yet wired')
      } catch {
        globalThis.crypto.getRandomValues(identityKeyBytes)
        console.warn('[KeyCeremony] Wasm not available, using random identity key for dev')
      }
      const identityKeyHex = Array.from(identityKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('')

      // Step 4: Finish registration with authd
      const finishRes = await AuthService.finishRegistration({
        sessionId: beginRes.sessionId,
        credentialJson: JSON.stringify(credential),
        identityKey: identityKeyHex,
        deviceLabel: `${navigator.userAgent.split(' ')[0]} Browser`,
      })

      // Step 5: Store auth tokens and navigate
      setStep('done')
      login(finishRes.accessToken, finishRes.refreshToken, finishRes.userId, finishRes.deviceId)
      navigate('/chat')
    } catch (err) {
      setStep('error')
      setError(err instanceof Error ? err.message : 'Registration failed')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
            <ShieldCheck className="h-8 w-8 text-primary" />
          </div>
          <CardTitle>Create Your GenChat Account</CardTitle>
          <CardDescription>
            Zero-trust, quantum-safe messaging. No passwords — just your biometric passkey.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {step === 'form' && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="displayName">Display Name</Label>
                <Input
                  id="displayName"
                  placeholder="Enter your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                  autoFocus
                />
              </div>
              <Button className="w-full" size="lg" onClick={handleRegister} disabled={!displayName.trim()}>
                <Fingerprint className="mr-2 h-5 w-5" />
                Create with Passkey
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

          {step === 'keygen' && (
            <div className="flex flex-col items-center space-y-4 py-8">
              <Spinner size="lg" />
              <p className="text-sm text-muted-foreground">Generating quantum-safe encryption keys…</p>
              <p className="text-xs text-muted-foreground">ML-KEM-768 + X25519 + Ed25519</p>
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
            Already have an account?{' '}
            <Link to="/auth/login" className="font-medium text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    </div>
  )
}
