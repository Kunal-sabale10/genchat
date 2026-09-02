mod types;

use std::ptr;
use std::slice;
use libc::{c_int, size_t};

use genchat_crypto::keys::*;
use genchat_crypto::mls::*;
use genchat_crypto::ratchet::*;

use types::*;

// ============================================================
// Identity Key Pair
// ============================================================

/// Generate a new Ed25519 identity keypair.
#[no_mangle]
pub extern "C" fn genchat_identity_keypair_generate() -> *mut IdentityKeyPair {
    Box::into_raw(Box::new(IdentityKeyPair::generate()))
}

/// Copy the 32-byte public key into the provided buffer.
#[no_mangle]
pub extern "C" fn genchat_identity_keypair_public_key(
    kp: *const IdentityKeyPair,
    out: *mut u8,
) -> c_int {
    if kp.is_null() || out.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let kp = unsafe { &*kp };
    let pk = kp.public_key_bytes();
    unsafe { ptr::copy_nonoverlapping(pk.as_ptr(), out, 32); }
    GENCHAT_OK
}

/// Sign a message, writing the 64-byte signature to the output buffer.
#[no_mangle]
pub extern "C" fn genchat_identity_keypair_sign(
    kp: *const IdentityKeyPair,
    msg: *const u8,
    msg_len: size_t,
    out_sig: *mut u8,
) -> c_int {
    if kp.is_null() || msg.is_null() || out_sig.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let kp = unsafe { &*kp };
    let message = unsafe { slice::from_raw_parts(msg, msg_len) };
    let sig = kp.sign(message);
    if sig.len() != 64 {
        return GENCHAT_ERR_CRYPTO;
    }
    unsafe { ptr::copy_nonoverlapping(sig.as_ptr(), out_sig, 64); }
    GENCHAT_OK
}

/// Free an identity keypair.
#[no_mangle]
pub extern "C" fn genchat_identity_keypair_free(kp: *mut IdentityKeyPair) {
    if !kp.is_null() {
        unsafe { drop(Box::from_raw(kp)); }
    }
}

// ============================================================
// X25519 Key Pair
// ============================================================

#[no_mangle]
pub extern "C" fn genchat_x25519_keypair_generate() -> *mut X25519KeyPair {
    Box::into_raw(Box::new(X25519KeyPair::generate()))
}

#[no_mangle]
pub extern "C" fn genchat_x25519_keypair_public_key(
    kp: *const X25519KeyPair,
    out: *mut u8,
) -> c_int {
    if kp.is_null() || out.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let kp = unsafe { &*kp };
    let pk = kp.public_key_bytes();
    unsafe { ptr::copy_nonoverlapping(pk.as_ptr(), out, 32); }
    GENCHAT_OK
}

#[no_mangle]
pub extern "C" fn genchat_x25519_keypair_free(kp: *mut X25519KeyPair) {
    if !kp.is_null() {
        unsafe { drop(Box::from_raw(kp)); }
    }
}

// ============================================================
// PQ Key Pair (ML-KEM-768)
// ============================================================

#[no_mangle]
pub extern "C" fn genchat_pq_keypair_generate() -> *mut PqKeyPair {
    Box::into_raw(Box::new(PqKeyPair::generate()))
}

#[no_mangle]
pub extern "C" fn genchat_pq_keypair_encapsulation_key(
    kp: *const PqKeyPair,
    out: *mut u8,
    out_len: *mut size_t,
) -> c_int {
    if kp.is_null() || out.is_null() || out_len.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let kp = unsafe { &*kp };
    let ek = &kp.encapsulation_key_bytes;
    unsafe {
        ptr::copy_nonoverlapping(ek.as_ptr(), out, ek.len());
        *out_len = ek.len();
    }
    GENCHAT_OK
}

#[no_mangle]
pub extern "C" fn genchat_pq_keypair_free(kp: *mut PqKeyPair) {
    if !kp.is_null() {
        unsafe { drop(Box::from_raw(kp)); }
    }
}

// ============================================================
// Vodozemac Account
// ============================================================

#[no_mangle]
pub extern "C" fn genchat_account_new() -> *mut GenChatAccount {
    Box::into_raw(Box::new(GenChatAccount::new()))
}

#[no_mangle]
pub extern "C" fn genchat_account_generate_one_time_keys(
    account: *mut GenChatAccount,
    count: size_t,
) -> c_int {
    if account.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let account = unsafe { &mut *account };
    account.generate_one_time_keys(count);
    GENCHAT_OK
}

#[no_mangle]
pub extern "C" fn genchat_account_free(account: *mut GenChatAccount) {
    if !account.is_null() {
        unsafe { drop(Box::from_raw(account)); }
    }
}

// ============================================================
// Session Encrypt/Decrypt
// ============================================================

/// Encrypt plaintext, allocating output buffer.
/// Caller must free the output using genchat_free.
#[no_mangle]
pub extern "C" fn genchat_session_encrypt(
    session: *mut GenChatSession,
    plaintext: *const u8,
    plaintext_len: size_t,
    out_ciphertext: *mut *mut u8,
    out_len: *mut size_t,
    out_msg_type: *mut u8,
) -> c_int {
    if session.is_null() || plaintext.is_null() || out_ciphertext.is_null()
        || out_len.is_null() || out_msg_type.is_null()
    {
        return GENCHAT_ERR_NULL_PTR;
    }
    let session = unsafe { &mut *session };
    let pt = unsafe { slice::from_raw_parts(plaintext, plaintext_len) };
    let envelope = session.encrypt(pt);

    let mut ct = envelope.ciphertext.into_boxed_slice();
    unsafe {
        *out_msg_type = envelope.message_type;
        *out_len = ct.len();
        *out_ciphertext = ct.as_mut_ptr();
    }
    std::mem::forget(ct); // Caller owns the memory now
    GENCHAT_OK
}

