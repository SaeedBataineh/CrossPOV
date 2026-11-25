//! Match data from the CrossPOV server.
//!
//! The app never talks to Riot or the game. While VALORANT is open it asks
//! the CrossPOV server for the user's latest match every 5 minutes, then
//! twice after the game closes (when the last match usually shows up). A
//! match id it hasn't seen means a match just ended; it's saved locally and
//! the UI is told. Few requests per player keeps the shared match-data limit
//! free for everyone.
//!
//! The shape mirrors `MatchSummary` in server/src/match.ts.

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{
    procs,
    settings::Settings,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchPlayer {
    pub puuid: String,
    pub name: String,
    pub tag: String,
    pub team: String,
    pub agent: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRound {
    pub index: u32,
    pub winner: Option<String>,
    pub start_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchKill {
    pub round: u32,
    pub at_ms: u64,
    pub in_round_ms: u64,
    pub killer: String,
    pub victim: String,
    pub weapon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchTeam {
    pub id: String,
    pub won: bool,
    pub rounds_won: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub id: String,
    pub map: String,
    pub mode: String,
    pub region: String,
    pub started_at: String,
    pub length_ms: u64,
    pub teams: Vec<MatchTeam>,
    pub players: Vec<MatchPlayer>,
    pub rounds: Vec<MatchRound>,
    pub kills: Vec<MatchKill>,
}

#[derive(Deserialize)]
struct LatestResponse {
    #[serde(rename = "match")]
    match_: MatchSummary,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

/// Status shown in the UI.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchesStatus {
    /// When we last asked the server (ms since 1970).
    pub last_check_ms: Option<u64>,
    pub error: Option<String>,
    /// False until the user has entered their Riot ID.
    pub configured: bool,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Splits "Name#TAG" into its parts.
pub fn split_riot_id(riot_id: &str) -> Option<(String, String)> {
    let (name, tag) = riot_id.trim().rsplit_once('#')?;
    let (name, tag) = (name.trim(), tag.trim());
    (!name.is_empty() && !tag.is_empty()).then(|| (name.to_string(), tag.to_string()))
}

/// Asks the server for the user's latest match.
pub fn fetch_latest(server: &str, region: &str, riot_id: &str) -> Result<MatchSummary, String> {
    let (name, tag) = split_riot_id(riot_id).ok_or("Enter your Riot ID as Name#TAG in Settings.")?;
    // Windows' own TLS and certificate store; if the PC's DNS can't find the
    // server, the address is looked up over HTTPS instead (net.rs).
    let agent = crate::net::agent(
        ureq::Agent::config_builder()
            .tls_config(crate::net::tls())
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            // The server uses this to turn away out-of-date versions.
            .user_agent(crate::USER_AGENT)
            .build(),
    );
    let url = format!("{}/api/latest-match", server.trim_end_matches('/'));
    let mut res = agent
        .get(&url)
        .query("region", region)
        .query("name", &name)
        .query("tag", &tag)
        .call()
        .map_err(|e| crate::net_error(&e.to_string()))?;
    let status = res.status().as_u16();
    if status == 200 {
        let body: LatestResponse = res.body_mut().read_json().map_err(|e| format!("Unexpected answer from the server: {e}"))?;
        Ok(body.match_)
    } else {
        let msg = res
            .body_mut()
            .read_json::<ErrorResponse>()
            .map(|e| e.error)
            .unwrap_or_else(|_| format!("Server error ({status})"));
        Err(msg)
    }
}

/// Matches saved on disk, one JSON file each.
#[derive(Clone)]
pub struct MatchStore {
    dir: PathBuf,
}

const KEEP: usize = 50;

impl MatchStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, id: &str) -> PathBuf {
        // Ids come from the server; keep only safe characters for the file name.
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join(format!("{safe}.json"))
    }

    pub fn has(&self, id: &str) -> bool {
        self.path(id).is_file()
    }

    pub fn save(&self, m: &MatchSummary) -> Result<(), String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_vec(m).map_err(|e| e.to_string())?;
        fs::write(self.path(&m.id), json).map_err(|e| e.to_string())?;
        self.prune();
        Ok(())
    }

    /// Newest first.
    pub fn list(&self) -> Vec<MatchSummary> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        let mut out: Vec<MatchSummary> = entries
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| fs::read(e.path()).ok())
            .filter_map(|b| serde_json::from_slice(&b).ok())
            .collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    fn prune(&self) {
        for old in self.list().into_iter().skip(KEEP) {
            let _ = fs::remove_file(self.path(&old.id));
        }
    }
}

/// How often to ask while the game is open.
const IN_GAME_EVERY: Duration = Duration::from_secs(5 * 60);
/// After the game closes: one check soon, one a few minutes later (match data can lag).
const AFTER_CLOSE: [Duration; 2] = [Duration::from_secs(30), Duration::from_secs(5 * 60)];
const TICK: Duration = Duration::from_secs(15);

/// Whether to ask the server now. `failures` in a row stretch the wait (up to 4x),
/// so a busy server isn't hammered by every app at once.
fn check_due(game_running: bool, since_check: Option<Duration>, since_close: Option<Duration>, close_checks_done: usize, failures: u32) -> bool {
    let backoff = 1u32 << failures.min(2);
    if game_running {
        return since_check.is_none_or(|d| d >= IN_GAME_EVERY * backoff);
    }
    match (since_close, AFTER_CLOSE.get(close_checks_done)) {
        (Some(c), Some(&wait)) => c >= wait * backoff,
        _ => false,
    }
}

pub type MatchListener = Box<dyn Fn(MatchEvent) + Send + Sync>;

pub enum MatchEvent {
    Found(MatchSummary),
    Status(MatchesStatus),
}

#[derive(Clone)]
pub struct MatchWatcher {
    store: MatchStore,
    settings: Arc<Mutex<Settings>>,
    status: Arc<Mutex<MatchesStatus>>,
    listener: Arc<MatchListener>,
}

impl MatchWatcher {
    pub fn new(store: MatchStore, settings: Settings, listener: MatchListener) -> Self {
        let configured = split_riot_id(&settings.riot_id).is_some();
        Self {
            store,
            settings: Arc::new(Mutex::new(settings)),
            status: Arc::new(Mutex::new(MatchesStatus { configured, ..MatchesStatus::default() })),
            listener: Arc::new(listener),
        }
    }

    pub fn update_settings(&self, s: Settings) {
        let configured = split_riot_id(&s.riot_id).is_some();
        *self.settings.lock().unwrap_or_else(|e| e.into_inner()) = s;
        let status = {
            let mut st = self.status.lock().unwrap_or_else(|e| e.into_inner());
            st.configured = configured;
            st.clone()
        };
        (self.listener)(MatchEvent::Status(status));
    }

    pub fn status(&self) -> MatchesStatus {
        self.status.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn list(&self) -> Vec<MatchSummary> {
        self.store.list()
    }

    /// Asks the server now. Returns the latest match (new or already known).
    pub fn check_now(&self) -> Result<MatchSummary, String> {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let result = fetch_latest(&s.server_url, &s.region, &s.riot_id);
        let status = {
            let mut st = self.status.lock().unwrap_or_else(|e| e.into_inner());
            st.last_check_ms = Some(now_ms());
            st.error = result.as_ref().err().cloned();
            st.configured = split_riot_id(&s.riot_id).is_some();
            st.clone()
        };
        (self.listener)(MatchEvent::Status(status));
        let m = result?;
        if !self.store.has(&m.id) {
            self.store.save(&m)?;
            (self.listener)(MatchEvent::Found(m.clone()));
        }
        Ok(m)
    }

    pub fn spawn(&self) {
        let me = self.clone();
        thread::Builder::new()
            .name("match-watcher".into())
            .spawn(move || crate::keep_running(|| me.run()))
            .expect("spawn match watcher");
    }

    fn run(&self) {
        let mut was_running = false;
        let mut closed_at: Option<Instant> = None;
        let mut close_checks = 0usize;
        let mut last_check: Option<Instant> = None;
        let mut failures = 0u32;
        loop {
            let running = procs::game_running();
            if running {
                closed_at = None;
            } else if was_running {
                closed_at = Some(Instant::now());
                close_checks = 0;
                failures = 0;
            }
            was_running = running;
            let configured = split_riot_id(&self.settings.lock().unwrap_or_else(|e| e.into_inner()).riot_id).is_some();
            let since_check = last_check.map(|t| t.elapsed());
            let since_close = closed_at.map(|t| t.elapsed());
            if configured && check_due(running, since_check, since_close, close_checks, failures) {
                last_check = Some(Instant::now());
                if !running {
                    close_checks += 1;
                }
                match self.check_now() {
                    Ok(_) => failures = 0,
                    Err(e) => {
                        failures += 1;
                        eprintln!("match check: {e}");
                    }
                }
            }
            thread::sleep(TICK);
        }
    }
}

/// The user's own player entry in a match. Used by streamer detection (step 4).
#[cfg_attr(not(test), allow(dead_code))]
pub fn find_me<'a>(m: &'a MatchSummary, riot_id: &str) -> Option<&'a MatchPlayer> {
    let (name, tag) = split_riot_id(riot_id)?;
    m.players.iter().find(|p| p.name.eq_ignore_ascii_case(&name) && p.tag.eq_ignore_ascii_case(&tag))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_every_5_minutes_in_game_then_twice_after() {
        let m = |x: u64| Some(Duration::from_secs(x * 60));
        let s = |x: u64| Some(Duration::from_secs(x));
        assert!(check_due(true, None, None, 0, 0), "first check right away");
        assert!(!check_due(true, m(4), None, 0, 0));
        assert!(check_due(true, m(5), None, 0, 0));
        assert!(!check_due(false, m(1), s(10), 0, 0), "not the instant it closes");
        assert!(check_due(false, m(1), s(30), 0, 0), "30 s after closing");
        assert!(!check_due(false, m(1), m(3), 1, 0));
        assert!(check_due(false, m(5), m(5), 1, 0), "once more after 5 min");
        assert!(!check_due(false, m(60), m(60), 2, 0), "then stops");
        assert!(!check_due(false, None, None, 0, 0), "game never ran: never asks");
        assert!(!check_due(true, m(5), None, 0, 1), "a failure doubles the wait");
        assert!(check_due(true, m(20), None, 0, 9), "at most 4x");
    }

    const SAMPLE: &str = r#"{"match":{"id":"0b6d5e1f-1a2b-4c3d-8e9f-0123456789ab","map":"Ascent","mode":"Competitive","region":"eu",
      "startedAt":"2026-11-24T19:00:00.000Z","lengthMs":2100000,
      "teams":[{"id":"Blue","won":true,"roundsWon":13}],
      "players":[{"puuid":"me","name":"Me","tag":"EUW","team":"Blue","agent":"Jett","kills":20,"deaths":12,"assists":4}],
      "rounds":[{"index":0,"winner":"Blue","startMs":5000},{"index":2,"winner":null,"startMs":null}],
      "kills":[{"round":0,"atMs":30000,"inRoundMs":25000,"killer":"me","victim":"st","weapon":null}]}}"#;

    #[test]
    fn reads_the_servers_format() {
        let r: LatestResponse = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(r.match_.map, "Ascent");
        assert_eq!(r.match_.kills[0].at_ms, 30_000);
        assert_eq!(r.match_.rounds[1].start_ms, None);
        assert_eq!(find_me(&r.match_, "me#euw").map(|p| p.agent.as_str()), Some("Jett"));
    }

    /// Talks to a real CrossPOV server when CROSSPOV_TEST_SERVER is set
    /// (e.g. `wrangler dev` on localhost). A made-up Riot ID must come back
    /// as the server's clear "not found" message.
    #[test]
    fn live_server_reports_unknown_riot_id() {
        let Ok(server) = std::env::var("CROSSPOV_TEST_SERVER") else { return };
        let err = fetch_latest(&server, "eu", "zzqqxxnotreal#Q9Z8").unwrap_err();
        assert!(err.contains("No matches found"), "{err}");
        let err = fetch_latest(&server, "mars", "a#b").unwrap_err();
        assert!(err.contains("Region"), "{err}");
    }

    #[test]
    fn splits_riot_ids() {
        assert_eq!(split_riot_id(" Some Player #EUW "), Some(("Some Player".into(), "EUW".into())));
        assert_eq!(split_riot_id("a#b#c"), Some(("a#b".into(), "c".into())));
        assert_eq!(split_riot_id("nohash"), None);
        assert_eq!(split_riot_id("#EUW"), None);
    }

    #[test]
    fn store_saves_lists_and_sanitises_ids() {
        let dir = std::env::temp_dir().join(format!("crosspov-matches-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = MatchStore::new(dir.clone());
        let mut m = serde_json::from_str::<LatestResponse>(SAMPLE).unwrap().match_;
        store.save(&m).unwrap();
        m.id = "../../evil".into();
        m.started_at = "2026-11-25T00:00:00Z".into();
        store.save(&m).unwrap();
        assert!(dir.join("evil.json").is_file(), "path characters are stripped");
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].started_at, "2026-11-25T00:00:00Z", "newest first");
        let _ = fs::remove_dir_all(dir);
    }
}
