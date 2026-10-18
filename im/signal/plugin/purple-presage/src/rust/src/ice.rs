//! Fetch Signal's calling ICE/TURN relays (`GET /v2/calling/relays`) and turn them into the STUN/TURN
//! servers the signal_media libnice agent needs.
//!
//! Without these the agent only gathers `typ host` candidates on the tablet's private LAN IP, so a
//! remote peer on the internet can't reach it and the call sits on "Connecting" forever (Signal
//! relays all calls through its TURN servers for IP privacy). The servers are passed to the media
//! engine as `RELAY` lines ahead of `START` (see call_bridge.rs), and the engine wires them into the
//! nice agent via nice_agent_set_stun_server() / nice_agent_set_relay_info() (signal_media.c).

use presage::libsignal_service::configuration::Endpoint;
use presage::libsignal_service::push_service::HttpAuthOverride;
use presage::manager::Registered;
use presage::store::Store;
use presage::Manager;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IceKind {
    Stun,
    Turn,
}

#[derive(Clone, Debug)]
pub struct IceServer {
    pub kind: IceKind,
    pub host: String, // an IP address (from urlsWithIps) when available - libnice relay info wants IPs
    pub port: u16,
    pub transport: String, // "udp" | "tcp" | "tls"
    pub username: String,
    pub password: String,
}

#[derive(serde::Deserialize)]
struct RelaysResponse {
    #[serde(default)]
    relays: Vec<Relay>,
}

#[derive(serde::Deserialize)]
struct Relay {
    #[serde(default)]
    username: String,
    #[serde(default)]
    password: String,
    #[serde(default, rename = "urlsWithIps")]
    urls_with_ips: Vec<String>,
    #[serde(default)]
    urls: Vec<String>,
}

/// Parse a WebRTC ICE URL ("turn:1.2.3.4:80?transport=udp", "stun:1.2.3.4:3478") into an IceServer.
fn parse_ice_url(url: &str, username: &str, password: &str) -> Option<IceServer> {
    let (scheme, rest) = url.split_once(':')?;
    let kind = match scheme {
        "stun" | "stuns" => IceKind::Stun,
        "turn" | "turns" => IceKind::Turn,
        _ => return None,
    };
    // rest = "host:port" or "host:port?transport=udp"
    let (hostport, query) = match rest.split_once('?') {
        Some((hp, q)) => (hp, Some(q)),
        None => (rest, None),
    };
    // Skip IPv6 endpoints: the TouchPad has no IPv6, so an IPv6 TURN server ("[2a06:...]:80") never
    // resolves -> its libnice allocation fails and lingers ("alive TURN refreshes"), which can drag
    // the whole ICE component to FAILED even though the IPv4 relays work. Same workaround as the
    // WhatsApp/meowcaller path (engine.go: "IPv6 endpoints skipped"). urlsWithIps brackets IPv6.
    if hostport.starts_with('[') {
        return None;
    }
    // "host:port" -> both; bare "host" (e.g. Signal's `turn:141.101.90.1`) -> the standard STUN/TURN
    // port 3478. Dropping the port-less URL was a bug: that entry is the UDP TURN relay (transport=udp),
    // the ONLY path that reliably traverses NAT / WiFi AP client-isolation; without it we were left with
    // TCP/TLS TURN only, and calls failed whenever the direct peer-to-peer path was blocked.
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (hostport.to_string(), 3478u16),
    };
    let host = host.as_str();
    let transport = query
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("transport=")))
        .unwrap_or(if scheme.ends_with('s') { "tls" } else { "udp" })
        .to_string();
    Some(IceServer {
        kind,
        host: host.to_string(),
        port,
        transport,
        username: username.to_string(),
        password: password.to_string(),
    })
}

/// GET /v2/calling/relays with the account's identified credentials and flatten it to a STUN/TURN
/// list. Returns empty on any failure (the call still tries with host candidates; better than aborting).
pub async fn fetch_ice_servers<C: Store>(manager: &Manager<C, Registered>) -> Vec<IceServer> {
    let push = manager.webos_identified_push_service();
    let builder = match push.request(
        reqwest::Method::GET,
        Endpoint::Service {
            path: "/v2/calling/relays".into(),
        },
        HttpAuthOverride::NoOverride,
    ) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("ice: could not build /v2/calling/relays request: {e}");
            return Vec::new();
        }
    };
    // Hard timeout on the whole request: this runs INSIDE presage's single command/receive loop, so a
    // hanging relays fetch would wedge all Signal traffic and the call would never even spawn the
    // engine. Worst case we time out and place the call with host-only candidates (old behaviour).
    let fetch = async {
        let resp = builder.send().await.map_err(|e| format!("send: {e}"))?;
        let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
        Ok::<_, String>(bytes)
    };
    let bytes = match tokio::time::timeout(std::time::Duration::from_secs(5), fetch).await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            eprintln!("ice: GET /v2/calling/relays failed: {e}");
            return Vec::new();
        }
        Err(_) => {
            eprintln!("ice: GET /v2/calling/relays timed out (proceeding host-only)");
            return Vec::new();
        }
    };
    let parsed: RelaysResponse = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("ice: parsing relays JSON failed: {e}");
            return Vec::new();
        }
    };

    let mut servers = Vec::new();
    for relay in &parsed.relays {
        // Prefer urlsWithIps: libnice's set_relay_info/set_stun_server want an IP, not a hostname.
        let urls = if !relay.urls_with_ips.is_empty() {
            &relay.urls_with_ips
        } else {
            &relay.urls
        };
        // DIAG: dump the raw relay URLs so we can see whether Signal offers UDP TURN (needed for a
        // reliable relay path through AP client-isolation) or only TCP/TLS, and what we drop (IPv6).
        eprintln!("ice: relay urls_with_ips={:?} urls={:?}", relay.urls_with_ips, relay.urls);
        for u in urls {
            match parse_ice_url(u, &relay.username, &relay.password) {
                Some(s) => { eprintln!("ice:   USE {u} -> transport={}", s.transport); servers.push(s); }
                None    => eprintln!("ice:   SKIP {u} (ipv6 or unparseable)"),
            }
        }
    }
    // Prefer UDP TURN and drop the TCP/TLS duplicates for the same relay. All three transports point
    // at the SAME server and we only need one; applying all of them makes the engine run 3 simultaneous
    // TURN allocations (3 separate client sockets, one per transport), and that fd churn during
    // gathering was found (via forced libnice conncheck logging) to trigger a libnice bug where a UDP
    // socket recv spuriously fails with ENOTTY and gets PERMANENTLY detached from the event loop -
    // silently discarding every reply on it for the rest of the call. Cutting to one TURN allocation
    // removes most of that churn. Falls back to keeping TCP/TLS if no UDP TURN was offered at all
    // (some networks block UDP TURN outright), so relay capability is never lost, just de-duplicated.
    if servers.iter().any(|s| s.kind == IceKind::Turn && s.transport == "udp") {
        let before = servers.len();
        servers.retain(|s| s.kind != IceKind::Turn || s.transport == "udp");
        if servers.len() != before {
            eprintln!("ice: dropped {} non-UDP TURN duplicate(s) (UDP TURN already available)", before - servers.len());
        }
    }

    eprintln!(
        "ice: fetched {} STUN/TURN entries from {} relay(s)",
        servers.len(),
        parsed.relays.len()
    );
    servers
}
