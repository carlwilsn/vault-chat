"""The speak gate (bot.py Gate): a finished job's result never starts while Carl is talking, while his turn is still being
endpointed, or while the voice is mid-reply to him; it waits for the next real gap, however long he goes on.

  python test_gate.py      (the pipeline's own environment: pipecat installed)
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pipecat.frames.frames import (  # noqa: E402
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)

from bot import Gate  # noqa: E402

Q = Gate.QUIET_SECS


def fresh() -> Gate:
    return Gate(0.0)


def test_idle_when_nobody_talks():
    g = fresh()
    assert not g.idle(Q - 0.1)
    assert g.idle(Q)


def test_waits_while_he_is_talking():
    # The bar completes (a result arrives) at t=5 while he talks; nothing starts until his exchange is over.
    g = fresh()
    g.on_frame(VADUserStartedSpeakingFrame(), 3.0)
    assert not g.idle(3.4)  # his voice, before a word is transcribed
    g.on_frame(UserStartedSpeakingFrame(), 3.5)
    for t in (5.0, 6.0, 8.0):
        assert not g.idle(t)
    g.on_frame(VADUserStoppedSpeakingFrame(), 8.2)
    # Endpointing: his voice stopped, the turn model hasn't ended his turn yet.
    assert not g.idle(8.2 + Q + 1)
    g.on_frame(UserStoppedSpeakingFrame(), 9.0)
    # His turn ended: its reply is owed, so still no.
    assert not g.idle(9.0 + Q + 1)
    g.reply_done(11.0)
    g.on_frame(BotStartedSpeakingFrame(), 11.2)
    assert not g.idle(14.0)  # the voice answering him
    g.on_frame(BotStoppedSpeakingFrame(), 15.0)
    assert not g.idle(15.0 + Q - 0.1)
    assert g.idle(15.0 + Q + 0.01)  # the next real gap


def test_endpointing_holds_even_after_his_voice_stops():
    g = fresh()
    g.on_frame(UserStartedSpeakingFrame(), 1.0)
    g.on_frame(VADUserStoppedSpeakingFrame(), 2.0)
    assert not g.idle(10.0)  # the turn is still open (Smart Turn waiting): no result speaks into his pause


def test_waits_while_the_voice_is_mid_reply():
    g = fresh()
    g.on_frame(UserStartedSpeakingFrame(), 1.0)
    g.on_frame(UserStoppedSpeakingFrame(), 2.0)
    g.reply_done(3.0)
    g.on_frame(BotStartedSpeakingFrame(), 3.1)
    assert not g.idle(3.1 + Q + 5)
    g.on_frame(BotStoppedSpeakingFrame(), 10.0)
    assert g.idle(10.0 + Q + 0.01)


def test_reply_owed_holds_between_his_turn_and_the_reply():
    # His turn ended; the reply's text hasn't come (the model is thinking): a result must not jump in front.
    g = fresh()
    g.on_frame(UserStartedSpeakingFrame(), 1.0)
    g.on_frame(UserStoppedSpeakingFrame(), 2.0)
    assert not g.idle(2.0 + Q + 3)
    g.reply_done(6.0)
    assert g.idle(6.0 + Q + 0.01)


def test_he_keeps_talking_for_minutes():
    g = fresh()
    g.on_frame(VADUserStartedSpeakingFrame(), 1.0)
    g.on_frame(UserStartedSpeakingFrame(), 1.3)
    t = 1.3
    while t < 300:  # five minutes of him talking, pauses and all
        g.on_frame(VADUserStoppedSpeakingFrame(), t + 4)
        assert not g.idle(t + 4.5)
        g.on_frame(VADUserStartedSpeakingFrame(), t + 5)
        assert not g.idle(t + 5.5)
        t += 5
    g.on_frame(VADUserStoppedSpeakingFrame(), t)
    g.on_frame(UserStoppedSpeakingFrame(), t + 0.5)
    g.reply_done(t + 2)
    g.on_frame(BotStartedSpeakingFrame(), t + 2.2)
    g.on_frame(BotStoppedSpeakingFrame(), t + 6)
    assert g.idle(t + 6 + Q + 0.01)


def test_a_reply_that_never_comes_stops_holding():
    # An exchange whose reply was cancelled with no words never blocks results forever.
    g = fresh()
    g.on_frame(UserStartedSpeakingFrame(), 1.0)
    g.on_frame(UserStoppedSpeakingFrame(), 2.0)
    assert not g.idle(2.0 + Gate.OWED_MAX_SECS - 1)
    assert g.idle(2.0 + Gate.OWED_MAX_SECS + 0.1)


if __name__ == "__main__":
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            n += 1
            print(f"ok  {name}")
    print(f"{n} passed")
