use genchat_crypto::keys::{IdentityKeyPair, PqKeyPair, PqPreKey, PreKeyBundle, SignedPreKey, X25519KeyPair};
use genchat_crypto::pqxdh::{initiate_pqxdh, respond_pqxdh};
use genchat_crypto::ratchet::{GenChatAccount, GenChatSession};
use genchat_crypto::sframe::SFrameTransformer;
use vodozemac::olm::SessionConfig;
use zeroize::Zeroize;

// =========================================================================
// 1. PQXDH Handshake & Prekey Tampering Tests
// =========================================================================

#[test]
fn test_adversarial_pqxdh_prekey_signature_tampering() {
    let bob_identity = IdentityKeyPair::generate();
    let bob_x25519_identity = X25519KeyPair::generate();
    let bob_spk = X25519KeyPair::generate();
    let bob_pq_keypair = PqKeyPair::generate();

    let mut spk_sig = bob_identity.sign(&bob_spk.public_key_bytes());
    // Corrupt Bob's SPK signature
    spk_sig[0] ^= 0xFF;

    let pq_sig = bob_identity.sign(&bob_pq_keypair.encapsulation_key_bytes);

    let bob_bundle = PreKeyBundle {
        identity_key: bob_identity.public_key_bytes(),
        identity_key_x25519: bob_x25519_identity.public_key_bytes(),
        signed_pre_key: SignedPreKey {
            key_id: 1,
            public_key: bob_spk.public_key_bytes(),
            signature: spk_sig,
        },
        pq_pre_key: PqPreKey {
            key_id: 1,
            public_key: bob_pq_keypair.encapsulation_key_bytes.clone(),
            signature: pq_sig,
        },
        one_time_pre_key: None,
    };

    let alice_identity = IdentityKeyPair::generate();
    let alice_x25519_identity = X25519KeyPair::generate();

    let result = initiate_pqxdh(&alice_identity, &alice_x25519_identity, &bob_bundle);
    assert!(
        result.is_err(),
        "PQXDH initiation MUST fail when Signed Pre-Key signature is forged/tampered!"
    );
}

#[test]
fn test_adversarial_pqxdh_pq_prekey_signature_tampering() {
    let bob_identity = IdentityKeyPair::generate();
    let bob_x25519_identity = X25519KeyPair::generate();
    let bob_spk = X25519KeyPair::generate();
    let bob_pq_keypair = PqKeyPair::generate();

    let spk_sig = bob_identity.sign(&bob_spk.public_key_bytes());
    let mut pq_sig = bob_identity.sign(&bob_pq_keypair.encapsulation_key_bytes);
    // Corrupt Bob's PQ pre-key signature
    pq_sig[5] ^= 0xAA;

    let bob_bundle = PreKeyBundle {
        identity_key: bob_identity.public_key_bytes(),
        identity_key_x25519: bob_x25519_identity.public_key_bytes(),
        signed_pre_key: SignedPreKey {
            key_id: 1,
            public_key: bob_spk.public_key_bytes(),
            signature: spk_sig,
        },
        pq_pre_key: PqPreKey {
            key_id: 1,
            public_key: bob_pq_keypair.encapsulation_key_bytes.clone(),
            signature: pq_sig,
        },
        one_time_pre_key: None,
    };

    let alice_identity = IdentityKeyPair::generate();
    let alice_x25519_identity = X25519KeyPair::generate();

    let result = initiate_pqxdh(&alice_identity, &alice_x25519_identity, &bob_bundle);
    assert!(
        result.is_err(),
        "PQXDH initiation MUST fail when ML-KEM-768 Pre-Key signature is forged/tampered!"
    );
}

