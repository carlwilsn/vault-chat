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

from bot import Gate, ResultFlow  # noqa: E402

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


def test_a_result_is_said_whole_gated_once():
    # One result in four sentences: the gap is waited for once, then the rest goes straight on (no 1.2 s per piece).
    f = ResultFlow()
    assert f.next(7, 0) == "gate"
    f.started(7, 0)
    assert [f.next(7, 0) for _ in range(3)] == ["go", "go", "go"]
    # The next result waits for its own gap.
    assert f.next(8, 0) == "gate"


def test_talking_over_a_result_stops_the_rest():
    f = ResultFlow()
    f.started(3, 2)
    assert f.next(3, 3) == "drop"  # he started a turn while it played: a barge-in
    assert f.next(3, 3) == "drop"
    assert f.next(4, 3) == "gate"  # a later result is said (after its gap)


def test_a_result_his_voice_ran_into_as_it_started_is_said_again_whole():
    # The gap closed as it opened: his first word was transcribed 2.6 s into the result and cut it. He never heard it.
    f = ResultFlow()
    f.started(5, 0, now=100.0)
    assert f.collided(user_turns=1, turn_at=102.6)
    # While it waits for the next gap, later pieces of that result are kept for the replay, not said or dropped.
    f.replaying = True
    assert f.next(5, 1) == "hold"
    # Said again once: a second collision on the same result is a real barge-in.
    f.replayed.add(5)
    f.replaying = False
    f.started(5, 1, now=120.0)
    assert not f.collided(user_turns=2, turn_at=120.2)


def test_talking_over_a_result_well_into_it_is_a_barge_in_not_a_replay():
    f = ResultFlow()
    f.started(6, 0, now=100.0)
    assert not f.collided(user_turns=1, turn_at=104.5)  # 4.5 s in: he heard it and talked over it
    assert f.next(6, 1) == "drop"
    assert not f.collided(user_turns=0, turn_at=-1e9)  # no turn of his: nothing was cut


def test_an_untagged_piece_is_gated_like_before():
    f = ResultFlow()
    f.started(None, 0)
    assert f.next(None, 0) == "gate"


def test_gate_counts_his_turns():
    g = fresh()
    g.on_frame(UserStartedSpeakingFrame(), 1.0)
    g.on_frame(UserStoppedSpeakingFrame(), 2.0)
    g.on_frame(UserStartedSpeakingFrame(), 3.0)
    assert g.user_turns == 2


if __name__ == "__main__":
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            n += 1
            print(f"ok  {name}")
    print(f"{n} passed")
