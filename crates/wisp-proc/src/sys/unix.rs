//! Signals and the process table on Unix.

use std::io;

use super::ProcInfo;

pub const SIGKILL: i32 = libc::SIGKILL;
pub const SIGTERM: i32 = libc::SIGTERM;
pub const SIGHUP: i32 = libc::SIGHUP;
pub const SIGCONT: i32 = libc::SIGCONT;
pub const SIGINT: i32 = libc::SIGINT;

const NAMES: &[(&str, i32)] = &[
    ("SIGHUP", libc::SIGHUP),
    ("SIGINT", libc::SIGINT),
    ("SIGQUIT", libc::SIGQUIT),
    ("SIGKILL", libc::SIGKILL),
    ("SIGTERM", libc::SIGTERM),
    ("SIGUSR1", libc::SIGUSR1),
    ("SIGUSR2", libc::SIGUSR2),
    ("SIGWINCH", libc::SIGWINCH),
    ("SIGCONT", libc::SIGCONT),
    ("SIGSTOP", libc::SIGSTOP),
    ("SIGTSTP", libc::SIGTSTP),
    ("SIGALRM", libc::SIGALRM),
    ("SIGPIPE", libc::SIGPIPE),
];

/// `"SIGTERM"` or `"TERM"` → its number on this OS.
pub fn signal_number(name: &str) -> Option<i32> {
    let full = if name.starts_with("SIG") { name.to_owned() } else { format!("SIG{name}") };
    NAMES.iter().find(|(n, _)| *n == full).map(|&(_, s)| s)
}

/// A signal number → `"SIGTERM"` (or `"SIG42"` for one without a name here).
pub fn signal_name(sig: i32) -> String {
    NAMES.iter().find(|&&(_, s)| s == sig).map_or_else(|| format!("SIG{sig}"), |(n, _)| (*n).to_owned())
}

/// kill(2) reads 0 as "my group", -1 as "everyone" and 1 is init: none is ever a child of ours.
fn target(pid: u32) -> io::Result<libc::pid_t> {
    match libc::pid_t::try_from(pid) {
        Ok(p) if p > 1 => Ok(p),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, format!("refusing to signal pid {pid}"))),
    }
}

fn check(ret: libc::c_int) -> io::Result<()> {
    if ret == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

/// Send `sig` to one process.
pub fn signal_pid(pid: u32, sig: i32) -> io::Result<()> {
    let pid = target(pid)?;
    // SAFETY: kill(2) takes plain integers and touches no memory of ours; `target` rules out the
    // broadcast pids 0 and -1.
    #[allow(unsafe_code)]
    check(unsafe { libc::kill(pid, sig) })
}

/// Send `sig` to every process in group `pgid`.
pub fn signal_group(pgid: u32, sig: i32) -> io::Result<()> {
    let pgid = target(pgid)?;
    // SAFETY: as for kill(2): integers only, and `target` refuses pgid 0 (our own group) and 1.
    #[allow(unsafe_code)]
    check(unsafe { libc::killpg(pgid, sig) })
}

/// Every process this user can see.
#[cfg(target_os = "linux")]
pub fn processes() -> io::Result<Vec<ProcInfo>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let Ok(entry) = entry else { continue };
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        // A process may exit between the listing and the read: it is simply not in the table.
        if let Ok(stat) = std::fs::read_to_string(entry.path().join("stat"))
            && let Some(info) = parse_stat(pid, &stat)
        {
            out.push(info);
        }
    }
    Ok(out)
}

/// `/proc/<pid>/stat`: `pid (comm) state ppid pgrp ...`; comm may hold spaces and parentheses.
#[cfg(any(target_os = "linux", test))]
fn parse_stat(pid: u32, stat: &str) -> Option<ProcInfo> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut f = rest.split_ascii_whitespace();
    let state = f.next()?;
    let ppid = f.next()?.parse().ok()?;
    let pgid = f.next()?.parse().ok()?;
    // starttime is field 22 of stat(5): the 17th after pgrp.
    let start = f.nth(16).and_then(|v| v.parse().ok()).unwrap_or(0);
    Some(ProcInfo { pid, ppid, pgid, zombie: state == "Z" || state == "X", start })
}

