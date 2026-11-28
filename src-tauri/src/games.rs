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
    /// That screen's Windows handle (HMONITOR), for monitor capture: names
    /// the screen itself, not a number another program might count otherwise.
    #[serde(skip)]
    pub hmonitor: u64,
    /// That screen's top-left corner on the desktop (Display Capture picks the
    /// monitor by it).
    #[serde(skip)]
    pub screen_origin: (i32, i32),
    /// That screen's height in pixels, if known.
    #[serde(skip)]
    pub screen_height: Option<u32>,
    /// The game's window (HWND), to record just it. 0 = unknown: record the screen.
    #[serde(skip)]
    pub hwnd: u64,
    /// Size of the game's picture (its window's inside), in pixels.
    #[serde(skip)]
    pub window_size: Option<(u32, u32)>,
    /// Size of its screen as Windows runs it (a "true stretch" resolution
    /// shows up here as e.g. 1568x1080), in pixels.
    #[serde(skip)]
    pub screen_size: Option<(u32, u32)>,
    /// Its screen's refresh rate: window capture can't get more distinct
    /// frames per second than this.
    #[serde(skip)]
    pub refresh_hz: Option<u32>,
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
            Some(g) if SCREEN_CHECKED.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed() < SCREEN_RECHECK) => Some(Spot {
                output_idx: g.output_idx,
                hmonitor: g.hmonitor,
                screen_origin: g.screen_origin,
                screen_height: g.screen_height,
                screen_size: g.screen_size,
                hwnd: g.hwnd,
                window_size: g.window_size,
                refresh_hz: g.refresh_hz,
            }),
            _ => {
                *SCREEN_CHECKED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                let previous = same.filter(|g| g.hwnd != 0).map(|g| Spot {
                    output_idx: g.output_idx,
                    hmonitor: g.hmonitor,
                    screen_origin: g.screen_origin,
                    screen_height: g.screen_height,
                    screen_size: g.screen_size,
                    hwnd: g.hwnd,
                    window_size: g.window_size,
                    refresh_hz: g.refresh_hz,
                });
                match (window::screen_of_process(&exe), previous) {
                    // Minimised (alt-tab out of exclusive fullscreen) the window
                    // reports no size: keep the one it had.
                    (Some(now), Some(before)) if now.hwnd == before.hwnd && now.window_size.is_none() => Some(Spot { window_size: before.window_size, ..now }),
                    (Some(now), _) => Some(now),
                    // No visible window big enough, but its window still exists
                    // (minimised): still the game, keep recording.
                    (None, Some(before)) if window::still_open(before.hwnd) => Some(before),
                    (None, _) => None,
                }
            }
        };
        screen.map(|spot| (exe, name, found, spot))
    });
    let found = if let Some((exe, name, found, spot)) = listed {
        Some(Game {
            exe,
            name,
            found,
            output_idx: spot.output_idx,
            hmonitor: spot.hmonitor,
            screen_origin: spot.screen_origin,
            screen_height: spot.screen_height,
            hwnd: spot.hwnd,
            window_size: spot.window_size,
            screen_size: spot.screen_size,
            refresh_hz: spot.refresh_hz,
            pid: None,
        })
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
            output_idx: front.spot.output_idx,
            hmonitor: front.spot.hmonitor,
            screen_origin: front.spot.screen_origin,
            screen_height: front.spot.screen_height,
            hwnd: front.spot.hwnd,
            window_size: front.spot.window_size,
            screen_size: front.spot.screen_size,
            refresh_hz: front.spot.refresh_hz,
            pid: Some(front.pid),
        })
    });
    // Note the game in the activity log when it changes (shows up in crash reports).
    let before = current.as_ref().map(|g| g.exe.to_lowercase());
    let now = found.as_ref().map(|g| g.exe.to_lowercase());
    if before != now {
        if let Some(g) = &found {
            crate::icons::remember(&g.exe);
        }
        crate::trail(&match &found {
            Some(g) => format!("game: {} ({}, {:?}, screen {})", g.name, g.exe, g.found, g.output_idx),
            None => "game: none".to_string(),
        });
    }
    *current = found.clone();
    found
}

/// Whether another window is in front of the game on its screen (you
/// tabbed out to the desktop, Discord, a browser). A window in front on
/// another monitor doesn't count: the game's screen still shows the game.
pub fn covered(game: &Game) -> bool {
    window::covered(&game.exe, game.hwnd)
}

/// The game the recorder last saw, for the updater ("wait until the game closes").
pub fn last_seen() -> Option<Game> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Where a game is: its screen and window.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct Spot {
    output_idx: u32,
    hmonitor: u64,
    screen_origin: (i32, i32),
    screen_height: Option<u32>,
    screen_size: Option<(u32, u32)>,
    hwnd: u64,
    window_size: Option<(u32, u32)>,
    refresh_hz: Option<u32>,
}

/// The front window when it fills its whole screen.
#[cfg_attr(not(windows), allow(dead_code))]
struct Front {
    pid: u32,
    spot: Spot,
}

