import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "@ai-sdk/provider";
import { errToString } from "../../src/errfmt.ts";

const NOT_OBJECT = (s: string) => {
  assert.ok(!s.includes("[object Object]"), `leaked [object Object]: ${s}`);
  assert.ok(s.length > 0);
};

test("plain strings and primitives", () => {
  assert.equal(errToString("boom"), "boom");
  assert.equal(errToString("  "), "unknown error");
  assert.equal(errToString(null), "unknown error");
  assert.equal(errToString(undefined), "unknown error");
  assert.equal(errToString(42), "42");
  assert.equal(errToString(false), "false");
  assert.equal(errToString(10n), "10");
  assert.equal(errToString(Symbol("sym")), "Symbol(sym)");
  NOT_OBJECT(errToString("[object Object]"));
});

test("Error instances keep their message and cause", () => {
  assert.equal(errToString(new Error("disk full")), "disk full");
  const e = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });
  const s = errToString(e);
  assert.match(s, /fetch failed/);
  assert.match(s, /ECONNREFUSED/);
});

test("non-Error throwables never become [object Object]", () => {
  const cases: unknown[] = [
    { type: "overloaded_error" },
    { error: { message: "Rate limit exceeded", code: 429 } },
    { message: { text: "nested message object" } },
    { message: {} },
    {},
    [],
    { statusCode: 502 },
    { status: 503, statusText: "Service Unavailable" },
    Object.create(null),
    new (class Weird {})(),
    () => {},
  ];
  for (const c of cases) NOT_OBJECT(errToString(c));
  assert.equal(errToString({ error: { message: "Rate limit exceeded", code: 429 } }), "Rate limit exceeded");
  assert.match(errToString({ type: "overloaded_error" }), /overloaded_error/);
  assert.match(errToString({ message: { text: "nested message object" } }), /nested message object/);
  assert.match(errToString({ statusCode: 502 }), /502/);
  assert.match(errToString({ status: 503, statusText: "Service Unavailable" }), /Service Unavailable.*503/);
  assert.match(errToString(new (class Weird {})()), /Weird/);
});

test("circular objects are handled", () => {
  const a: any = { kind: "loop" };
  a.self = a;
  const s = errToString(a);
  NOT_OBJECT(s);
  assert.match(s, /loop/);
  const b: any = { error: null };
  b.error = b;
  NOT_OBJECT(errToString(b));
});

test("AI SDK APICallError: status + provider body", () => {
  const e = new APICallError({
    message: "Bad Request",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: JSON.stringify({ error: { message: "No endpoints found that support tool use", code: 400 } }),
  });
  const s = errToString(e);
  assert.match(s, /Bad Request/);
  assert.match(s, /400/);
  assert.match(s, /No endpoints found that support tool use/);
});

test("non-JSON response bodies and data fields are surfaced", () => {
  assert.match(errToString({ message: "upstream", statusCode: 500, responseBody: "<html>gateway</html>" }), /gateway/);
  assert.match(errToString({ response: { data: { error: "invalid key" } } }), /invalid key/);
});

test("AggregateError lists its members", () => {
  const s = errToString(new AggregateError([new Error("a failed"), { code: "B_FAILED" }], "several"));
  assert.match(s, /several/);
  assert.match(s, /a failed/);
  assert.match(s, /B_FAILED/);
});

test("output is capped", () => {
  assert.ok(errToString("x".repeat(10_000)).length <= 2000);
});
