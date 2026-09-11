//! SHA-256 摘要（sha2 crate，RustCrypto）+ 小写 hex 编码：W2 三字段 revision 的
//! 内容指纹。统一由 Rust 侧计算并随 file.read / file.write / file.edit 响应
//! 返回，TS 侧只透传记录，避免跨语言哈希口径漂移。

use sha2::{Digest, Sha256};

pub fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_vectors() {
        // NIST 公开向量：空串与 "abc"。
        assert_eq!(
            hex_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            hex_digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn distinguishes_similar_inputs() {
        assert_ne!(hex_digest(b"hello"), hex_digest(b"hellO"));
        assert_ne!(hex_digest(b"hello"), hex_digest(b"hello\n"));
    }
}
