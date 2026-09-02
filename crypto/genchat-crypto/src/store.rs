use crate::error::CryptoError;
use crate::keys::X25519KeyPair;
use crate::ratchet::GenChatSession;

/// Storage trait for sessions
pub trait SessionStore {
    fn load_session(&self, session_id: &str) -> Result<Option<GenChatSession>, CryptoError>;
    fn save_session(&mut self, session_id: &str, session: &GenChatSession) -> Result<(), CryptoError>;
}

/// Storage trait for pre-keys
pub trait PreKeyStore {
    fn load_pre_key(&self, key_id: u32) -> Result<Option<X25519KeyPair>, CryptoError>;
    fn remove_pre_key(&mut self, key_id: u32) -> Result<(), CryptoError>;
}
