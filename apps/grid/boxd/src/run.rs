//! What a run may ask for, and the `docker run` boxd builds from it (v1 grid/boxd.js `checkRun`, `containerRun`,
//! `envFileText`). Everything but the id, the port, the env, the limits and the DNS (image, runtime, network,
//! mounts, uid) is boxd's own: a grid that was broken into can't ask for more than a box.

use crate::json::J;

/// The container settings (v1 `CONTAINER`), boxd's own.
#[derive(Debug, Clone, PartialEq)]
pub struct Container {
    pub image: String,
    /// `runsc` (gVisor: a user-space kernel between the agents and the host's), or "" for runc
    pub runtime: String,
    pub network: String,
    pub memory: String,
    pub memory_swap: String,
    pub cpus: f64,
    pub pids: u64,
    pub uid: u32,
    pub dns: Vec<String>,
}

impl Default for Container {
    fn default() -> Self {
        Self { image: "wisp-grid-user".into(), runtime: "runsc".into(), network: "wisp-users".into(), memory: "1536m".into(), memory_swap: "3g".into(), cpus: 1.5, pids: 512, uid: 1000, dns: vec!["1.1.1.1".into(), "9.9.9.9".into()] }
    }
}

/// A checked run.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    pub id: String,
    pub port: u16,
    pub env: Vec<(String, String)>,
    pub memory: String,
    pub memory_swap: String,
    pub cpus: f64,
    pub pids: u64,
    pub dns: Vec<String>,
    pub sandbox: bool,
}

pub fn container_name(id: &str) -> String {
    format!("wisp-u-{id}")
}

