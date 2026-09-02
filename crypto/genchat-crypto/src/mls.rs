use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use crate::error::CryptoError;
use crate::keys::{IdentityKeyPair, X25519KeyPair};

/// Deterministic epoch secret derivation across all group members
fn derive_epoch_secrets(
    current_epoch_secret: &[u8; 32],
    epoch: u64,
    context_tag: &[u8],
) -> ([u8; 32], [u8; 32]) {
    let mut epoch_info = Vec::with_capacity(context_tag.len() + 8);
    epoch_info.extend_from_slice(context_tag);
    epoch_info.extend_from_slice(&epoch.to_be_bytes());

    let hk = Hkdf::<Sha256>::new(Some(current_epoch_secret), &epoch_info);
    
    let mut next_epoch_secret = [0u8; 32];
    hk.expand(b"genchat_mls_next_epoch", &mut next_epoch_secret)
        .expect("HKDF expand next_epoch failed");

    let mut next_app_secret = [0u8; 32];
    let hk_app = Hkdf::<Sha256>::new(None, &next_epoch_secret);
    hk_app.expand(b"genchat_mls_application_secret", &mut next_app_secret)
        .expect("HKDF expand app_secret failed");

    (next_epoch_secret, next_app_secret)
}

/// Key package published by a client device to allow others to add it to groups
#[derive(Clone, Serialize, Deserialize)]
pub struct MlsKeyPackage {
    pub user_id: String,
    pub device_id: String,
    pub identity_key: [u8; 32],      // Ed25519
    pub hpke_public_key: [u8; 32],   // X25519
    pub signature: Vec<u8>,
}

impl MlsKeyPackage {
    pub fn new(
        user_id: String,
        device_id: String,
        identity: &IdentityKeyPair,
        x25519_kp: &X25519KeyPair,
    ) -> Self {
        let hpke_pk = x25519_kp.public_key_bytes();
        let mut msg = Vec::new();
        msg.extend_from_slice(user_id.as_bytes());
        msg.extend_from_slice(device_id.as_bytes());
        msg.extend_from_slice(&hpke_pk);
        let sig = identity.sign(&msg);

        Self {
            user_id,
            device_id,
            identity_key: identity.public_key_bytes(),
            hpke_public_key: hpke_pk,
            signature: sig,
        }
    }

    pub fn verify(&self) -> Result<(), CryptoError> {
        let mut msg = Vec::new();
        msg.extend_from_slice(self.user_id.as_bytes());
        msg.extend_from_slice(self.device_id.as_bytes());
        msg.extend_from_slice(&self.hpke_public_key);

        let sig = ed25519_dalek::Signature::from_slice(&self.signature)
            .map_err(|_| CryptoError::InvalidSignature)?;
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&self.identity_key)
            .map_err(|_| CryptoError::InvalidSignature)?;
        
        use ed25519_dalek::Verifier;
        vk.verify(&msg, &sig)
            .map_err(|_| CryptoError::InvalidSignature)
    }
}

/// Leaf node in the MLS ratchet tree
#[derive(Clone, Serialize, Deserialize)]
pub struct MlsLeafNode {
    pub user_id: String,
    pub device_id: String,
    pub identity_key: [u8; 32],
    pub public_key: [u8; 32],
    pub is_blank: bool,
}

/// TreeKEM binary tree structure for MLS groups
#[derive(Clone, Serialize, Deserialize)]
pub struct TreeKemTree {
    pub leaves: Vec<MlsLeafNode>,
}

impl TreeKemTree {
    pub fn new() -> Self {
        Self {
            leaves: Vec::new(),
        }
    }

    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    pub fn find_leaf_by_user(&self, user_id: &str) -> Option<usize> {
        self.leaves.iter().position(|l| !l.is_blank && l.user_id == user_id)
    }

    pub fn add_leaf(&mut self, leaf: MlsLeafNode) -> usize {
        for (idx, existing) in self.leaves.iter_mut().enumerate() {
            if existing.is_blank {
                *existing = leaf;
                return idx;
            }
        }
        let idx = self.leaves.len();
        self.leaves.push(leaf);
        idx
    }

    pub fn blank_leaf(&mut self, leaf_idx: usize) {
        if leaf_idx < self.leaves.len() {
            self.leaves[leaf_idx].is_blank = true;
        }
    }

    pub fn active_members(&self) -> Vec<(usize, &MlsLeafNode)> {
        self.leaves
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.is_blank)
            .collect()
    }
}

