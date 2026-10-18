# im/_core

`include/webos-ls2-compat.h` maps the legacy split-bus `LSPalmService` API the
plugins were written against onto luna-service2 3.x.

## Call services

Plugins that bridge calls into the Phone app register `com.palm.<net>.call`
from inside the IM transport (`imlibpurpleservice`) when they load or when
their network logs in: `whatsapp/plugin/purple-combined/glue/call.c`,
`telegram/plugin/tdlib-purple/call-luna.cpp`,
`signal/plugin/purple-presage/src/c/call.c`,
`teams/plugin/purple-teams/teams_call_luna.c`.

`imlibpurpleservice` ships the role that lets it own those names and defines
the `imlibpurple-call.operation` group for their methods. Each network's
`files/sysbus/` (installed by `webos_system_bus`) holds the two files the plugin package installs
with it:

- `com.palm.<net>.call.service` (`services.d`), `Type=static`. ls-hubd only
  routes to names listed in service files ("Service not listed in service
  files" otherwise), but the name must not be activatable: it exists only
  once the plugin registers it inside an already running transport, and an
  activation would start a second transport. The Phone app resubscribes to
  `callStateQuery` every 5 s until the name is there.
- `com.palm.<net>.call.perm.json` (`client-permissions.d`), granting
  `org.webosports.app.phone` the call methods (`dial`, `answer`,
  `callStateQuery`, ...).

The Phone app finds call transports from accounts whose capabilityProviders
include `PHONE` (`qml/services/CallTransports.qml`) and drives them through
the PHONE capability's `implementation` (`SynergyTransport.qml`).
