/**
 * Active Session Management & Remote Revocation Client
 */

export interface ActiveSession {
  id: string;
  user_id: string;
  device_id: string;
  device_label: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  is_current: boolean;
}

export class SessionClient {
  private apiBase: string;

  constructor(apiBase = '') {
    this.apiBase = apiBase || (import.meta as any).env?.VITE_AUTH_URL || '';
  }

  /**
   * Fetches the list of active authenticated sessions for the caller.
   */
  async listActiveSessions(authToken: string, currentDeviceId?: string): Promise<ActiveSession[]> {
    if (!authToken) {
      throw new Error('Authentication token required');
    }

    const resp = await fetch(`${this.apiBase}/api/v1/sessions`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    if (!resp.ok) {
      throw new Error(`Failed to list active sessions: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const rawSessions: ActiveSession[] = data.sessions || [];

    return rawSessions.map((s) => ({
      ...s,
      is_current: currentDeviceId ? s.device_id === currentDeviceId : s.is_current,
    }));
  }

  /**
   * Remotely revokes an active session by its session ID.
   */
  async revokeSession(authToken: string, sessionId: string): Promise<void> {
    if (!authToken) {
      throw new Error('Authentication token required');
    }
    if (!sessionId) {
      throw new Error('Session ID required');
    }

    // Try DELETE /api/v1/sessions/:id
    const resp = await fetch(`${this.apiBase}/api/v1/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (resp.ok) {
      return;
    }

    // Fallback to POST /api/v1/sessions/revoke
    const postResp = await fetch(`${this.apiBase}/api/v1/sessions/revoke`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: sessionId }),
    });

    if (!postResp.ok) {
      throw new Error(`Failed to revoke session: ${postResp.status} ${postResp.statusText}`);
    }
  }
}

export const sessionClient = new SessionClient();
