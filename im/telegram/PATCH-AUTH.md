# telegram-purple auth patches for imlibpurple (webOS)

Context: imlibpurpletransport implements **no** libpurple request-ops, so
`purple_request_input`/`purple_request_fields` return FALSE. telegram-purple's
interactive login (phone → code → optional 2FA) must therefore use its **IM-channel
compat fallback** instead. Findings from reading the cloned source:

- **Login code — ALREADY WORKS, no code change required.** `tgp-request.c:request_code`
  (lines 48-65) already falls back to opening an IM conversation with a buddy named
  **"Telegram"** when `purple_request_input` returns FALSE *or* the account bool
  `compat-verification` is set. The user's reply is intercepted in the send path
  (`telegram-purple.c:622-632`, `gc_get_data(gc)->request_code_data`) and fed to the
  login callback. On imlibpurple `purple_request_input` returns FALSE, so this triggers
  automatically.
- **Account password field is unused** by the plugin (no `purple_account_get_password`
  anywhere), so the webOS account can safely store the non-empty sentinel `"logincode"`
  that imlibpurple requires (it rejects an empty password before login).

## Patch 1 (recommended, 1 char) — make code entry deterministic
Force the compat fallback on so we don't depend on `purple_request_input`'s return value.

`telegram-purple.c` ~line 835-837:
```c
  opt = purple_account_option_bool_new (
      _("Fall back to IM-based verification (compatibility)"),
      "compat-verification", 0);      //  <-- change the default 0 to 1
```
→ change the final `0` to `1`.

## Patch 2 (needed only for 2-step-verification accounts) — 2FA IM fallback
`tgp-request.c:request_password` (lines 118-128) has **no** compat fallback: if
`purple_request_input` fails it just errors out. Mirror `request_code`:

1. Add a slot next to `request_code_data` in `tgp-structs.h`:
   ```c
   struct request_values_data *request_code_data;
   struct request_values_data *request_password_data;   // NEW
   ```
2. In `request_password`, on the `!purple_request_input(...)` branch, instead of erroring:
   ```c
   tls_get_data (TLS)->request_password_data =
       request_values_data_init (TLS, callback, arg, 0);
   PurpleConversation *conv = purple_conversation_new (
       PURPLE_CONV_TYPE_IM, tls_get_pa (TLS), "Telegram");
   purple_conversation_write (conv, "Telegram",
       _("Enter your Telegram 2-step-verification password"),
       PURPLE_MESSAGE_RECV | PURPLE_MESSAGE_SYSTEM, 0);
   ```
3. In the send path (`telegram-purple.c` ~622, next to the `request_code_data` check),
   add a symmetric block: if `request_password_data` is set, consume the outgoing
   message as the password, call its callback, clear the slot.

Note ordering: on a 2FA account the plugin asks for the **code first, then the
password** — both arrive as consecutive replies to the same "Telegram" chat, so the
send-path handler must check `request_code_data` first, then `request_password_data`.

## Build
Rebuild after patching (same recipe as README). Verify plugin id stays `prpl-telegram`.

## Verify on device
Add a Telegram account (phone). In Messaging, a "Telegram" chat appears asking for the
code; reply with it. If 2FA is enabled and Patch 2 is applied, a second prompt asks for
the password; reply with it. Login completes over ssl-openssl TLS 1.3.