/// A user id: letters, digits, - and _, 1 to 64.
pub fn is_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `<user>-sb-<8 hex>` (grid/sandboxes.js): a user's own box is never a sandbox.
fn is_sandbox_id(id: &str) -> bool {
    id.rsplit_once("-sb-").is_some_and(|(u, h)| !u.is_empty() && h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn is_env_key(k: &str) -> bool {
    let mut b = k.bytes();
    k.len() <= 128 && b.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_') && b.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// `1536m`, `3g`, `512`: digits and one unit.
fn is_size(s: &str) -> bool {
    let d = s.strip_suffix(['b', 'k', 'm', 'g', 'B', 'K', 'M', 'G']).unwrap_or(s);
    !d.is_empty() && d.len() <= 12 && d.bytes().all(|c| c.is_ascii_digit())
}

fn is_ip(s: &str) -> bool {
    s.parse::<std::net::IpAddr>().is_ok()
}

/// `KEY=value` lines for `docker run --env-file`, which takes values as they are: no quotes, so no line breaks.
pub fn env_file_text(env: &[(String, String)]) -> Result<String, String> {
    let mut out = String::new();
    for (k, v) in env {
        if !is_env_key(k) {
            return Err(format!("env: \"{k}\" isn't a variable name."));
        }
        if v.contains(['\0', '\r', '\n']) {
            return Err(format!("env: {k} has a line break in it."));
        }
        out.push_str(k);
        out.push('=');
        out.push_str(v);
        out.push('\n');
    }
    Ok(out)
}

/// A run request, checked against boxd's defaults.
pub fn check_run(req: &J, d: &Container) -> Result<Run, String> {
    let id = req.get("id").map(J::text).unwrap_or_default();
    if !is_id(&id) {
        return Err("run: a user id (letters, digits, - and _), please.".into());
    }
    let port = req.get("port").and_then(J::num).filter(|p| p.fract() == 0.0 && (1024.0..=65535.0).contains(p)).ok_or("run: a port from 1024 to 65535.")?;
    let env: Vec<(String, String)> = match req.get("env") {
        Some(J::Obj(o)) => o.iter().map(|(k, v)| (k.clone(), v.text())).collect(),
        _ => Vec::new(),
    };
    if env.len() > 200 {
        return Err("run: too many env variables.".into());
    }
    env_file_text(&env)?;
    let lim = |k: &str| req.get("limits").and_then(|l| l.get(k));
    let memory = lim("memory").map_or_else(|| d.memory.clone(), J::text);
    let memory_swap = lim("memorySwap").map_or_else(|| d.memory_swap.clone(), J::text);
    if !is_size(&memory) {
        return Err(format!("run: memory \"{memory}\" isn't a size like 1536m."));
    }
    if !is_size(&memory_swap) && memory_swap != "-1" {
        return Err(format!("run: memorySwap \"{memory_swap}\" isn't a size like 1536m."));
    }
    let cpus = lim("cpus").map_or(Some(d.cpus), J::num).filter(|c| *c > 0.0 && *c <= 256.0).ok_or("run: cpus isn't a number of CPUs.")?;
    let pids = lim("pids").map_or(Some(f64::from(u32::try_from(d.pids).unwrap_or(u32::MAX))), J::num).filter(|p| p.fract() == 0.0 && (16.0..=1_000_000.0).contains(p)).ok_or("run: pids isn't a process limit.")?;
    let dns: Vec<String> = match req.get("dns") {
        Some(J::Arr(a)) => a.iter().map(J::text).collect(),
        Some(_) => return Err("run: dns is a list of 1 to 4 IP addresses.".into()),
        None => d.dns.clone(),
    };
    if dns.is_empty() || dns.len() > 4 || !dns.iter().all(|x| is_ip(x)) {
        return Err("run: dns is a list of 1 to 4 IP addresses.".into());
    }
    let sandbox = req.get("sandbox") == Some(&J::Bool(true)) && is_sandbox_id(&id);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // checked to be in range above
    Ok(Run { id, port: port as u16, env, memory, memory_swap, cpus, pids: pids as u64, dns, sandbox })
}

/// Root in a sandbox (under gVisor only): its root is gVisor's, not the host's.
pub fn sandbox_root(runtime: &str) -> bool {
    runtime == "runsc"
}

/// `docker run` for one user's wisp. Attached (no -d) with --rm: the docker process lives as long as the
/// container, so boxd watches it like any child.
pub fn container_run(c: &Container, r: &Run, resolv: &str, env_file: &str, home: &str) -> Vec<String> {
    let root = r.sandbox && sandbox_root(&c.runtime);
    let mut a: Vec<String> = ["run", "--rm", "--init", "--name"].iter().map(|s| (*s).to_owned()).collect();
    a.push(container_name(&r.id));
    if !c.runtime.is_empty() {
        a.extend(["--runtime".into(), c.runtime.clone()]);
    }
    a.extend(["--network".into(), c.network.clone()]);
    a.extend(["-v".into(), format!("{resolv}:/etc/resolv.conf:ro")]);
    // only this box's loopback reaches it, on the same port inside, so Host headers match
    a.extend(["-p".into(), format!("127.0.0.1:{0}:{0}", r.port)]);
    a.extend(["--memory".into(), r.memory.clone(), "--memory-swap".into(), r.memory_swap.clone(), "--cpus".into(), r.cpus.to_string(), "--pids-limit".into(), r.pids.to_string()]);
    if root {
        // root in a sandbox still goes without raw sockets, device nodes and the audit log
        for cap in ["NET_RAW", "MKNOD", "AUDIT_WRITE"] {
            a.extend(["--cap-drop".into(), cap.into()]);
        }
    } else {
        a.extend(["--cap-drop".into(), "ALL".into(), "--security-opt".into(), "no-new-privileges".into()]);
        a.extend(["--user".into(), format!("{0}:{0}", c.uid)]);
    }
    if r.sandbox {
        a.extend(["--shm-size".into(), "512m".into()]);
    }
    a.extend(["-v".into(), format!("{home}:/home/wisp"), "-w".into(), "/home/wisp".into()]);
    // its secrets come from a 0600 file, never the command line, which `ps` shows everyone
    a.extend(["--env-file".into(), env_file.to_owned()]);
    a.extend(["-e".into(), "HOME=/home/wisp".into(), "-e".into(), "WISP_HOST=0.0.0.0".into(), "-e".into(), format!("WISP_PORT={}", r.port)]);
    if root {
        a.extend(["--user".into(), "0".into()]);
    }
    a.push(c.image.clone());
    if root {
        a.push("/usr/local/sbin/wisp-sandbox-init".into());
    }
    a.extend(["wisp".into(), "serve".into(), "--port".into(), r.port.to_string()]);
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse;

    fn req(s: &str) -> J {
        parse(s).unwrap_or(J::Null)
    }

    #[test]
    fn run_requests_take_only_what_boxd_allows() {
        let d = Container::default();
        let ok = check_run(&req(r#"{"id":"u1","port":4100,"env":{"WISP_BOX":"1","N":5}}"#), &d);
        let Ok(r) = ok else { panic!("{ok:?}") };
        assert_eq!((r.port, r.memory.as_str(), r.cpus, r.pids), (4100, "1536m", 1.5, 512));
        assert_eq!(r.env, vec![("WISP_BOX".into(), "1".into()), ("N".into(), "5".into())]);
        assert!(!r.sandbox);
        for (bad, why) in [
            (r#"{"id":"../etc","port":4100}"#, "user id"),
            (r#"{"id":"u1","port":80}"#, "port"),
            (r#"{"id":"u1","port":4100.5}"#, "port"),
            (r#"{"id":"u1","port":4100,"env":{"1BAD":"x"}}"#, "variable name"),
            (r#"{"id":"u1","port":4100,"env":{"A":"x\ny"}}"#, "line break"),
            (r#"{"id":"u1","port":4100,"limits":{"memory":"lots"}}"#, "memory"),
            (r#"{"id":"u1","port":4100,"limits":{"cpus":0}}"#, "cpus"),
            (r#"{"id":"u1","port":4100,"limits":{"pids":3}}"#, "pids"),
            (r#"{"id":"u1","port":4100,"dns":["evil.example"]}"#, "dns"),
            (r#"{"id":"u1","port":4100,"dns":[]}"#, "dns"),
        ] {
            let e = check_run(&req(bad), &d).err().unwrap_or_default();
            assert!(e.contains(why), "{bad}: {e}");
        }
        // a sandbox only by its id's shape
        assert!(check_run(&req(r#"{"id":"u1-sb-0a1b2c3d","port":4100,"sandbox":true}"#), &d).is_ok_and(|r| r.sandbox));
        assert!(check_run(&req(r#"{"id":"u1","port":4100,"sandbox":true}"#), &d).is_ok_and(|r| !r.sandbox), "a user's own box is never a sandbox");
        assert_eq!(env_file_text(&[("A".into(), "1".into()), ("B".into(), "x y".into())]).as_deref(), Ok("A=1\nB=x y\n"));
    }

    #[test]
    fn container_run_locks_a_box_down() {
        let c = Container::default();
        let r = check_run(&req(r#"{"id":"u1","port":4100}"#), &c).unwrap_or_else(|e| panic!("{e}"));
        let a = container_run(&c, &r, "/b/u1/resolv.conf", "/b/u1/env", "/b/u1/home").join(" ");
        for want in ["--rm", "--runtime runsc", "--network wisp-users", "-p 127.0.0.1:4100:4100", "--cap-drop ALL", "no-new-privileges", "--user 1000:1000", "--env-file /b/u1/env", "-v /b/u1/home:/home/wisp", "--pids-limit 512", "wisp-grid-user wisp serve --port 4100"] {
            assert!(a.contains(want), "{want} in {a}");
        }
        assert!(!a.contains("SECRET"), "no secret on the command line");
        let sb = check_run(&req(r#"{"id":"u1-sb-0a1b2c3d","port":4101,"sandbox":true}"#), &c).unwrap_or_else(|e| panic!("{e}"));
        let a = container_run(&c, &sb, "r", "e", "h").join(" ");
        assert!(a.contains("--user 0") && a.contains("wisp-sandbox-init") && a.contains("--cap-drop NET_RAW") && !a.contains("--cap-drop ALL"));
        // under runc a sandbox is locked down like any box
        let runc = Container { runtime: String::new(), ..Container::default() };
        let a = container_run(&runc, &sb, "r", "e", "h").join(" ");
        assert!(a.contains("--cap-drop ALL") && !a.contains("--user 0") && !a.contains("--runtime"));
    }
}
