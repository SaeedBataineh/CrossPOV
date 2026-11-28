//! Auto-clips (VALORANT): while you play, the recorder also writes
//! everything to disk in 5-minute pieces (same encoder, no extra load).
//! When a match's data comes in, your multikills (the kill counts chosen in
//! Settings, per round) are cut out of the pieces without re-encoding,
//! named ("Ascent · Jett · Round 7 · 3K"), and the pieces are deleted.
//! The clips you saved with the hotkey during that match get the same kind
//! of name.
//!
//! Times: the match data gives its start (wall clock) and each kill's time
//! from it; each piece's start is when its file was made.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    clips::{self, ClipInfo, ClipKind, ClipMeta, MY_CLIPS},
    ffmpeg::{self, NoWindow},
    games::Game,
    matches::{find_me, MatchSummary},
    settings::{Container, Settings},
};

pub const VALORANT_EXE: &str = "VALORANT-Win64-Shipping.exe";
/// Seconds of the clip before the round's first kill and after its last.
const BEFORE_MS: u64 = 6_000;
const AFTER_MS: u64 = 4_000;
/// The pieces need room: no match recording with less free than this.
const MIN_FREE_BYTES: u64 = 20_000_000_000;
/// Pieces are deleted after this long even if no match data came.
const KEEP_PIECES: Duration = Duration::from_secs(3 * 3600);

pub fn session_dir(work: &Path) -> PathBuf {
    work.join("session")
}

/// Where the recorder should write the pieces now, if at all: auto-clip on,
/// playing VALORANT, and room on the drive.
pub fn wanted_session(work: &Path, settings: &Settings, game: Option<&Game>) -> Option<PathBuf> {
    let valorant = game.is_some_and(|g| g.exe.eq_ignore_ascii_case(VALORANT_EXE));
    (settings.auto_clip && !settings.auto_clip_kills.is_empty() && valorant && enough_room(work)).then(|| session_dir(work))
}

/// Free space on `path`'s drive is at least MIN_FREE_BYTES (checked at most
/// every 5 minutes).
fn enough_room(path: &Path) -> bool {
    use std::sync::Mutex;
    use std::time::Instant;
    static LAST: Mutex<Option<(Instant, bool)>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, ok)) = *last {
        if at.elapsed() < Duration::from_secs(300) {
            return ok;
        }
    }
    let disks = sysinfo::Disks::new_with_refreshed_list().ok();
    let free = disks
        .iter()
        .flat_map(|d| d.iter())
        .filter(|d| path.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space());
    // Unknown: assume there's room (the recorder copes with a full drive).
    let ok = free.is_none_or(|f| f >= MIN_FREE_BYTES);
    if !ok {
        crate::trail("auto-clip: less than 20 GB free, not recording the match for auto-clips");
    }
    *last = Some((Instant::now(), ok));
    ok
}

