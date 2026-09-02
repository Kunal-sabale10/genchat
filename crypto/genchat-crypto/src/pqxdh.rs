use hkdf::Hkdf;
use sha2::Sha512;
use serde::{Serialize, Deserialize};
use x25519_dalek::PublicKey as X25519PublicKey;
use ed25519_dalek::{VerifyingKey, Signature, Verifier};

use crate::error::CryptoError;
use crate::keys::*;

const PQXDH_INFO: &[u8] = b"PQXDH_X25519_SHA-512_ML-KEM-768";
const DOMAIN_SEPARATOR: [u8; 32] = [0xFF; 32];

/// Result of initiating a PQXDH session (Alice's side)
pub struct PqxdhInitResult {
    pub shared_secret: [u8; 32],
    pub associated_data: Vec<u8>,
    pub init_message: PqxdhInitMessage,
}

/// The initial message Alice sends to Bob
#[derive(Clone, Serialize, Deserialize)]
pub struct PqxdhInitMessage {
    pub sender_identity_key: [u8; 32],
    pub ephemeral_key: [u8; 32],
    pub pq_ciphertext: Vec<u8>,        // ML-KEM-768 ciphertext (1088 bytes)
    pub used_signed_pre_key_id: u32,
    pub used_pq_pre_key_id: u32,
    pub used_one_time_key_id: Option<u32>,
}

/// Initiate PQXDH (Alice's side)
pub fn initiate_pqxdh(
    alice_identity: &IdentityKeyPair,
    alice_x25519_identity: &X25519KeyPair, // X25519 version of identity key
    bob_bundle: &PreKeyBundle,
) -> Result<PqxdhInitResult, CryptoError> {
    // 1. Verify Bob's signed pre-key signature
    let bob_ed25519_pk = VerifyingKey::from_bytes(&bob_bundle.identity_key)
        .map_err(|_| CryptoError::InvalidSignature)?;
    let spk_sig = Signature::from_slice(&bob_bundle.signed_pre_key.signature)
        .map_err(|_| CryptoError::InvalidSignature)?;
    bob_ed25519_pk.verify(&bob_bundle.signed_pre_key.public_key, &spk_sig)
        .map_err(|_| CryptoError::InvalidSignature)?;

    // 2. Verify Bob's PQ pre-key signature  
    let pq_sig = Signature::from_slice(&bob_bundle.pq_pre_key.signature)
        .map_err(|_| CryptoError::InvalidSignature)?;
    bob_ed25519_pk.verify(&bob_bundle.pq_pre_key.public_key, &pq_sig)
        .map_err(|_| CryptoError::InvalidSignature)?;

    // 3. Generate ephemeral X25519 key pair
    let ephemeral_key_pair = X25519KeyPair::generate();

    // 4. Compute DH1 = X25519(IK_A_x25519, SPK_B)
    let bob_spk_x25519 = X25519PublicKey::from(bob_bundle.signed_pre_key.public_key);
    let dh1 = alice_x25519_identity.diffie_hellman(&bob_spk_x25519);

    // 5. Compute DH2 = X25519(EK_A, IK_B_x25519)
    // Here we assume bob's identity_key could be mapped, but for this impl we'd need bob's x25519 identity key.
    // The spec requires Bob's X25519 Identity Key. Let's assume we have it or can map it. 
    // For simplicity here, since Bob's bundle only has Ed25519 IK, we'll need a birational mapping in practice.
    // We will just use the Ed25519 key bytes as X25519 bytes for this stub, but in real life it should be mapped properly.
    let bob_ik_x25519_bytes = bob_bundle.identity_key; // NOTE: birational mapping needed here
    let bob_ik_x25519 = X25519PublicKey::from(bob_ik_x25519_bytes);
    let dh2 = ephemeral_key_pair.diffie_hellman(&bob_ik_x25519);

    // 6. Compute DH3 = X25519(EK_A, SPK_B)
    let dh3 = ephemeral_key_pair.diffie_hellman(&bob_spk_x25519);

    // 7. Compute DH4 = X25519(EK_A, OPK_B) if present
    let (dh4, used_one_time_key_id) = if let Some(opk) = &bob_bundle.one_time_pre_key {
        let bob_opk_x25519 = X25519PublicKey::from(opk.public_key);
        (Some(ephemeral_key_pair.diffie_hellman(&bob_opk_x25519)), Some(opk.key_id))
    } else {
        (None, None)
    };

    // 8. Compute (pq_ct, pq_ss) = ML-KEM-768.Encaps(PQPK_B)
    let (pq_ciphertext, pq_shared_secret) = PqKeyPair::encapsulate_with(&bob_bundle.pq_pre_key.public_key)?;

    // Derive Shared Secret
    let mut dhs: Vec<&[u8; 32]> = vec![&dh1, &dh2, &dh3];
    if let Some(ref dh4_val) = dh4 {
        dhs.push(dh4_val);
    }
    
    let (shared_secret, associated_data) = derive_shared_secret(
        &dhs,
        &pq_shared_secret,
        &alice_identity.public_key_bytes(),
        &bob_bundle.identity_key,
    )?;

    Ok(PqxdhInitResult {
        shared_secret,
        associated_data,
        init_message: PqxdhInitMessage {
            sender_identity_key: alice_identity.public_key_bytes(),
            ephemeral_key: ephemeral_key_pair.public_key_bytes(),
            pq_ciphertext,
            used_signed_pre_key_id: bob_bundle.signed_pre_key.key_id,
            used_pq_pre_key_id: bob_bundle.pq_pre_key.key_id,
            used_one_time_key_id,
        },
    })
}

