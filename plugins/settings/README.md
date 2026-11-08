# wisp.settings

The user's way into every plugin's settings (plan §3.1 rule 8: one config system).

## Intent

- Each setting is declared by the plugin that owns it, typed and validated; another plugin may lock one.
- A change is saved before wisp answers, and survives a restart (the kernel's registry, saved through the
  store).
- v1's `GET`/`PATCH /config` keep working with v1's `defaults` names; a v1 install's values carry over once.
- The client sends its IANA time zone (`settings.timeZone`): what wisp writes times in.

## Not yet

The settings still kept by their own plugins' commands (Automations stop at, Ask before running a changed
harness, Usage stats) move into the registry.