/// Welcome message for a newly added group member
#[derive(Clone, Serialize, Deserialize)]
pub struct MlsWelcome {
    pub group_id: String,
    pub epoch: u64,
    pub encrypted_group_secrets: Vec<u8>, // Encrypted to new member's HPKE key
    pub tree: TreeKemTree,
    pub nonce: [u8; 12],
}

/// Commit message broadcast to update group epoch / membership
#[derive(Clone, Serialize, Deserialize)]
pub struct MlsCommit {
    pub group_id: String,
    pub epoch: u64,
    pub sender_leaf_index: usize,
    pub commit_tag: String,
    pub new_path_public_key: [u8; 32],
    pub confirmation_tag: [u8; 32],
}

/// Encrypted application message payload
#[derive(Clone, Serialize, Deserialize)]
pub struct MlsCiphertext {
    pub group_id: String,
    pub epoch: u64,
    pub sender_leaf_index: usize,
    pub generation: u32,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

/// Group state for an active MLS member (RFC 9420)
pub struct MlsGroup {
    pub group_id: String,
    pub epoch: u64,
    pub my_leaf_index: usize,
    pub my_identity: IdentityKeyPair,
    pub my_hpke_secret: StaticSecret,
    pub tree: TreeKemTree,
    pub epoch_secret: [u8; 32],
    pub application_secret: [u8; 32],
    pub message_generation: u32,
}

impl MlsGroup {
    /// Get current group epoch
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Create a new MLS group with the creator as the first member (epoch 0)
    pub fn create(
        group_id: String,
        user_id: String,
        device_id: String,
        identity: IdentityKeyPair,
        hpke_keypair: X25519KeyPair,
    ) -> Self {
        let mut tree = TreeKemTree::new();
        let my_leaf_idx = tree.add_leaf(MlsLeafNode {
            user_id,
            device_id,
            identity_key: identity.public_key_bytes(),
            public_key: hpke_keypair.public_key_bytes(),
            is_blank: false,
        });

        let mut initial_epoch_secret = [0u8; 32];
        OsRng.fill_bytes(&mut initial_epoch_secret);

        let (_, initial_app_secret) = derive_epoch_secrets(&initial_epoch_secret, 0, b"init");

        Self {
            group_id,
            epoch: 0,
            my_leaf_index: my_leaf_idx,
            my_identity: identity,
            my_hpke_secret: hpke_keypair.clone_secret(),
            tree,
            epoch_secret: initial_epoch_secret,
            application_secret: initial_app_secret,
            message_generation: 0,
        }
    }

    /// Add a new member to the group, generating Welcome and Commit messages
    pub fn add_member(
        &mut self,
        key_package: &MlsKeyPackage,
    ) -> Result<(MlsWelcome, MlsCommit), CryptoError> {
        key_package.verify()?;

        let new_leaf = MlsLeafNode {
            user_id: key_package.user_id.clone(),
            device_id: key_package.device_id.clone(),
            identity_key: key_package.identity_key,
            public_key: key_package.hpke_public_key,
            is_blank: false,
        };

        let new_leaf_idx = self.tree.add_leaf(new_leaf);
        let next_epoch = self.epoch + 1;

        // Derive next epoch secrets deterministically
        let (next_epoch_secret, next_app_secret) = derive_epoch_secrets(
            &self.epoch_secret,
            next_epoch,
            b"add_member",
        );

        // Encrypt group secrets for the new member using HPKE (X25519 + AES-GCM)
        let eph_secret = StaticSecret::random_from_rng(OsRng);
        let eph_pub = X25519PublicKey::from(&eph_secret);
        let recipient_pub = X25519PublicKey::from(key_package.hpke_public_key);
        let shared_dh = eph_secret.diffie_hellman(&recipient_pub);

        let hk = Hkdf::<Sha256>::new(None, shared_dh.as_bytes());
        let mut enc_key = [0u8; 32];
        hk.expand(b"MLS Welcome Enc", &mut enc_key)
            .map_err(|_| CryptoError::HkdfError)?;

        let cipher = Aes256Gcm::new_from_slice(&enc_key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        #[derive(Serialize)]
        struct WelcomePayload<'a> {
            epoch: u64,
            my_leaf_idx: usize,
            epoch_secret: &'a [u8; 32],
            application_secret: &'a [u8; 32],
        }

        let payload_struct = WelcomePayload {
            epoch: next_epoch,
            my_leaf_idx: new_leaf_idx,
            epoch_secret: &next_epoch_secret,
            application_secret: &next_app_secret,
        };

        let serialized_payload = serde_json::to_vec(&payload_struct)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;

        let encrypted = cipher.encrypt(nonce, serialized_payload.as_ref())
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let mut full_encrypted = Vec::with_capacity(32 + encrypted.len());
        full_encrypted.extend_from_slice(eph_pub.as_bytes());
        full_encrypted.extend_from_slice(&encrypted);

        let welcome = MlsWelcome {
            group_id: self.group_id.clone(),
            epoch: next_epoch,
            encrypted_group_secrets: full_encrypted,
            tree: self.tree.clone(),
            nonce: nonce_bytes,
        };

        let path_keypair = X25519KeyPair::generate();
        let commit = MlsCommit {
            group_id: self.group_id.clone(),
            epoch: next_epoch,
            sender_leaf_index: self.my_leaf_index,
            commit_tag: "add_member".to_string(),
            new_path_public_key: path_keypair.public_key_bytes(),
            confirmation_tag: [0u8; 32],
        };

        // Transition local group state to next epoch
        self.epoch = next_epoch;
        self.epoch_secret = next_epoch_secret;
        self.application_secret = next_app_secret;
        self.message_generation = 0;

        Ok((welcome, commit))
    }

