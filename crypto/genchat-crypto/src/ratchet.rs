use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use vodozemac::olm::{Account, Session, OlmMessage, SessionConfig, AccountPickle, SessionPickle};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey};

use crate::error::CryptoError;

pub struct GenChatAccount {
    account: Account,
}

impl GenChatAccount {
    pub fn new() -> Self {
        Self {
            account: Account::new(),
        }
    }

    pub fn identity_keys(&self) -> (Curve25519PublicKey, Ed25519PublicKey) {
        (self.account.curve25519_key(), self.account.ed25519_key())
    }

    pub fn generate_one_time_keys(&mut self, count: usize) {
        self.account.generate_one_time_keys(count);
    }

    pub fn one_time_keys(&self) -> HashMap<String, Curve25519PublicKey> {
        self.account
            .one_time_keys()
            .into_iter()
            .map(|(id, key)| (id.to_string(), key))
            .collect()
    }

    pub fn mark_keys_as_published(&mut self) {
        self.account.mark_keys_as_published();
    }

    pub fn create_outbound_session(
        &self, 
        config: SessionConfig,
        identity_key: Curve25519PublicKey, 
        one_time_key: Curve25519PublicKey
    ) -> GenChatSession {
        let session = self.account.create_outbound_session(config, identity_key, one_time_key);
        GenChatSession { session }
    }

    pub fn create_inbound_session(
        &mut self,
        identity_key: Curve25519PublicKey,
        message: &vodozemac::olm::PreKeyMessage,
    ) -> Result<(GenChatSession, Vec<u8>), CryptoError> {
        let result = self.account.create_inbound_session(identity_key, message)
            .map_err(|e| CryptoError::VodozemacError(e.to_string()))?;
        Ok((GenChatSession { session: result.session }, result.plaintext))
    }

    pub fn pickle(&self, pickle_key: &[u8; 32]) -> Result<String, CryptoError> {
        let pickle = self.account.pickle().encrypt(pickle_key);
        serde_json::to_string(&pickle).map_err(|e| CryptoError::SerializationError(e.to_string()))
    }

    pub fn unpickle(data: &str, pickle_key: &[u8; 32]) -> Result<Self, CryptoError> {
        let pickle: AccountPickle = serde_json::from_str(data)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;
        let account = Account::from_pickle(pickle, pickle_key)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;
        Ok(Self { account })
    }
}

pub struct GenChatSession {
    session: Session,
}

impl GenChatSession {
    pub fn encrypt(&mut self, plaintext: &[u8]) -> EncryptedEnvelope {
        let msg = self.session.encrypt(plaintext);
        match msg {
            OlmMessage::PreKey(pk_msg) => EncryptedEnvelope {
                message_type: 0,
                ciphertext: pk_msg.to_bytes(),
            },
            OlmMessage::Normal(norm_msg) => EncryptedEnvelope {
                message_type: 1,
                ciphertext: norm_msg.to_bytes(),
            }
        }
    }

    pub fn decrypt(&mut self, envelope: &EncryptedEnvelope) -> Result<Vec<u8>, CryptoError> {
        let msg = if envelope.message_type == 0 {
            let pk_msg = vodozemac::olm::PreKeyMessage::from_bytes(&envelope.ciphertext)
                .map_err(|e| CryptoError::VodozemacError(e.to_string()))?;
            OlmMessage::PreKey(pk_msg)
        } else {
            let norm_msg = vodozemac::olm::Message::from_bytes(&envelope.ciphertext)
                .map_err(|e| CryptoError::VodozemacError(e.to_string()))?;
            OlmMessage::Normal(norm_msg)
        };
        
        let plaintext = self.session.decrypt(&msg)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;
        Ok(plaintext)
    }

    pub fn session_id(&self) -> String {
        self.session.session_id()
    }

    pub fn pickle(&self, pickle_key: &[u8; 32]) -> Result<String, CryptoError> {
        let pickle = self.session.pickle().encrypt(pickle_key);
        serde_json::to_string(&pickle).map_err(|e| CryptoError::SerializationError(e.to_string()))
    }

    pub fn unpickle(data: &str, pickle_key: &[u8; 32]) -> Result<Self, CryptoError> {
        let pickle: SessionPickle = serde_json::from_str(data)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;
        let session = Session::from_pickle(pickle, pickle_key)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;
        Ok(Self { session })
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub message_type: u8,  // 0 = pre-key message, 1 = normal message  
    pub ciphertext: Vec<u8>,
}
