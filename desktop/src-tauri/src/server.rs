// The child that runs wisp's server: the same `wisp` binary as Homebrew and npm (ADR-0013), as `wisp serve`
// with `web/` beside it. It holds the read end of a pipe on its stdin (WISP_EXIT_WITH_STDIN): when this process
// goes, however it goes, that pipe closes and the server shuts down. On Windows the server is also in a Job Object
// that kills it when this process's last handle to the job goes (DESK2-05): Windows has no SIGTERM, and a quit that
// never reached our exit path must not leave the server listening.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const HEALTH_LIMIT: Duration = Duration::from_secs(60);
const QUIT_LIMIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct Server {
    child: Arc<Mutex<Option<Child>>>,
    stdin: Mutex<Option<ChildStdin>>,
    stopping: Arc<AtomicBool>,
    /// Windows: the job the server is in (killed with it when this process ends); held, never used again
    #[cfg(windows)]
    job: Mutex<Option<job::Job>>,
}

// Any HTTP answer counts: a wisp from the CLI, or ours once it's up.
pub fn answers(port: u16, path: &str) -> bool {
    let Ok(addrs) = ("localhost", port).to_socket_addrs() else { return false };
    addrs.into_iter().any(|addr| {
        let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_secs(1)) else { return false };
        let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
        let ask = format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n");
        let mut head = [0u8; 5];
        s.write_all(ask.as_bytes()).is_ok() && s.read_exact(&mut head).is_ok() && &head == b"HTTP/"
    })
}

impl Server {
    /// `path`: the login shell's PATH for the server and the agents it starts (src/shell_path.rs); None keeps ours.
    pub fn start(&self, app: &AppHandle, wisp: &Path, data: &Path, port: u16, path: Option<&str>) -> std::io::Result<()> {
        let mut cmd = Command::new(wisp);
        cmd.arg("serve")
            .current_dir(wisp.parent().unwrap_or(data))
            .env("WISP_PORT", port.to_string())
            .env("WISP_EXIT_WITH_STDIN", "1")
            .env("WISP_DESKTOP", "tauri")
            .env("WISP_DESKTOP_DATA", data)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(path) = path {
            cmd.env("PATH", path);
        }
        // A release shell has no stderr of its own, so a server that dies young would say nothing.
        if let Ok(log) = std::fs::create_dir_all(data).and_then(|_| std::fs::File::create(data.join("server.log"))) {
            cmd.stderr(log);
        }
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
        let mut child = cmd.spawn()?;
        #[cfg(windows)]
        {
            *self.job.lock().unwrap() = job::Job::kill_on_close(&child);
        }
        *self.stdin.lock().unwrap() = child.stdin.take();
        let lines = child.stdout.take().expect("piped stdout");
        *self.child.lock().unwrap() = Some(child);
        let window = app.clone();
        thread::spawn(move || relay(lines, window));
        Ok(())
    }

    // Once it's up the server is what makes this an app: the shell dies with it, and the update flow
    // counts on that (the server exits, a helper waits for the port and opens the new build).
    pub fn exit_with_it(&self, app: AppHandle) {
        let (child, stopping) = (self.child.clone(), self.stopping.clone());
        thread::spawn(move || loop {
            thread::sleep(POLL);
            if stopping.load(Ordering::SeqCst) {
                return;
            }
            let done = child.lock().unwrap().as_mut().is_none_or(|c| !matches!(c.try_wait(), Ok(None)));
            if done {
                return app.exit(0);
            }
        });
    }

    pub fn wait_healthy(&self, port: u16) -> bool {
        let start = Instant::now();
        while start.elapsed() < HEALTH_LIMIT {
            if answers(port, "/api/health") {
                return true;
            }
            let gone = self.child.lock().unwrap().as_mut().is_none_or(|c| !matches!(c.try_wait(), Ok(None)));
            if gone {
                return false;
            }
            thread::sleep(POLL);
        }
        false
    }

    // Blocks the quit until the server is done: closing the pipe is its signal to stop the agents.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        drop(self.stdin.lock().unwrap().take());
        let Some(mut child) = self.child.lock().unwrap().take() else { return };
        let start = Instant::now();
        while start.elapsed() < QUIT_LIMIT {
            if !matches!(child.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(POLL);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

// The server's log goes on to our stdout. `wisp:shell` lines are for us (a dev server may ask to reload).
fn relay(lines: impl Read, app: AppHandle) {
    for line in BufReader::new(lines).lines().map_while(Result::ok) {
        match line.strip_prefix("wisp:shell ") {
            Some("reload") => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.reload();
                }
            }
            Some("relaunch") => app.request_restart(),
            _ => {
                let _ = writeln!(std::io::stdout(), "{line}"); // println! panics when nobody reads it
            }
        }
    }
}

/// A Job Object with KILL_ON_JOB_CLOSE: its processes end when its last handle closes, which is when this process
/// ends, however it ends (a quit, a crash, Task Manager). Best effort: without it the stdin pipe still stops the server.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // a kernel handle: any thread may hold it
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close(child: &Child) -> Option<Self> {
            // SAFETY: plain Win32 calls on a job we create and a process handle the Child owns while we use it.
            unsafe {
                let job = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    u32::try_from(std::mem::size_of_val(&info)).unwrap_or(0),
                );
                if set.is_err() || AssignProcessToJobObject(job, HANDLE(child.as_raw_handle())).is_err() {
                    let _ = CloseHandle(job);
                    return None;
                }
                Some(Self(job))
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: our own handle, closed once
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
