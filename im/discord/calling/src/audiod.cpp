#include "audiod.h"
#include "common.h"
#include <cstdlib>
#include <unistd.h>
#include <sys/wait.h>

namespace dv {

// Fork/exec luna-send so we never link liblunaservice into this foundation binary.
// luna-send is on-device at /usr/bin/luna-send. Response goes to STDERR (see the
// project luna-send memory note) — we don't parse it, this is fire-and-forget.
static void lunaSend(const char* uri, const char* payload) {
    pid_t pid = fork();
    if (pid == 0) {
        execl("/usr/bin/luna-send", "luna-send", "-n", "1", uri, payload, (char*)nullptr);
        _exit(127);
    } else if (pid > 0) {
        int st = 0; waitpid(pid, &st, 0);
    }
}

void audiod_call_active(bool on) {
    if (on) {
        lunaSend("palm://com.palm.audio/phone/CallStatusUpdate",
                 "{\"lines\":[{\"state\":\"active\",\"calls\":[{\"id\":1,"
                 "\"address\":\"discord\",\"origin\":\"outgoing\",\"video\":false,"
                 "\"transport\":\"com.palm.discord\"}]}]}");
        // TouchPad has no earpiece -> default to the loudspeaker; audiod auto-switches
        // to a wired headset / BT when present.
        lunaSend("palm://com.palm.audio/phone/setCurrentScenario",
                 "{\"scenario\":\"phone_back_speaker\"}");
        DV_INFO("audiod: voip call ON (loudspeaker)");
    } else {
        lunaSend("palm://com.palm.audio/phone/CallStatusUpdate", "{\"lines\":[]}");
        DV_INFO("audiod: voip call OFF");
    }
}

} // namespace dv
