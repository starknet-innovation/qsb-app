use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use bdk_wallet::{
    KeychainKind, SignOptions, Wallet,
    bitcoin::{
        Amount, Network, OutPoint, Psbt, ScriptBuf, Sequence, Transaction, TxIn, TxOut, Witness,
        absolute::LockTime,
        bip32::{DerivationPath, Xpriv},
        consensus::serialize,
        hashes::{Hash, sha256},
        secp256k1::Secp256k1,
        transaction::Version,
    },
};
use rand::{RngCore, rngs::OsRng};
use security_framework::passwords::{get_generic_password, set_generic_password};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    str::FromStr,
};
use zeroize::Zeroizing;

const SERVICE: &str = "org.starknet.qsb.bdk-wallet.v1";
fn exclusive(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}
fn private_read(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && meta.permissions().mode() & 0o077 == 0,
        "Expected a private regular file"
    );
    ensure!(meta.len() <= 16384, "Wallet file exceeds limit");
    Ok(fs::read(path)?)
}
fn wallet(seed: &[u8]) -> Result<Wallet> {
    ensure!(seed.len() == 32, "Invalid seed length");
    let xprv = Xpriv::new_master(Network::Bitcoin, seed)?;
    let mut wallet = Wallet::create(
        format!("wpkh({xprv}/84h/0h/0h/0/*)"),
        format!("wpkh({xprv}/84h/0h/0h/1/*)"),
    )
    .network(Network::Bitcoin)
    .create_wallet_no_persist()?;
    wallet.reveal_next_address(KeychainKind::External);
    Ok(wallet)
}
fn info(seed: &[u8]) -> Result<serde_json::Value> {
    let wallet = wallet(seed)?;
    let secp = Secp256k1::new();
    let child = Xpriv::new_master(Network::Bitcoin, seed)?
        .derive_priv(&secp, &DerivationPath::from_str("m/84h/0h/0h/0/0")?)?;
    Ok(
        serde_json::json!({"network":"bitcoin", "address":wallet.peek_address(KeychainKind::External,0).address.to_string(), "publicKey":child.private_key.public_key(&secp).to_string(), "derivation":"m/84h/0h/0h/0/0"}),
    )
}
fn init(dir: &Path) -> Result<()> {
    // create_dir is intentionally exclusive: never replace an existing wallet.
    fs::create_dir(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    let mut seed = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(seed.as_mut());
    let mut credential = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(credential.as_mut());
    let encoded_credential = Zeroizing::new(STANDARD.encode(&credential[..]));
    let password = age::secrecy::SecretString::from(encoded_credential.to_string());
    let ciphertext = age::encrypt(&age::scrypt::Recipient::new(password.clone()), &seed[..])?;
    let account = info(&seed[..])?["address"]
        .as_str()
        .context("Missing address")?
        .to_owned();
    match get_generic_password(SERVICE, &account) {
        Err(e) if e.code() == -25300 => {} // errSecItemNotFound only
        _ => bail!("Keychain item exists or Keychain is unavailable"),
    }
    set_generic_password(SERVICE, &account, encoded_credential.as_bytes())?;
    exclusive(&dir.join("seed.age"), &ciphertext)?;
    exclusive(&dir.join("seed.backup.age"), &ciphertext)?;
    exclusive(
        &dir.join("wallet.json"),
        serde_json::to_vec_pretty(&info(&seed[..])?)?.as_slice(),
    )?;
    let reopened = unlock(dir, "seed.backup.age")?;
    ensure!(
        reopened.as_slice() == &seed[..],
        "Backup verification failed"
    );
    fs::File::open(dir)?.sync_all()?;
    println!("{}", info(reopened.as_slice())?);
    Ok(())
}
fn unlock(dir: &Path, filename: &str) -> Result<Zeroizing<Vec<u8>>> {
    let meta = fs::symlink_metadata(dir)?;
    ensure!(
        meta.is_dir() && meta.permissions().mode() & 0o077 == 0,
        "Expected a private wallet directory"
    );
    let public: serde_json::Value =
        serde_json::from_slice(&private_read(&dir.join("wallet.json"))?)?;
    let account = public["address"]
        .as_str()
        .context("Missing wallet address")?;
    let credential = Zeroizing::new(get_generic_password(SERVICE, account)?);
    let pass = age::secrecy::SecretString::from(
        String::from_utf8(credential.to_vec())
            .map_err(|_| anyhow::anyhow!("Invalid Keychain credential encoding"))?,
    );
    let seed = Zeroizing::new(age::decrypt(
        &age::scrypt::Identity::new(pass),
        &private_read(&dir.join(filename))?,
    )?);
    ensure!(
        info(seed.as_slice())? == public,
        "Encrypted wallet identity mismatch"
    );
    Ok(seed)
}
fn message_signature(seed: &[u8], message: &[u8]) -> Result<String> {
    ensure!(message.len() <= 16384, "Message exceeds limit");
    let wallet = wallet(seed)?;
    let script = wallet
        .peek_address(KeychainKind::External, 0)
        .address
        .script_pubkey();
    let tag = sha256::Hash::hash(b"BIP0322-signed-message");
    let mut payload = Vec::with_capacity(64 + message.len());
    payload.extend(tag.to_byte_array());
    payload.extend(tag.to_byte_array());
    payload.extend(message);
    let digest = sha256::Hash::hash(&payload);
    let mut script_sig = vec![0, 32];
    script_sig.extend(digest.to_byte_array());
    let to_spend = Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint::null(),
            script_sig: ScriptBuf::from_bytes(script_sig),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: script,
        }],
    };
    let to_sign = Transaction {
        version: Version(0),
        lock_time: LockTime::ZERO,
        input: vec![TxIn {
            previous_output: OutPoint {
                txid: to_spend.compute_txid(),
                vout: 0,
            },
            script_sig: ScriptBuf::new(),
            sequence: Sequence::ZERO,
            witness: Witness::new(),
        }],
        output: vec![TxOut {
            value: Amount::ZERO,
            script_pubkey: ScriptBuf::from_bytes(vec![0x6a]),
        }],
    };
    let mut psbt = Psbt::from_unsigned_tx(to_sign)?;
    psbt.inputs[0].witness_utxo = Some(to_spend.output[0].clone());
    psbt.inputs[0].non_witness_utxo = Some(to_spend);
    #[allow(deprecated)] // BDK's supported compatibility API enforces SignOptions.
    let complete = wallet.sign(&mut psbt, SignOptions::default())?;
    ensure!(complete, "BIP-322 signing incomplete");
    Ok(STANDARD.encode(serialize(
        psbt.inputs[0]
            .final_script_witness
            .as_ref()
            .context("Missing witness")?,
    )))
}
fn sign_deposit(seed: &[u8], request: &[u8]) -> Result<String> {
    let request: serde_json::Value = serde_json::from_slice(request)?;
    let encoded = request["psbt"].as_str().context("Missing PSBT")?;
    let mut psbt = Psbt::deserialize(&STANDARD.decode(encoded)?)?;
    ensure!(
        !psbt.inputs.is_empty() && psbt.inputs.len() <= 32,
        "Unsupported input count"
    );
    let txid = request["approvedUnsignedTxid"]
        .as_str()
        .context("Exact unsigned transaction approval required")?;
    ensure!(
        psbt.unsigned_tx.compute_txid().to_string() == txid,
        "Transaction approval mismatch"
    );
    let wallet = wallet(seed)?;
    let owned = wallet
        .peek_address(KeychainKind::External, 0)
        .address
        .script_pubkey();
    let mut total = 0u64;
    let selected: Vec<usize> = request["inputs"]
        .as_array()
        .context("Explicit input indices required")?
        .iter()
        .map(|n| {
            n.as_u64()
                .map(|n| n as usize)
                .context("Invalid input index")
        })
        .collect::<Result<_>>()?;
    ensure!(
        !selected.is_empty() && selected.iter().all(|i| *i < psbt.inputs.len()),
        "Invalid signing selection"
    );
    let original = psbt.clone();
    for (i, input) in psbt.inputs.iter().enumerate() {
        let prev = input
            .non_witness_utxo
            .as_ref()
            .context("Full previous transaction required")?;
        let outpoint = psbt.unsigned_tx.input[i].previous_output;
        ensure!(
            prev.compute_txid() == outpoint.txid,
            "Previous transaction identity mismatch"
        );
        let output = prev
            .output
            .get(outpoint.vout as usize)
            .context("Previous output missing")?;
        if selected.contains(&i) {
            ensure!(
                input.partial_sigs.is_empty()
                    && input.final_script_sig.is_none()
                    && input.final_script_witness.is_none(),
                "Selected input already contains authorization material"
            );
            ensure!(
                output.script_pubkey == owned && input.witness_utxo.as_ref() == Some(output),
                "Selected input is not this wallet's native P2WPKH output"
            );
        } else {
            ensure!(
                output.script_pubkey != owned,
                "Every owned input must be explicitly selected"
            );
        }
        ensure!(
            input.sighash_type.is_none() || input.sighash_type == Some(bitcoin_sighash_all()),
            "Only SIGHASH_ALL supported"
        );
        total = total
            .checked_add(output.value.to_sat())
            .context("Input amount overflow")?;
    }
    let outputs = psbt
        .unsigned_tx
        .output
        .iter()
        .try_fold(0u64, |a, o| a.checked_add(o.value.to_sat()))
        .context("Output amount overflow")?;
    let fee = total
        .checked_sub(outputs)
        .context("Outputs exceed inputs")?;
    ensure!(
        request["approvedFeeSats"].as_u64() == Some(fee),
        "Exact fee approval mismatch"
    );
    #[allow(deprecated)]
    wallet.sign(
        &mut psbt,
        SignOptions {
            try_finalize: false,
            ..Default::default()
        },
    )?;
    for i in 0..psbt.inputs.len() {
        if selected.contains(&i) {
            ensure!(
                !psbt.inputs[i].partial_sigs.is_empty(),
                "Selected input not signed"
            );
        } else {
            // Export no signatures or metadata for inputs outside the approved selection.
            psbt.inputs[i] = original.inputs[i].clone();
        }
    }
    ensure!(
        psbt.unsigned_tx == original.unsigned_tx,
        "Signer changed transaction"
    );
    Ok(STANDARD.encode(psbt.serialize()))
}
fn bitcoin_sighash_all() -> bdk_wallet::bitcoin::psbt::PsbtSighashType {
    bdk_wallet::bitcoin::sighash::EcdsaSighashType::All.into()
}
fn backup_passphrase() -> Result<age::secrecy::SecretString> {
    // Only a fixed UI program enters argv. Its hidden answer is captured here,
    // never inherited by the terminal, shell, logs or caller's stdout.
    fn prompt(label: &str) -> Result<Zeroizing<String>> {
        let program = format!(
            "text returned of (display dialog \"{label}\" default answer \"\" with hidden answer buttons {{\"Cancel\", \"OK\"}} default button \"OK\" with title \"QSB wallet encrypted backup\")"
        );
        let output = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(program)
            .output()?;
        ensure!(output.status.success(), "Backup password entry canceled");
        let mut value = Zeroizing::new(String::from_utf8(output.stdout)?);
        if value.ends_with('\n') {
            value.pop();
        }
        Ok(value)
    }
    let first = prompt(
        "Choose a recovery passphrase (at least 14 characters). Keep it offline; never send it to chat.",
    )?;
    ensure!(
        first.chars().count() >= 14,
        "Recovery passphrase needs at least 14 characters"
    );
    let second = prompt("Confirm the recovery passphrase")?;
    ensure!(*first == *second, "Recovery passphrases differ");
    Ok(age::secrecy::SecretString::from(first.to_string()))
}
fn recovery_backup(dir: &Path, from_stdin: bool) -> Result<()> {
    let seed = unlock(dir, "seed.age")?;
    ensure!(
        !dir.join("recovery.age").exists(),
        "Recovery backup already exists"
    );
    let pass = if from_stdin {
        let mut text = Zeroizing::new(String::new());
        std::io::stdin().take(1025).read_to_string(&mut text)?;
        ensure!(
            text.len() >= 14 && text.len() <= 1024,
            "Invalid recovery passphrase length"
        );
        age::secrecy::SecretString::from(text.to_string())
    } else {
        backup_passphrase()?
    };
    let encrypted = age::encrypt(&age::scrypt::Recipient::new(pass.clone()), &seed)?;
    exclusive(&dir.join("recovery.age"), &encrypted)?;
    let restored = Zeroizing::new(age::decrypt(
        &age::scrypt::Identity::new(pass),
        &private_read(&dir.join("recovery.age"))?,
    )?);
    ensure!(*restored == *seed, "Portable recovery verification failed");
    fs::File::open(dir)?.sync_all()?;
    println!(
        "Portable encrypted recovery backup verified. Keep recovery.age and its passphrase separately offline."
    );
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(
        args.len() == 3,
        "Usage: qsb-bdk-wallet <init|info|verify-backup|sign-message|sign-deposit> <wallet-directory>; signing requests come from stdin"
    );
    let dir = PathBuf::from(&args[2]);
    ensure!(dir.is_absolute(), "Use an absolute wallet path");
    match args[1].as_str() {
        "init" => init(&dir),
        "backup" => recovery_backup(&dir, false),
        "backup-stdin" => recovery_backup(&dir, true),
        "info" | "verify-backup" => {
            let seed = unlock(
                &dir,
                if args[1] == "verify-backup" {
                    "seed.backup.age"
                } else {
                    "seed.age"
                },
            )?;
            println!("{}", info(&seed)?);
            Ok(())
        }
        "sign-message" => {
            let mut message = Vec::new();
            std::io::stdin().take(16385).read_to_end(&mut message)?;
            let seed = unlock(&dir, "seed.age")?;
            println!("{}", message_signature(&seed, &message)?);
            Ok(())
        }
        "sign-deposit" => {
            let mut request = Vec::new();
            std::io::stdin()
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut request)?;
            ensure!(
                request.len() <= 4 * 1024 * 1024,
                "PSBT request exceeds limit"
            );
            let seed = unlock(&dir, "seed.age")?;
            println!("{}", sign_deposit(&seed, &request)?);
            Ok(())
        }
        _ => bail!("Unknown command; this CLI has no broadcast operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_fixture_signature() {
        let seed = [42u8; 32];
        println!("{}", info(&seed).unwrap());
        println!(
            "{}",
            message_signature(&seed, b"QSB public BIP-322 validation").unwrap()
        );
    }
    #[test]
    fn rejects_wrong_seed_size() {
        assert!(wallet(&[0u8; 31]).is_err());
    }
    #[test]
    fn approval_bound_mixed_input_signing() {
        let seed = [42u8; 32];
        let w = wallet(&seed).unwrap();
        let script = w
            .peek_address(KeychainKind::External, 0)
            .address
            .script_pubkey();
        let prev = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn::default()],
            output: vec![TxOut {
                value: Amount::from_sat(100_000),
                script_pubkey: script,
            }],
        };
        let foreign = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![TxIn::default()],
            output: vec![TxOut {
                value: Amount::from_sat(200_000),
                script_pubkey: ScriptBuf::from_bytes(vec![0x51]),
            }],
        };
        let tx = Transaction {
            version: Version::TWO,
            lock_time: LockTime::ZERO,
            input: vec![
                TxIn {
                    previous_output: OutPoint {
                        txid: prev.compute_txid(),
                        vout: 0,
                    },
                    ..TxIn::default()
                },
                TxIn {
                    previous_output: OutPoint {
                        txid: foreign.compute_txid(),
                        vout: 0,
                    },
                    ..TxIn::default()
                },
            ],
            output: vec![TxOut {
                value: Amount::from_sat(299_000),
                script_pubkey: ScriptBuf::from_bytes(vec![0x51]),
            }],
        };
        let mut psbt = Psbt::from_unsigned_tx(tx).unwrap();
        psbt.inputs[0].witness_utxo = Some(prev.output[0].clone());
        psbt.inputs[0].non_witness_utxo = Some(prev);
        psbt.inputs[1].non_witness_utxo = Some(foreign);
        let request = serde_json::json!({"psbt":STANDARD.encode(psbt.serialize()),"inputs":[0],"approvedUnsignedTxid":psbt.unsigned_tx.compute_txid().to_string(),"approvedFeeSats":1000});
        let encoded = sign_deposit(&seed, &serde_json::to_vec(&request).unwrap()).unwrap();
        let signed = Psbt::deserialize(&STANDARD.decode(encoded).unwrap()).unwrap();
        assert_eq!(signed.inputs[1], psbt.inputs[1]);
        let (public, signature) = signed.inputs[0].partial_sigs.iter().next().unwrap();
        let hash = bdk_wallet::bitcoin::sighash::SighashCache::new(&signed.unsigned_tx)
            .p2wpkh_signature_hash(
                0,
                &psbt.inputs[0].witness_utxo.as_ref().unwrap().script_pubkey,
                Amount::from_sat(100_000),
                bdk_wallet::bitcoin::sighash::EcdsaSighashType::All,
            )
            .unwrap();
        Secp256k1::verification_only()
            .verify_ecdsa(
                &bdk_wallet::bitcoin::secp256k1::Message::from_digest(hash.to_byte_array()),
                &signature.signature,
                &public.inner,
            )
            .unwrap();
        let mut already_signed = request.clone();
        already_signed["psbt"] = serde_json::json!(STANDARD.encode(signed.serialize()));
        assert!(sign_deposit(&seed, &serde_json::to_vec(&already_signed).unwrap()).is_err());
        for (field, value) in [
            ("approvedFeeSats", serde_json::json!(999)),
            ("approvedUnsignedTxid", serde_json::json!("00")),
            ("inputs", serde_json::json!([1])),
        ] {
            let mut invalid = request.clone();
            invalid[field] = value;
            assert!(sign_deposit(&seed, &serde_json::to_vec(&invalid).unwrap()).is_err());
        }
    }
    #[test]
    fn encrypted_seed_recovery_and_tamper() {
        let password = age::secrecy::SecretString::from("public-test-only-credential".to_owned());
        let encrypted =
            age::encrypt(&age::scrypt::Recipient::new(password.clone()), &[42u8; 32]).unwrap();
        assert_eq!(
            age::decrypt(&age::scrypt::Identity::new(password.clone()), &encrypted).unwrap(),
            [42u8; 32]
        );
        let mut corrupted = encrypted;
        let last = corrupted.len() - 1;
        corrupted[last] ^= 1;
        assert!(age::decrypt(&age::scrypt::Identity::new(password), &corrupted).is_err());
    }
}
