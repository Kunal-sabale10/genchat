use libc::{c_int, size_t};

/// Error codes returned by FFI functions
pub const GENCHAT_OK: c_int = 0;
pub const GENCHAT_ERR_NULL_PTR: c_int = -1;
#[allow(dead_code)]
pub const GENCHAT_ERR_INVALID_ARG: c_int = -2;
pub const GENCHAT_ERR_CRYPTO: c_int = -3;
#[allow(dead_code)]
pub const GENCHAT_ERR_ALLOC: c_int = -4;

/// C-compatible pre-key bundle for PQXDH
#[allow(dead_code)]
#[repr(C)]
pub struct CPreKeyBundle {
    pub identity_key: [u8; 32],
    pub signed_pre_key_id: u32,
    pub signed_pre_key: [u8; 32],
    pub signed_pre_key_sig: [u8; 64],
    pub pq_pre_key_id: u32,
    pub pq_pre_key: *const u8,     // Pointer to 1184-byte ML-KEM-768 encapsulation key
    pub pq_pre_key_len: size_t,
    pub pq_pre_key_sig: [u8; 64],
    pub has_one_time_key: c_int,   // 1 = yes, 0 = no
    pub one_time_key_id: u32,
    pub one_time_key: [u8; 32],
}

/// C-compatible PQXDH init message output
#[allow(dead_code)]
#[repr(C)]
pub struct CInitMessage {
    pub sender_identity_key: [u8; 32],
    pub ephemeral_key: [u8; 32],
    pub pq_ciphertext: *mut u8,    // Heap-allocated, caller must free via genchat_free
    pub pq_ciphertext_len: size_t,
    pub used_signed_pre_key_id: u32,
    pub used_pq_pre_key_id: u32,
    pub has_one_time_key_id: c_int,
    pub used_one_time_key_id: u32,
}

/// C-compatible encrypted envelope
#[allow(dead_code)]
#[repr(C)]
pub struct CEncryptedEnvelope {
    pub message_type: u8,
    pub ciphertext: *mut u8,
    pub ciphertext_len: size_t,
}
