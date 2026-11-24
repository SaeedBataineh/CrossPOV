//! Streamer clips: after a match, ask the server which players were live on
//! Twitch, work out the moments you fought each of them (from the kill
//! timestamps), and download just those seconds of their VOD with yt-dlp.
//!
//! VOD time of a moment = (match start - VOD start) + time into the match.
//! The server gives the first part as `offset_sec`.

use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{
    clips::{self, ClipInfo, ClipMeta, STREAMER_CLIPS},
    ffmpeg::{self, NoWindow},
    matches::{find_me, MatchStore, MatchSummary},
    procs::{self, Procs},
    settings::{DownloadQuality, Settings},
};

// ---------- server response ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub login: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vod {
    pub id: String,
    pub url: String,
    pub started_at: String,
    pub duration_sec: f64,
    pub offset_sec: f64,
    pub live: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamerHit {
    pub puuid: String,
    pub name: String,
    pub tag: String,
    pub channel: Channel,
    pub vod: Option<Vod>,
    pub live_game: Option<String>,
}

#[derive(Deserialize)]
struct StreamersResponse {
    streamers: Vec<StreamerHit>,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

fn agent() -> ureq::Agent {
    // Windows' own TLS and its own list of trusted certificate authorities, like a
    // browser. (ureq's default, Mozilla's list, can reject valid chains that
    // Windows builds to a different root.)
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    ureq::Agent::config_builder()
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        // The server uses this to turn away out-of-date versions.
        .user_agent(crate::USER_AGENT)
        .build()
        .into()
}

/// Asks the server which players in a match were streaming.
pub fn fetch_streamers(server: &str, m: &MatchSummary, me: Option<&str>) -> Result<Vec<StreamerHit>, String> {
    let url = format!("{}/api/match/{}/{}/streamers", server.trim_end_matches('/'), m.region, m.id);
    let mut req = agent().get(&url);
    if let Some(me) = me {
        req = req.query("me", me);
    }
    let mut res = req.call().map_err(|e| crate::net_error(&e.to_string()))?;
    let status = res.status().as_u16();
    if status == 200 {
        let body: StreamersResponse = res.body_mut().read_json().map_err(|e| format!("Unexpected answer from the server: {e}"))?;
        Ok(body.streamers)
    } else {
        Err(res.body_mut().read_json::<ErrorResponse>().map(|e| e.error).unwrap_or_else(|_| format!("Server error ({status})")))
    }
}

// ---------- moments ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Moment {
    KilledYou,
    YouKilled,
    Round,
}

impl Moment {
    pub fn label(self) -> &'static str {
        match self {
            Moment::KilledYou => "They killed you",
            Moment::YouKilled => "You killed them",
            Moment::Round => "Round you both played",
        }
    }
    fn slug(self) -> &'static str {
        match self {
            Moment::KilledYou => "killed-you",
            Moment::YouKilled => "you-killed",
            Moment::Round => "round",
        }
    }
}

/// A piece of the match to clip, in seconds from the match start.
#[derive(Debug, Clone, PartialEq)]
pub struct Window {
    pub start: f64,
    pub end: f64,
    pub round: u32,
    pub moment: Moment,
}

impl Window {
    /// Stable id so a window is only downloaded once.
    pub fn key(&self) -> String {
        format!("{}-{}-{}", self.round, self.moment.slug(), (self.start * 10.0).round() as i64)
    }
}

/// The moments between `me` and `them` worth clipping, per the user's settings.
/// Overlapping windows are merged.
pub fn fight_windows(m: &MatchSummary, me: &str, them: &str, s: &Settings) -> Vec<Window> {
    let (before, after) = (f64::from(s.seconds_before), f64::from(s.seconds_after));
    let mut out: Vec<Window> = Vec::new();
    if s.clip_whole_round {
        let mut rounds: Vec<u32> = m
            .kills
            .iter()
            .filter(|k| {
                (s.clip_you_killed && k.killer == me && k.victim == them)
                    || (s.clip_killed_you && k.killer == them && k.victim == me)
            })
            .map(|k| k.round)
            .collect();
        rounds.dedup();
        for r in rounds {
            let start = m.rounds.iter().find(|x| x.index == r).and_then(|x| x.start_ms);
            let next = m.rounds.iter().find(|x| x.index == r + 1).and_then(|x| x.start_ms);
            let last_kill = m.kills.iter().filter(|k| k.round == r).map(|k| k.at_ms).max();
            if let (Some(a), Some(b)) = (start, next.or(last_kill.map(|t| t + 5_000))) {
                out.push(Window { start: a as f64 / 1000.0, end: b as f64 / 1000.0, round: r, moment: Moment::Round });
            }
        }
        return out;
    }
    for k in &m.kills {
        let moment = if k.killer == them && k.victim == me && s.clip_killed_you {
            Moment::KilledYou
        } else if k.killer == me && k.victim == them && s.clip_you_killed {
            Moment::YouKilled
        } else {
            continue;
        };
        let t = k.at_ms as f64 / 1000.0;
        let w = Window { start: (t - before).max(0.0), end: t + after, round: k.round, moment };
        match out.last_mut() {
            Some(prev) if w.start <= prev.end => prev.end = prev.end.max(w.end),
            _ => out.push(w),
        }
    }
    out
}

