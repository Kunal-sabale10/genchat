use genchat_crypto::keys::{IdentityKeyPair, X25519KeyPair};
use genchat_crypto::mls::{MlsCiphertext, MlsCommit, MlsGroup, MlsKeyPackage};
use genchat_crypto::sframe::SFrameTransformer;

#[test]
fn test_fuzz_robustness_on_malformed_crypto_inputs() {
    let alice_identity = IdentityKeyPair::generate();
    let alice_hpke = X25519KeyPair::generate();

    let mut group = MlsGroup::create(
        "fuzz-room".into(),
        "alice-user".into(),
        "alice-device".into(),
        alice_identity,
        alice_hpke,
    );

    // 1. Fuzz MLS Decryption with Corrupted Ciphertexts
    let malformed_ciphertexts = vec![
        MlsCiphertext {
            group_id: "fuzz-room".into(),
            epoch: 0,
            sender_leaf_index: 0,
            generation: 0,
            nonce: [0u8; 12],
            ciphertext: vec![], // Empty payload
        },
        MlsCiphertext {
            group_id: "wrong-room".into(),
            epoch: 0,
            sender_leaf_index: 0,
            generation: 0,
            nonce: [0u8; 12],
            ciphertext: vec![0xDE, 0xAD, 0xBE, 0xEF],
        },
        MlsCiphertext {
            group_id: "fuzz-room".into(),
            epoch: 999, // Non-existent epoch
            sender_leaf_index: 0,
            generation: 0,
            nonce: [0u8; 12],
            ciphertext: vec![1, 2, 3, 4, 5, 6, 7, 8],
        },
    ];

    for (i, ct) in malformed_ciphertexts.iter().enumerate() {
        let res = group.decrypt_message(ct);
        assert!(
            res.is_err(),
            "Malformed ciphertext #{} must fail gracefully without panic",
            i
        );
    }

    // 2. Fuzz MLS Commit Processing
    let malformed_commit = MlsCommit {
        group_id: "fuzz-room".into(),
        epoch: 42, // Skipping epochs
        sender_leaf_index: 0,
        commit_tag: "fuzz".into(),
        new_path_public_key: [0u8; 32],
        confirmation_tag: [0u8; 32],
    };
    let commit_res = group.apply_commit(&malformed_commit);
    assert!(commit_res.is_err(), "Invalid commit epoch MUST return an error");

    // 3. Fuzz SFrame Decoder with Truncated & Corrupted Buffers
    let mut sframe = SFrameTransformer::new(999, [0xAA; 32])
        .expect("Failed to create SFrame transformer");

    let corrupted_buffers: Vec<Vec<u8>> = vec![
        vec![],                          // 0 bytes
        vec![0; 8],                      // Truncated header
        vec![0; 15],                     // 1 byte short of header
        vec![0; 16],                     // Empty payload
        vec![0xFF; 32],                  // Random bytes
    ];

    for (i, buf) in corrupted_buffers.iter().enumerate() {
        let dec_res = sframe.decrypt_frame(buf);
        assert!(
            dec_res.is_err(),
            "Corrupted SFrame buffer #{} must return error without panic",
            i
        );
    }

    // 4. Fuzz KeyPackage Verification with Tampered Signature
    let kp_tampered = MlsKeyPackage {
        user_id: "bob".into(),
        device_id: "bob-dev".into(),
        identity_key: [1u8; 32],
        hpke_public_key: [2u8; 32],
        signature: vec![0xFF; 64], // Invalid signature
    };
    let kp_res = kp_tampered.verify();
    assert!(kp_res.is_err(), "Tampered KeyPackage signature MUST fail verification");
}
