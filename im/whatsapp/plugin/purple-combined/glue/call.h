#ifndef GOWHATSAPP_CALL_H
#define GOWHATSAPP_CALL_H

// Register the com.palm.whatsapp.call luna-service (WhatsApp voice calling), attached
// to libpurple's default GMainContext. Idempotent — safe to call on every login; only
// the first call registers. Defined in glue/call.c.
void whatsapp_call_luna_init(void);

#endif