/// Decrypt ciphertext, allocating output buffer.
/// Caller must free the output using genchat_free.
#[no_mangle]
pub extern "C" fn genchat_session_decrypt(
    session: *mut GenChatSession,
    msg_type: u8,
    ciphertext: *const u8,
    ciphertext_len: size_t,
    out_plaintext: *mut *mut u8,
    out_len: *mut size_t,
) -> c_int {
    if session.is_null() || ciphertext.is_null() || out_plaintext.is_null() || out_len.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let session = unsafe { &mut *session };
    let ct = unsafe { slice::from_raw_parts(ciphertext, ciphertext_len) };

    let envelope = genchat_crypto::ratchet::EncryptedEnvelope {
        message_type: msg_type,
        ciphertext: ct.to_vec(),
    };

    match session.decrypt(&envelope) {
        Ok(plaintext) => {
            let mut pt = plaintext.into_boxed_slice();
            unsafe {
                *out_len = pt.len();
                *out_plaintext = pt.as_mut_ptr();
            }
            std::mem::forget(pt);
            GENCHAT_OK
        }
        Err(_) => GENCHAT_ERR_CRYPTO,
    }
}

#[no_mangle]
pub extern "C" fn genchat_session_free(session: *mut GenChatSession) {
    if !session.is_null() {
        unsafe { drop(Box::from_raw(session)); }
    }
}

// ============================================================
// MLS Group Encryption (RFC 9420)
// ============================================================

/// Create a new MLS group with creator as first member.
#[no_mangle]
pub extern "C" fn genchat_mls_group_create(
    group_id: *const libc::c_char,
    user_id: *const libc::c_char,
    device_id: *const libc::c_char,
    identity: *const IdentityKeyPair,
    hpke_kp: *const X25519KeyPair,
) -> *mut MlsGroup {
    if group_id.is_null() || user_id.is_null() || device_id.is_null() || identity.is_null() || hpke_kp.is_null() {
        return ptr::null_mut();
    }
    let gid = unsafe { std::ffi::CStr::from_ptr(group_id).to_string_lossy().into_owned() };
    let uid = unsafe { std::ffi::CStr::from_ptr(user_id).to_string_lossy().into_owned() };
    let did = unsafe { std::ffi::CStr::from_ptr(device_id).to_string_lossy().into_owned() };
    let id_kp = unsafe { &*identity };
    let hpke = unsafe { &*hpke_kp };

    let group = MlsGroup::create(
        gid,
        uid,
        did,
        IdentityKeyPair::from_bytes(&id_kp.secret_key_bytes()).unwrap(),
        X25519KeyPair::from_secret_bytes(hpke.secret_bytes()),
    );
    Box::into_raw(Box::new(group))
}

/// Encrypt an application message for an MLS group.
#[no_mangle]
pub extern "C" fn genchat_mls_group_encrypt(
    group: *mut MlsGroup,
    plaintext: *const u8,
    plaintext_len: size_t,
    out_ciphertext: *mut *mut u8,
    out_len: *mut size_t,
) -> c_int {
    if group.is_null() || plaintext.is_null() || out_ciphertext.is_null() || out_len.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let group = unsafe { &mut *group };
    let pt = unsafe { slice::from_raw_parts(plaintext, plaintext_len) };

    match group.encrypt_message(pt) {
        Ok(ct) => {
            let serialized = serde_json::to_vec(&ct).map_err(|_| ()).unwrap();
            let mut boxed = serialized.into_boxed_slice();
            unsafe {
                *out_len = boxed.len();
                *out_ciphertext = boxed.as_mut_ptr();
            }
            std::mem::forget(boxed);
            GENCHAT_OK
        }
        Err(_) => GENCHAT_ERR_CRYPTO,
    }
}

/// Decrypt an MLS group message.
#[no_mangle]
pub extern "C" fn genchat_mls_group_decrypt(
    group: *const MlsGroup,
    ciphertext_json: *const u8,
    ciphertext_len: size_t,
    out_plaintext: *mut *mut u8,
    out_len: *mut size_t,
) -> c_int {
    if group.is_null() || ciphertext_json.is_null() || out_plaintext.is_null() || out_len.is_null() {
        return GENCHAT_ERR_NULL_PTR;
    }
    let group = unsafe { &*group };
    let raw = unsafe { slice::from_raw_parts(ciphertext_json, ciphertext_len) };

    let ct: MlsCiphertext = match serde_json::from_slice(raw) {
        Ok(c) => c,
        Err(_) => return GENCHAT_ERR_CRYPTO,
    };

    match group.decrypt_message(&ct) {
        Ok(pt) => {
            let mut boxed = pt.into_boxed_slice();
            unsafe {
                *out_len = boxed.len();
                *out_plaintext = boxed.as_mut_ptr();
            }
            std::mem::forget(boxed);
            GENCHAT_OK
        }
        Err(_) => GENCHAT_ERR_CRYPTO,
    }
}

/// Free an MLS group state.
#[no_mangle]
pub extern "C" fn genchat_mls_group_free(group: *mut MlsGroup) {
    if !group.is_null() {
        unsafe { drop(Box::from_raw(group)); }
    }
}

// ============================================================
// Memory Management
// ============================================================

/// Free memory allocated by genchat FFI functions.
#[no_mangle]
pub extern "C" fn genchat_free(ptr: *mut u8, len: size_t) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let _ = Vec::from_raw_parts(ptr, len, len);
        }
    }
}
