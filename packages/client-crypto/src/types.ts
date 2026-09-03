export interface SignedPreKey {
  key_id: number;
  public_key_hex: string;
  private_key_hex: string;
  signature_hex: string;
}

export interface PqPreKey {
  key_id: number;
  public_key_hex: string;
  decapsulation_key_hex: string;
  signature_hex: string;
}

export interface OneTimePreKey {
  key_id: number;
  public_key_hex: string;
  private_key_hex: string;
}

export interface OneTimePublicKey {
  key_id: number;
  public_key_hex: string;
}

/**
 * Secret identity key bundle stored strictly locally in encrypted IndexedDB
 */
export interface IdentityKeyBundle {
  identity_key_ed25519_pub_hex: string;
  identity_key_ed25519_priv_hex: string;
  identity_key_x25519_pub_hex: string;
  identity_key_x25519_priv_hex: string;
  signed_pre_key: SignedPreKey;
  pq_pre_key: PqPreKey;
  one_time_pre_keys: OneTimePreKey[];
}

/**
 * Public PreKeyBundle uploaded to GenChat server for asynchronous PQXDH exchange
 */
export interface PublicPreKeyBundle {
  identity_key_hex: string;
  identity_key_x25519_hex: string;
  signed_pre_key_id: number;
  signed_pre_key_public_hex: string;
  signed_pre_key_signature_hex: string;
  pq_pre_key_id: number;
  pq_pre_key_public_hex: string;
  pq_pre_key_signature_hex: string;
  one_time_pre_keys: OneTimePublicKey[];
}

export interface PqxdhInitMessage {
  sender_identity_key_hex: string;
  sender_identity_key_x25519_hex: string;
  ephemeral_key_hex: string;
  pq_ciphertext_hex: string;
  used_signed_pre_key_id: number;
  used_pq_pre_key_id: number;
  used_one_time_key_id?: number;
}

export interface HandshakeInitResult {
  shared_secret_hex: string;
  init_message: PqxdhInitMessage;
}

export interface EncryptedMessagePayload {
  message_type: number; // 0 = PreKeyMessage, 1 = NormalMessage
  ciphertext_base64: string;
  updated_session_pickle: string;
}

export interface DecryptedMessagePayload {
  plaintext: Uint8Array;
  updated_session_pickle: string;
}

export interface RatchetSessionState {
  conversation_id: string;
  peer_user_id: string;
  session_pickle: string;
  pickle_key_hex: string;
  updated_at: number;
}
