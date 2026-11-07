//! Job Objects and the process table on Windows.
//!
//! Each child goes into its own Job Object. Processes it starts join the job too, so terminating
//! the job ends the whole tree (what `taskkill /T` did in v1, without its walk-the-tree race), and
//! `KILL_ON_JOB_CLOSE` ends it if wisp-native itself dies: the handle closes with the process.

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::{CloseHandle, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectBasicAccountingInformation, JobObjectExtendedLimitInformation, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE, TerminateProcess};

use crate::ProcInfo;

/// Windows has no signals; the protocol maps every kill to `TerminateJobObject`.
pub const SIGKILL: i32 = 9;
pub const SIGTERM: i32 = 15;
pub const SIGHUP: i32 = 1;

pub fn signal_number(name: &str) -> Option<i32> {
    match name.strip_prefix("SIG").unwrap_or(name) {
        "KILL" => Some(SIGKILL),
        "TERM" => Some(SIGTERM),
        "HUP" => Some(SIGHUP),
        "INT" => Some(2),
        _ => None,
    }
}

pub fn signal_name(sig: i32) -> String {
    match sig {
        SIGKILL => "SIGKILL".to_owned(),
        SIGTERM => "SIGTERM".to_owned(),
        SIGHUP => "SIGHUP".to_owned(),
        2 => "SIGINT".to_owned(),
        n => format!("SIG{n}"),
    }
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 { Err(io::Error::last_os_error()) } else { Ok(()) }
}

/// An owned handle, closed on drop.
#[derive(Debug)]
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: we own this handle (it came from a successful Create*/Open* call) and close it once.
        #[allow(unsafe_code)]
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A Job Object holding one child's tree. Dropping it terminates every process still in it.
#[derive(Debug)]
pub struct Job(Owned);

// SAFETY: a job handle is a kernel object reference; Win32 job calls are thread-safe.
#[allow(unsafe_code)]
unsafe impl Send for Job {}
// SAFETY: as above; no method takes &mut or keeps interior state.
#[allow(unsafe_code)]
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> io::Result<Job> {
        // SAFETY: null attributes and a null name are documented as "default, unnamed".
        #[allow(unsafe_code)]
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(Owned(handle));
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid "no limits" value.
        #[allow(unsafe_code)]
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(size_of_val(&info)).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: `info` lives across the call and `size` is its exact size.
        #[allow(unsafe_code)]
        let ok = unsafe {
            SetInformationJobObject(job.0.0, JobObjectExtendedLimitInformation, (&raw const info).cast(), size)
        };
        check(ok)?;
        Ok(job)
    }

    /// Put process `pid` (a child we just started, so its pid can't have been reused) in the job.
    pub fn assign(&self, pid: u32) -> io::Result<()> {
        // SAFETY: OpenProcess takes integers; a failure is a null handle, checked below.
        #[allow(unsafe_code)]
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid) };
        if process.is_null() {
            return Err(io::Error::last_os_error());
        }
        let process = Owned(process);
        // SAFETY: both handles are open and owned by us for the duration of the call.
        #[allow(unsafe_code)]
        let ok = unsafe { AssignProcessToJobObject(self.0.0, process.0) };
        check(ok)
    }

    /// End every process in the job.
    pub fn terminate(&self, code: u32) -> io::Result<()> {
        // SAFETY: the job handle is open and owned by self.
        #[allow(unsafe_code)]
        let ok = unsafe { TerminateJobObject(self.0.0, code) };
        check(ok)
    }

    /// How many processes in the job are still running.
    pub fn active(&self) -> io::Result<u32> {
        // SAFETY: an all-zero accounting struct is a valid out-buffer.
        #[allow(unsafe_code)]
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let size = u32::try_from(size_of_val(&info)).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: `info` is a writable buffer of `size` bytes; the return length pointer may be null.
        #[allow(unsafe_code)]
        let ok = unsafe {
            QueryInformationJobObject(
                self.0.0,
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                size,
                ptr::null_mut(),
            )
        };
        check(ok)?;
        Ok(info.ActiveProcesses)
    }
}

/// End one process (used only when a child couldn't be put in a job).
pub fn terminate_pid(pid: u32, code: u32) -> io::Result<()> {
    // SAFETY: integers only; failure is a null handle, checked below.
    #[allow(unsafe_code)]
    let process = unsafe { OpenProcess(PROCESS_TERMINATE, FALSE, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = Owned(process);
    // SAFETY: the handle is open and owned for the call.
    #[allow(unsafe_code)]
    let ok = unsafe { TerminateProcess(process.0, code) };
    check(ok)
}

/// Every process on the machine (pid and parent), from a Toolhelp snapshot.
pub fn processes() -> io::Result<Vec<ProcInfo>> {
    // SAFETY: flags and pid 0 ("all processes") are plain integers.
    #[allow(unsafe_code)]
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let snap = Owned(snap);
    // SAFETY: PROCESSENTRY32W is plain data; all-zero is valid before dwSize is set.
    #[allow(unsafe_code)]
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = u32::try_from(size_of_val(&entry)).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut out = Vec::new();
    // SAFETY: the snapshot handle is open and `entry` is writable with dwSize set.
    #[allow(unsafe_code)]
    let mut more = unsafe { Process32FirstW(snap.0, &raw mut entry) };
    while more != 0 {
        out.push(ProcInfo { pid: entry.th32ProcessID, ppid: entry.th32ParentProcessID, pgid: 0, zombie: false });
        // SAFETY: as for Process32FirstW.
        #[allow(unsafe_code)]
        let next = unsafe { Process32NextW(snap.0, &raw mut entry) };
        more = next;
    }
    Ok(out)
}
