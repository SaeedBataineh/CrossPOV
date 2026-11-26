//! Which game is being played right now, so the recorder knows when to run,
//! which screen to capture and whose sound to record.
//!
//! A game is found three ways, in this order:
//! 1. one CrossPOV knows (the built-in list below, VALORANT first),
//! 2. one you added in Settings,
//! 3. any other app running fullscreen or borderless fullscreen in front.
//!
//! An app found by being fullscreen stays "the game" until it closes, so
//! alt-tabbing out doesn't stop the recording. Apps in `ignored_games` are
//! never recorded. Nothing here touches the game: it only reads the process
//! list and the position of the front window.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::{procs, settings::Settings};

/// Games CrossPOV knows by their program name: (exe, name).
pub const KNOWN_GAMES: &[(&str, &str)] = &[
    ("VALORANT-Win64-Shipping.exe", "VALORANT"),
    ("cs2.exe", "Counter-Strike 2"),
    ("FortniteClient-Win64-Shipping.exe", "Fortnite"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("League of Legends.exe", "League of Legends"),
    ("dota2.exe", "Dota 2"),
    ("Overwatch.exe", "Overwatch 2"),
    ("RainbowSix.exe", "Rainbow Six Siege"),
    ("RainbowSix_Vulkan.exe", "Rainbow Six Siege"),
    ("RainbowSix_DX11.exe", "Rainbow Six Siege"),
    ("cod.exe", "Call of Duty"),
    ("RocketLeague.exe", "Rocket League"),
    ("GTA5.exe", "Grand Theft Auto V"),
    ("GTA5_Enhanced.exe", "Grand Theft Auto V"),
    ("RDR2.exe", "Red Dead Redemption 2"),
    ("eldenring.exe", "Elden Ring"),
    ("TslGame.exe", "PUBG: Battlegrounds"),
    ("destiny2.exe", "Destiny 2"),
    ("DeadByDaylight-Win64-Shipping.exe", "Dead by Daylight"),
    ("RobloxPlayerBeta.exe", "Roblox"),
    ("Minecraft.Windows.exe", "Minecraft"),
    ("FallGuys_client_game.exe", "Fall Guys"),
    ("HuntGame.exe", "Hunt: Showdown"),
    ("EscapeFromTarkov.exe", "Escape from Tarkov"),
    ("RustClient.exe", "Rust"),
    ("Discovery.exe", "The Finals"),
    ("Warframe.x64.exe", "Warframe"),
    ("Palworld-Win64-Shipping.exe", "Palworld"),
    ("helldivers2.exe", "Helldivers 2"),
    ("BF2042.exe", "Battlefield 2042"),
    ("bf1.exe", "Battlefield 1"),
    ("HaloInfinite.exe", "Halo Infinite"),
    ("StreetFighter6.exe", "Street Fighter 6"),
    ("Polaris-Win64-Shipping.exe", "Tekken 8"),
    ("deadlock.exe", "Deadlock"),
    ("Lethal Company.exe", "Lethal Company"),
    ("Among Us.exe", "Among Us"),
    ("Terraria.exe", "Terraria"),
    ("Stardew Valley.exe", "Stardew Valley"),
    ("Cyberpunk2077.exe", "Cyberpunk 2077"),
    ("witcher3.exe", "The Witcher 3"),
    ("HogwartsLegacy.exe", "Hogwarts Legacy"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
    ("Starfield.exe", "Starfield"),
    ("Diablo IV.exe", "Diablo IV"),
    ("Wow.exe", "World of Warcraft"),
    ("Hearthstone.exe", "Hearthstone"),
    ("osu!.exe", "osu!"),
    ("ForzaHorizon5.exe", "Forza Horizon 5"),
    ("SoTGame.exe", "Sea of Thieves"),
    ("GenshinImpact.exe", "Genshin Impact"),
    ("ZenlessZoneZero.exe", "Zenless Zone Zero"),
    ("StarRail.exe", "Honkai: Star Rail"),
    ("PathOfExile.exe", "Path of Exile"),
    ("PathOfExile_x64.exe", "Path of Exile"),
    ("MonsterHunterWilds.exe", "Monster Hunter Wilds"),
    ("MonsterHunterWorld.exe", "Monster Hunter: World"),
    ("sekiro.exe", "Sekiro"),
    ("DarkSoulsIII.exe", "Dark Souls III"),
    ("Phasmophobia.exe", "Phasmophobia"),
    ("valheim.exe", "Valheim"),
    ("arma3_x64.exe", "Arma 3"),
    ("DayZ_x64.exe", "DayZ"),
    ("SquadGame.exe", "Squad"),
    ("ReadyOrNot-Win64-Shipping.exe", "Ready or Not"),
    ("HLL-Win64-Shipping.exe", "Hell Let Loose"),
    ("Brawlhalla.exe", "Brawlhalla"),
    ("Chivalry2-Win64-Shipping.exe", "Chivalry 2"),
    ("Mordhau-Win64-Shipping.exe", "Mordhau"),
    ("SonsOfTheForest.exe", "Sons of the Forest"),
];

/// Apps that go fullscreen but aren't games: browsers, video players,
/// launchers, chat, Windows itself. Never picked up as "fullscreen = game".
const NOT_GAMES: &[&str] = &[
    "explorer.exe", "crosspov.exe", "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "opera_gx.exe",
    "brave.exe", "vivaldi.exe", "arc.exe", "vlc.exe", "mpc-hc64.exe", "mpc-be64.exe", "wmplayer.exe",
    "potplayermini64.exe", "mpv.exe", "applicationframehost.exe", "discord.exe", "obs64.exe", "steam.exe",
    "steamwebhelper.exe", "epicgameslauncher.exe", "battle.net.exe", "riotclientservices.exe", "riotclientux.exe",
    "leagueclientux.exe", "eadesktop.exe", "ubisoftconnect.exe", "upc.exe", "galaxyclient.exe", "medal.exe",
    "shellexperiencehost.exe", "startmenuexperiencehost.exe", "searchhost.exe", "searchapp.exe", "lockapp.exe",
    "textinputhost.exe", "powerpnt.exe", "spotify.exe", "zoom.exe", "teams.exe", "ms-teams.exe", "slack.exe",
    "code.exe", "windowsterminal.exe", "nvidia overlay.exe", "nvcontainer.exe", "gamebar.exe", "taskmgr.exe",
    "netflix.exe", "photos.exe", "microsoft.photos.exe", "snippingtool.exe", "screenclippinghost.exe",
];

/// How a game was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Found {
    #[default]
    Known,
    Yours,
    Fullscreen,
}

/// The game being played.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub exe: String,
    pub name: String,
    pub found: Found,
    /// Which screen it's on, as the screen-capture counts them (0 = main).
    #[serde(skip)]
    pub output_idx: u32,
    /// That screen's height in pixels, if known.
    #[serde(skip)]
    pub screen_height: Option<u32>,
    /// The process found fullscreen (kept until it closes).
    #[serde(skip)]
    pid: Option<u32>,
}

