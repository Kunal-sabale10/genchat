use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use wasm_bindgen::prelude::*;

use genchat_crypto::keys::{IdentityKeyPair, SignedPreKey, X25519KeyPair};
use genchat_crypto::pqxdh::{initiate_pqxdh, receive_pqxdh, PqxdhInitMessage, PreKeyBundle};
use genchat_crypto::ratchet::{EncryptedEnvelope, GenChatAccount, GenChatSession};
use genchat_crypto::sframe::SFrameTransformer;

mod types;
use types::*;

#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    // Initialization hook when wasm module is instantiated
}

/// Helper to decode 32-byte hex string
fn decode_32_hex(s: &str) -> Result<[u8; 32], JsValue> {
    let bytes = hex::decode(s).map_err(|e| JsValue::from_str(&format!("invalid hex: {}", e)))?;
    if bytes.len() != 32 {
        return Err(JsValue::from_str(&format!("expected 32 bytes hex, got {}", bytes.len())));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// 1. Generate full local PQXDH key bundles (Identity, Signed Pre-Key, Post-Quantum ML-KEM Pre-Key, One-Time Keys)
#[wasm_bindgen]
pub fn generate_pqxdh_keys(one_time_keys_count: usize) -> Result<JsValue, JsValue> {
    // 1. Identity keys
    let identity = IdentityKeyPair::generate();
    let identity_x25519 = X25519KeyPair::generate();

    // 2. Signed Pre-Key (X25519)
    let spk = SignedPreKey::generate(1, &identity);

    // 3. Post-Quantum Pre-Key (ML-KEM-768)
    let (pq_encaps, pq_decaps) = genchat_crypto::keys::generate_ml_kem_768_keypair();
    let pq_public_bytes = pq_encaps.as_bytes().to_vec();
    let pq_sig = identity.sign(&pq_public_bytes);

    // 4. One-Time Pre-Keys
    let mut wasm_otks = Vec::with_capacity(one_time_keys_count);
    let mut wasm_otk_pubs = Vec::with_capacity(one_time_keys_count);

    for i in 1..=(one_time_keys_count as u32) {
        let otk = X25519KeyPair::generate();
        wasm_otks.push(WasmOneTimePreKey {
            key_id: i,
            public_key_hex: hex::encode(otk.public_key_bytes()),
            private_key_hex: hex::encode(otk.secret_bytes()),
        });
        wasm_otk_pubs.push(WasmOneTimePublicKey {
            key_id: i,
            public_key_hex: hex::encode(otk.public_key_bytes()),
        });
    }

    let identity_bundle = WasmIdentityBundle {
        identity_key_ed25519_pub_hex: hex::encode(identity.verifying_key_bytes()),
        identity_key_ed25519_priv_hex: hex::encode(identity.signing_key_bytes()),
        identity_key_x25519_pub_hex: hex::encode(identity_x25519.public_key_bytes()),
        identity_key_x25519_priv_hex: hex::encode(identity_x25519.secret_bytes()),
        signed_pre_key: WasmSignedPreKey {
            key_id: spk.id,
            public_key_hex: hex::encode(spk.public_key),
            private_key_hex: hex::encode(spk.keypair.secret_bytes()),
            signature_hex: hex::encode(spk.signature),
        },
        pq_pre_key: WasmPqPreKey {
            key_id: 1,
            public_key_hex: hex::encode(&pq_public_bytes),
            decapsulation_key_hex: hex::encode(pq_decaps.as_bytes()),
            signature_hex: hex::encode(pq_sig.to_bytes()),
        },
        one_time_pre_keys: wasm_otks,
    };

    let public_bundle = WasmPublicPreKeyBundle {
        identity_key_hex: hex::encode(identity.verifying_key_bytes()),
        identity_key_x25519_hex: hex::encode(identity_x25519.public_key_bytes()),
        signed_pre_key_id: spk.id,
        signed_pre_key_public_hex: hex::encode(spk.public_key),
        signed_pre_key_signature_hex: hex::encode(spk.signature),
        pq_pre_key_id: 1,
        pq_pre_key_public_hex: hex::encode(&pq_public_bytes),
        pq_pre_key_signature_hex: hex::encode(pq_sig.to_bytes()),
        one_time_pre_keys: wasm_otk_pubs,
    };

    #[derive(serde::Serialize)]
    struct FullResult {
        identity_bundle: WasmIdentityBundle,
        public_bundle: WasmPublicPreKeyBundle,
    }

    serde_wasm_bindgen::to_value(&FullResult {
        identity_bundle,
        public_bundle,
    }).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 2. Initiate PQXDH Handshake (Alice $\to$ Bob)
#[wasm_bindgen]
pub fn initiate_pqxdh_handshake(
    alice_identity_bundle: JsValue,
    bob_public_bundle: JsValue,
) -> Result<JsValue, JsValue> {
    let alice: WasmIdentityBundle = serde_wasm_bindgen::from_value(alice_identity_bundle)
        .map_err(|e| JsValue::from_str(&format!("invalid alice bundle: {}", e)))?;
    let bob: WasmPublicPreKeyBundle = serde_wasm_bindgen::from_value(bob_public_bundle)
        .map_err(|e| JsValue::from_str(&format!("invalid bob bundle: {}", e)))?;

    // Reconstruct Alice's keys
    let alice_ed_priv = decode_32_hex(&alice.identity_key_ed25519_priv_hex)?;
    let alice_identity = IdentityKeyPair::from_bytes(&alice_ed_priv)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let alice_x_priv = decode_32_hex(&alice.identity_key_x25519_priv_hex)?;
    let alice_x25519 = X25519KeyPair::from_secret_bytes(&alice_x_priv);

    // Reconstruct Bob's bundle
    let bob_ed_pub = decode_32_hex(&bob.identity_key_hex)?;
    let bob_x_pub = decode_32_hex(&bob.identity_key_x25519_hex)?;
    let bob_spk_pub = decode_32_hex(&bob.signed_pre_key_public_hex)?;
    let bob_spk_sig = hex::decode(&bob.signed_pre_key_signature_hex)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bob_pq_pub = hex::decode(&bob.pq_pre_key_public_hex)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bob_pq_sig = hex::decode(&bob.pq_pre_key_signature_hex)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let bob_otk = if let Some(otk) = bob.one_time_pre_keys.first() {
        let otk_pub = decode_32_hex(&otk.public_key_hex)?;
        Some(genchat_crypto::keys::OneTimePreKey {
            id: otk.key_id,
            public_key: otk_pub,
            keypair: X25519KeyPair::generate(),
        })
    } else {
        None
    };

    let prekey_bundle = PreKeyBundle {
        identity_key: bob_ed_pub,
        identity_key_x25519: bob_x_pub,
        signed_pre_key: genchat_crypto::keys::SignedPreKeyBundle {
            id: bob.signed_pre_key_id,
            public_key: bob_spk_pub,
            signature: bob_spk_sig,
        },
        pq_pre_key: genchat_crypto::keys::PQPreKeyBundle {
            id: bob.pq_pre_key_id,
            public_key: bob_pq_pub,
            signature: bob_pq_sig,
        },
        one_time_pre_key: bob_otk,
    };

    let result = initiate_pqxdh(&alice_identity, &alice_x25519, &prekey_bundle)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let out = WasmHandshakeInitResult {
        shared_secret_hex: hex::encode(result.shared_secret),
        init_message: WasmPqxdhInitMessage {
            sender_identity_key_hex: hex::encode(result.init_message.sender_identity_key),
            sender_identity_key_x25519_hex: hex::encode(result.init_message.sender_identity_key_x25519),
            ephemeral_key_hex: hex::encode(result.init_message.ephemeral_key),
            pq_ciphertext_hex: hex::encode(result.init_message.pq_ciphertext),
            used_signed_pre_key_id: result.init_message.used_signed_pre_key_id,
            used_pq_pre_key_id: result.init_message.used_pq_pre_key_id,
            used_one_time_key_id: result.init_message.used_one_time_key_id,
        },
    };

    serde_wasm_bindgen::to_value(&out).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 3. Receive PQXDH Handshake (Bob $\leftarrow$ Alice)
#[wasm_bindgen]
pub fn receive_pqxdh_handshake(
    bob_identity_bundle: JsValue,
    alice_init_message: JsValue,
) -> Result<String, JsValue> {
    let bob: WasmIdentityBundle = serde_wasm_bindgen::from_value(bob_identity_bundle)
        .map_err(|e| JsValue::from_str(&format!("invalid bob bundle: {}", e)))?;
    let init_msg: WasmPqxdhInitMessage = serde_wasm_bindgen::from_value(alice_init_message)
        .map_err(|e| JsValue::from_str(&format!("invalid init message: {}", e)))?;

    let bob_ed_priv = decode_32_hex(&bob.identity_key_ed25519_priv_hex)?;
    let bob_identity = IdentityKeyPair::from_bytes(&bob_ed_priv)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let bob_spk_priv = decode_32_hex(&bob.signed_pre_key.private_key_hex)?;
    let bob_spk_keypair = X25519KeyPair::from_secret_bytes(&bob_spk_priv);

    let bob_pq_decaps_bytes = hex::decode(&bob.pq_pre_key.decapsulation_key_hex)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let bob_pq_decaps_key = genchat_crypto::keys::ml_kem_768_decapsulation_key_from_bytes(&bob_pq_decaps_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let bob_otk_keypair = if let Some(otk_id) = init_msg.used_one_time_key_id {
        bob.one_time_pre_keys.iter().find(|k| k.key_id == otk_id).and_then(|k| {
            decode_32_hex(&k.private_key_hex).ok().map(|b| X25519KeyPair::from_secret_bytes(&b))
        })
    } else {
        None
    };

    let alice_ed_pub = decode_32_hex(&init_msg.sender_identity_key_hex)?;
    let alice_x_pub = decode_32_hex(&init_msg.sender_identity_key_x25519_hex)?;
    let ephem_pub = decode_32_hex(&init_msg.ephemeral_key_hex)?;
    let pq_ct = hex::decode(&init_msg.pq_ciphertext_hex)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let native_init_msg = PqxdhInitMessage {
        sender_identity_key: alice_ed_pub,
        sender_identity_key_x25519: alice_x_pub,
        ephemeral_key: ephem_pub,
        pq_ciphertext: pq_ct,
        used_signed_pre_key_id: init_msg.used_signed_pre_key_id,
        used_pq_pre_key_id: init_msg.used_pq_pre_key_id,
        used_one_time_key_id: init_msg.used_one_time_key_id,
    };

    let shared_secret = receive_pqxdh(
        &bob_identity,
        &bob_spk_keypair,
        &bob_pq_decaps_key,
        bob_otk_keypair.as_ref(),
        &alice_ed_pub,
        &native_init_msg,
    ).map_err(|e| JsValue::from_str(&e.to_string()))?;

    Ok(hex::encode(shared_secret))
}

/// 4. Create new Ratchet Account
#[wasm_bindgen]
pub fn create_ratchet_account(pickle_key_hex: &str) -> Result<String, JsValue> {
    let pickle_key = decode_32_hex(pickle_key_hex)?;
    let account = GenChatAccount::new();
    Ok(account.pickle(&pickle_key))
}

/// 5. Encrypt message using Double Ratchet session state
#[wasm_bindgen]
pub fn encrypt_message(
    session_pickle: &str,
    pickle_key_hex: &str,
    plaintext: &[u8],
) -> Result<JsValue, JsValue> {
    let pickle_key = decode_32_hex(pickle_key_hex)?;
    let mut session = GenChatSession::from_pickle(session_pickle, &pickle_key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let envelope = session.encrypt(plaintext);
    let updated_pickle = session.pickle(&pickle_key);

    let res = WasmEncryptedPayload {
        message_type: envelope.message_type as usize,
        ciphertext_base64: BASE64.encode(&envelope.ciphertext),
        updated_session_pickle: updated_pickle,
    };

    serde_wasm_bindgen::to_value(&res).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 6. Decrypt message using Double Ratchet session state
#[wasm_bindgen]
pub fn decrypt_message(
    session_pickle: &str,
    pickle_key_hex: &str,
    message_type: usize,
    ciphertext_base64: &str,
) -> Result<JsValue, JsValue> {
    let pickle_key = decode_32_hex(pickle_key_hex)?;
    let mut session = GenChatSession::from_pickle(session_pickle, &pickle_key)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let raw_ct = BASE64.decode(ciphertext_base64)
        .map_err(|e| JsValue::from_str(&format!("invalid base64: {}", e)))?;

    let envelope = EncryptedEnvelope {
        message_type: message_type as u8,
        ciphertext: raw_ct,
    };

    let plaintext = session.decrypt(&envelope)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let updated_pickle = session.pickle(&pickle_key);

    let res = WasmDecryptedPayload {
        plaintext,
        updated_session_pickle: updated_pickle,
    };

    serde_wasm_bindgen::to_value(&res).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 7. SFrame WebRTC media frame encryption
#[wasm_bindgen]
pub fn sframe_encrypt(
    participant_key_id: u64,
    base_secret_hex: &str,
    frame_payload: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let secret = decode_32_hex(base_secret_hex)?;
    let mut sframe = SFrameTransformer::new(participant_key_id, secret)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    sframe.encrypt_frame(frame_payload)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}

/// 8. SFrame WebRTC media frame decryption
#[wasm_bindgen]
pub fn sframe_decrypt(
    participant_key_id: u64,
    base_secret_hex: &str,
    encrypted_frame: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let secret = decode_32_hex(base_secret_hex)?;
    let mut sframe = SFrameTransformer::new(participant_key_id, secret)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    sframe.decrypt_frame(encrypted_frame)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
