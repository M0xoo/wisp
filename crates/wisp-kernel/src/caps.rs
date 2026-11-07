
/// Does `caller`'s set allow `permission`? The full matcher (scopes, plugin manifests, deny lists) is
/// the kernel agent's; this conservative version allows only the user and the kernel.
pub fn allowed(caller: &Caller, _permission: &str) -> bool {
    caller.set == "user:full" || caller.set == "kernel"
}
