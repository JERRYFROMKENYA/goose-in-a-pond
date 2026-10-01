//! Apple Music developer tokens. A MusicKit `.p8` key signs a short JWT (ES256) that every MusicKit
//! client presents; this is the one implementation of that, used by the pond (which signs with a key
//! its household pasted) and by the pondcredentials service (which signs with Jarida's).

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;

const PEM_BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
const PEM_END: &str = "-----END PRIVATE KEY-----";
const PEM_LINE_WIDTH: usize = 64;

/// Apple refuses a developer token that lives past about six months (15,777,000 seconds).
pub const APPLE_MAX_TTL: Duration = Duration::from_secs(15_777_000);

pub const KEY_NOT_PKCS8: &str = "The Apple Music private key must be the key from the .p8 file \
                                 Apple gave you (it starts with -----BEGIN PRIVATE KEY-----).";
pub const KEY_UNREADABLE: &str = "The Apple Music private key could not be read. Paste the whole \
                                  contents of the .p8 file again.";

/// Rebuilds a PKCS#8 PEM from a key in any whitespace form: a single-line input collapses the
/// newlines a PEM needs, and some people paste only the base64 body.
pub fn normalize_private_key(raw: &str) -> Result<String, &'static str> {
    let body: String = raw
        .replace(PEM_BEGIN, "")
        .replace(PEM_END, "")
        .replace("\\n", "")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if body.is_empty() {
        return Err(KEY_UNREADABLE);
    }
    // Standard base64 has no '-', so any left over is another PEM label, e.g. SEC1's.
    if body.contains('-') {
        return Err(KEY_NOT_PKCS8);
    }
    let der = STANDARD
        .decode(body.as_bytes())
        .map_err(|_| KEY_UNREADABLE)?;
    let canonical = STANDARD.encode(der);

    let mut pem = String::with_capacity(canonical.len() + canonical.len() / PEM_LINE_WIDTH + 64);
    pem.push_str(PEM_BEGIN);
    pem.push('\n');
    for line in canonical.as_bytes().chunks(PEM_LINE_WIDTH) {
        // Base64 output is ASCII, so every chunk boundary is a char boundary.
        pem.push_str(std::str::from_utf8(line).map_err(|_| KEY_UNREADABLE)?);
        pem.push('\n');
    }
    pem.push_str(PEM_END);
    pem.push('\n');
    Ok(pem)
}

#[derive(Serialize)]
struct DeveloperClaims<'a> {
    iss: &'a str,
    iat: u64,
    exp: u64,
}

/// The three things a developer token is signed with.
pub struct SigningCredentials {
    pub team_id: String,
    pub key_id: String,
    pub private_key: String,
}

