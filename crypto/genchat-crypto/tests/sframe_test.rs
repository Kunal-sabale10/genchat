use genchat_crypto::sframe::SFrameTransformer;

#[test]
fn test_sframe_e2ee_frame_encryption_and_decryption() {
    let participant_key_id = 1001u64;
    let base_secret = [0x42u8; 32];

    let mut sender = SFrameTransformer::new(participant_key_id, base_secret)
        .expect("Failed to initialize sender SFrame transformer");
    let mut receiver = SFrameTransformer::new(participant_key_id, base_secret)
        .expect("Failed to initialize receiver SFrame transformer");

    // 1. Encrypt raw video RTP frame
    let raw_video_frame = b"VP8-RAW-VIDEO-PAYLOAD-KEYFRAME-DATA-1234567890";
    let encrypted_frame = sender.encrypt_frame(raw_video_frame)
        .expect("Failed to encrypt SFrame video frame");

    assert!(
        encrypted_frame.len() >= 16 + raw_video_frame.len(),
        "Encrypted frame must contain 16-byte SFrame header + ciphertext + AEAD tag"
    );

    // 2. Receiver decrypts frame
    let decrypted_frame = receiver.decrypt_frame(&encrypted_frame)
        .expect("Failed to decrypt SFrame video frame");
    assert_eq!(decrypted_frame, raw_video_frame.to_vec());

    // 3. Encrypt second audio frame
    let raw_audio_frame = b"OPUS-RAW-AUDIO-FRAME-PAYLOAD";
    let encrypted_audio = sender.encrypt_frame(raw_audio_frame)
        .expect("Failed to encrypt SFrame audio frame");

    let decrypted_audio = receiver.decrypt_frame(&encrypted_audio)
        .expect("Failed to decrypt SFrame audio frame");
    assert_eq!(decrypted_audio, raw_audio_frame.to_vec());

    // 4. Test tampering resistance
    let mut tampered_frame = encrypted_audio.clone();
    let last = tampered_frame.len() - 1;
    tampered_frame[last] ^= 0xFF; // Flip bit in AEAD tag

    let tamper_res = receiver.decrypt_frame(&tampered_frame);
    assert!(
        tamper_res.is_err(),
        "Tampered SFrame payload MUST fail authentication!"
    );
}