#[cfg(windows)]
mod window {
    use super::{Front, Spot};
    use windows::Win32::{
        Foundation::{HWND, RECT},
        Graphics::{
            Dxgi::{CreateDXGIFactory1, IDXGIFactory1},
            Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        },
        UI::WindowsAndMessaging::{EnumWindows, GetClassNameW, GetClientRect, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsWindow, IsWindowVisible},
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
            // A minimised window sits off-screen (-32000,-32000): "nearest
            // monitor" is then just whichever is closest to that, not the
            // game's. Use where it goes back to when restored.
            let monitor = if windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd).as_bool() {
                let mut place = windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT {
                    length: std::mem::size_of::<windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT>() as u32,
                    ..Default::default()
                };
                if windows::Win32::UI::WindowsAndMessaging::GetWindowPlacement(hwnd, &mut place).is_ok() {
                    windows::Win32::Graphics::Gdi::MonitorFromRect(&place.rcNormalPosition, MONITOR_DEFAULTTONEAREST)
                } else {
                    MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
                }
            } else {
                MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
            };
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let ok = GetMonitorInfoW(monitor, &mut info).as_bool();
            let rect = info.rcMonitor;
            let height = (ok && rect.bottom > rect.top).then(|| (rect.bottom - rect.top) as u32);
            (monitor, height, rect)
        }
    }

    fn spot_of(hwnd: HWND, monitor: HMONITOR, screen_height: Option<u32>, screen: RECT) -> Spot {
        let size = |r: RECT| (r.right > r.left && r.bottom > r.top).then(|| ((r.right - r.left) as u32, (r.bottom - r.top) as u32));
        let mut client = RECT::default();
        // SAFETY: plain query on a window Windows handed us; `client` is a valid local.
        let window_size = unsafe { GetClientRect(hwnd, &mut client) }.ok().and_then(|_| size(client));
        Spot { output_idx: output_index(monitor), hmonitor: monitor.0 as usize as u64, screen_origin: (screen.left, screen.top), screen_height, screen_size: size(screen), hwnd: hwnd.0 as usize as u64, window_size, refresh_hz: refresh_of(monitor) }
    }

    /// A screen's refresh rate, in Hz.
    fn refresh_of(monitor: HMONITOR) -> Option<u32> {
        use windows::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_CURRENT_SETTINGS, MONITORINFOEXW};
        // SAFETY: both structs have their size fields set as Windows requires;
        // MONITORINFOEXW starts with a MONITORINFO, as GetMonitorInfoW expects.
        unsafe {
            let mut info = MONITORINFOEXW::default();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if !GetMonitorInfoW(monitor, &mut info.monitorInfo).as_bool() {
                return None;
            }
            let mut mode = DEVMODEW { dmSize: std::mem::size_of::<DEVMODEW>() as u16, ..Default::default() };
            EnumDisplaySettingsW(windows::core::PCWSTR(info.szDevice.as_ptr()), ENUM_CURRENT_SETTINGS, &mut mode)
                .as_bool()
                .then_some(mode.dmDisplayFrequency)
                .filter(|&hz| hz > 1)
        }
    }

    pub(super) fn covered(exe: &str, game_hwnd: u64) -> bool {
        // SAFETY: plain Win32 queries on the front window and the game's window.
        unsafe {
            let front = GetForegroundWindow();
            if front.is_invalid() {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(front, Some(&mut pid));
            let front_exe = crate::procs::shared(|p| p.names(&[pid])).remove(&pid);
            if front_exe.is_some_and(|e| e.eq_ignore_ascii_case(exe)) {
                return false; // The game itself is in front.
            }
            if game_hwnd == 0 {
                return true;
            }
            let game = HWND(game_hwnd as usize as *mut core::ffi::c_void);
            MonitorFromWindow(front, MONITOR_DEFAULTTONEAREST) == MonitorFromWindow(game, MONITOR_DEFAULTTONEAREST)
        }
    }

    /// Whether a window still exists (it may be minimised).
    pub(super) fn still_open(hwnd: u64) -> bool {
        // SAFETY: IsWindow only checks the handle; any value is safe to pass.
        unsafe { IsWindow(Some(HWND(hwnd as usize as *mut core::ffi::c_void))) }.as_bool()
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
            covers.then(|| Front { pid, spot: spot_of(hwnd, monitor, screen_height, screen) })
        }
    }

    /// The screen a listed game's biggest visible window is on.
    /// Also its window, to record just that.
    pub(super) fn screen_of_process(exe: &str) -> Option<Spot> {
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
        let (monitor, height, screen) = monitor_of(hwnd);
        Some(spot_of(hwnd, monitor, height, screen))
    }
}

#[cfg(not(windows))]
mod window {
    use super::{Front, Spot};
    pub(super) fn fullscreen_front() -> Option<Front> {
        None
    }
    pub(super) fn still_open(_hwnd: u64) -> bool {
        false
    }
    pub(super) fn covered(_exe: &str, _hwnd: u64) -> bool {
        false
    }
    pub(super) fn screen_of_process(_exe: &str) -> Option<Spot> {
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