impl SigningCredentials {
    /// An ES256 developer token issued at `issued_at` (unix seconds), with its `exp`. A `ttl` past
    /// Apple's ceiling is refused here rather than signed and rejected later, far from the cause.
    pub fn sign(&self, issued_at: u64, ttl: Duration) -> Result<(String, u64), String> {
        if ttl > APPLE_MAX_TTL {
            return Err(
                "Apple refuses a developer token that lives longer than six months.".into(),
            );
        }
        let pem = normalize_private_key(&self.private_key)?;
        let key = jsonwebtoken::EncodingKey::from_ec_pem(pem.as_bytes())
            .map_err(|_| KEY_UNREADABLE.to_string())?;
        let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256);
        header.typ = None;
        header.kid = Some(self.key_id.clone());
        let exp = issued_at + ttl.as_secs();
        let claims = DeveloperClaims {
            iss: &self.team_id,
            iat: issued_at,
            exp,
        };
        // A well-formed PKCS#8 of the wrong curve or a corrupt scalar only fails here.
        let token =
            jsonwebtoken::encode(&header, &claims, &key).map_err(|_| KEY_UNREADABLE.to_string())?;
        Ok((token, exp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    /// A fresh P-256 key per call, so no key material is ever committed.
    fn generated_key() -> (Vec<u8>, Vec<u8>) {
        let pair = EcdsaKeyPair::generate(&ECDSA_P256_SHA256_FIXED_SIGNING).unwrap();
        let pkcs8 = pair.to_pkcs8v1().unwrap().as_ref().to_vec();
        (pkcs8, pair.public_key().as_ref().to_vec())
    }

    fn pem_with_newlines(der: &[u8]) -> String {
        let body = STANDARD.encode(der);
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!("{PEM_BEGIN}\n{}\n{PEM_END}\n", lines.join("\n"))
    }

    fn credentials(private_key: String) -> SigningCredentials {
        SigningCredentials {
            team_id: "TEAMID1234".into(),
            key_id: "KEYID12345".into(),
            private_key,
        }
    }

    #[test]
    fn developer_token_verifies_against_the_public_key_with_apples_header_and_claims() {
        let (der, public) = generated_key();
        let issued_at = 1_790_000_000;
        let ttl = Duration::from_secs(7 * 24 * 60 * 60);
        let (token, exp) = credentials(pem_with_newlines(&der))
            .sign(issued_at, ttl)
            .unwrap();
        assert_eq!(exp, issued_at + 7 * 24 * 60 * 60);

        let header = jsonwebtoken::decode_header(&token).unwrap();
        assert_eq!(header.alg, jsonwebtoken::Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("KEYID12345"));

        let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        let decoded = jsonwebtoken::decode::<serde_json::Value>(
            &token,
            &jsonwebtoken::DecodingKey::from_ec_der(&public),
            &validation,
        )
        .expect("signature verifies with the matching public key");
        assert_eq!(decoded.claims["iss"], "TEAMID1234");
        assert_eq!(decoded.claims["iat"], issued_at);
        assert_eq!(decoded.claims["exp"], exp);

        let (_, other_public) = generated_key();
        assert!(
            jsonwebtoken::decode::<serde_json::Value>(
                &token,
                &jsonwebtoken::DecodingKey::from_ec_der(&other_public),
                &validation,
            )
            .is_err(),
            "a different key must not verify"
        );
    }

    #[test]
    fn a_ttl_past_apples_ceiling_is_refused_before_it_is_signed() {
        let (der, _) = generated_key();
        let creds = credentials(pem_with_newlines(&der));
        assert!(
            creds.sign(1, APPLE_MAX_TTL).is_ok(),
            "the ceiling itself is allowed"
        );
        let err = creds
            .sign(1, APPLE_MAX_TTL + Duration::from_secs(1))
            .unwrap_err();
        assert!(err.contains("six months"), "{err}");
    }

    #[test]
    fn a_pasted_key_is_accepted_in_every_whitespace_form() {
        let (der, _) = generated_key();
        let canonical = pem_with_newlines(&der);
        let collapsed = canonical.replace('\n', " ");
        let bare_body = STANDARD.encode(&der);
        let escaped = canonical.replace('\n', "\\n");

        for (form, input) in [
            ("PEM with newlines", canonical.as_str()),
            ("newlines collapsed to spaces", collapsed.as_str()),
            ("bare base64 body", bare_body.as_str()),
            ("JSON-escaped newlines", escaped.as_str()),
        ] {
            let pem =
                normalize_private_key(input).unwrap_or_else(|e| panic!("{form} was rejected: {e}"));
            assert_eq!(pem, canonical, "{form} must rebuild the same PEM");
            assert!(pem.lines().all(|l| l.len() <= 64));
            assert!(
                credentials(input.to_string())
                    .sign(1, Duration::from_secs(60))
                    .is_ok(),
                "{form} must sign"
            );
        }
    }

    #[test]
    fn garbage_and_wrong_key_shapes_are_rejected_with_actionable_text() {
        for garbage in [
            "",
            "   ",
            "not a key!!",
            "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
        ] {
            assert!(
                normalize_private_key(garbage).is_err(),
                "{garbage:?} accepted"
            );
        }
        assert_eq!(
            normalize_private_key(
                "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----"
            ),
            Err(KEY_NOT_PKCS8)
        );
        // Valid base64 that is not a key normalises, then fails at signing, not with a panic.
        let err = credentials(STANDARD.encode(b"definitely not a key"))
            .sign(1, Duration::from_secs(60))
            .unwrap_err();
        assert!(err.contains(".p8"), "got: {err}");
    }
}
