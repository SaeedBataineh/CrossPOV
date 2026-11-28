//! HTTPS clients for the app, with a DNS fallback.
//!
//! Some PCs can't look up crosspov.com: an internet provider, router or
//! security tool that blocks new domains, or a DNS server that's down
//! ("No such host is known", Windows errors 11001-11004). When Windows'
//! own lookup fails, the address is asked of Cloudflare's or Google's
//! DNS-over-HTTPS service instead, reached by IP address so it needs no
//! lookup itself. The connection is still made to the real site with its
//! real certificate checked, so a wrong answer can't be used to impersonate
//! it. Normal lookups are tried first and are used whenever they work.

use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use ureq::{
    config::Config,
    http::Uri,
    unversioned::{
        resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
        transport::{DefaultConnector, NextTimeout},
    },
};

/// DNS-over-HTTPS services, by IP address so they need no lookup.
const DOH: &[&str] = &["https://1.1.1.1/dns-query", "https://8.8.8.8/resolve"];
const CACHE_FOR: Duration = Duration::from_secs(10 * 60);

/// Windows' TLS and certificate store, like the rest of the app.
pub fn tls() -> ureq::tls::TlsConfig {
    ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build()
}

/// An agent for `config` that falls back to DNS-over-HTTPS when the PC's DNS fails.
pub fn agent(config: Config) -> ureq::Agent {
    ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        FallbackResolver::default(),
    )
}

#[derive(Debug, Default)]
pub struct FallbackResolver {
    system: DefaultResolver,
}

impl Resolver for FallbackResolver {
    fn resolve(
        &self,
        uri: &Uri,
        config: &Config,
        timeout: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let err = match self.system.resolve(uri, config, timeout) {
            Ok(addrs) => return Ok(addrs),
            Err(e) => e,
        };
        let Some(host) = uri.host().filter(|h| h.parse::<IpAddr>().is_err()) else {
            return Err(err);
        };
        let port = uri
            .port_u16()
            .unwrap_or(if uri.scheme_str() == Some("http") {
                80
            } else {
                443
            });
        let Some(ips) = lookup_over_https(host) else {
            return Err(err);
        };
        let mut out = self.empty();
        for ip in ips.into_iter().take(16) {
            out.push(SocketAddr::new(ip, port));
        }
        if out.is_empty() {
            Err(err)
        } else {
            Ok(out)
        }
    }
}

fn cache() -> &'static Mutex<HashMap<String, (Instant, Vec<IpAddr>)>> {
    static C: OnceLock<Mutex<HashMap<String, (Instant, Vec<IpAddr>)>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// IPv4 addresses of `host` from a DNS-over-HTTPS service, or None.
pub fn lookup_over_https(host: &str) -> Option<Vec<IpAddr>> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.len() > 253
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return None;
    }
    if let Some((at, ips)) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&host) {
        if at.elapsed() < CACHE_FOR {
            return Some(ips.clone());
        }
    }
    // A plain agent: these URLs are IP addresses, so no lookup is needed (and no recursion).
    let doh: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(tls())
        .timeout_global(Some(Duration::from_secs(8)))
        .user_agent(crate::USER_AGENT)
        .build()
        .into();
    for base in DOH {
        let Ok(mut res) = doh
            .get(*base)
            .query("name", &host)
            .query("type", "A")
            .header("accept", "application/dns-json")
            .call()
        else {
            continue;
        };
        let Ok(body) = res.body_mut().read_to_string() else {
            continue;
        };
        let ips = parse_dns_json(&body);
        if !ips.is_empty() {
            cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(host, (Instant::now(), ips.clone()));
            return Some(ips);
        }
    }
    None
}

/// The A records in a DNS JSON answer (Cloudflare's and Google's format).
fn parse_dns_json(body: &str) -> Vec<IpAddr> {
    #[derive(serde::Deserialize)]
    struct Answer {
        #[serde(rename = "type")]
        kind: u16,
        data: String,
    }
    #[derive(serde::Deserialize)]
    struct Reply {
        #[serde(rename = "Status", default)]
        status: u16,
        #[serde(rename = "Answer", default)]
        answer: Vec<Answer>,
    }
    let Ok(r) = serde_json::from_str::<Reply>(body) else {
        return Vec::new();
    };
    if r.status != 0 {
        return Vec::new();
    }
    r.answer
        .into_iter()
        .filter(|a| a.kind == 1)
        .filter_map(|a| a.data.parse().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dns_json_answers() {
        let body = r#"{"Status":0,"Answer":[{"name":"crosspov.com","type":5,"data":"x.example."},{"name":"crosspov.com","type":1,"TTL":300,"data":"104.21.49.137"},{"name":"crosspov.com","type":1,"data":"172.67.163.129"}]}"#;
        assert_eq!(
            parse_dns_json(body),
            vec![
                "104.21.49.137".parse::<IpAddr>().unwrap(),
                "172.67.163.129".parse().unwrap()
            ]
        );
        assert!(parse_dns_json(r#"{"Status":3}"#).is_empty(), "NXDOMAIN");
        assert!(parse_dns_json("not json").is_empty());
    }

    #[test]
    fn odd_host_names_are_never_looked_up() {
        assert!(lookup_over_https("bad host/../x").is_none());
        assert!(lookup_over_https("").is_none());
    }

    /// Real lookup through Cloudflare's DNS-over-HTTPS (run with --ignored).
    #[test]
    #[ignore]
    fn looks_up_crosspov_over_https() {
        let ips = lookup_over_https("crosspov.com").expect("answer");
        assert!(!ips.is_empty());
    }

    /// A host the PC can't resolve still connects when DNS-over-HTTPS knows it.
    #[test]
    #[ignore]
    fn falls_back_when_the_system_lookup_fails() {
        // ".invalid" never resolves through normal DNS; the fallback can't find it either, so this must fail cleanly.
        let a = agent(ureq::Agent::config_builder().tls_config(tls()).build());
        assert!(a.get("https://crosspov-test.invalid/").call().is_err());
    }
}
