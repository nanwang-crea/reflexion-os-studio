use super::*;
use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
#[test]
fn imports_only_supported_synthetic_rows_from_readonly_snapshot() {
    let root = std::env::temp_dir().join(format!(
        "reflexion-synthetic-import-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let key = [7; 16];
    let encode = |value: &[u8]| {
        let mut encrypted = b"v10".to_vec();
        encrypted.extend(
            cbc::Encryptor::<aes::Aes128>::new((&key).into(), b"                ".into())
                .encrypt_padded_vec_mut::<Pkcs7>(value),
        );
        encrypted
    };
    let db = Connection::open(root.join("Login Data")).unwrap();
    db.execute_batch("CREATE TABLE logins(origin_url TEXT,username_value TEXT,password_value BLOB,blacklisted_by_user INTEGER);").unwrap();
    db.execute(
        "INSERT INTO logins VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![
            "https://example.test/login",
            "synthetic-user",
            encode(b"fixture-password")
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO logins VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![
            "http://example.test/login",
            "synthetic-user",
            encode(b"fixture-password")
        ],
    )
    .unwrap();
    let mut skipped = 0;
    let entries = passwords(&root, &key, &mut skipped).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(skipped, 1);
    assert_eq!(entries[0].origin, "https://example.test");
    assert_eq!(entries[0].password, "fixture-password");
    assert!(database(&root, Path::new("../outside")).is_err());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn cookie_snapshot_checks_host_binding_and_skips_partitioned_and_expired_rows() {
    use sha2::{Digest, Sha256};
    let root = std::env::temp_dir().join(format!(
        "reflexion-synthetic-cookies-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let db = Connection::open(root.join("Cookies")).unwrap();
    db.execute_batch("CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES ('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT);").unwrap();
    let key = [8; 16];
    let mut plain = Sha256::digest(b".example.test").to_vec();
    plain.extend_from_slice(b"synthetic-cookie");
    let mut encrypted = b"v10".to_vec();
    encrypted.extend(
        cbc::Encryptor::<aes::Aes128>::new((&key).into(), b"                ".into())
            .encrypt_padded_vec_mut::<Pkcs7>(&plain),
    );
    for (partition, expiry) in [("", 0i64), ("https://partition.test", 0), ("", 1)] {
        db.execute(
            "INSERT INTO cookies VALUES('.example.test','fixture','',?1,'/',?2,1,1,2,?3)",
            rusqlite::params![&encrypted, expiry, partition],
        )
        .unwrap();
    }
    let mut skipped = 0;
    let imported = cookies(&root, &key, &mut skipped).unwrap();
    assert_eq!(imported.len(), 1);
    assert_eq!(skipped, 2);
    assert_eq!(imported[0].value, "synthetic-cookie");
    assert_eq!(imported[0].same_site, "Strict");
    assert!(imported[0].secure && imported[0].http_only);
    db.execute("UPDATE cookies SET host_key = '.other.test' WHERE top_frame_site_key = '' AND expires_utc = 0", []).unwrap();
    assert!(cookies(&root, &key, &mut skipped).is_err());
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
