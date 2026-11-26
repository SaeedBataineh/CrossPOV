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
        None => crate::procs::shared(|p| p.exe_path(exe))?,
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
    fn makes_a_valid_png() {
        let png = encode_png(2, 2, &[255; 16]).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }
}
