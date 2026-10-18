"""Accounts service and db8 helpers.

createAccount is permission-checked against the template's writePermissions
using the *caller's* app id (accounts/handlers/create.js), and the customUI
validator app is the one every template lists. So account calls go out as the
connector's validator app, the same identity a real sign-in uses.
"""

ACCOUNTS = "luna://com.palm.service.accounts"
DB = "luna://com.palm.db"
DB_APP = "com.palm.configurator"


class AccountError(Exception):
    pass


def caller_for(conn):
    return conn.validator_app or "com.palm.app.accounts"


def templates(dev):
    r = dev.luna(ACCOUNTS + "/listAccountTemplates", {}, app_id="com.palm.app.accounts")
    if not r or not r.get("returnValue", True) or "results" not in r:
        raise AccountError("listAccountTemplates: %r" % (r,))
    return {t["templateId"]: t for t in r["results"]}


def accounts_for(dev, conn):
    r = dev.luna(ACCOUNTS + "/listAccounts", {"templateId": conn.id}, app_id=caller_for(conn))
    if not r or not r.get("returnValue", True):
        raise AccountError("listAccounts(%s): %r" % (conn.id, r))
    return [a for a in r.get("results", []) if not a.get("beingDeleted")]


def create(dev, conn, username, credentials, capability_ids=None, config=None):
    caps = capability_ids or [c["id"] for c in conn.capabilities if c.get("id")]
    payload = {
        "templateId": conn.id,
        "capabilityProviders": [{"id": c} for c in caps],
        "username": username,
        "credentials": credentials,
    }
    if config:
        payload["config"] = config
    r = dev.luna(ACCOUNTS + "/createAccount", payload, app_id=caller_for(conn), timeout_ms=30000)
    if r and not r.get("returnValue") and "Permission denied" in (r.get("errorText") or ""):
        # A validator that hands its result back through CrossAppResult (Discord) never
        # calls createAccount itself: the Accounts app does, and it is always allowed.
        r = dev.luna(ACCOUNTS + "/createAccount", payload, app_id="com.palm.app.accounts",
                     timeout_ms=30000)
        if r and r.get("returnValue"):
            r["result"]["_harness_caller"] = "com.palm.app.accounts"
    if not r or not r.get("returnValue"):
        raise AccountError("createAccount(%s): %r" % (conn.id, r))
    return r["result"]


def delete(dev, conn, account_id):
    r = dev.luna(ACCOUNTS + "/deleteAccount", {"accountId": account_id},
                 app_id=caller_for(conn), timeout_ms=30000)
    if r and not r.get("returnValue") and "Permission denied" in (r.get("errorText") or ""):
        r = dev.luna(ACCOUNTS + "/deleteAccount", {"accountId": account_id},
                     app_id="com.palm.app.accounts", timeout_ms=30000)
    if not r or not r.get("returnValue"):
        raise AccountError("deleteAccount(%s): %r" % (account_id, r))
    return r


def db_find(dev, kind, where=None, limit=100):
    q = {"from": kind, "limit": limit}
    if where:
        q["where"] = [{"prop": p, "op": "=", "val": v} for p, v in where.items()]
    r = dev.luna(DB + "/find", {"query": q}, app_id=DB_APP)
    if r is None:
        raise AccountError("db8 find %s: no reply" % kind)
    if not r.get("returnValue"):
        # an unregistered kind is a fact worth reporting, not a crash
        raise AccountError("db8 find %s: %s" % (kind, r.get("errorText", r)))
    return r.get("results", [])


def db_del(dev, kind, where):
    q = {"from": kind, "where": [{"prop": p, "op": "=", "val": v} for p, v in where.items()]}
    return dev.luna(DB + "/del", {"query": q}, app_id=DB_APP)