impl Game {
    /// "Record all the time" (for testing): the main screen, no game sound.
    pub fn desktop() -> Self {
        Self { name: "Desktop".into(), found: Found::Yours, ..Self::default() }
    }
}

/// When the listed game's screen was last looked up.
static SCREEN_CHECKED: Mutex<Option<Instant>> = Mutex::new(None);
const SCREEN_RECHECK: Duration = Duration::from_secs(10);

/// The game found last time, so a fullscreen one is kept while you alt-tab.
static CURRENT: Mutex<Option<Game>> = Mutex::new(None);

fn ignored(s: &Settings, exe: &str) -> bool {
    s.ignored_games.iter().any(|e| e.eq_ignore_ascii_case(exe))
}

/// Pretty name for a program: "Some Game.exe" -> "Some Game".
pub fn display_name(exe: &str) -> String {
    let base = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    base.trim_end_matches("-Win64-Shipping").trim_end_matches("_x64").to_string()
}

/// The game being played right now, if any. Cheap enough to call every
/// couple of seconds (one shared process list, one look at the front window).
pub fn detect(s: &Settings) -> Option<Game> {
    let mut current = CURRENT.lock().unwrap_or_else(|e| e.into_inner());

    // 1-2: a game on the built-in list or yours, running now. One pass over
    // the process list, then a lookup per name.
    let running = procs::shared(|p| p.running_names());
    let known = KNOWN_GAMES.iter().map(|(exe, name)| (exe.to_string(), name.to_string(), Found::Known));
    let yours = s.custom_games.iter().map(|g| (g.exe.clone(), g.name.clone(), Found::Yours));
    // A listed game only counts with a visible window: some (Roblox, for one)
    // keep running in the background after you close them.
    let listed = known.chain(yours).filter(|(exe, _, _)| running.contains(&exe.to_lowercase()) && !ignored(s, exe)).find_map(|(exe, name, found)| {
        // Its window (and screen): looked up when it starts, then every 10 s
        // (the window list and graphics-card query aren't free).
        let same = current.as_ref().filter(|g| g.exe == exe);
        let screen = match same {
            Some(g) if SCREEN_CHECKED.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < SCREEN_RECHECK) => Some((g.output_idx, g.screen_height)),
            _ => {
                *SCREEN_CHECKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                window::screen_of_process(&exe)
            }
        };
        screen.map(|(output_idx, screen_height)| (exe, name, found, output_idx, screen_height))
    });
    let found = if let Some((exe, name, found, output_idx, screen_height)) = listed {
        Some(Game { exe, name, found, output_idx, screen_height, pid: None })
    } else if let Some(g) = current.as_ref().filter(|g| g.found == Found::Fullscreen && !ignored(s, &g.exe)) {
        // 3, still open: keep it, even while you're tabbed out.
        let alive = g.pid.is_some_and(|pid| procs::shared(|p| p.pid_running(pid)));
        if alive { Some(g.clone()) } else { None }
    } else {
        None
    };
    let found = found.or_else(|| {
        // 3, new: whatever is fullscreen in front, unless it's not a game.
        if !s.record_fullscreen {
            return None;
        }
        let front = window::fullscreen_front()?;
        let exe = procs::shared(|p| p.names(&[front.pid])).remove(&front.pid)?;
        let lower = exe.to_lowercase();
        if NOT_GAMES.contains(&lower.as_str()) || ignored(s, &exe) {
            return None;
        }
        Some(Game {
            name: display_name(&exe),
            exe,
            found: Found::Fullscreen,
            output_idx: front.output_idx,
            screen_height: front.screen_height,
            pid: Some(front.pid),
        })
    });
    // Note the game in the activity log when it changes (shows up in crash reports).
    let before = current.as_ref().map(|g| g.exe.to_lowercase());
    let now = found.as_ref().map(|g| g.exe.to_lowercase());
    if before != now {
        crate::trail(&match &found {
            Some(g) => format!("game: {} ({}, {:?}, screen {})", g.name, g.exe, g.found, g.output_idx),
            None => "game: none".to_string(),
        });
    }
    *current = found.clone();
    found
}

