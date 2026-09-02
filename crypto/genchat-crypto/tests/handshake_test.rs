use genchat_crypto::keys::{IdentityKeyPair, OneTimePreKey, PqKeyPair, PqPreKey, PreKeyBundle, SignedPreKey, X25519KeyPair};
use genchat_crypto::pqxdh::{initiate_pqxdh, respond_pqxdh};
use genchat_crypto::ratchet::GenChatAccount;
use vodozemac::olm::SessionConfig;

#[test]
fn test_alice_bob_pqxdh_handshake_and_ratchet_messaging() {
    // -------------------------------------------------------------
    // 1. Setup Bob's identity and published pre-key bundle
    // -------------------------------------------------------------
    let bob_identity = IdentityKeyPair::generate();
    let bob_x25519_identity = X25519KeyPair::generate();
    let bob_spk = X25519KeyPair::generate();
    let bob_pq_keypair = PqKeyPair::generate();
    let bob_otk = X25519KeyPair::generate();

    let spk_sig = bob_identity.sign(&bob_spk.public_key_bytes());
    let pq_sig = bob_identity.sign(&bob_pq_keypair.encapsulation_key_bytes);

    let bob_bundle = PreKeyBundle {
        identity_key: bob_identity.public_key_bytes(),
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
        one_time_pre_key: Some(OneTimePreKey {
            key_id: 1,
            public_key: bob_otk.public_key_bytes(),
        }),
    };

    // -------------------------------------------------------------
    // 2. Alice initiates PQXDH handshake using Bob's pre-key bundle
    // -------------------------------------------------------------
    let alice_identity = IdentityKeyPair::generate();
    let alice_x25519_identity = X25519KeyPair::generate();

    let alice_init = initiate_pqxdh(
        &alice_identity,
        &alice_x25519_identity,
        &bob_bundle,
    ).expect("Alice failed to initiate PQXDH handshake");

    // -------------------------------------------------------------
    // 3. Bob responds to PQXDH handshake
    // -------------------------------------------------------------
    let bob_respond = respond_pqxdh(
        &bob_identity,
        &bob_x25519_identity,
        &bob_spk,
        &bob_pq_keypair,
        Some(&bob_otk),
        &alice_init.init_message,
    ).expect("Bob failed to respond to PQXDH handshake");

    // -------------------------------------------------------------
    // 4. Verify shared secret and associated data match
    // -------------------------------------------------------------
    assert_eq!(
        alice_init.shared_secret, bob_respond.shared_secret,
        "Alice and Bob derived different PQXDH shared secrets!"
    );
    assert_eq!(
        alice_init.associated_data, bob_respond.associated_data,
        "Alice and Bob derived different associated data!"
    );

    // -------------------------------------------------------------
    // 5. Verify vodozemac Double Ratchet bidirectional messaging
    // -------------------------------------------------------------
    let mut alice_account = GenChatAccount::new();
    let mut bob_account = GenChatAccount::new();

    bob_account.generate_one_time_keys(1);
    let bob_otks = bob_account.one_time_keys();
    let (bob_otk_id, bob_otk_pk) = bob_otks.into_iter().next().expect("No OTK generated for Bob");
    let (bob_ik_curve, _) = bob_account.identity_keys();

    // Alice creates outbound session to Bob
    let mut alice_session = alice_account.create_outbound_session(
        SessionConfig::version_2(),
        bob_ik_curve,
        bob_otk_pk,
    );

    // Alice encrypts initial message (PreKeyMessage)
    let alice_msg_1 = b"Hello Bob, this is a post-quantum protected Double Ratchet session!";
    let envelope_1 = alice_session.encrypt(alice_msg_1);
    assert_eq!(envelope_1.message_type, 0, "Initial message must be PreKey type");

    // Bob creates inbound session from Alice's prekey message
    let (alice_ik_curve, _) = alice_account.identity_keys();
    let prekey_msg = vodozemac::olm::PreKeyMessage::from_bytes(&envelope_1.ciphertext)
        .expect("Failed to parse prekey message");
    let (mut bob_session, decrypted_1) = bob_account.create_inbound_session(
        alice_ik_curve,
        &prekey_msg,
    ).expect("Bob failed to create inbound session");

    assert_eq!(decrypted_1, alice_msg_1.to_vec());

    // Bob replies to Alice (Normal message)
    let bob_msg_1 = b"Hi Alice, I received your message and verified the ratchet!";
    let envelope_2 = bob_session.encrypt(bob_msg_1);
    let decrypted_2 = alice_session.decrypt(&envelope_2)
        .expect("Alice failed to decrypt Bob's message");

    assert_eq!(decrypted_2, bob_msg_1.to_vec());

    // Alice replies back
    let alice_msg_2 = b"Ratchet forward secrecy confirmed!";
    let envelope_3 = alice_session.encrypt(alice_msg_2);
    let decrypted_3 = bob_session.decrypt(&envelope_3)
        .expect("Bob failed to decrypt Alice's second message");

    assert_eq!(decrypted_3, alice_msg_2.to_vec());
}
