use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmSignedPreKey {
    pub key_id: u32,
    pub public_key_hex: String,
    pub private_key_hex: String,
    pub signature_hex: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmPqPreKey {
    pub key_id: u32,
    pub public_key_hex: String,
    pub decapsulation_key_hex: String, // Private ML-KEM key
    pub signature_hex: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmOneTimePreKey {
    pub key_id: u32,
    pub public_key_hex: String,
    pub private_key_hex: String,
}

/// Full local key store bundle (Public + Private keys)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmIdentityBundle {
    pub identity_key_ed25519_pub_hex: String,
    pub identity_key_ed25519_priv_hex: String,
    pub identity_key_x25519_pub_hex: String,
    pub identity_key_x25519_priv_hex: String,
    pub signed_pre_key: WasmSignedPreKey,
    pub pq_pre_key: WasmPqPreKey,
    pub one_time_pre_keys: Vec<WasmOneTimePreKey>,
}

/// Public PreKeyBundle to be uploaded to GenChat Auth/Key Service
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmPublicPreKeyBundle {
    pub identity_key_hex: String,       // Ed25519 public key
    pub identity_key_x25519_hex: String, // X25519 public key
    pub signed_pre_key_id: u32,
    pub signed_pre_key_public_hex: String,
    pub signed_pre_key_signature_hex: String,
    pub pq_pre_key_id: u32,
    pub pq_pre_key_public_hex: String,
    pub pq_pre_key_signature_hex: String,
    pub one_time_pre_keys: Vec<WasmOneTimePublicKey>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmOneTimePublicKey {
    pub key_id: u32,
    pub public_key_hex: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmPqxdhInitMessage {
    pub sender_identity_key_hex: String,
    pub sender_identity_key_x25519_hex: String,
    pub ephemeral_key_hex: String,
    pub pq_ciphertext_hex: String,
    pub used_signed_pre_key_id: u32,
    pub used_pq_pre_key_id: u32,
    pub used_one_time_key_id: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmHandshakeInitResult {
    pub shared_secret_hex: String,
    pub init_message: WasmPqxdhInitMessage,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmEncryptedPayload {
    pub message_type: usize, // 0 = PreKeyMessage, 1 = NormalMessage
    pub ciphertext_base64: String,
    pub updated_session_pickle: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WasmDecryptedPayload {
    pub plaintext: Vec<u8>,
    pub updated_session_pickle: String,
}