// ---------- yt-dlp ----------

#[cfg(windows)]
const YTDLP_EXE: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const YTDLP_EXE: &str = "yt-dlp";

/// `CROSSPOV_YTDLP`, then next to the app, then PATH.
pub fn locate_ytdlp() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("CROSSPOV_YTDLP").map(PathBuf::from) {
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(p) = crate::tools::get(YTDLP_EXE) {
        return Some(p);
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let p = dir.join(YTDLP_EXE);
        if p.is_file() {
            return Some(p);
        }
    }
    ffmpeg::which(YTDLP_EXE)
}

pub fn ytdlp_args(vod_url: &str, from: f64, to: f64, quality: DownloadQuality, ffmpeg: &Path, out_stem: &Path) -> Vec<String> {
    let format = match quality {
        DownloadQuality::Source => "best",
        DownloadQuality::P1080 => "best[height<=1080]/best",
        DownloadQuality::P720 => "best[height<=720]/best",
    };
    vec![
        "--no-warnings".into(),
        "--quiet".into(),
        "--no-progress".into(),
        "--no-part".into(),
        "--no-playlist".into(),
        "--ffmpeg-location".into(),
        ffmpeg.to_string_lossy().into_owned(),
        "-f".into(),
        format.into(),
        "--download-sections".into(),
        format!("*{from:.1}-{to:.1}"),
        "--remux-video".into(),
        "mp4".into(),
        "-o".into(),
        format!("{}.%(ext)s", out_stem.to_string_lossy()),
        // "--": whatever comes next is a URL, never an option.
        "--".into(),
        vod_url.into(),
    ]
}

/// Only plain Twitch VOD links are downloaded, whatever the server says.
pub fn is_twitch_vod_url(url: &str) -> bool {
    url.strip_prefix("https://www.twitch.tv/videos/")
        .is_some_and(|id| !id.is_empty() && id.len() <= 20 && id.bytes().all(|b| b.is_ascii_digit()))
}

/// A channel name or match id made safe for a file name: letters, digits and _ only.
pub fn file_safe(s: &str, max: usize) -> String {
    let out: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(max).collect();
    if out.is_empty() { "unknown".into() } else { out }
}

#[derive(Debug, PartialEq)]
pub enum DownloadError {
    SubOnly,
    Gone,
    Other(String),
}

/// Reads yt-dlp's error text.
pub fn classify_error(stderr: &str) -> DownloadError {
    let s = stderr.to_lowercase();
    if s.contains("subscriber") || s.contains("sub-only") || s.contains("subs only") {
        DownloadError::SubOnly
    } else if s.contains("does not exist") || s.contains("404") || s.contains("not available") || s.contains("was deleted") {
        DownloadError::Gone
    } else {
        DownloadError::Other(stderr.trim().lines().last().unwrap_or("download failed").chars().take(300).collect())
    }
}