/// The game the recorder last saw, for the updater ("wait until the game closes").
pub fn last_seen() -> Option<Game> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The front window when it fills its whole screen.
#[cfg_attr(not(windows), allow(dead_code))]
struct Front {
    pid: u32,
    output_idx: u32,
    screen_height: Option<u32>,
}

#[cfg(windows)]
mod window {
    use super::Front;
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::{
            Dxgi::{CreateDXGIFactory1, IDXGIFactory1},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible},
    };
    use windows::core::BOOL;
    use windows::Win32::Foundation::LPARAM;

    /// Which screen a monitor is, in the order the screen capture (DXGI, first
    /// graphics card) counts them. Screens on another graphics card fall back to 0.
    fn output_index(monitor: HMONITOR) -> u32 {
        // SAFETY: plain COM calls; every returned interface is owned and released on drop.
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return 0 };
            let Ok(adapter) = factory.EnumAdapters1(0) else { return 0 };
            let mut i = 0;
            while let Ok(output) = adapter.EnumOutputs(i) {
                if output.GetDesc().is_ok_and(|d| d.Monitor == monitor) {
                    return i;
                }
                i += 1;
            }
        }
        0
    }

    /// The screen a window is on: its handle, height and rectangle. Cheap.
    fn monitor_of(hwnd: HWND) -> (HMONITOR, Option<u32>, RECT) {
        // SAFETY: `hwnd` came from Windows; MONITORINFO has cbSize set as required.
        unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let ok = GetMonitorInfoW(monitor, &mut info).as_bool();
            let rect = info.rcMonitor;
            let height = (ok && rect.bottom > rect.top).then(|| (rect.bottom - rect.top) as u32);
            (monitor, height, rect)
        }
    }

    fn class_of(hwnd: HWND) -> String {
        let mut buf = [0u16; 64];
        // SAFETY: the buffer is valid for its length.
        let n = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    pub(super) fn fullscreen_front() -> Option<Front> {
        // SAFETY: plain Win32 queries on the front window; out-params are valid locals.
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            // The desktop and the taskbar aren't games.
            if matches!(class_of(hwnd).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 || pid == std::process::id() {
                return None;
            }
            let mut win = RECT::default();
            GetWindowRect(hwnd, &mut win).ok()?;
            let (monitor, screen_height, screen) = monitor_of(hwnd);
            let covers = win.left <= screen.left && win.top <= screen.top && win.right >= screen.right && win.bottom >= screen.bottom;
            // Only a fullscreen window is worth asking the graphics card which screen it is.
            covers.then(|| Front { pid, output_idx: output_index(monitor), screen_height })
        }
    }

    /// The screen a listed game's biggest visible window is on.
    pub(super) fn screen_of_process(exe: &str) -> Option<(u32, Option<u32>)> {
        let pids: Vec<u32> = crate::procs::shared(|p| p.root_pids(exe));
        if pids.is_empty() {
            return None;
        }
        struct Search {
            pids: Vec<u32>,
            best: Option<(i64, HWND)>,
        }
        unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
            // SAFETY: `data` is the &mut Search passed to EnumWindows below, alive for the call.
            let search = unsafe { &mut *(data.0 as *mut Search) };
            let mut pid = 0u32;
            // SAFETY: plain queries on a window Windows handed us.
            unsafe {
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if search.pids.contains(&pid) && IsWindowVisible(hwnd).as_bool() {
                    let mut r = RECT::default();
                    if GetWindowRect(hwnd, &mut r).is_ok() {
                        let area = i64::from(r.right - r.left) * i64::from(r.bottom - r.top);
                        // Tiny or empty "windows" don't count: background programs keep those.
                        if area >= 100 * 100 && search.best.is_none_or(|(a, _)| area > a) {
                            search.best = Some((area, hwnd));
                        }
                    }
                }
            }
            BOOL(1)
        }
        let mut search = Search { pids, best: None };
        // SAFETY: the callback only touches `search`, which outlives the call.
        let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
        let (_, hwnd) = search.best?;
        let (monitor, height, _) = monitor_of(hwnd);
        Some((output_index(monitor), height))
    }
}

