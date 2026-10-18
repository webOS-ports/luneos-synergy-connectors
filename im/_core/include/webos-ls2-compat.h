/*
 * webos-ls2-compat.h -- build the call services against either webOS luna-service2.
 *
 * Legacy webOS 3.0.5 has a split bus: a service registers once and gets a public and a private
 * LSHandle out of one LSPalmService. luna-service2 3.x, which LuneOS ships, dropped that model
 * entirely -- there is a single bus, and LSRegisterPalmService, LSPalmServiceRegisterCategory,
 * LSGmainAttachPalmService, LSPalmServiceGetPublicConnection and LSPalmServiceGetPrivateConnection
 * are all gone, along with the LSPalmService type itself.
 *
 * Every call service in this tree (telegram, signal, whatsapp/facebook, teams) uses that legacy
 * API in exactly the same shape, and passes the SAME method table for both buses. So rather than
 * rewrite four call implementations, this header re-expresses the legacy API on top of the modern
 * single-bus one. Including it costs the legacy build nothing -- there the real functions are used.
 *
 * Include this instead of <lunaservice.h>.
 */
#ifndef WEBOS_LS2_COMPAT_H
#define WEBOS_LS2_COMPAT_H

#include <lunaservice.h>

/*
 * Which luna-service2 is this? Callers may force it with -DWEBOS_LS2_MODERN=1/0; otherwise
 * detect on payload.h, which 3.x added and the 3.0.5-era header set does not have.
 */
#ifndef WEBOS_LS2_MODERN
#  if defined(__has_include)
#    if __has_include(<luna-service2/payload.h>)
#      define WEBOS_LS2_MODERN 1
#    else
#      define WEBOS_LS2_MODERN 0
#    endif
#  else
#    define WEBOS_LS2_MODERN 0
#  endif
#endif

#if WEBOS_LS2_MODERN

#include <glib.h>

/*
 * One bus, so an "LSPalmService" is just an LSHandle and both connection accessors return it.
 * The typedef means LSPalmService* is LSHandle* and no call site needs a cast.
 */
typedef LSHandle LSPalmService;

static inline bool
LSRegisterPalmService(const char *name, LSPalmService **ret_service, LSError *lserror)
{
    return LSRegister(name, ret_service, lserror);
}

/*
 * The legacy call takes a public and a private method table. On a single bus only one can be
 * registered: prefer the private one, which is what every caller here passes twice anyway. If a
 * future caller passes two DIFFERENT tables, the public one is silently dropped -- hence the
 * guard, which fails the build rather than losing methods quietly.
 */
static inline bool
LSPalmServiceRegisterCategory(LSPalmService *psh, const char *category,
                              LSMethod *methods_public, LSMethod *methods_private,
                              LSSignal *signals, void *category_user_data, LSError *lserror)
{
    LSMethod *methods = methods_private ? methods_private : methods_public;

    if (methods_public && methods_private && methods_public != methods_private)
    {
        LSErrorInit(lserror);
        g_critical("LSPalmServiceRegisterCategory shim: distinct public/private method tables "
                   "cannot be expressed on a single-bus luna-service2 (category '%s')", category);
        return false;
    }

    return LSRegisterCategory(psh, category, methods, signals, NULL, lserror)
        && (category_user_data == NULL
            || LSCategorySetData(psh, category, category_user_data, lserror));
}

static inline bool
LSGmainAttachPalmService(LSPalmService *psh, GMainLoop *mainLoop, LSError *lserror)
{
    return LSGmainAttach(psh, mainLoop, lserror);
}

static inline LSHandle *
LSPalmServiceGetPrivateConnection(LSPalmService *psh)
{
    return psh;
}

static inline LSHandle *
LSPalmServiceGetPublicConnection(LSPalmService *psh)
{
    return psh;
}

#endif /* WEBOS_LS2_MODERN */

#endif /* WEBOS_LS2_COMPAT_H */