#[test]
fn test_adversarial_pqxdh_ciphertext_tampering() {
    let bob_identity = IdentityKeyPair::generate();
    let bob_x25519_identity = X25519KeyPair::generate();
    let bob_spk = X25519KeyPair::generate();
    let bob_pq_keypair = PqKeyPair::generate();

    let spk_sig = bob_identity.sign(&bob_spk.public_key_bytes());
    let pq_sig = bob_identity.sign(&bob_pq_keypair.encapsulation_key_bytes);

    let bob_bundle = PreKeyBundle {
        identity_key: bob_identity.public_key_bytes(),
        identity_key_x25519: bob_x25519_identity.public_key_bytes(),
        signed_pre_key: SignedPreKey {
            key_id: 1,
            public_key: bob_spk.public_key_bytes(),
            signature: spk_sig,
        },
        pq_pre_key: PqPreKey {
            key_id: 1,
            public_key: bob_pq_keypair.encapsulation_key_bytes.clone(),
            signature: pq_sig,
        },
        one_time_pre_key: None,
    };

    let alice_identity = IdentityKeyPair::generate();
    let alice_x25519_identity = X25519KeyPair::generate();

    let alice_init = initiate_pqxdh(&alice_identity, &alice_x25519_identity, &bob_bundle)
        .expect("Valid initiation");

    // Tamper with ML-KEM encapsulation ciphertext transmitted over the wire
    let mut tampered_init = alice_init.init_message.clone();
    tampered_init.pq_ciphertext[10] ^= 0x55;

    let bob_result = respond_pqxdh(
        &bob_identity,
        &bob_x25519_identity,
        &bob_spk,
        &bob_pq_keypair,
        None,
        &tampered_init,
    );

    // ML-KEM implicit rejection / decapsulation mismatch ensures Bob derives a different secret
    if let Ok(bob_resp) = bob_result {
        assert_ne!(
            alice_init.shared_secret, bob_resp.shared_secret,
            "Tampered ML-KEM ciphertext MUST NOT produce matching shared secret!"
        );
    }
}

// =========================================================================
// 2. Double Ratchet Tamper Resistance & Post-Compromise Security (PCS)
// =========================================================================

#[test]
fn test_adversarial_ratchet_tampered_envelope() {
    let alice_account = GenChatAccount::new();
    let mut bob_account = GenChatAccount::new();

    bob_account.generate_one_time_keys(1);
    let (_bob_otk_id, bob_otk_pk) = bob_account.one_time_keys().into_iter().next().unwrap();
    let (bob_ik_curve, _) = bob_account.identity_keys();

    let mut alice_session = alice_account.create_outbound_session(
        SessionConfig::version_2(),
        bob_ik_curve,
        bob_otk_pk,
    );

    let msg = b"Top secret plaintext that must be protected";
    let mut envelope = alice_session.encrypt(msg);

    // Flip bit in ciphertext payload
    let last = envelope.ciphertext.len() - 1;
    envelope.ciphertext[last] ^= 0x01;

    let (alice_ik_curve, _) = alice_account.identity_keys();
    let prekey_msg = vodozemac::olm::PreKeyMessage::from_bytes(&envelope.ciphertext);
    if let Ok(parsed_prekey) = prekey_msg {
        let bob_result = bob_account.create_inbound_session(alice_ik_curve, &parsed_prekey);
        assert!(
            bob_result.is_err(),
            "Double Ratchet inbound session creation MUST fail on tampered ciphertext!"
        );
    }
}

#[test]
fn test_adversarial_ratchet_post_compromise_security() {
    let alice_account = GenChatAccount::new();
    let mut bob_account = GenChatAccount::new();

    bob_account.generate_one_time_keys(1);
    let (_, bob_otk_pk) = bob_account.one_time_keys().into_iter().next().unwrap();
    let (bob_ik_curve, _) = bob_account.identity_keys();

    let mut alice_session = alice_account.create_outbound_session(
        SessionConfig::version_2(),
        bob_ik_curve,
        bob_otk_pk,
    );

    // 1. Initial message exchange establishes bidirectional ratchet
    let env_1 = alice_session.encrypt(b"Epoch 0 Message");
    let (alice_ik_curve, _) = alice_account.identity_keys();
    let prekey_msg = vodozemac::olm::PreKeyMessage::from_bytes(&env_1.ciphertext).unwrap();
    let (mut bob_session, _) = bob_account.create_inbound_session(alice_ik_curve, &prekey_msg).unwrap();

    // 2. Clone/pickle session state to simulate compromise of ephemeral keys at step 1
    let pickle_key = [0x77u8; 32];
    let compromised_bob_pickle = bob_session.pickle(&pickle_key);

    // 3. Normal communication continues: Bob replies to Alice, Alice replies back (DH ratchet turns)
    let env_2 = bob_session.encrypt(b"Epoch 1 Reply");
    let _ = alice_session.decrypt(&env_2).unwrap();

    let env_3 = alice_session.encrypt(b"Epoch 2 Secret - PCS Healed Message");
    let decrypted_by_real_bob = bob_session.decrypt(&env_3).unwrap();
    assert_eq!(decrypted_by_real_bob, b"Epoch 2 Secret - PCS Healed Message".to_vec());

    // 4. Adversary using old compromised pickle tries to decrypt future message (Epoch 2)
    // Vodozemac sessions advance their internal DH state; the un-ratcheted old state cannot decrypt
    let mut stale_adversary_session = GenChatSession::from_pickle(&compromised_bob_pickle, &pickle_key).unwrap();
    let adversary_result = stale_adversary_session.decrypt(&env_3);
    assert!(
        adversary_result.is_err(),
        "Adversary possessing old session state MUST NOT be able to decrypt messages after DH ratchet turnover (PCS failure)!"
    );
}