    /// Join a group from a received MlsWelcome message
    pub fn from_welcome(
        welcome: &MlsWelcome,
        identity: IdentityKeyPair,
        my_hpke_secret: StaticSecret,
    ) -> Result<Self, CryptoError> {
        if welcome.encrypted_group_secrets.len() < 32 {
            return Err(CryptoError::DecryptionFailed("Welcome payload too short".into()));
        }

        let eph_pub_bytes: [u8; 32] = welcome.encrypted_group_secrets[..32]
            .try_into()
            .map_err(|_| CryptoError::DecryptionFailed("Invalid ephemeral key length".into()))?;
        let eph_pub = X25519PublicKey::from(eph_pub_bytes);
        let ciphertext = &welcome.encrypted_group_secrets[32..];

        let shared_dh = my_hpke_secret.diffie_hellman(&eph_pub);
        let hk = Hkdf::<Sha256>::new(None, shared_dh.as_bytes());
        let mut enc_key = [0u8; 32];
        hk.expand(b"MLS Welcome Enc", &mut enc_key)
            .map_err(|_| CryptoError::HkdfError)?;

        let cipher = Aes256Gcm::new_from_slice(&enc_key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;
        let nonce = Nonce::from_slice(&welcome.nonce);

        let plaintext = cipher.decrypt(nonce, ciphertext)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        #[derive(Deserialize)]
        struct WelcomePayload {
            epoch: u64,
            my_leaf_idx: usize,
            epoch_secret: [u8; 32],
            application_secret: [u8; 32],
        }

        let payload: WelcomePayload = serde_json::from_slice(&plaintext)
            .map_err(|e| CryptoError::SerializationError(e.to_string()))?;

        Ok(Self {
            group_id: welcome.group_id.clone(),
            epoch: payload.epoch,
            my_leaf_index: payload.my_leaf_idx,
            my_identity: identity,
            my_hpke_secret,
            tree: welcome.tree.clone(),
            epoch_secret: payload.epoch_secret,
            application_secret: payload.application_secret,
            message_generation: 0,
        })
    }

    /// Apply an incoming Commit message from an existing member to advance epoch
    pub fn apply_commit(&mut self, commit: &MlsCommit) -> Result<(), CryptoError> {
        if commit.epoch != self.epoch + 1 {
            return Err(CryptoError::InvalidEpoch {
                expected: self.epoch + 1,
                got: commit.epoch,
            });
        }

        let tag = if commit.commit_tag.is_empty() {
            b"add_member" as &[u8]
        } else {
            commit.commit_tag.as_bytes()
        };

        let (next_epoch_secret, next_app_secret) = derive_epoch_secrets(
            &self.epoch_secret,
            commit.epoch,
            tag,
        );

        self.epoch = commit.epoch;
        self.epoch_secret = next_epoch_secret;
        self.application_secret = next_app_secret;
        self.message_generation = 0;

        Ok(())
    }

    /// Alias for apply_commit
    pub fn process_commit(&mut self, commit: &MlsCommit) -> Result<(), CryptoError> {
        self.apply_commit(commit)
    }

    /// Remove a member from the group, re-keying the tree and advancing epoch
    pub fn remove_member(&mut self, user_id: &str) -> Result<MlsCommit, CryptoError> {
        let leaf_idx = self.tree.find_leaf_by_user(user_id)
            .ok_or_else(|| CryptoError::MemberNotFound(user_id.to_string()))?;

        self.tree.blank_leaf(leaf_idx);
        let next_epoch = self.epoch + 1;

        let (next_epoch_secret, next_app_secret) = derive_epoch_secrets(
            &self.epoch_secret,
            next_epoch,
            b"remove_member",
        );

        let path_keypair = X25519KeyPair::generate();
        let commit = MlsCommit {
            group_id: self.group_id.clone(),
            epoch: next_epoch,
            sender_leaf_index: self.my_leaf_index,
            commit_tag: "remove_member".to_string(),
            new_path_public_key: path_keypair.public_key_bytes(),
            confirmation_tag: [0u8; 32],
        };

        self.epoch = next_epoch;
        self.epoch_secret = next_epoch_secret;
        self.application_secret = next_app_secret;
        self.message_generation = 0;

        Ok(commit)
    }

    /// Encrypt an application message under the current epoch's application secret
    pub fn encrypt_message(&mut self, plaintext: &[u8]) -> Result<MlsCiphertext, CryptoError> {
        let gen = self.message_generation;
        self.message_generation += 1;

        // Derive generation key
        let mut ikm = Vec::with_capacity(36);
        ikm.extend_from_slice(&self.application_secret);
        ikm.extend_from_slice(&gen.to_be_bytes());

        let hk = Hkdf::<Sha256>::new(None, &ikm);
        let mut msg_key = [0u8; 32];
        hk.expand(b"MLS App Msg Key", &mut msg_key)
            .map_err(|_| CryptoError::HkdfError)?;

        // 12-byte Nonce: 4 bytes sender leaf index + 8 bytes sequence number (generation)
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[0..4].copy_from_slice(&(self.my_leaf_index as u32).to_be_bytes());
        nonce_bytes[4..12].copy_from_slice(&(gen as u64).to_be_bytes());
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&msg_key)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        let ad = format!("{}:{}:{}", self.group_id, self.epoch, gen);
        let payload = Payload {
            msg: plaintext,
            aad: ad.as_bytes(),
        };

        let ciphertext = cipher.encrypt(nonce, payload)
            .map_err(|e| CryptoError::EncryptionFailed(e.to_string()))?;

        Ok(MlsCiphertext {
            group_id: self.group_id.clone(),
            epoch: self.epoch,
            sender_leaf_index: self.my_leaf_index,
            generation: gen,
            nonce: nonce_bytes,
            ciphertext,
        })
    }

