use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use x25519_dalek::{StaticSecret, PublicKey as X25519PublicKey};
use hybrid_array::Array;
use ml_kem::{
    kem::{Decapsulate, DecapsulationKey, Encapsulate, EncapsulationKey},
    EncodedSizeUser,
    KemCore,
    MlKem768,
    MlKem768Params,
};
use rand::rngs::OsRng;
use zeroize::Zeroize;
use serde::{Serialize, Deserialize};

use crate::error::CryptoError;

pub type MlKem768EncapsulationKey = EncapsulationKey<MlKem768Params>;
pub type MlKem768DecapsulationKey = DecapsulationKey<MlKem768Params>;
pub type MlKem768Ciphertext = ml_kem::Ciphertext<MlKem768>;

/// Ed25519 identity key pair for a user/device
pub struct IdentityKeyPair {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
}

impl IdentityKeyPair {
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        Self {
            signing_key,
            verifying_key,
        }
    }

    pub fn from_bytes(secret: &[u8; 32]) -> Result<Self, CryptoError> {
        let signing_key = SigningKey::from_bytes(secret);
        let verifying_key = signing_key.verifying_key();
        Ok(Self {
            signing_key,
            verifying_key,
        })
    }

    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        let signature = self.signing_key.sign(message);
        signature.to_bytes().to_vec()
    }

    pub fn verify(&self, message: &[u8], signature_bytes: &[u8]) -> Result<(), CryptoError> {
        let sig = Signature::from_slice(signature_bytes)
            .map_err(|_| CryptoError::InvalidSignature)?;
        self.verifying_key.verify(message, &sig)
            .map_err(|_| CryptoError::InvalidSignature)
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.verifying_key.to_bytes()
    }

    pub fn secret_key_bytes(&self) -> [u8; 32] {
        self.signing_key.to_bytes()
    }
}

/// X25519 key pair for Diffie-Hellman
pub struct X25519KeyPair {
    secret: StaticSecret,
    public: X25519PublicKey,
}

impl X25519KeyPair {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = X25519PublicKey::from(&secret);
        Self { secret, public }
    }

    pub fn diffie_hellman(&self, their_public: &X25519PublicKey) -> [u8; 32] {
        let shared = self.secret.diffie_hellman(their_public);
        shared.to_bytes()
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        self.public.to_bytes()
    }

    pub fn public_key(&self) -> &X25519PublicKey {
        &self.public
    }
}

/// ML-KEM-768 key pair for post-quantum key encapsulation
pub struct PqKeyPair {
    pub encapsulation_key_bytes: Vec<u8>,
    decapsulation_key_bytes: Vec<u8>,
}

impl PqKeyPair {
    pub fn generate() -> Self {
        let (dk, ek) = MlKem768::generate(&mut OsRng);
        Self {
            encapsulation_key_bytes: ek.as_bytes().as_slice().to_vec(),
            decapsulation_key_bytes: dk.as_bytes().as_slice().to_vec(),
        }
    }

    pub fn encapsulate_with(encapsulation_key_bytes: &[u8]) -> Result<(Vec<u8>, [u8; 32]), CryptoError> {
        let array = Array::try_from(encapsulation_key_bytes)
            .map_err(|_| CryptoError::InvalidKeyLength {
                expected: 1184,
                got: encapsulation_key_bytes.len(),
            })?;
        let ek = MlKem768EncapsulationKey::from_bytes(&array);
        let (ct, ss) = ek.encapsulate(&mut OsRng)
            .map_err(|_| CryptoError::KemEncapsulationFailed)?;

        Ok((ct.as_slice().to_vec(), ss.into()))
    }

    pub fn decapsulate(&self, ciphertext: &[u8]) -> Result<[u8; 32], CryptoError> {
        let dk_array = Array::try_from(self.decapsulation_key_bytes.as_slice())
            .map_err(|_| CryptoError::KemDecapsulationFailed)?;
        let dk = MlKem768DecapsulationKey::from_bytes(&dk_array);

        let ct_array: MlKem768Ciphertext = Array::try_from(ciphertext)
            .map_err(|_| CryptoError::InvalidKeyLength {
                expected: 1088,
                got: ciphertext.len(),
            })?;
        let ss = dk.decapsulate(&ct_array)
            .map_err(|_| CryptoError::KemDecapsulationFailed)?;

        Ok(ss.into())
    }
}

impl Zeroize for PqKeyPair {
    fn zeroize(&mut self) {
        self.decapsulation_key_bytes.zeroize();
    }
}

impl Drop for PqKeyPair {
    fn drop(&mut self) {
        self.zeroize();
    }
}

/// Signed pre-key (X25519 + Ed25519 signature)
#[derive(Clone, Serialize, Deserialize)]
pub struct SignedPreKey {
    pub key_id: u32,
    pub public_key: [u8; 32],    // X25519
    pub signature: Vec<u8>,       // Ed25519 sig over public_key
}

/// PQ pre-key (ML-KEM-768 + Ed25519 signature)
#[derive(Clone, Serialize, Deserialize)]
pub struct PqPreKey {
    pub key_id: u32,
    pub public_key: Vec<u8>,     // ML-KEM-768 encapsulation key (1184 bytes)
    pub signature: Vec<u8>,       // Ed25519 sig over public_key
}

/// One-time pre-key
#[derive(Clone, Serialize, Deserialize)]
pub struct OneTimePreKey {
    pub key_id: u32,
    pub public_key: [u8; 32],    // X25519
}

/// Complete PQXDH key bundle (published to server)
#[derive(Clone, Serialize, Deserialize)]
pub struct PreKeyBundle {
    pub identity_key: [u8; 32],          // Ed25519 verifying key
    pub identity_key_x25519: [u8; 32],   // X25519 public key (Bob's IK_B for DH)
    pub signed_pre_key: SignedPreKey,
    pub pq_pre_key: PqPreKey,
    pub one_time_pre_key: Option<OneTimePreKey>,
}