/// A recorded piece and the wall-clock time it covers (ms since 1970).
#[derive(Debug, Clone, PartialEq)]
pub struct Piece {
    pub path: PathBuf,
    pub start_ms: u64,
    pub end_ms: u64,
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The pieces, oldest first. Each starts when its file was made and ends
/// where the next starts (the last one: when it was last written).
pub fn pieces(dir: &Path) -> Vec<Piece> {
    let mut files: Vec<(PathBuf, u64, u64)> = fs::read_dir(dir)
        .map(|it| {
            it.flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("mkv")))
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    let modified = ms(m.modified().ok()?);
                    Some((e.path(), m.created().map(ms).unwrap_or(modified), modified))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort_by_key(|f| f.1);
    let starts: Vec<u64> = files.iter().map(|f| f.1).collect();
    files
        .into_iter()
        .enumerate()
        .map(|(i, (path, start, modified))| Piece { path, start_ms: start, end_ms: starts.get(i + 1).copied().unwrap_or(modified).max(start) })
        .collect()
}

/// One multikill to clip (wall-clock ms), and its round (1 = first).
#[derive(Debug, Clone, PartialEq)]
pub struct Moment {
    pub round: u32,
    pub kills: u32,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// The match's start, ms since 1970.
fn started_ms(m: &MatchSummary) -> Option<u64> {
    let t = time::OffsetDateTime::parse(&m.started_at, &time::format_description::well_known::Rfc3339).ok()?;
    Some((t.unix_timestamp_nanos() / 1_000_000) as u64)
}

/// Your rounds with a kill count in `wanted` (e.g. [3, 4, 5]).
pub fn multikills(m: &MatchSummary, me: &str, wanted: &[u32]) -> Vec<Moment> {
    let Some(start) = started_ms(m) else { return Vec::new() };
    let mut rounds: BTreeMap<u32, Vec<u64>> = BTreeMap::new();
    for k in m.kills.iter().filter(|k| k.killer == me && k.victim != me) {
        rounds.entry(k.round).or_default().push(k.at_ms);
    }
    rounds
        .into_iter()
        .filter(|(_, times)| wanted.contains(&(times.len().min(5) as u32)))
        .map(|(round, times)| {
            let (first, last) = (times.iter().min().copied().unwrap_or(0), times.iter().max().copied().unwrap_or(0));
            Moment { round: round + 1, kills: times.len().min(5) as u32, start_ms: (start + first).saturating_sub(BEFORE_MS), end_ms: start + last + AFTER_MS }
        })
        .collect()
}

/// The round (1 = first) being played at wall-clock `at`.
pub fn round_at(m: &MatchSummary, at: u64) -> Option<u32> {
    let start = started_ms(m)?;
    if at < start || at > start + m.length_ms + 60_000 {
        return None;
    }
    let t = at - start;
    m.rounds.iter().filter(|r| r.start_ms.is_some_and(|s| s <= t)).map(|r| r.index + 1).max().or(Some(1))
}

/// "3K", "4K", "ACE".
pub fn kills_label(kills: u32) -> String {
    if kills >= 5 { "ACE".into() } else { format!("{kills}K") }
}

/// Where a file's own timestamps start (ffmpeg's "start: 0.000000").
fn start_of(ffmpeg: &Path, file: &Path) -> f64 {
    let out = Command::new(ffmpeg).arg("-hide_banner").arg("-i").arg(file).no_window().output();
    let text = out.map(|o| String::from_utf8_lossy(&o.stderr).into_owned()).unwrap_or_default();
    text.split("start: ").nth(1).and_then(|s| s.split(',').next()).and_then(|s| s.trim().parse().ok()).unwrap_or(0.0)
}

/// The concat list taking [from, to] (wall ms) out of `pieces`, or None if
/// they don't cover it.
fn cut_list(pieces: &[Piece], from: u64, to: u64, start_of: &mut dyn FnMut(&Path) -> f64) -> Option<String> {
    let used: Vec<&Piece> = pieces.iter().filter(|p| p.end_ms > from && p.start_ms < to).collect();
    if used.is_empty() || used[0].start_ms > from + 2_000 || used.last()?.end_ms + 2_000 < to {
        return None;
    }
    let mut list = String::new();
    for p in used {
        let zero = start_of(&p.path);
        let inp = from.saturating_sub(p.start_ms) as f64 / 1000.0 + zero;
        let out = (to.min(p.end_ms) - p.start_ms) as f64 / 1000.0 + zero;
        let path = p.path.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
        list.push_str(&format!("file '{path}'\ninpoint {inp:.3}\noutpoint {out:.3}\n"));
    }
    Some(list)
}

/// After a match: clips your multikills, names your hotkey clips from it,
/// and deletes the pieces it no longer needs. Returns the new clips.
pub fn after_match(m: &MatchSummary, settings: &Settings, work: &Path, clip_root: &Path, ffmpeg: &Path) -> Vec<ClipInfo> {
    let Some(me) = find_me(m, &settings.riot_id) else { return Vec::new() };
    let (me_id, agent) = (me.puuid.clone(), me.agent.clone());
    let existing = clips::list(clip_root);
    name_hotkey_clips(m, &agent, clip_root, &existing);

    let mut made = Vec::new();
    let dir = session_dir(work);
    let all = pieces(&dir);
    if settings.auto_clip && !all.is_empty() {
        for moment in multikills(m, &me_id, &settings.auto_clip_kills) {
            let done = existing.iter().any(|c| c.match_id.as_deref() == Some(m.id.as_str()) && c.round == Some(moment.round) && c.kills.is_some());
            if done {
                continue;
            }
            match clip_moment(m, &moment, &agent, &all, settings, clip_root, ffmpeg) {
                Ok(clip) => {
                    crate::trail(&format!("auto-clip: Round {} {} on {}", moment.round, kills_label(moment.kills), m.map));
                    made.push(clip);
                }
                Err(e) => crate::trail(&format!("auto-clip: Round {} {}: {e}", moment.round, kills_label(moment.kills))),
            }
        }
    }
    // Done with this match: its pieces (and older ones) go.
    if let Some(end) = started_ms(m).map(|s| s + m.length_ms) {
        for p in all.iter().filter(|p| p.end_ms <= end) {
            let _ = fs::remove_file(&p.path);
        }
    }
    if !made.is_empty() && settings.prune_oldest {
        clips::prune(clip_root, settings.storage_limit_gb);
    }
    made
}

fn clip_moment(m: &MatchSummary, moment: &Moment, agent: &str, pieces: &[Piece], settings: &Settings, clip_root: &Path, ffmpeg: &Path) -> Result<ClipInfo, String> {
    let mut zero = |p: &Path| start_of(ffmpeg, p);
    let list = cut_list(pieces, moment.start_ms, moment.end_ms, &mut zero).ok_or("not recorded (CrossPOV wasn't recording then)")?;
    let dir = clip_root.join(MY_CLIPS);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let when = time::OffsetDateTime::from_unix_timestamp((moment.start_ms / 1000) as i64)
        .ok()
        .map(|t| t.to_offset(time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC)))
        .and_then(|t| t.format(time::macros::format_description!("[year]-[month]-[day]_[hour]-[minute]-[second]")).ok())
        .unwrap_or_default();
    let ext = if settings.format == Container::Mkv { "mkv" } else { "mp4" };
    let out = dir.join(format!("Clip_{when}_R{}_{}.{ext}", moment.round, kills_label(moment.kills)));
    let list_file = dir.join(format!(".autoclip-{}.txt", std::process::id()));
    fs::write(&list_file, list).map_err(|e| e.to_string())?;
    let mut args: Vec<String> = ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i"].iter().map(|s| s.to_string()).collect();
    args.push(list_file.to_string_lossy().into_owned());
    args.extend(["-map", "0", "-c", "copy", "-avoid_negative_ts", "make_zero"].iter().map(|s| s.to_string()));
    if ext == "mp4" {
        args.extend(["-movflags", "+faststart"].iter().map(|s| s.to_string()));
    }
    args.push(out.to_string_lossy().into_owned());
    let res = Command::new(ffmpeg).args(&args).no_window().output();
    let _ = fs::remove_file(&list_file);
    let res = res.map_err(|e| e.to_string())?;
    if !res.status.success() || fs::metadata(&out).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = fs::remove_file(&out);
        return Err(String::from_utf8_lossy(&res.stderr).trim().chars().take(300).collect());
    }
    let thumb = clips::thumb_path(clip_root, &out);
    if let Some(d) = thumb.parent() {
        let _ = fs::create_dir_all(d);
    }
    let _ = Command::new(ffmpeg).args(ffmpeg::thumbnail_args(&out, &thumb)).no_window().output();
    let meta = ClipMeta {
        duration_sec: Some((moment.end_ms - moment.start_ms) as f64 / 1000.0),
        round: Some(moment.round),
        map: Some(m.map.clone()),
        match_id: Some(m.id.clone()),
        game: Some("VALORANT".into()),
        agent: Some(agent.to_string()),
        kills: Some(moment.kills),
        ..ClipMeta::default()
    };
    clips::write_meta(clip_root, &out, &meta);
    // The clip's date is when it happened, not when it was cut.
    if let Ok(f) = fs::File::options().write(true).open(&out) {
        let _ = f.set_modified(UNIX_EPOCH + Duration::from_millis(moment.end_ms));
    }
    clips::info(clip_root, &out, ClipKind::Mine).ok_or_else(|| "the clip wasn't saved".into())
}