    /// Decrypt an application message from a group member
    pub fn decrypt_message(&self, msg: &MlsCiphertext) -> Result<Vec<u8>, CryptoError> {
        if msg.group_id != self.group_id {
            return Err(CryptoError::DecryptionFailed("Mismatched group ID".into()));
        }
        if msg.epoch != self.epoch {
            return Err(CryptoError::InvalidEpoch {
                expected: self.epoch,
                got: msg.epoch,
            });
        }

        let mut ikm = Vec::with_capacity(36);
        ikm.extend_from_slice(&self.application_secret);
        ikm.extend_from_slice(&msg.generation.to_be_bytes());

        let hk = Hkdf::<Sha256>::new(None, &ikm);
        let mut msg_key = [0u8; 32];
        hk.expand(b"MLS App Msg Key", &mut msg_key)
            .map_err(|_| CryptoError::HkdfError)?;

        // Reconstruct exact 12-byte Nonce
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[0..4].copy_from_slice(&(msg.sender_leaf_index as u32).to_be_bytes());
        nonce_bytes[4..12].copy_from_slice(&(msg.generation as u64).to_be_bytes());
        let nonce = Nonce::from_slice(&nonce_bytes);

        let cipher = Aes256Gcm::new_from_slice(&msg_key)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))?;

        let ad = format!("{}:{}:{}", self.group_id, self.epoch, msg.generation);
        let payload = Payload {
            msg: &msg.ciphertext,
            aad: ad.as_bytes(),
        };

        cipher.decrypt(nonce, payload)
            .map_err(|e| CryptoError::DecryptionFailed(e.to_string()))
    }
}
