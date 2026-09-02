use thiserror::Error;

#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("invalid signature on pre-key bundle")]
    InvalidSignature,
    
    #[error("invalid key length: expected {expected}, got {got}")]
    InvalidKeyLength { expected: usize, got: usize },
    
    #[error("ML-KEM encapsulation failed")]
    KemEncapsulationFailed,
    
    #[error("ML-KEM decapsulation failed")]
    KemDecapsulationFailed,
    
    #[error("HKDF expansion failed")]
    HkdfError,
    
    #[error("session not initialized")]
    SessionNotInitialized,
    
    #[error("decryption failed: {0}")]
    DecryptionFailed(String),
    
    #[error("serialization error: {0}")]
    SerializationError(String),
    
    #[error("vodozemac error: {0}")]
    VodozemacError(String),
}