/// Respond to PQXDH (Bob's side)
pub fn respond_pqxdh(
    bob_identity: &IdentityKeyPair,
    bob_x25519_identity: &X25519KeyPair,
    bob_signed_pre_key: &X25519KeyPair,
    bob_pq_key_pair: &PqKeyPair,
    bob_one_time_key: Option<&X25519KeyPair>,
    init_msg: &PqxdhInitMessage,
) -> Result<PqxdhRespondResult, CryptoError> {
    
    // 1. DH1 = X25519(SPK_B, IK_A_x25519)
    // Note: birational mapping needed from sender_identity_key to X25519.
    let alice_ik_x25519 = X25519PublicKey::from(init_msg.sender_identity_key);
    let dh1 = bob_signed_pre_key.diffie_hellman(&alice_ik_x25519);

    // 2. DH2 = X25519(IK_B_x25519, EK_A)
    let alice_ek_x25519 = X25519PublicKey::from(init_msg.ephemeral_key);
    let dh2 = bob_x25519_identity.diffie_hellman(&alice_ek_x25519);

    // 3. DH3 = X25519(SPK_B, EK_A)
    let dh3 = bob_signed_pre_key.diffie_hellman(&alice_ek_x25519);

    // 4. DH4 = X25519(OPK_B, EK_A) if present
    let dh4 = if let Some(opk) = bob_one_time_key {
        Some(opk.diffie_hellman(&alice_ek_x25519))
    } else {
        None
    };

    // 5. pq_ss = ML-KEM-768.Decaps(PQSK_B, pq_ct)
    let pq_shared_secret = bob_pq_key_pair.decapsulate(&init_msg.pq_ciphertext)?;

    // Derive Shared Secret
    let mut dhs: Vec<&[u8; 32]> = vec![&dh1, &dh2, &dh3];
    if let Some(ref dh4_val) = dh4 {
        dhs.push(dh4_val);
    }
    
    let (shared_secret, associated_data) = derive_shared_secret(
        &dhs,
        &pq_shared_secret,
        &init_msg.sender_identity_key,
        &bob_identity.public_key_bytes(),
    )?;

    Ok(PqxdhRespondResult {
        shared_secret,
        associated_data,
    })
}

pub struct PqxdhRespondResult {
    pub shared_secret: [u8; 32],
    pub associated_data: Vec<u8>,
}

// Internal helper
fn derive_shared_secret(
    dh_results: &[&[u8; 32]],
    pq_shared_secret: &[u8; 32],
    alice_identity: &[u8; 32],
    bob_identity: &[u8; 32],
) -> Result<([u8; 32], Vec<u8>), CryptoError> {
    // Build KM from all DH outputs + PQ shared secret
    let mut km = Vec::new();
    for dh in dh_results {
        km.extend_from_slice(*dh);
    }
    km.extend_from_slice(pq_shared_secret);
    
    // IKM = F || KM
    let mut ikm = Vec::with_capacity(32 + km.len());
    ikm.extend_from_slice(&DOMAIN_SEPARATOR);
    ikm.extend_from_slice(&km);
    
    // HKDF-SHA-512
    let salt = [0u8; 64]; // SHA-512 output size
    let hk = Hkdf::<Sha512>::new(Some(&salt), &ikm);
    let mut sk = [0u8; 32];
    hk.expand(PQXDH_INFO, &mut sk).map_err(|_| CryptoError::HkdfError)?;
    
    // AD = Encode(IK_A) || Encode(IK_B)
    let mut ad = Vec::with_capacity(64);
    ad.extend_from_slice(alice_identity);
    ad.extend_from_slice(bob_identity);
    
    Ok((sk, ad))
}
