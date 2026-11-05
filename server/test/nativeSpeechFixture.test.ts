// Frozen gates expose Python + the pinned Pi SDK, not the mutable media venv.
// A missing runtime must fail, never turn new genuine-flow coverage into skip.
import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./helpers";

it("frozen gate frame collector executes production ResultFlow without optional media imports", () => {
  const result = spawnSync(process.env.VC_TEST_VOICE_PYTHON ?? "python3", ["-I", "-c", `
import asyncio, json, sys, time
sys.path.insert(0, sys.argv[1])
from native_flow_fixture import load_native_flow
n = load_native_flow()
assert 'pipecat' not in sys.modules and 'aiohttp' not in sys.modules
assert n.Quiet.say_piece.__code__.co_filename.endswith('/bot.py')
assert n.ResultFlow.next.__code__.co_filename.endswith('/bot.py')
class Frames:
    def __init__(self): self.text = []
    async def queue_frame(self, frame): self.text.append(frame.text)
async def check():
    q, f, flow = n.Quiet(), Frames(), n.ResultFlow()
    q.gate.changed -= n.Gate.QUIET_SECS
    async def stale(utt): return False
    async def fresh(utt): return True
    await q.say_piece(flow, 1, 'stale', f, stale)
    await q.say_piece(flow, 2, 'fresh', f, fresh)
    assert f.text == ['fresh']
    q.gate.on_frame(n.UserStartedSpeakingFrame(), time.monotonic())
    await q.say_piece(flow, 2, 'stale continuation', f, fresh)
    assert f.text == ['fresh']
    print(json.dumps(f.text))
asyncio.run(check())
`, join(ROOT, "voice-pipeline")], { encoding: "utf8", timeout: 10000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["fresh"]);
});