/// Every process this user can see.
#[cfg(target_os = "macos")]
pub fn processes() -> io::Result<Vec<ProcInfo>> {
    const PID: usize = size_of::<libc::pid_t>();
    // SAFETY: a null buffer of size 0 asks only for the count; nothing is written.
    #[allow(unsafe_code)]
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let count = usize::try_from(count).map_err(|_| io::Error::last_os_error())?;
    // Room for processes started between the two calls.
    let mut pids: Vec<libc::pid_t> = vec![0; count + 64];
    let bytes = libc::c_int::try_from(pids.len() * PID).map_err(|_| io::Error::from(io::ErrorKind::OutOfMemory))?;
    // SAFETY: `pids` is a live, writable buffer of exactly `bytes` bytes; the call writes at most that.
    #[allow(unsafe_code)]
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    let filled = usize::try_from(filled).map_err(|_| io::Error::last_os_error())?;
    pids.truncate(filled.min(pids.len()));
    Ok(pids.into_iter().filter_map(bsd_info).collect())
}

#[cfg(target_os = "macos")]
fn bsd_info(pid: libc::pid_t) -> Option<ProcInfo> {
    const SIZE: usize = size_of::<libc::proc_bsdinfo>();
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = libc::c_int::try_from(SIZE).ok()?;
    // SAFETY: `info` is a writable proc_bsdinfo-sized buffer and `size` says so; the kernel fills
    // at most `size` bytes and returns how many.
    #[allow(unsafe_code)]
    let got = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
    if usize::try_from(got).ok()? != SIZE {
        return None; // gone, or another user's
    }
    // SAFETY: the call above filled every byte (got == SIZE), and the struct is plain integers.
    #[allow(unsafe_code)]
    let info = unsafe { info.assume_init() };
    Some(ProcInfo {
        pid: info.pbi_pid,
        ppid: info.pbi_ppid,
        pgid: info.pbi_pgid,
        zombie: info.pbi_status == libc::SZOMB,
        start: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
    })
}

/// What Activity Monitor calls a process's Memory: `phys_footprint` (RSS leaves out compressed memory and
/// counts shared pages). One `proc_pid_rusage` call per pid, no root; another user's process is refused
/// and left out. v1 asked the system perl for it (one process per tick); this is a syscall each.
#[cfg(target_os = "macos")]
pub fn footprint(pid: u32) -> Option<u64> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v0>::zeroed();
    // SAFETY: RUSAGE_INFO_V0 asks the kernel to fill exactly one rusage_info_v0, and `info` is a
    // writable buffer of that type that lives across the call.
    #[allow(unsafe_code)]
    let ret = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V0, info.as_mut_ptr().cast()) };
    if ret != 0 {
        return None;
    }
    // SAFETY: the call returned 0, so it filled the whole struct, which is plain integers.
    #[allow(unsafe_code)]
    let info = unsafe { info.assume_init() };
    (info.ri_phys_footprint > 0).then_some(info.ri_phys_footprint)
}

/// Not macOS: no footprint; callers keep RSS.
#[cfg(not(target_os = "macos"))]
pub fn footprint(_pid: u32) -> Option<u64> {
    None
}

/// Every process this user can see (not implemented on this Unix: trees are killed by group only).
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn processes() -> io::Result<Vec<ProcInfo>> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "a test")]
mod tests {
    use super::*;

    #[test]
    fn signal_names_round_trip() {
        assert_eq!(signal_number("SIGTERM"), Some(libc::SIGTERM));
        assert_eq!(signal_number("KILL"), Some(libc::SIGKILL));
        assert_eq!(signal_number("SIGNOPE"), None);
        assert_eq!(signal_name(libc::SIGINT), "SIGINT");
        assert_eq!(signal_name(77), "SIG77");
    }

    #[test]
    fn broadcast_pids_are_refused() {
        for pid in [0, 1, u32::MAX] {
            assert_eq!(signal_pid(pid, 0).unwrap_err().kind(), io::ErrorKind::InvalidInput);
            assert_eq!(signal_group(pid, 0).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn stat_lines_with_odd_names_parse() {
        let info = parse_stat(42, "42 (a (b) c) S 7 42 42 0 -1").unwrap();
        assert_eq!(info, ProcInfo { pid: 42, ppid: 7, pgid: 42, zombie: false, start: 0 });
        assert!(parse_stat(9, "9 (z) Z 1 9").unwrap().zombie);
        let full = "7 (x) S 1 7 7 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 123456 9999 1";
        assert_eq!(parse_stat(7, full).unwrap().start, 123_456);
        assert_eq!(parse_stat(9, "garbage"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_process_has_a_footprint() {
        let bytes = footprint(std::process::id()).unwrap();
        assert!(bytes > 1024 * 1024, "{bytes}");
        assert_eq!(footprint(u32::MAX), None);
    }

    #[test]
    fn the_table_holds_this_process() {
        let me = std::process::id();
        let table = processes().unwrap();
        let row = table.iter().find(|p| p.pid == me).unwrap();
        assert!(!row.zombie);
        assert!(row.ppid > 0);
    }
}
