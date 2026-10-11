use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub fn key(source: &str) -> Result<Zeroizing<[u8; 16]>, String> {
    let (service, account) = match source {
        "chrome" => ("Chrome Safe Storage", "Chrome"),
        "edge" => ("Microsoft Edge Safe Storage", "Microsoft Edge"),
        _ => return Err("不支持的来源浏览器".into()),
    };
    let password = Zeroizing::new(
        security_framework::passwords::get_generic_password(service, account)
            .map_err(|_| "系统钥匙串未允许访问来源浏览器密钥，请检查系统授权".to_string())?,
    );
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&password, b"saltysalt", 1003, key.as_mut());
    Ok(key)
}
pub fn decrypt(
    encrypted: &[u8],
    key: &[u8; 16],
    host: Option<&str>,
) -> Result<Zeroizing<String>, String> {
    if encrypted.len() > 1024 * 1024 {
        return Err("来源加密条目超过大小限制".into());
    }
    if !encrypted.starts_with(b"v10") {
        return Err("来源浏览器使用未支持的加密格式，已停止迁移".into());
    }
    let mut bytes = Zeroizing::new(
        cbc::Decryptor::<aes::Aes128>::new(key.into(), b"                ".into())
            .decrypt_padded_vec_mut::<Pkcs7>(&encrypted[3..])
            .map_err(|_| "来源数据解密失败，已停止迁移".to_string())?,
    );
    if let Some(host) = host {
        let digest = Sha256::digest(host.as_bytes());
        if !bytes.starts_with(&digest) {
            return Err("Cookie 域校验失败，已停止迁移".into());
        }
        bytes.drain(..32);
    }
    String::from_utf8(bytes.to_vec())
        .map(Zeroizing::new)
        .map_err(|_| "来源数据编码不受支持".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;
    #[test]
    fn decrypts_synthetic_values_and_checks_cookie_domain_binding() {
        let key = [42; 16];
        let mut plain = Sha256::digest(b"example.test").to_vec();
        plain.extend_from_slice(b"synthetic-cookie");
        let cipher = cbc::Encryptor::<aes::Aes128>::new((&key).into(), b"                ".into())
            .encrypt_padded_vec_mut::<Pkcs7>(&plain);
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(cipher);
        assert_eq!(
            decrypt(&encrypted, &key, Some("example.test"))
                .unwrap()
                .as_str(),
            "synthetic-cookie"
        );
        assert!(decrypt(&encrypted, &key, Some("other.test")).is_err());
        assert!(decrypt(b"v20invalid", &key, None).is_err());
        assert!(decrypt(b"v10bad-block", &key, None).is_err());
    }
}