fn download(ytdlp: &Path, _ffmpeg: &Path, args: Vec<String>) -> Result<(), DownloadError> {
    let out = Command::new(ytdlp)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .no_window()
        .output()
        .map_err(|e| DownloadError::Other(format!("couldn't run yt-dlp: {e}")))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(classify_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

// ---------- state ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamerStatus {
    /// Found; clips are being downloaded or waiting for the VOD to catch up.
    Working,
    /// All fights saved.
    Clipped,
    /// Streamer found, but you never fought them.
    NoFights,
    /// They were live, but don't save VODs.
    NoVod,
    /// VOD is for subscribers only; skipped.
    SubOnly,
    /// VOD deleted or downloads keep failing.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    pub puuid: String,
    pub name: String,
    pub channel: Channel,
    pub vod: Option<Vod>,
    pub status: StreamerStatus,
    pub clips: u32,
    pub fights: u32,
    #[serde(default)]
    pub done: Vec<String>,
    #[serde(default)]
    pub failures: u32,
    pub message: Option<String>,
    /// Added by the user with "Played against a streamer it missed?".
    #[serde(default)]
    pub manual: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchStreamers {
    pub match_id: String,
    pub checked_ms: Option<u64>,
    pub error: Option<String>,
    pub players: Vec<PlayerState>,
    /// Nothing left to do for this match.
    pub finished: bool,
    /// How many times the server has been asked about this match.
    #[serde(default)]
    pub checks: u32,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Clone)]
pub struct StreamerStore {
    dir: PathBuf,
}

impl StreamerStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }
    fn path(&self, id: &str) -> PathBuf {
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
        self.dir.join(format!("{safe}.streamers.json"))
    }
    pub fn get(&self, id: &str) -> MatchStreamers {
        fs::read(self.path(id))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| MatchStreamers { match_id: id.to_string(), ..Default::default() })
    }
    pub fn put(&self, s: &MatchStreamers) {
        let _ = fs::create_dir_all(&self.dir);
        if let Ok(json) = serde_json::to_vec(s) {
            let _ = fs::write(self.path(&s.match_id), json);
        }
    }
}

/// A channel the user linked to a player by hand ("Missed a streamer?").
/// Kept only on this PC: the server never stores it, and it is never shared.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    /// Riot's permanent player id; stays the same when they rename the account.
    pub puuid: String,
    pub login: String,
    /// What the player was when linked, e.g. "Enemy · Raze", so the user can tell links apart.
    pub label: String,
    pub added_ms: u64,
    /// Later matches where this link found the streamer live.
    pub seen: u32,
}

#[derive(Clone)]
pub struct LinkStore {
    path: PathBuf,
    lock: Arc<Mutex<()>>,
}