// =========================================================================
// 3. SFrame Replay Window Boundary & Tampering
// =========================================================================

#[test]
fn test_adversarial_sframe_replay_window_boundary() {
    let key_id = 9999u64;
    let base_secret = [0x55u8; 32];

    let mut sender = SFrameTransformer::new(key_id, base_secret).unwrap();
    let mut receiver = SFrameTransformer::new(key_id, base_secret).unwrap();

    // Sender encrypts 150 consecutive frames
    let mut frames = Vec::new();
    for i in 0..150 {
        let payload = format!("frame-content-{}", i);
        let ct = sender.encrypt_frame(payload.as_bytes()).unwrap();
        frames.push(ct);
    }

    // Receiver processes frame 149 (advances highest counter to 149)
    let dec_latest = receiver.decrypt_frame(&frames[149]).unwrap();
    assert_eq!(dec_latest, b"frame-content-149".to_vec());

    // Frame 148 is within the 128-counter replay window (149 - 128 = 21) -> accepted
    let dec_near = receiver.decrypt_frame(&frames[148]);
    assert!(dec_near.is_ok(), "Frame within 128-window should be accepted");

    // Frame 10 is outside the 128-counter window (10 + 128 = 138 < 149) -> MUST be rejected
    let dec_stale = receiver.decrypt_frame(&frames[10]);
    assert!(
        dec_stale.is_err(),
        "Frame outside 128 sliding window MUST be rejected by SFrame replay check!"
    );
}

#[test]
fn test_adversarial_sframe_tampered_header_and_payload() {
    let key_id = 8888u64;
    let base_secret = [0x33u8; 32];

    let mut sender = SFrameTransformer::new(key_id, base_secret).unwrap();
    let mut receiver = SFrameTransformer::new(key_id, base_secret).unwrap();

    let ct = sender.encrypt_frame(b"sensitive-webrtc-stream").unwrap();

    // Tamper KeyID in SFrame header (first 8 bytes)
    let mut tampered_header = ct.clone();
    tampered_header[0] ^= 0x01;
    let res_header = receiver.decrypt_frame(&tampered_header);
    assert!(res_header.is_err(), "SFrame with tampered KeyID must fail authentication!");

    // Tamper ciphertext payload byte
    let mut tampered_payload = ct.clone();
    let mid = ct.len() / 2;
    tampered_payload[mid] ^= 0xAA;
    let res_payload = receiver.decrypt_frame(&tampered_payload);
    assert!(res_payload.is_err(), "SFrame with tampered ciphertext payload must fail authentication!");
}

// =========================================================================
// 4. Memory Zeroization Verification
// =========================================================================

#[test]
fn test_zeroization_on_drop_and_explicit_wipe() {
    // 1. Verify PqKeyPair zeroization
    let mut pq_keys = PqKeyPair::generate();
    assert!(!pq_keys.secret_bytes().iter().all(|&b| b == 0));
    pq_keys.zeroize();
    assert!(
        pq_keys.secret_bytes().iter().all(|&b| b == 0),
        "PqKeyPair decapsulation secret MUST be all zeroes after zeroize()"
    );

    // 2. Verify SFrameTransformer zeroization
    let mut sframe = SFrameTransformer::new(1234, [0x99u8; 32]).unwrap();
    assert_ne!(sframe.base_secret, [0u8; 32]);
    sframe.zeroize();
    assert_eq!(
        sframe.base_secret,
        [0u8; 32],
        "SFrameTransformer base_secret MUST be all zeroes after zeroize()"
    );
}
