use genchat_crypto::keys::{IdentityKeyPair, X25519KeyPair};
use genchat_crypto::mls::{MlsGroup, MlsKeyPackage};

#[test]
fn test_mls_3party_group_lifecycle_and_messaging() {
    // -------------------------------------------------------------
    // 1. Identities and Key Packages for Alice, Bob, and Charlie
    // -------------------------------------------------------------
    let alice_identity = IdentityKeyPair::generate();
    let alice_hpke = X25519KeyPair::generate();

    let bob_identity = IdentityKeyPair::generate();
    let bob_hpke = X25519KeyPair::generate();
    let bob_kp = MlsKeyPackage::new(
        "bob-user-id".into(),
        "bob-device-1".into(),
        &bob_identity,
        &bob_hpke,
    );

    let charlie_identity = IdentityKeyPair::generate();
    let charlie_hpke = X25519KeyPair::generate();
    let charlie_kp = MlsKeyPackage::new(
        "charlie-user-id".into(),
        "charlie-device-1".into(),
        &charlie_identity,
        &charlie_hpke,
    );

    // -------------------------------------------------------------
    // 2. Alice creates the group (Epoch 0)
    // -------------------------------------------------------------
    let mut alice_group = MlsGroup::create(
        "quantum-secure-room-1".into(),
        "alice-user-id".into(),
        "alice-device-1".into(),
        alice_identity,
        alice_hpke,
    );
    assert_eq!(alice_group.epoch, 0);

    // -------------------------------------------------------------
    // 3. Alice adds Bob to the group (Epoch 1)
    // -------------------------------------------------------------
    let (welcome_bob, commit_1) = alice_group.add_member(&bob_kp)
        .expect("Alice failed to add Bob");
    assert_eq!(alice_group.epoch, 1);

    // Bob joins from Welcome
    let mut bob_group = MlsGroup::from_welcome(
        &welcome_bob,
        bob_identity,
        bob_hpke.clone_secret(),
    ).expect("Bob failed to join group from Welcome");
    assert_eq!(bob_group.epoch, 1);

    // -------------------------------------------------------------
    // 4. Test Alice <-> Bob Group Messaging in Epoch 1
    // -------------------------------------------------------------
    let msg_1 = b"Welcome to the MLS encrypted group, Bob!";
    let ct_1 = alice_group.encrypt_message(msg_1)
        .expect("Alice encryption failed");
    let decrypted_by_bob_1 = bob_group.decrypt_message(&ct_1)
        .expect("Bob decryption failed");
    assert_eq!(decrypted_by_bob_1, msg_1.to_vec());

    let msg_2 = b"Thanks Alice! MLS TreeKEM encryption is operational.";
    let ct_2 = bob_group.encrypt_message(msg_2)
        .expect("Bob encryption failed");
    let decrypted_by_alice_2 = alice_group.decrypt_message(&ct_2)
        .expect("Alice decryption failed");
    assert_eq!(decrypted_by_alice_2, msg_2.to_vec());

    // -------------------------------------------------------------
    // 5. Alice adds Charlie to the group (Epoch 2)
    // -------------------------------------------------------------
    let (welcome_charlie, commit_2) = alice_group.add_member(&charlie_kp)
        .expect("Alice failed to add Charlie");
    assert_eq!(alice_group.epoch, 2);

    // Bob processes Commit 2 to advance to Epoch 2
    bob_group.apply_commit(&commit_2)
        .expect("Bob failed to apply Commit 2");
    assert_eq!(bob_group.epoch(), 2);

    // Charlie joins from Welcome
    let mut charlie_group = MlsGroup::from_welcome(
        &welcome_charlie,
        charlie_identity,
        charlie_hpke.clone_secret(),
    ).expect("Charlie failed to join from Welcome");
    assert_eq!(charlie_group.epoch(), 2);

    // Verify all 3 members are synchronized on Epoch 2
    assert_eq!(alice_group.epoch(), 2);
    assert_eq!(bob_group.epoch(), 2);
    assert_eq!(charlie_group.epoch(), 2);

    // -------------------------------------------------------------
    // 6. Charlie sends message in Epoch 2 -> Alice and Bob both decrypt
    // -------------------------------------------------------------
    let msg_3 = b"Hello everyone! Charlie has joined the MLS room.";
    let ct_3 = charlie_group.encrypt_message(msg_3)
        .expect("Charlie encryption failed");

    let dec_alice_3 = alice_group.decrypt_message(&ct_3)
        .expect("Alice failed to decrypt Charlie's message");
    let dec_bob_3 = bob_group.decrypt_message(&ct_3)
        .expect("Bob failed to decrypt Charlie's message");

    assert_eq!(dec_alice_3, msg_3.to_vec());
    assert_eq!(dec_bob_3, msg_3.to_vec());

    // -------------------------------------------------------------
    // 7. Alice removes Bob from the group (Epoch 3)
    // -------------------------------------------------------------
    let commit_3 = alice_group.remove_member("bob-user-id")
        .expect("Alice failed to remove Bob");
    assert_eq!(alice_group.epoch, 3);

    // Charlie processes Commit 3 to advance to Epoch 3
    charlie_group.process_commit(&commit_3)
        .expect("Charlie failed to process Commit 3");
    assert_eq!(charlie_group.epoch, 3);

    // -------------------------------------------------------------
    // 8. Post-Compromise / Forward Secrecy Check
    // Alice sends message in Epoch 3 -> Charlie decrypts, Bob fails!
    // -------------------------------------------------------------
    let msg_4 = b"Confidential message after Bob was removed.";
    let ct_4 = alice_group.encrypt_message(msg_4)
        .expect("Alice encryption failed");

    let dec_charlie_4 = charlie_group.decrypt_message(&ct_4)
        .expect("Charlie should decrypt Epoch 3 message");
    assert_eq!(dec_charlie_4, msg_4.to_vec());

    // Bob is still at Epoch 2 and cannot decrypt Epoch 3 message
    let bob_attempt = bob_group.decrypt_message(&ct_4);
    assert!(
        bob_attempt.is_err(),
        "Evicted member Bob MUST NOT be able to decrypt subsequent epoch messages!"
    );
}