#[cfg(not(windows))]
mod window {
    use super::Front;
    pub(super) fn fullscreen_front() -> Option<Front> {
        None
    }
    pub(super) fn screen_of_process(_exe: &str) -> Option<(u32, Option<u32>)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_programs_plainly() {
        assert_eq!(display_name("Some Game.exe"), "Some Game");
        assert_eq!(display_name("Thing-Win64-Shipping.exe"), "Thing");
    }

    #[test]
    fn known_list_is_tidy() {
        assert_eq!(KNOWN_GAMES[0].1, "VALORANT", "VALORANT is checked first");
        for (exe, name) in KNOWN_GAMES {
            assert!(exe.to_lowercase().ends_with(".exe"), "{exe}");
            assert!(!name.is_empty());
            assert!(!NOT_GAMES.contains(&exe.to_lowercase().as_str()), "{exe} is listed as both");
        }
        assert!(NOT_GAMES.iter().all(|e| *e == e.to_lowercase()), "NOT_GAMES is compared in lower case");
    }

    #[test]
    fn ignored_games_are_never_picked() {
        let s = Settings { ignored_games: vec!["Some.EXE".into()], ..Settings::default() };
        assert!(ignored(&s, "some.exe"));
        assert!(!ignored(&s, "other.exe"));
    }
}
