use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use sha2::Sha256;
use std::collections::HashMap;

use crate::error::CryptoError;

const SFRAME_KEY_LABEL: &[u8] = b"SFrame 1.0 Key";
const SFRAME_SALT_LABEL: &[u8] = b"SFrame 1.0 Salt";

/// SFrame per-participant frame encryptor/decryptor for WebRTC Insertable Streams
pub struct SFrameTransformer {
    pub participant_key_id: u64,
    pub base_secret: [u8; 32],
    encryption_key: [u8; 32],
    salt: [u8; 12],
    send_frame_counter: u64,
    received_counters: HashMap<u64, u64>, // key_id -> highest seen counter
}

impl SFrameTransformer {
    /// Create a new SFrame transformer with a shared or participant base key
    pub fn new(participant_key_id: u64, base_secret: [u8; 32]) -> Result<Self, CryptoError> {
        let hk = Hkdf::<Sha256>::new(None, &base_secret);

        let mut encryption_key = [0u8; 32];
        hk.expand(SFRAME_KEY_LABEL, &mut encryption_key)
            .map_err(|_| CryptoError::HkdfError)?;

        let mut salt = [0u8; 12];
        hk.expand(SFRAME_SALT_LABEL, &mut salt)
            .map_err(|_| CryptoError::HkdfError)?;

        Ok(Self {
            participant_key_id,
            base_secret,
            encryption_key,
            salt,
            send_frame_counter: 0,
            received_counters: HashMap::new(),
        })
    }

    /// Encrypt a raw WebRTC video or audio frame payload (Insertable Streams layer)
    /// Format: [SFrame Header (KeyId: 8 bytes, Counter: 8 bytes) || Encrypted Frame Ciphertext (with tag)]
    pub fn encrypt_frame(&mut self, raw_frame_payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let counter = self.send_frame_counter;
        self.send_frame_counter += 1;

        // Build 12-byte nonce = Salt XOR (Counter padded to 12 bytes)
        let mut nonce_bytes = self.salt;
        let counter_be = counter.to_be_bytes();
        for i in 0..8 {
            nonce_bytes[4 + i] ^= counter_be[i];
        }
        let nonce = Nonce::from_slice(&nonce_bytes);

        // Header: KeyID (8 bytes) + Counter (8 bytes)
        let mut header = [0u8; 16];
        header[0..8].copy_from_slice(&self.participant_key_id.to_be_bytes());
        header[8..16].copy_from_slice(&counter_be);

        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let payload = Payload {
            msg: raw_frame_payload,
            aad: &header,
        };

        let ciphertext = cipher.encrypt(nonce, payload)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let mut output = Vec::with_capacity(16 + ciphertext.len());
        output.extend_from_slice(&header);
        output.extend_from_slice(&ciphertext);

        Ok(output)
    }

    /// Decrypt an encrypted WebRTC frame payload received from an untrusted SFU
    pub fn decrypt_frame(&mut self, encrypted_frame: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if encrypted_frame.len() < 16 {
            return Err(CryptoError::DecryptionFailed("Frame too short for SFrame header".into()));
        }

        let header = &encrypted_frame[0..16];
        let ciphertext = &encrypted_frame[16..];

        let key_id = u64::from_be_bytes(header[0..8].try_into().unwrap());
        let counter = u64::from_be_bytes(header[8..16].try_into().unwrap());

        // Replay check
        if let Some(&highest) = self.received_counters.get(&key_id) {
            if counter <= highest && counter + 128 < highest {
                return Err(CryptoError::DecryptionFailed("SFrame replay protection rejected counter".into()));
            }
        }

        // Build 12-byte nonce
        let mut nonce_bytes = self.salt;
        let counter_be = counter.to_be_bytes();
        for i in 0..8 {
            nonce_bytes[4 + i] ^= counter_be[i];
        }
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&self.encryption_key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        let payload = Payload {
            msg: ciphertext,
            aad: header,
        };

        let plaintext = cipher.decrypt(nonce, payload)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        // Update counter tracking
        let current_max = self.received_counters.entry(key_id).or_insert(0);
        if counter > *current_max {
            *current_max = counter;
        }

        Ok(plaintext)
    }
}
