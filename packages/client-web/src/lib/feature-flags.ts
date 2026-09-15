/**
 * Feature Flags Client & React Hook
 *
 * Provides staged rollout and remote kill-switch evaluation for risky features:
 * - device_linking
 * - group_calling
 * - ai_summary
 * - protobuf_wire
 */

import { useState, useEffect } from 'react'

export interface FeatureFlagsMap {
  [flag: string]: boolean
}

let cachedFlags: FeatureFlagsMap = {
  device_linking: true,
  group_calling: true,
  ai_summary: true,
  protobuf_wire: true,
}

let subscribers = new Set<(flags: FeatureFlagsMap) => void>()

export async function fetchFeatureFlags(token?: string, authUrl = ''): Promise<FeatureFlagsMap> {
  const url = `${authUrl}/features`
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  try {
    const res = await fetch(url, { headers })
    if (res.ok) {
      const data = await res.json()
      if (data.features) {
        cachedFlags = { ...cachedFlags, ...data.features }
        subscribers.forEach((cb) => cb(cachedFlags))
        try {
          localStorage.setItem('genchat_features', JSON.stringify(cachedFlags))
        } catch {
          // ignore localStorage issues in private mode
        }
      }
    }
  } catch (err) {
    console.warn('[FeatureFlags] Failed to fetch remote flags, using cached/defaults', err)
  }

  return cachedFlags
}

export function isFeatureEnabled(flagName: string): boolean {
  if (typeof window !== 'undefined' && Object.keys(cachedFlags).length === 0) {
    try {
      const stored = localStorage.getItem('genchat_features')
      if (stored) {
        cachedFlags = JSON.parse(stored)
      }
    } catch {
      // ignore
    }
  }
  return cachedFlags[flagName] ?? false
}

export function useFeatureFlag(flagName: string): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => isFeatureEnabled(flagName))

  useEffect(() => {
    const handleUpdate = (flags: FeatureFlagsMap) => {
      if (flagName in flags) {
        setEnabled(flags[flagName])
      }
    }
    subscribers.add(handleUpdate)
    return () => {
      subscribers.delete(handleUpdate)
    }
  }, [flagName])

  return enabled
}