/// Your hotkey clips saved during the match get its map, your agent and the round.
fn name_hotkey_clips(m: &MatchSummary, agent: &str, clip_root: &Path, existing: &[ClipInfo]) {
    for c in existing.iter().filter(|c| c.kind == ClipKind::Mine && c.match_id.is_none() && c.made_ms.is_none()) {
        // A clip ends when it's saved: the moment is just before.
        let Some(round) = round_at(m, c.created_ms.saturating_sub(5_000)) else { continue };
        let path = Path::new(&c.path);
        let mut meta = clips::read_meta(clip_root, path);
        meta.map = Some(m.map.clone());
        meta.round = Some(round);
        meta.match_id = Some(m.id.clone());
        meta.agent = Some(agent.to_string());
        clips::write_meta(clip_root, path, &meta);
    }
}

/// Deletes pieces nothing will need (over 3 hours old). Returns the bytes freed.
pub fn prune(work: &Path) -> u64 {
    let now = ms(SystemTime::now());
    let mut freed = 0;
    for p in pieces(&session_dir(work)) {
        if now.saturating_sub(p.end_ms) > KEEP_PIECES.as_millis() as u64 {
            let size = fs::metadata(&p.path).map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(&p.path).is_ok() {
                freed += size;
            }
        }
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matches::{MatchKill, MatchPlayer, MatchRound};

    fn kill(round: u32, at_ms: u64, killer: &str) -> MatchKill {
        MatchKill { round, at_ms, in_round_ms: 0, killer: killer.into(), victim: "x".into(), weapon: None }
    }

    fn game() -> MatchSummary {
        MatchSummary {
            id: "m1".into(),
            map: "Ascent".into(),
            started_at: "2026-11-28T10:00:00Z".into(),
            length_ms: 30 * 60_000,
            rounds: vec![
                MatchRound { index: 0, winner: None, start_ms: Some(0) },
                MatchRound { index: 1, winner: None, start_ms: Some(100_000) },
                MatchRound { index: 2, winner: None, start_ms: Some(200_000) },
            ],
            kills: vec![
                kill(0, 20_000, "me"),
                kill(0, 25_000, "me"),
                kill(1, 120_000, "me"),
                kill(1, 121_000, "me"),
                kill(1, 130_000, "me"),
                kill(1, 131_000, "other"),
                kill(2, 210_000, "me"),
            ],
            players: vec![MatchPlayer { puuid: "me".into(), name: "Me".into(), tag: "1".into(), agent: "Jett".into(), ..Default::default() }],
            ..Default::default()
        }
    }

    #[test]
    fn finds_the_chosen_multikills() {
        let m = game();
        let start = started_ms(&m).unwrap();
        let three = multikills(&m, "me", &[3, 4, 5]);
        assert_eq!(three, vec![Moment { round: 2, kills: 3, start_ms: start + 120_000 - BEFORE_MS, end_ms: start + 130_000 + AFTER_MS }]);
        let twos: Vec<u32> = multikills(&m, "me", &[2]).iter().map(|k| k.round).collect();
        assert_eq!(twos, vec![1], "round 1's 2K only");
        assert!(multikills(&m, "me", &[]).is_empty());
        assert_eq!(kills_label(5), "ACE");
        assert_eq!(kills_label(3), "3K");
    }

    #[test]
    fn knows_the_round_at_a_time() {
        let m = game();
        let start = started_ms(&m).unwrap();
        assert_eq!(round_at(&m, start + 50_000), Some(1));
        assert_eq!(round_at(&m, start + 150_000), Some(2));
        assert_eq!(round_at(&m, start + 250_000), Some(3));
        assert_eq!(round_at(&m, start - 1_000), None, "before the match");
        assert_eq!(round_at(&m, start + 3_600_000), None, "long after");
    }

    #[test]
    fn cuts_across_pieces() {
        let p = |n: u64, s: u64, e: u64| Piece { path: PathBuf::from(format!("C:\\s\\{n}.mkv")), start_ms: s, end_ms: e };
        let pieces = vec![p(1, 0, 300_000), p(2, 300_000, 600_000)];
        let mut zero = |_: &Path| 0.0;
        let one = cut_list(&pieces, 100_000, 110_000, &mut zero).unwrap();
        assert_eq!(one, "file 'C:/s/1.mkv'\ninpoint 100.000\noutpoint 110.000\n");
        let both = cut_list(&pieces, 295_000, 305_000, &mut zero).unwrap();
        assert_eq!(both, "file 'C:/s/1.mkv'\ninpoint 295.000\noutpoint 300.000\nfile 'C:/s/2.mkv'\ninpoint 0.000\noutpoint 5.000\n");
        assert!(cut_list(&pieces, 700_000, 710_000, &mut zero).is_none(), "not recorded");
        let mut later = |_: &Path| 12.5;
        assert!(cut_list(&pieces, 100_000, 110_000, &mut later).unwrap().contains("inpoint 112.500"), "a piece's own start counts");
    }
}
