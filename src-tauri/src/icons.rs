//! Program icons (VALORANT, Discord, Spotify...) for the Audio and Games
//! settings: taken from the program's own .exe while it runs, and kept as a
//! small PNG so it still shows once the program is closed.

use std::path::PathBuf;

/// Pixel size of the saved icons (shown at 32 px; sharp on high-DPI screens).
#[cfg_attr(not(windows), allow(dead_code))]
const SIZE: u32 = 64;

/// "Discord.exe" is fine; anything with a path or odd characters is not.
fn valid_exe(exe: &str) -> bool {
    exe.len() <= 128
        && exe.to_ascii_lowercase().ends_with(".exe")
        && !exe.starts_with('.')
        && exe.chars().all(|c| c.is_alphanumeric() || " ._-+()".contains(c))
}

fn cache_path(exe: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(dir).join("app.crosspov.desktop").join("icons").join(format!("{}.png", exe.to_lowercase())))
}

/// The icon of `exe` as PNG bytes, or None if it isn't known (never ran
/// while CrossPOV was open, or has no icon). `path`: where the program is,
/// if known (e.g. just picked in "Add a game"); otherwise it's looked up
/// among running programs.
pub fn icon_png(exe: &str, path: Option<PathBuf>) -> Option<Vec<u8>> {
    if !valid_exe(exe) {
        return None;
    }
    let cache = cache_path(exe);
    if let Some(bytes) = cache.as_ref().and_then(|p| std::fs::read(p).ok()) {
        return Some(bytes);
    }
    let named_exe = |p: &PathBuf| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(exe));
    let path = match path.filter(named_exe) {
        Some(p) => p,
        None => running_path(exe).or_else(|| installed_path(exe))?,
    };
    let png = extract(&path)?;
    if let Some(cache) = cache {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(cache, &png);
    }
    Some(png)
}

/// Where a running program is. Asks Windows for the bare minimum ("limited
/// information"), which works even for games protected by anti-cheat
/// (VALORANT's Vanguard), where reading the full process details doesn't.
pub(crate) fn running_path(exe: &str) -> Option<PathBuf> {
    if let Some(p) = crate::procs::shared(|p| p.exe_path(exe)) {
        return Some(p);
    }
    #[cfg(windows)]
    for pid in crate::procs::shared(|p| p.root_pids(exe)) {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: plain query on a process handle we open and close here; the
        // buffer outlives the call and its length is passed in.
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { continue };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(handle);
            if ok && len > 0 {
                return Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])));
            }
        }
    }
    None
}

/// Where an installed (not running) game is, for games whose launcher says
/// where it put them. VALORANT: Riot's product settings name its folder.
pub(crate) fn installed_path(exe: &str) -> Option<PathBuf> {
    if !exe.eq_ignore_ascii_case("VALORANT-Win64-Shipping.exe") && !exe.eq_ignore_ascii_case("VALORANT.exe") {
        return None;
    }
    let data = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let settings = data.join("Riot Games").join("Metadata").join("valorant.live").join("valorant.live.product_settings.yaml");
    let folder = std::fs::read_to_string(settings)
        .ok()
        .and_then(|text| riot_install_folder(&text))
        .unwrap_or_else(|| PathBuf::from(r"C:\Riot Games\VALORANT\live"));
    [folder.join("ShooterGame").join("Binaries").join("Win64").join("VALORANT-Win64-Shipping.exe"), folder.join("VALORANT.exe")]
        .into_iter()
        .find(|p| p.is_file())
}

/// `product_install_full_path: "C:/Riot Games/VALORANT/live"` from Riot's settings.
fn riot_install_folder(yaml: &str) -> Option<PathBuf> {
    yaml.lines()
        .find_map(|l| l.trim().strip_prefix("product_install_full_path:"))
        .map(|v| v.trim().trim_matches('"').trim_matches('\''))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Keeps a game's icon as soon as it's seen running, so Settings can show
/// it later. In the background: never slows down game detection.
pub fn remember(exe: &str) {
    let exe = exe.to_string();
    std::thread::spawn(move || {
        let _ = icon_png(&exe, None);
    });
}

#[cfg(not(windows))]
fn extract(_path: &std::path::Path) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn extract(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP};
    use windows::Win32::UI::Shell::SHDefExtractIconW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut icon = HICON::default();
    // S_OK only: S_FALSE means the file has no icon.
    if unsafe { SHDefExtractIconW(PCWSTR(wide.as_ptr()), 0, 0, Some(&mut icon), None, SIZE) } != HRESULT(0) || icon.is_invalid() {
        return None;
    }
    let mut info = ICONINFO::default();
    let got = unsafe { GetIconInfo(icon, &mut info) };
    let _ = unsafe { DestroyIcon(icon) };
    got.ok()?;

    /// 32-bit top-down BGRA pixels of a bitmap.
    fn pixels(bm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
        if bm.is_invalid() {
            return None;
        }
        let mut b = BITMAP::default();
        if unsafe { GetObjectW(bm.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut b as *mut BITMAP).cast())) } == 0 {
            return None;
        }
        let (w, h) = (b.bmWidth.unsigned_abs(), b.bmHeight.unsigned_abs());
        if w == 0 || h == 0 || w > 512 || h > 512 {
            return None;
        }
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; (w * h * 4) as usize];
        let dc = unsafe { GetDC(None) };
        let lines = unsafe { GetDIBits(dc, bm, 0, h, Some(buf.as_mut_ptr().cast()), &mut bmi, DIB_RGB_COLORS) };
        unsafe { ReleaseDC(None, dc) };
        (lines == h as i32).then_some((w, h, buf))
    }

    let color = pixels(info.hbmColor);
    let mask = pixels(info.hbmMask);
    unsafe {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
    }
    let (w, h, mut px) = color?;
    // Old icons have no alpha: their mask says what's see-through (white = clear).
    if px.chunks_exact(4).all(|p| p[3] == 0) {
        let (_, _, m) = mask.filter(|(mw, mh, _)| *mw == w && *mh >= h)?;
        for (p, mp) in px.chunks_exact_mut(4).zip(m.chunks_exact(4)) {
            p[3] = if mp[0] == 0 { 255 } else { 0 };
        }
    }
    for p in px.chunks_exact_mut(4) {
        p.swap(0, 2); // BGRA -> RGBA
    }
    encode_png(w, h, &px)
}

#[cfg_attr(not(windows), allow(dead_code))]
fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().ok()?;
    writer.write_image_data(rgba).ok()?;
    writer.finish().ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_exe_names_are_looked_up() {
        assert!(valid_exe("VALORANT-Win64-Shipping.exe"));
        assert!(valid_exe("Discord.exe"));
        assert!(!valid_exe("..\\..\\x.exe"));
        assert!(!valid_exe("C:/Windows/notepad.exe"));
        assert!(!valid_exe("notes.txt"));
    }

    #[test]
    fn reads_where_riot_installed_valorant() {
        let yaml = "product_install_full_path: \"D:/Games/Riot Games/VALORANT/live\"\nproduct_install_root: \"D:/Games/Riot Games\"\n";
        assert_eq!(riot_install_folder(yaml), Some(PathBuf::from("D:/Games/Riot Games/VALORANT/live")));
        assert_eq!(riot_install_folder("other: 1"), None);
    }

    #[test]
    fn makes_a_valid_png() {
        let png = encode_png(2, 2, &[255; 16]).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}
