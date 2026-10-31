"""Throwaway spike 2: settles three questions before the private /challenge prompt is built.

R1  Does an ephemeral command sent as a reply to someone still carry reply_to_message?
TM  Does picking a member without a username (from the @ list) arrive as a text_mention with the user?
CB  Do taps on an ephemeral prompt carry the ephemeral message, and do edit + delete work?

Commands (group, all ephemeral): /challengep. Reply to the prompt with an @ pick; tap its button twice.
Every update is printed raw ("RAW ...") plus a one-line verdict ("R1:", "TM:", "CB:").
"""

import json
import os
import time
import urllib.error
import urllib.request

API = f"https://api.telegram.org/bot{os.environ['BOT_TOKEN']}/"


def call(method, **params):
    req = urllib.request.Request(
        API + method, data=json.dumps(params).encode(), headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=70) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as err:
        body = json.load(err)
    if not body.get("ok"):
        print(f"FAILED {method}: {body.get('description')} params={json.dumps(params)}", flush=True)
    return body.get("result") if body.get("ok") else None


def keyboard(step):
    return {
        "inline_keyboard": [[{"text": f"Tap me ({step})", "callback_data": f"spike/{step}", "style": "primary"}]],
        "force_reply": True,
    }


def on_command(msg):
    eph = msg.get("ephemeral_message_id")
    target = msg.get("reply_to_message")
    print(
        f"R1: ephemeral={bool(eph)} reply_to_message={'present, from ' + str((target or {}).get('from', {}).get('first_name')) if target else 'ABSENT'}",
        flush=True,
    )
    params = dict(
        chat_id=msg["chat"]["id"],
        text="Spike prompt: reply with an @ pick of someone with no username, then tap the button twice.",
        reply_markup=keyboard(1),
        ephemeral_message_parameters={"receiver_user_id": msg["from"]["id"]},
    )
    if eph:
        params["reply_parameters"] = {"ephemeral_message_id": eph}
    if msg.get("is_topic_message"):
        params["message_thread_id"] = msg["message_thread_id"]
    call("sendMessage", **params)


def on_reply(msg):
    ents = msg.get("entities") or []
    kinds = [
        (e["type"], e.get("user", {}).get("id"), e.get("user", {}).get("username")) for e in ents
    ]
    print(f"TM: reply entities={kinds} text={msg.get('text')!r}", flush=True)
    if msg.get("ephemeral_message_id"):
        call(
            "sendMessage",
            chat_id=msg["chat"]["id"],
            text=f"Spike got entities: {kinds}",
            reply_parameters={"ephemeral_message_id": msg["ephemeral_message_id"]},
            ephemeral_message_parameters={"receiver_user_id": msg["from"]["id"]},
        )


def on_callback(cq):
    m = cq.get("message") or {}
    eph = m.get("ephemeral_message_id")
    has_markup = "reply_markup" in m
    print(
        f"CB: data={cq.get('data')} message_id={m.get('message_id')} ephemeral_message_id={eph} reply_markup={'present' if has_markup else 'ABSENT'}",
        flush=True,
    )
    call("answerCallbackQuery", callback_query_id=cq["id"])
    if not eph:
        return
    base = dict(chat_id=m["chat"]["id"], receiver_user_id=cq["from"]["id"], ephemeral_message_id=eph)
    if cq.get("data") == "spike/1":
        ok = call("editEphemeralMessageText", text="Spike prompt, edited. Tap again to delete it.", reply_markup=keyboard(2), **base)
        print(f"CB: edit result={ok}", flush=True)
    else:
        ok = call("deleteEphemeralMessage", **base)
        print(f"CB: delete result={ok}", flush=True)


def main():
    me = call("getMe")
    print(f"spike2 running as @{me['username']}", flush=True)
    call(
        "setMyCommands",
        scope={"type": "all_group_chats"},
        commands=[{"command": "challengep", "description": "Spike: private prompt checks", "is_ephemeral": True}],
    )
    call("deleteWebhook")
    offset = 0
    while True:
        for upd in call("getUpdates", offset=offset, timeout=50, allowed_updates=["message", "callback_query"]) or []:
            offset = upd["update_id"] + 1
            print("RAW " + json.dumps(upd), flush=True)
            if "callback_query" in upd:
                on_callback(upd["callback_query"])
                continue
            msg = upd.get("message") or {}
            if msg.get("chat", {}).get("type") not in ("group", "supergroup"):
                continue
            text = msg.get("text") or ""
            if text.startswith("/challengep"):
                on_command(msg)
            elif (msg.get("reply_to_message") or {}).get("from", {}).get("id") == me["id"]:
                on_reply(msg)


if __name__ == "__main__":
    main()