impl LinkStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Arc::new(Mutex::new(())) }
    }
    pub fn all(&self) -> Vec<Link> {
        fs::read(&self.path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    fn write(&self, links: &[Link]) {
        if let Some(dir) = self.path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec_pretty(links) {
            let tmp = self.path.with_extension("json.tmp");
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }
    /// Adds or updates the link for a player.
    pub fn save(&self, puuid: &str, login: &str, label: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut links = self.all();
        links.retain(|l| l.puuid != puuid);
        links.push(Link { puuid: puuid.into(), login: login.into(), label: label.into(), added_ms: now_ms(), seen: 0 });
        self.write(&links);
    }
    pub fn remove(&self, puuid: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut links = self.all();
        links.retain(|l| l.puuid != puuid);
        self.write(&links);
    }
    fn mark_seen(&self, puuid: &str) {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut links = self.all();
        if let Some(l) = links.iter_mut().find(|l| l.puuid == puuid) {
            l.seen += 1;
        }
        self.write(&links);
    }
}

/// A Twitch login from what the user typed ("twitch.tv/Name", a full URL, or just the name).
pub fn clean_login(input: &str) -> Option<String> {
    let l = input.trim().trim_start_matches("https://").trim_start_matches("http://").trim_start_matches("www.").trim_start_matches("twitch.tv/");
    let l = l.split(['/', '?', '#']).next().unwrap_or("").to_lowercase();
    (3..=25).contains(&l.len()).then_some(l).filter(|l| l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
}

/// Asks the server whether `login` was live during this match as player `puuid`.
pub fn fetch_channel(server: &str, m: &MatchSummary, puuid: &str, login: &str) -> Result<Option<StreamerHit>, String> {
    let url = format!("{}/api/match/{}/{}/channel", server.trim_end_matches('/'), m.region, m.id);
    let mut res = agent()
        .get(&url)
        .query("login", login)
        .query("puuid", puuid)
        .call()
        .map_err(|e| crate::net_error(&e.to_string()))?;
    let status = res.status().as_u16();
    if status != 200 {
        return Err(res.body_mut().read_json::<ErrorResponse>().map(|e| e.error).unwrap_or_else(|_| format!("Server error ({status})")));
    }
    let hits: StreamersResponse = res.body_mut().read_json().map_err(|e| e.to_string())?;
    Ok(hits.streamers.into_iter().next())
}

/// "Enemy · Raze": how a player is shown, without their Riot name.
pub fn player_label(player: &crate::matches::MatchPlayer, me: Option<&crate::matches::MatchPlayer>) -> String {
    let side = match me {
        Some(me) if me.team == player.team => "Teammate",
        Some(_) => "Enemy",
        None => "Player",
    };
    format!("{side} · {}", player.agent)
}

/// Merges a fresh server answer into what we already know for a match.
pub fn merge_hits(state: &mut MatchStreamers, hits: Vec<StreamerHit>, m: &MatchSummary, me: Option<&str>, s: &Settings) {
    for hit in hits {
        let fights = me.map(|me| fight_windows(m, me, &hit.puuid, s).len() as u32).unwrap_or(0);
        if let Some(p) = state.players.iter_mut().find(|p| p.puuid == hit.puuid) {
            p.vod = hit.vod.or(p.vod.take());
            p.fights = fights;
        } else {
            state.players.push(PlayerState {
                puuid: hit.puuid,
                name: hit.name,
                channel: hit.channel,
                status: if hit.vod.is_some() { StreamerStatus::Working } else { StreamerStatus::NoVod },
                vod: hit.vod,
                clips: 0,
                fights,
                done: Vec::new(),
                failures: 0,
                message: None,
                manual: false,
            });
        }
    }
}

// ---------- worker ----------

/// Re-ask the server this often per unfinished match (VODs appear and grow).
const RECHECK: Duration = Duration::from_secs(10 * 60);
const TICK: Duration = Duration::from_secs(60);
const MAX_FAILURES: u32 = 3;
/// Checks with no streamer found before a match is marked done.
const NO_STREAMER_CHECKS: u32 = 2;

pub type StreamerListener = Box<dyn Fn(&MatchStreamers, Option<&ClipInfo>) + Send + Sync>;

#[derive(Clone)]
pub struct StreamerWorker {
    matches: MatchStore,
    store: StreamerStore,
    links: LinkStore,
    settings: Arc<Mutex<Settings>>,
    clip_root: Arc<Mutex<PathBuf>>,
    listener: Arc<StreamerListener>,
    busy: Arc<Mutex<()>>,
}

impl StreamerWorker {
    pub fn new(matches: MatchStore, store: StreamerStore, links: LinkStore, settings: Settings, clip_root: PathBuf, listener: StreamerListener) -> Self {
        Self {
            matches,
            store,
            links,
            settings: Arc::new(Mutex::new(settings)),
            clip_root: Arc::new(Mutex::new(clip_root)),
            listener: Arc::new(listener),
            busy: Arc::new(Mutex::new(())),
        }
    }

    pub fn update(&self, settings: Settings, clip_root: PathBuf) {
        *self.settings.lock().unwrap_or_else(|e| e.into_inner()) = settings;
        *self.clip_root.lock().unwrap_or_else(|e| e.into_inner()) = clip_root;
    }

    pub fn all(&self) -> Vec<MatchStreamers> {
        self.matches.list().iter().map(|m| self.store.get(&m.id)).collect()
    }

    pub fn spawn(&self) {
        let me = self.clone();
        thread::Builder::new()
            .name("streamer-clips".into())
            .spawn(move || me.run())
            .expect("spawn streamer worker");
    }

    fn run(&self) {
        let game = procs::game_exe();
        let mut procs = Procs::new();
        loop {
            procs.refresh();
            let s = self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
            // Without "grab right after the match", wait until the game is closed.
            let may_download = s.grab_after_match || !procs.is_running(&game);
            if s.streamer_auto {
                for m in self.matches.list() {
                    if let Err(e) = self.process(&m, false, may_download) {
                        eprintln!("streamer clips for {}: {e}", m.id);
                    }
                }
            }
            thread::sleep(TICK);
        }
    }

    /// Checks one match now (the "Check again" button).
    pub fn check_now(&self, match_id: &str) -> Result<MatchStreamers, String> {
        let m = self.matches.list().into_iter().find(|m| m.id == match_id).ok_or("Match not found")?;
        self.process(&m, true, true)?;
        Ok(self.store.get(match_id))
    }

    /// Adds a channel the user says belongs to a player in this match, and
    /// remembers it on this PC so later matches against them are checked too.
    pub fn add_manual(&self, match_id: &str, puuid: &str, login: &str) -> Result<MatchStreamers, String> {
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let m = self.matches.list().into_iter().find(|m| m.id == match_id).ok_or("Match not found")?;
        let player = m.players.iter().find(|p| p.puuid == puuid).ok_or("Player not in this match")?;
        let login = clean_login(login).ok_or("That isn't a Twitch channel name.")?;
        let hit = fetch_channel(&s.server_url, &m, puuid, &login)?.ok_or_else(|| format!("{login} wasn't streaming during this match."))?;
        let me_player = find_me(&m, &s.riot_id);
        self.links.save(puuid, &login, &player_label(player, me_player));
        let _guard = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let mut state = self.store.get(&m.id);
        let me = me_player.map(|p| p.puuid.clone());
        state.players.retain(|p| p.puuid != player.puuid);
        merge_hits(&mut state, vec![hit], &m, me.as_deref(), &s);
        if let Some(p) = state.players.iter_mut().find(|p| p.puuid == player.puuid) {
            p.manual = true;
        }
        state.finished = false;
        self.store.put(&state);
        (self.listener)(&state, None);
        drop(_guard);
        self.check_now(&m.id)
    }

    /// Channels the user linked, newest first.
    pub fn links(&self) -> Vec<Link> {
        let mut l = self.links.all();
        l.sort_by_key(|x| std::cmp::Reverse(x.added_ms));
        l
    }

    pub fn remove_link(&self, puuid: &str) {
        self.links.remove(puuid);
    }

    /// Players in this match the user linked before: ask whether their channel was live.
    fn check_links(&self, m: &MatchSummary, s: &Settings, me: Option<&str>, state: &mut MatchStreamers) {
        let links = self.links.all();
        for p in &m.players {
            if Some(p.puuid.as_str()) == me || state.players.iter().any(|x| x.puuid == p.puuid) {
                continue;
            }
            let Some(link) = links.iter().find(|l| l.puuid == p.puuid) else { continue };
            match fetch_channel(&s.server_url, m, &p.puuid, &link.login) {
                Ok(Some(hit)) => {
                    merge_hits(state, vec![hit], m, me, s);
                    if let Some(x) = state.players.iter_mut().find(|x| x.puuid == p.puuid) {
                        x.manual = true;
                    }
                    self.links.mark_seen(&p.puuid);
                }
                Ok(None) => {} // not streaming this time
                Err(e) => eprintln!("linked channel {}: {e}", link.login),
            }
        }
    }

    fn process(&self, m: &MatchSummary, force: bool, may_download: bool) -> Result<(), String> {
        let _guard = self.busy.lock().unwrap_or_else(|e| e.into_inner());
        let s = self.settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let mut state = self.store.get(&m.id);
        if state.finished && !force {
            return Ok(());
        }
        let started = time::OffsetDateTime::parse(&m.started_at, &time::format_description::well_known::Rfc3339)
            .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as u64)
            .unwrap_or(0);
        let window_ms = u64::from(s.vod_wait_hours) * 3_600_000;
        if !force && now_ms().saturating_sub(started) > window_ms + m.length_ms {
            state.finished = true;
            self.store.put(&state);
            return Ok(());
        }
        let me = find_me(m, &s.riot_id).map(|p| p.puuid.clone());

        // Ask the server (at most every RECHECK, unless forced).
        let due = force || state.checked_ms.is_none_or(|t| now_ms().saturating_sub(t) >= RECHECK.as_millis() as u64);
        if due {
            match fetch_streamers(&s.server_url, m, me.as_deref()) {
                Ok(hits) => {
                    merge_hits(&mut state, hits, m, me.as_deref(), &s);
                    state.error = None;
                }
                Err(e) => state.error = Some(e),
            }
            // Channels you linked before (smurfs, odd names). Checked on the
            // first two checks only, like everything else, so it stays cheap.
            if state.checks < NO_STREAMER_CHECKS {
                self.check_links(m, &s, me.as_deref(), &mut state);
            }
            state.checked_ms = Some(now_ms());
            state.checks += 1;
            self.store.put(&state);
            (self.listener)(&state, None);
        }

        if let Some(me) = me.as_deref() {
            if may_download {
                self.download_fights(m, me, &s, &mut state);
            }
        }

        // Done when every streamer is settled and no VOD is still growing.
        // Most matches have no streamers at all: two clean checks (10 min
        // apart) are enough, so they aren't re-checked for an hour.
        let settled = state.players.iter().all(|p| p.status != StreamerStatus::Working);
        let nobody_streaming = state.players.is_empty() && state.checks >= NO_STREAMER_CHECKS && state.error.is_none();
        let all_done = settled && state.checked_ms.is_some() && state.error.is_none() && now_ms().saturating_sub(started) > m.length_ms + 3_600_000;
        if nobody_streaming || all_done {
            state.finished = true;
        }
        self.store.put(&state);
        (self.listener)(&state, None);
        Ok(())
    }

    fn download_fights(&self, m: &MatchSummary, me: &str, s: &Settings, state: &mut MatchStreamers) {
        let (Some(ytdlp), Some(ff)) = (locate_ytdlp(), ffmpeg::locate()) else {
            state.error = Some("yt-dlp or FFmpeg is missing. Reinstall CrossPOV.".into());
            return;
        };
        let root = self.clip_root.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let out_dir = root.join(STREAMER_CLIPS);
        for i in 0..state.players.len() {
            let p = state.players[i].clone();
            if p.status != StreamerStatus::Working {
                continue;
            }
            let Some(vod) = p.vod.clone() else { continue };
            let windows = fight_windows(m, me, &p.puuid, s);
            if windows.is_empty() {
                state.players[i].status = StreamerStatus::NoFights;
                continue;
            }
            let mut waiting = false;
            for w in &windows {
                if p.done.contains(&w.key()) {
                    continue;
                }
                let (from, to) = (vod.offset_sec + w.start, vod.offset_sec + w.end);
                if from < 0.0 {
                    continue; // Moment happened before their stream began.
                }
                if to > vod.duration_sec {
                    waiting = true; // VOD hasn't caught up yet (still live / processing).
                    continue;
                }
                if !is_twitch_vod_url(&vod.url) {
                    state.players[i].status = StreamerStatus::Failed;
                    state.players[i].message = Some("The server sent an unexpected video link, so nothing was downloaded.".into());
                    break;
                }
                let _ = fs::create_dir_all(&out_dir);
                let short = file_safe(&m.id, 8);
                let stem = out_dir.join(format!("{}_R{}_{}_{}", file_safe(&p.channel.login, 40), w.round + 1, w.moment.slug(), short));
                match download(&ytdlp, &ff, ytdlp_args(&vod.url, from, to, s.download_quality, &ff, &stem)) {
                    Ok(()) => {
                        let clip = stem.with_extension("mp4");
                        let thumb = clips::thumb_path(&root, &clip);
                        if let Some(dir) = thumb.parent() {
                            let _ = fs::create_dir_all(dir);
                        }
                        let _ = Command::new(&ff)
                            .args(ffmpeg::thumbnail_args(&clip, &thumb))
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .no_window()
                            .status();
                        let meta = ClipMeta {
                            duration_sec: Some(to - from),
                            streamer: Some(p.channel.display_name.clone()),
                            round: Some(w.round + 1),
                            moment: Some(w.moment.label().into()),
                            map: Some(m.map.clone()),
                        };
                        clips::write_meta(&root, &clip, &meta);
                        let pl = &mut state.players[i];
                        pl.done.push(w.key());
                        pl.clips += 1;
                        if let Some(info) = clips::list(&root).into_iter().find(|c| c.path == clip.to_string_lossy()) {
                            (self.listener)(state, Some(&info));
                        }
                    }
                    Err(DownloadError::SubOnly) => {
                        state.players[i].status = StreamerStatus::SubOnly;
                        break;
                    }
                    Err(DownloadError::Gone) => {
                        state.players[i].status = StreamerStatus::Failed;
                        state.players[i].message = Some("The VOD isn't available any more.".into());
                        break;
                    }
                    Err(DownloadError::Other(e)) => {
                        let pl = &mut state.players[i];
                        pl.failures += 1;
                        pl.message = Some(e);
                        if pl.failures >= MAX_FAILURES {
                            pl.status = StreamerStatus::Failed;
                        }
                        break;
                    }
                }
            }
            let pl = &mut state.players[i];
            if pl.status == StreamerStatus::Working && !waiting && windows.iter().all(|w| pl.done.contains(&w.key())) {
                pl.status = StreamerStatus::Clipped;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matches::{MatchKill, MatchPlayer, MatchRound};

    fn five_sec() -> Settings {
        Settings { seconds_before: 5, seconds_after: 5, ..Settings::default() }
    }

    #[test]
    fn default_padding_gives_a_full_two_minute_clip() {
        let w = fight_windows(&sample(), "me", "st", &Settings::default());
        // Kill at 30 s (60 s before is clamped at the match start) and death
        // at 150 s: with a minute each side the two clips touch, so they
        // become one clip from 0:00 to 3:30 instead of two overlapping ones.
        assert_eq!(w.len(), 1);
        assert_eq!((w[0].start, w[0].end), (0.0, 210.0));
    }

    fn kill(round: u32, at: u64, killer: &str, victim: &str) -> MatchKill {
        MatchKill { round, at_ms: at, in_round_ms: 0, killer: killer.into(), victim: victim.into(), weapon: None }
    }

    fn sample() -> MatchSummary {
        let p = |id: &str, name: &str| MatchPlayer {
            puuid: id.into(),
            name: name.into(),
            tag: "1".into(),
            team: "x".into(),
            agent: "Jett".into(),
            kills: 0,
            deaths: 0,
            assists: 0,
        };
        MatchSummary {
            id: "0b6d5e1f-1a2b-4c3d-8e9f-0123456789ab".into(),
            map: "Ascent".into(),
            mode: "Competitive".into(),
            region: "eu".into(),
            started_at: "2026-11-24T19:00:00Z".into(),
            length_ms: 1_800_000,
            teams: vec![],
            players: vec![p("me", "Me"), p("st", "streamer")],
            rounds: vec![
                MatchRound { index: 0, winner: None, start_ms: Some(5_000) },
                MatchRound { index: 1, winner: None, start_ms: Some(110_000) },
            ],
            kills: vec![
                kill(0, 30_000, "me", "st"),
                kill(0, 33_000, "other", "me"),
                kill(1, 150_000, "st", "me"),
                kill(1, 152_000, "me", "other"),
            ],
        }
    }

    #[test]
    fn finds_fights_between_you_and_the_streamer() {
        let s = five_sec(); // 5 s before, 5 s after
        let w = fight_windows(&sample(), "me", "st", &s);
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].start, w[0].end, w[0].moment), (25.0, 35.0, Moment::YouKilled));
        assert_eq!((w[1].start, w[1].end, w[1].moment, w[1].round), (145.0, 155.0, Moment::KilledYou, 1));
    }

    #[test]
    fn respects_which_moments_to_clip() {
        let s = Settings { clip_you_killed: false, ..five_sec() };
        let w = fight_windows(&sample(), "me", "st", &s);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].moment, Moment::KilledYou);
    }

    #[test]
    fn can_skip_deaths_to_the_streamer() {
        let s = Settings { clip_killed_you: false, ..five_sec() };
        let w = fight_windows(&sample(), "me", "st", &s);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].moment, Moment::YouKilled);
        // Whole-round mode must skip rounds where the only fight was them killing you.
        let whole = Settings { clip_whole_round: true, ..s };
        assert!(fight_windows(&sample(), "me", "st", &whole).iter().all(|w| w.round != 1));
    }

    #[test]
    fn merges_overlapping_moments() {
        let mut m = sample();
        m.kills.push(kill(0, 36_000, "st", "me"));
        m.kills.sort_by_key(|k| k.at_ms);
        let w = fight_windows(&m, "me", "st", &five_sec());
        assert_eq!((w[0].start, w[0].end), (25.0, 41.0), "kill at 30s and death at 36s become one clip");
    }

    #[test]
    fn whole_rounds_use_round_start_and_next_round() {
        let s = Settings { clip_whole_round: true, ..Settings::default() };
        let w = fight_windows(&sample(), "me", "st", &s);
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].start, w[0].end), (5.0, 110.0));
        assert_eq!((w[1].start, w[1].end), (110.0, 157.0), "last round ends 5 s after its last kill");
    }

    #[test]
    fn ytdlp_downloads_only_the_section() {
        let a = ytdlp_args("https://www.twitch.tv/videos/1", 3625.0, 3635.5, DownloadQuality::P1080, Path::new("/x/ffmpeg"), Path::new("/c/vs_st"));
        let j = a.join(" ");
        assert!(j.contains("--download-sections *3625.0-3635.5"), "{j}");
        assert!(j.contains("-f best[height<=1080]/best"));
        assert!(j.contains("-o /c/vs_st.%(ext)s"));
        assert!(j.ends_with("-- https://www.twitch.tv/videos/1"), "the URL can never be read as an option");
    }

    #[test]
    fn cleans_typed_channel_names() {
        assert_eq!(clean_login("https://www.twitch.tv/Some_Streamer/videos").as_deref(), Some("some_streamer"));
        assert_eq!(clean_login("twitch.tv/abc?x=1").as_deref(), Some("abc"));
        assert_eq!(clean_login("  Name123 ").as_deref(), Some("name123"));
        assert_eq!(clean_login("ab"), None);
        assert_eq!(clean_login("../etc"), None);
    }

    #[test]
    fn links_are_remembered_and_removed() {
        let path = std::env::temp_dir().join(format!("crosspov-links-{}.json", std::process::id()));
        let store = LinkStore::new(path.clone());
        store.save("p1", "streamer_one", "Enemy · Raze");
        store.save("p2", "other", "Teammate · Sova");
        store.save("p1", "renamed", "Enemy · Raze");
        let all = store.all();
        assert_eq!(all.len(), 2, "one link per player");
        assert_eq!(all.iter().find(|l| l.puuid == "p1").unwrap().login, "renamed");
        store.mark_seen("p2");
        assert_eq!(store.all().iter().find(|l| l.puuid == "p2").unwrap().seen, 1);
        store.remove("p1");
        assert_eq!(store.all().len(), 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn only_twitch_vod_links_and_safe_file_names() {
        assert!(is_twitch_vod_url("https://www.twitch.tv/videos/2290000000"));
        for bad in ["--exec calc", "https://evil.example/videos/1", "https://www.twitch.tv/videos/1?x=--exec", "https://www.twitch.tv/videos/", "file:///c/x"] {
            assert!(!is_twitch_vod_url(bad), "{bad}");
        }
        assert_eq!(file_safe("../../Windows/x", 40), "Windowsx");
        assert_eq!(file_safe("streamer_two", 40), "streamer_two");
        assert_eq!(file_safe("..", 40), "unknown");
    }

    /// Runs the real yt-dlp + FFmpeg download path against an HLS stream named
    /// by CROSSPOV_TEST_HLS (Twitch VODs are HLS) and checks only the
    /// requested seconds come back as a playable MP4.
    #[test]
    fn downloads_just_the_section() {
        let Ok(url) = std::env::var("CROSSPOV_TEST_HLS") else { return };
        let (ytdlp, ff) = (locate_ytdlp().expect("yt-dlp"), ffmpeg::locate().expect("ffmpeg"));
        let dir = std::env::temp_dir().join(format!("crosspov-ytdlp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let stem = dir.join("vs_test_R1_killed-you");
        let args = ytdlp_args(&url, 20.0, 30.0, DownloadQuality::Source, &ff, &stem);
        download(&ytdlp, &ff, args).expect("download");
        let clip = stem.with_extension("mp4");
        assert!(clip.is_file(), "mp4 written");
        let out = Command::new(&ff).args(["-hide_banner", "-i"]).arg(&clip).output().unwrap();
        let info = String::from_utf8_lossy(&out.stderr);
        let dur = info.lines().find(|l| l.contains("Duration:")).unwrap_or("").to_string();
        assert!(dur.contains("00:00:10") || dur.contains("00:00:11") || dur.contains("00:00:09"), "{dur}");
        assert!(info.contains("Video: h264") && info.contains("Audio: aac"), "{info}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn classifies_ytdlp_errors() {
        assert_eq!(classify_error("ERROR: [twitch:vod] 123: This video is only available for subscribers"), DownloadError::SubOnly);
        assert_eq!(classify_error("ERROR: Video 123 does not exist"), DownloadError::Gone);
        assert!(matches!(classify_error("ERROR: network\nERROR: timed out"), DownloadError::Other(m) if m == "ERROR: timed out"));
    }

    #[test]
    fn a_match_with_no_streamers_is_done_after_two_checks() {
        let dir = std::env::temp_dir().join(format!("crosspov-nostreamers-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let m = sample();
        let store = StreamerStore::new(dir.clone());
        // Two clean checks, no streamers found.
        store.put(&MatchStreamers { match_id: m.id.clone(), checked_ms: Some(now_ms()), checks: 2, ..Default::default() });
        let st = store.get(&m.id);
        let nobody = st.players.is_empty() && st.checks >= NO_STREAMER_CHECKS && st.error.is_none();
        assert!(nobody);
        // Older saved state without the counter still loads (counts as 0).
        fs::write(dir.join(format!("{}.streamers.json", m.id)), br#"{"matchId":"x","checkedMs":1,"error":null,"players":[],"finished":false}"#).unwrap();
        assert_eq!(store.get(&m.id).checks, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merging_server_hits_counts_fights() {
        let m = sample();
        let mut state = MatchStreamers { match_id: m.id.clone(), ..Default::default() };
        let hit = StreamerHit {
            puuid: "st".into(),
            name: "streamer".into(),
            tag: "1".into(),
            channel: Channel { id: "9".into(), login: "streamer".into(), display_name: "Streamer".into() },
            vod: Some(Vod { id: "v".into(), url: "u".into(), started_at: "".into(), duration_sec: 7200.0, offset_sec: 3600.0, live: true }),
            live_game: Some("VALORANT".into()),
        };
        merge_hits(&mut state, vec![hit.clone()], &m, Some("me"), &five_sec());
        assert_eq!(state.players.len(), 1);
        assert_eq!(state.players[0].fights, 2);
        assert_eq!(state.players[0].status, StreamerStatus::Working);
        // A later answer updates, never duplicates.
        merge_hits(&mut state, vec![hit], &m, Some("me"), &five_sec());
        assert_eq!(state.players.len(), 1);
    }
}
