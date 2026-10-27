//! Windows only: keeps the helper's entry in the Windows volume mixer and
//! Studio's own entry at the same level.
//!
//! Spotify songs play from this helper, a process of its own, so Windows
//! gives them a mixer entry of their own. Without this, turning Studio down
//! in the mixer did nothing to Spotify songs. Here the helper's entry takes
//! Studio's name and icon, and a change to either entry, volume or mute, is
//! copied to the other.
//!
//! Studio passes its own executable in `STUDIO_EXE`; its entries are the
//! sessions whose process runs that file. Elsewhere `start` does nothing.

// The level logic is only called on Windows (and in tests).
#![cfg_attr(not(windows), allow(dead_code))]

/// A session's mixer level: volume (0 – 1) and mute.
type Level = (f32, bool);

fn same(a: Level, b: Level) -> bool {
    (a.0 - b.0).abs() < 1e-4 && a.1 == b.1
}

/// The level every entry should have now. `sessions` is each entry's level
/// (None when it couldn't be read), whether it's the helper's, and whether
/// it was already seen at `last`, the level from the previous round.
///
/// The first time, Studio's own entry decides (Windows keeps its level from
/// last time); the helper's counts only when Studio has none yet. After
/// that, an entry that moved away from `last` is someone using the mixer.
/// A newly opened entry starts at whatever Windows remembered for it, so it
/// is set to match rather than followed.
fn target(sessions: &[(Option<Level>, bool, bool)], last: Option<Level>) -> Option<Level> {
    match last {
        None => sessions
            .iter()
            .filter_map(|&(level, ours, _)| level.map(|l| (ours, l)))
            .min_by_key(|&(ours, _)| ours)
            .map(|(_, l)| l),
        Some(last) => Some(
            sessions
                .iter()
                .find_map(|&(level, _, known)| level.filter(|&l| known && !same(l, last)))
                .unwrap_or(last),
        ),
    }
}

#[cfg(not(windows))]
pub fn start() {}

#[cfg(windows)]
pub fn start() {
    let Some(studio) = std::env::var_os("STUDIO_EXE") else { return };
    let studio = studio.to_string_lossy().to_lowercase();
    let _ = std::thread::Builder::new().name("mixer".into()).spawn(move || unsafe { win::run(&studio) });
}

#[cfg(windows)]
mod win {
    use std::collections::{HashMap, HashSet};
    use std::time::Duration;

    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateExpired, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    use super::{target, Level};

    /// How often levels are compared: quick enough to feel like one slider.
    const POLL: Duration = Duration::from_millis(200);
    /// Entries are looked up again every this many polls (2 s), for a new
    /// output device, a stream opened since, or a Studio that restarted its
    /// audio process.
    const RESCAN: u32 = 10;

    struct Session {
        id: String,
        volume: ISimpleAudioVolume,
        ours: bool,
    }

    pub unsafe fn run(studio: &str) {
        unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                return;
            }
            let me = GetCurrentProcessId();
            let icon = HSTRING::from(format!("{studio},0"));
            let mut sessions = Vec::new();
            let mut named = HashSet::new();
            let mut images = HashMap::new();
            let mut known = HashSet::new();
            let mut last: Option<Level> = None;
            let mut until_scan = 0u32;
            loop {
                if until_scan == 0 {
                    sessions = scan(me, studio, &icon, &mut named, &mut images).unwrap_or_default();
                    until_scan = RESCAN;
                }
                until_scan -= 1;
                sync(&sessions, &mut last, &mut known);
                std::thread::sleep(POLL);
            }
        }
    }

    /// Studio's entries and the helper's on the default output device.
    unsafe fn scan(
        me: u32,
        studio: &str,
        icon: &HSTRING,
        named: &mut HashSet<String>,
        images: &mut HashMap<u32, bool>,
    ) -> windows::core::Result<Vec<Session>> {
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let list = manager.GetSessionEnumerator()?;
            let mut found = Vec::new();
            for i in 0..list.GetCount()? {
                let Ok(control) = list.GetSession(i).and_then(|c| c.cast::<IAudioSessionControl2>()) else { continue };
                if control.GetState().map_or(true, |s| s == AudioSessionStateExpired) {
                    continue;
                }
                let Ok(pid) = control.GetProcessId() else { continue };
                let ours = pid == me;
                if !ours && !*images.entry(pid).or_insert_with(|| image(pid).as_deref() == Some(studio)) {
                    continue;
                }
                let Ok(volume) = control.cast::<ISimpleAudioVolume>() else { continue };
                let id = match control.GetSessionInstanceIdentifier() {
                    Ok(p) => {
                        let s = p.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(p.0 as *const _));
                        s
                    }
                    Err(_) => format!("{pid}/{i}"),
                };
                if ours && named.insert(id.clone()) {
                    let _ = control.SetDisplayName(&HSTRING::from("studio"), std::ptr::null());
                    let _ = control.SetIconPath(icon, std::ptr::null());
                }
                found.push(Session { id, volume, ours });
            }
            Ok(found)
        }
    }

    /// The executable a process runs, lowercased.
    unsafe fn image(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(process);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]).to_lowercase())
        }
    }

    unsafe fn sync(sessions: &[Session], last: &mut Option<Level>, known: &mut HashSet<String>) {
        unsafe {
            let levels: Vec<Option<Level>> = sessions
                .iter()
                .map(|s| Some((s.volume.GetMasterVolume().ok()?, s.volume.GetMute().ok()?.as_bool())))
                .collect();
            let view: Vec<_> = sessions.iter().zip(&levels).map(|(s, &l)| (l, s.ours, known.contains(&s.id))).collect();
            let Some(want) = target(&view, *last) else { return };
            for (s, level) in sessions.iter().zip(&levels) {
                if let Some(l) = level {
                    if (l.0 - want.0).abs() >= 1e-4 {
                        let _ = s.volume.SetMasterVolume(want.0, std::ptr::null());
                    }
                    if l.1 != want.1 {
                        let _ = s.volume.SetMute(want.1, std::ptr::null());
                    }
                }
                known.insert(s.id.clone());
            }
            *last = Some(want);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::target;

    #[test]
    fn studio_decides_first_then_whichever_entry_moved() {
        // First round: Studio's entry, even listed after the helper's.
        assert_eq!(target(&[(Some((1.0, false)), true, false), (Some((0.4, false)), false, false)], None), Some((0.4, false)));
        // No Studio entry yet: the helper's.
        assert_eq!(target(&[(Some((0.7, false)), true, false)], None), Some((0.7, false)));
        assert_eq!(target(&[], None), None);
        // Nothing moved: stays.
        let last = Some((0.4, false));
        assert_eq!(target(&[(Some((0.4, false)), true, true), (Some((0.4, false)), false, true)], last), last);
        // The helper's entry turned down in the mixer: Studio follows.
        assert_eq!(target(&[(Some((0.2, false)), true, true), (Some((0.4, false)), false, true)], last), Some((0.2, false)));
        // Studio's muted: the helper follows.
        assert_eq!(target(&[(Some((0.4, false)), true, true), (Some((0.4, true)), false, true)], last), Some((0.4, true)));
        // A just-opened entry at Windows' old level is set to match, not followed.
        assert_eq!(target(&[(Some((1.0, false)), true, false), (Some((0.4, false)), false, true)], last), last);
        // An entry that can't be read is left out.
        assert_eq!(target(&[(None, true, true)], last), last);
    }
}
